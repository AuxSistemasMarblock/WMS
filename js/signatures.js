/**
 * Sistema de Firmas Electrónicas
 * Captura de firmas con SignaturePad y validación según cantidad de placas
 */

let signaturePad = null;
let collectedSignatures = {};
let signatureQueue = [];
let currentSignatureType = null;
let isSubmittingSignature = false;

/**
 * Lock/unlock del scroll del body mientras el modal de firma está abierto.
 * Evita que en mobile el body scrollee detrás del modal y "mueva" el canvas.
 */
function lockBodyScroll() {
  document.body.style.overflow = 'hidden';
}
function unlockBodyScroll() {
  document.body.style.overflow = '';
}

// ResizeObserver: se inicializa una vez y reacciona automáticamente a cualquier
// cambio de tamaño del canvas (apertura del modal, rotación, resize de ventana).
let signatureCanvasObserver = null;

/**
 * Sincronizar el tamaño INTERNO del canvas con su tamaño CSS.
 * Mapeo 1:1 sin escala: la firma aparece exactamente donde se traza.
 * Si ya existen trazos, se preservan al redimensionar.
 */
function syncCanvasSize(canvas, cssWidth, cssHeight) {
  if (!canvas) return;
  if (cssWidth <= 0 || cssHeight <= 0) return;
  const w = Math.round(cssWidth);
  const h = Math.round(cssHeight);
  if (Math.abs(canvas.width - w) < 2 && Math.abs(canvas.height - h) < 2) return;

  // Si ya hay trazos dibujados, guardar una copia para restaurarla tras el resize
  const hasContent = signaturePad && !signaturePad.isEmpty();
  let tempCanvas = null;
  if (hasContent) {
    tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(canvas, 0, 0);
  }

  canvas.width = w;
  canvas.height = h;

  if (hasContent && tempCanvas) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = signaturePad.options.backgroundColor || '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(tempCanvas, 0, 0, w, h);
  } else if (signaturePad) {
    signaturePad.clear();
  }
}

/**
 * Inicializar SignaturePad (Singleton)
 */
function initSignaturePad() {
  const canvas = document.getElementById('signatureCanvas');
  if (!canvas) {
    console.error('❌ Canvas no encontrado');
    return;
  }

  if (signaturePad) {
    return signaturePad;
  }

  console.log('✅ Inicializando SignaturePad singleton en canvas:', canvas);

  signaturePad = new SignaturePad(canvas, {
    backgroundColor: '#ffffff',
    penColor: '#4285f4',
    minWidth: 1,
    maxWidth: 3,
    throttle: 10
  });

  // ResizeObserver: detecta cambios de tamaño del canvas automáticamente.
  if (window.ResizeObserver && !signatureCanvasObserver) {
    signatureCanvasObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        syncCanvasSize(canvas, entry.contentRect.width, entry.contentRect.height);
      }
    });
    signatureCanvasObserver.observe(canvas);
  }

  return signaturePad;
}

/**
 * Determinar firmas requeridas según cantidad de placas
 */
function getRequiredSignatures() {
  const placaCount = records.length;

  const required = {
    auxAlmacen: {
      label: 'Auxiliar de Almacén',
      required: true,
      icon: '👤'
    },
    cliente: {
      label: 'Cliente',
      required: true,
      icon: '🏢'
    }
  };

  if (placaCount > 3) {
    required.jefeAlmacen = {
      label: `Jefe de Almacén (+${placaCount} placas)`,
      required: true,
      icon: '👔'
    };
  }

  if (placaCount > 10) {
    required.gerente = {
      label: `Gerente (+${placaCount} placas)`,
      required: true,
      icon: '📊'
    };
  }

  return required;
}

/**
 * Mostrar modal de confirmación para salida de placas
 * Resuelve true si confirman, false si cancelan
 */
function askExitConfirmation(count, selectedIF) {
  return new Promise((resolve) => {
    document.getElementById('confirmPlacaCount').textContent = count;
    const ifDisplay = selectedIF
      ? (selectedIF.sourceDoc
          ? `${selectedIF.tranid} (${selectedIF.sourceDoc})`
          : selectedIF.tranid)
      : '—';
    document.getElementById('confirmIFText').textContent = ifDisplay;
    const modal = document.getElementById('confirmExitModal');
    const btnConfirm = document.getElementById('btnConfirmExit');
    const btnCancel = document.getElementById('btnCancelExit');

    // Mientras el modal está abierto, descartar lo que la pistola emita
    if (typeof clearScanBuffer === 'function') clearScanBuffer();
    modal.classList.add('active');

    const close = (val) => {
      modal.classList.remove('active');
      btnConfirm.onclick = null;
      btnCancel.onclick = null;
      resolve(val);
    };

    btnConfirm.onclick = () => close(true);
    btnCancel.onclick = () => close(false);
  });
}

