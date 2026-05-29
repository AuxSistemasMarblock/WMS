/**
 * Sistema de Firmas Electrónicas
 * Captura de firmas con SignaturePad y validación según cantidad de placas
 */

let signaturePad = null;
let collectedSignatures = {};
let signatureQueue = [];
let currentSignatureType = null;

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
 * Iniciar proceso de captura de firmas
 */
async function startSignatureCapture() {
  if (records.length === 0) {
    showToast('Escanea al menos una placa antes de capturar firmas', 'error');
    return;
  }

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

  // Mostrar modal
  document.getElementById('signatureModal').classList.add('active');
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

  // Ocultar modal y capturar siguiente
  document.getElementById('signatureModal').classList.remove('active');
  setTimeout(captureNextSignature, 300);
}

/**
 * Enviar todos los datos (escaneos + firmas) a NetSuite
 */
async function submitWithSignatures() {
  try {
    const success = await submitToNetSuite(collectedSignatures);

    if (success) {
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
