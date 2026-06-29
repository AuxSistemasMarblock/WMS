/**
 * Sistema de Firmas Electrónicas
 * Captura de firmas con SignaturePad y validación según cantidad de placas
 */

let signaturePad = null;
let collectedSignatures = {};
let signatureQueue = [];
let currentSignatureType = null;

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
// Es más robusto que requestAnimationFrame + getBoundingClientRect porque no
// depende del timing del frame y dispara solo cuando el tamaño REAL cambia.
let signatureCanvasObserver = null;

/**
 * Sincronizar el tamaño INTERNO del canvas con su tamaño CSS.
 * Mapeo 1:1 sin escala: la firma aparece exactamente donde se traza.
 *
 * Trade-off: en pantallas Retina/HiDPI la firma se ve ligeramente menos nítida
 * (1 pixel CSS = 1 pixel interno, sin supersampling). Esto es aceptable para
 * una firma y elimina COMPLETAMENTE el riesgo de offset por desincronización
 * entre ctx.scale y canvas.width.
 */
function syncCanvasSize(canvas, cssWidth, cssHeight) {
  if (!canvas) return;
  if (cssWidth <= 0 || cssHeight <= 0) return;
  const w = Math.round(cssWidth);
  const h = Math.round(cssHeight);
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w;
  canvas.height = h;
  if (signaturePad) signaturePad.clear();
}

/**
 * Inicializar SignaturePad
 */
function initSignaturePad() {
  const canvas = document.getElementById('signatureCanvas');
  if (!canvas) {
    console.error('❌ Canvas no encontrado');
    return;
  }

  console.log('✅ Canvas encontrado:', canvas);

  signaturePad = new SignaturePad(canvas, {
    backgroundColor: '#ffffff',
    penColor: '#4285f4',
    minWidth: 1,
    maxWidth: 3,
    throttle: 10
  });

  // ResizeObserver: detecta cambios de tamaño del canvas automáticamente.
  // Cubre: apertura del modal, rotación de pantalla, resize de ventana.
  if (window.ResizeObserver && !signatureCanvasObserver) {
    signatureCanvasObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        syncCanvasSize(canvas, entry.contentRect.width, entry.contentRect.height);
      }
    });
    signatureCanvasObserver.observe(canvas);
  }

  console.log('✅ SignaturePad inicializado:', signaturePad);
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
    // Todas las firmas capturadas
    await submitWithSignatures();
    return;
  }

  const signature = signatureQueue.shift();
  currentSignatureType = signature.type;

  // Actualizar UI del modal
  document.getElementById('signatureTitle').textContent = `${signature.icon} Firma de ${signature.label}`;

  // Limpiar canvas
  clearSignature();

  // Inicializar SignaturePad
  initSignaturePad();

  // Descartar buffer de pistola antes de mostrar el modal
  if (typeof clearScanBuffer === 'function') clearScanBuffer();

  // Mostrar modal primero (display:flex) para que .clientWidth devuelva el valor real
  const modal = document.getElementById('signatureModal');
  modal.classList.add('active');

  // Bloquear scroll del body para que no se mueva el canvas en mobile
  lockBodyScroll();

  // Sync inmediato del tamaño del canvas (ResizeObserver también disparará
  // cuando el browser termine de hacer layout, pero esto asegura que el canvas
  // esté sincronizado antes del primer toque del usuario).
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
 * Enviar firma capturada
 */
function submitSignature() {
  if (!signaturePad || signaturePad.isEmpty()) {
    showToast('Por favor traza tu firma', 'error');
    return;
  }

  // Convertir firma a PNG base64
  const signatureImage = signaturePad.toDataURL('image/png');
  collectedSignatures[currentSignatureType] = signatureImage;

  showToast(`✓ Firma de ${currentSignatureType} capturada`, 'success');

  // Ocultar modal y restaurar scroll del body
  document.getElementById('signatureModal').classList.remove('active');
  unlockBodyScroll();
  setTimeout(captureNextSignature, 300);
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

// NOTA: el resize/orientationchange ya lo cubre el ResizeObserver configurado
// en initSignaturePad(). No se necesitan listeners manuales de window.