/**
 * Iniciar proceso de captura de firmas
 */
async function startSignatureCapture() {
  if (records.length === 0) {
    showToast('Escanea al menos una placa antes de capturar firmas', 'error');
    return;
  }

  if (!selectedIF) {
    showToast('Selecciona una IF antes de completar el registro', 'error');
    return;
  }

  const confirmed = await askExitConfirmation(records.length, selectedIF);
  if (!confirmed) return;

  // Asegurar que SignaturePad esté listo
  initSignaturePad();

  collectedSignatures = {};
  const required = getRequiredSignatures();
  signatureQueue = Object.entries(required).map(([type, config]) => ({
    type,
    ...config
  }));

  showToast(`Se requieren ${signatureQueue.length} firmas`, 'info');
  await captureNextSignature();
}

/**
 * Capturar siguiente firma en la cola
 */
async function captureNextSignature() {
  if (signatureQueue.length === 0) {
    // Todas las firmas capturadas: cerrar modal y enviar
    const modal = document.getElementById('signatureModal');
    modal.classList.remove('active');
    unlockBodyScroll();
    await submitWithSignatures();
    return;
  }

  const signature = signatureQueue.shift();
  currentSignatureType = signature.type;

  // Actualizar UI del modal
  document.getElementById('signatureTitle').textContent = `${signature.icon} Firma de ${signature.label}`;

  // Asegurar instancia única e inicializada
  if (!signaturePad) {
    initSignaturePad();
  }

  // Limpiar canvas para la nueva firma
  clearSignature();

  // Descartar buffer de pistola antes de mostrar el modal
  if (typeof clearScanBuffer === 'function') clearScanBuffer();

  // Mostrar modal si no está activo
  const modal = document.getElementById('signatureModal');
  if (!modal.classList.contains('active')) {
    modal.classList.add('active');
    lockBodyScroll();
  }

  // Sincronizar tamaño del canvas
  const canvas = document.getElementById('signatureCanvas');
  const rect = canvas.getBoundingClientRect();
  syncCanvasSize(canvas, rect.width, rect.height);
}

/**
 * Limpiar canvas
 */
function clearSignature() {
  if (signaturePad) {
    signaturePad.clear();
  }
}

/**
 * Cancelar el flujo de captura de firmas
 */
function cancelSignatureCapture() {
  const modal = document.getElementById('signatureModal');
  modal.classList.remove('active');
  unlockBodyScroll();

  clearSignature();
  signatureQueue = [];
  collectedSignatures = {};
  currentSignatureType = null;
  isSubmittingSignature = false;

  showToast('Captura de firmas cancelada', 'info');
}

/**
 * Enviar firma capturada
 */
async function submitSignature() {
  if (isSubmittingSignature) return;

  if (!signaturePad || signaturePad.isEmpty()) {
    showToast('Por favor traza tu firma', 'error');
    return;
  }

  isSubmittingSignature = true;

  try {
    // Convertir firma a PNG base64
    const signatureImage = signaturePad.toDataURL('image/png');
    collectedSignatures[currentSignatureType] = signatureImage;

    showToast(`✓ Firma capturada`, 'success');

    // Pasar directamente a la siguiente firma sin cerrar el modal
    // (evita parpadeo, cambios de layout y disparos erróneos de ResizeObserver en Android)
    await captureNextSignature();
  } finally {
    isSubmittingSignature = false;
  }
}

/**
 * Enviar todos los datos (escaneos + firmas) a NetSuite
 */
async function submitWithSignatures() {
  try {
    const success = await submitToNetSuite(collectedSignatures);

    if (success) {
      if (typeof exportJSON === 'function') {
        await exportJSON();
      }

      // Limpiar datos
      records = [];
      collectedSignatures = {};
      signatureQueue = [];
      currentSignatureType = null;

      // Resetear el preview "Última placa leída" del card del escáner
      if (typeof updateLastScanPreview === 'function') {
        updateLastScanPreview({});
      }

      // Actualizar UI
      document.getElementById('tableBody').innerHTML = '<tr id="emptyRow"><td colspan="6"><div class="empty-state"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>Sin registros. Escanea un QR de placa para comenzar.</div></td></tr>';
      document.getElementById('rowCount').textContent = '0';
      clearIF();
    }
  } catch (error) {
    console.error('Submit error:', error);
    showToast('Error al enviar datos: ' + error.message, 'error');
  }
}

// Inicializar SignaturePad cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(initSignaturePad, 100);
});
