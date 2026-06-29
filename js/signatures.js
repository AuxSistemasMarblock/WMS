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

/**
 * Recalcular el tamaño del canvas de firma para que se ajuste al contenedor.
 *
 * CRÍTICO: la primera vez se hace en 2 pasos:
 *   1) style.width = '100%' + style.height = 'auto' → deja que CSS determine el tamaño
 *   2) getBoundingClientRect() → lee el tamaño REAL que el browser renderizó
 * Sin este truco, hay un mismatch entre canvas.width (interno) y canvas.style.width (CSS)
 * y la firma aparece offset. También diferimos con requestAnimationFrame para
 * asegurar que el modal ya esté en el layout antes de medir.
 */
function resizeSignatureCanvas() {
  const canvas = document.getElementById('signatureCanvas');
  if (!canvas) return;

  // Paso 1: dejar que CSS determine el tamaño (el padre ya debe estar visible)
  canvas.style.width = '100%';
  canvas.style.height = 'auto';

  // Paso 2: leer el tamaño real que el browser ya computó
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;  // padre aún no está en layout, abortar

  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  const cssWidth = Math.max(rect.width, 240);
  const cssHeight = Math.round(cssWidth * (200 / 450));

  // Paso 3: fijar tamaño CSS explícito
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';

  // Paso 4: resolución interna para HiDPI (2x o 3x para nitidez en Retina)
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);

  // Paso 5: aplicar escala al contexto para que signature_pad dibuje en coords CSS
  //         (es decir, los puntos del usuario se traducen 1:1 al pixel visual)
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(ratio, ratio);

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
  console.log('📏 Dimensiones canvas rect:', canvas.getBoundingClientRect());

  signaturePad = new SignaturePad(canvas, {
    backgroundColor: '#ffffff',
    penColor: '#4285f4',
    minWidth: 1,
    maxWidth: 3,
    throttle: 10
  });

  // No llamamos resizeSignatureCanvas() acá: el modal está oculto y el canvas
  // no tiene layout. El resize ocurre en captureNextSignature() cuando se muestra.
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

  // Diferir el resize al siguiente frame para asegurar que el browser ya calculó
  // el layout del modal. Sin esto, getBoundingClientRect() lee dimensiones viejas
  // y la firma aparece offset a un costado.
  requestAnimationFrame(() => {
    resizeSignatureCanvas();
  });
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

// Recalcular el canvas cuando cambia el tamaño de la ventana o la orientación
window.addEventListener('resize', () => {
  if (document.getElementById('signatureModal').classList.contains('active')) {
    resizeSignatureCanvas();
  }
});
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    if (document.getElementById('signatureModal').classList.contains('active')) {
      resizeSignatureCanvas();
    }
  }, 150);
});
