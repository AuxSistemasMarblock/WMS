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
 * Determinar firmas requeridas según cantidad de placas.
 * WMS 2.0 · U3: en Multi-IF los umbrales se agregan sobre el TOTAL del grupo.
 */
function getRequiredSignatures() {
  const placaCount = (typeof esModoMulti === 'function' && esModoMulti())
    ? (typeof getActiveRecords === 'function' ? getActiveRecords().length : 0)
    : records.length;

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
    let ifDisplay;
    if (typeof esModoMulti === 'function' && esModoMulti()) {
      // WMS 2.0 · U3: resumen del grupo en la confirmación
      const tranids = typeof grupoTranids === 'function' ? grupoTranids() : [];
      ifDisplay = `grupo: ${tranids.join(', ')} (${tranids.length} IFs)`;
    } else {
      ifDisplay = selectedIF
        ? (selectedIF.sourceDoc
            ? `${selectedIF.tranid} (${selectedIF.sourceDoc})`
            : selectedIF.tranid)
        : '—';
    }
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

  // WMS 2.0 · U3: en Multi-IF no hay una única IF seleccionada; el grupo manda
  const enMulti = typeof esModoMulti === 'function' && esModoMulti();
  if (!enMulti && !selectedIF) {
    showToast('Selecciona una IF antes de completar el registro', 'error');
    return;
  }
  if (enMulti && !(typeof multiState !== 'undefined' && multiState.grupo.length)) {
    showToast('Selecciona al menos una IF del grupo', 'error');
    return;
  }

  const placas = enMulti
    ? (typeof getActiveRecords === 'function' ? getActiveRecords().length : 0)
    : records.length;
  const confirmed = await askExitConfirmation(placas, selectedIF);
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
  // WMS 2.0 · U3: envío del grupo IF por IF con resumen y reintentos
  if (typeof esModoMulti === 'function' && esModoMulti()) {
    return submitGrupoConSignatures();
  }

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

// ────────────────────────────────────────────────────────────
// WMS 2.0 · U3 · Multi-IF: envío del grupo con resumen por IF
// ────────────────────────────────────────────────────────────

// Firmas del grupo + fallidas pendientes de reintento individual
let multiEnvioPendiente = { signatures: null, fallidas: [] };

async function submitGrupoConSignatures() {
  try {
    multiEnvioPendiente = { signatures: collectedSignatures, fallidas: [] };
    const resultado = await submitToNetSuiteMulti(collectedSignatures);
    multiEnvioPendiente.fallidas = resultado.fallidas;

    // Respaldo por placa (Google Sheets) — igual que el flujo simple
    if (typeof exportJSON === 'function') {
      await exportJSON();
    }

    // Las IFs enviadas con éxito salen de la tabla; las fallidas permanecen
    for (const exitosa of resultado.exitosas) {
      for (const r of (typeof getActiveRecords === 'function' ? getActiveRecords() : [])) {
        if (r.ifTranid === exitosa.tranid) {
          records[records.indexOf(r)] = null;
        }
      }
    }

    if (resultado.fallidas.length === 0) {
      showToast(`✓ Grupo enviado: ${resultado.exitosas.length} IF(s) en NetSuite`, 'success');
      limpiarTrasEnvioGrupo();
      return;
    }

    showToast(`${resultado.exitosas.length} IF(s) enviadas · ${resultado.fallidas.length} fallaron`, 'warning');
    if (typeof renderTableMulti === 'function') renderTableMulti();
    mostrarResumenEnvioMulti(resultado);
  } catch (error) {
    console.error('Submit grupo error:', error);
    showToast('Error al enviar el grupo: ' + error.message, 'error');
  }
}

function limpiarTrasEnvioGrupo() {
  records = [];
  collectedSignatures = {};
  signatureQueue = [];
  currentSignatureType = null;
  if (typeof updateLastScanPreview === 'function') updateLastScanPreview({});
  if (typeof resetearMulti === 'function') resetearMulti();
  if (typeof renderEmpty === 'function') renderEmpty();
  const rowCount = document.getElementById('rowCount');
  if (rowCount) rowCount.textContent = '0';
  if (typeof clearIF === 'function') clearIF();
}

/**
 * Modal de resumen por IF con reintento INDIVIDUAL de las fallidas.
 */
function mostrarResumenEnvioMulti(resultado) {
  const modal = document.getElementById('multiSubmitModal');
  const lista = document.getElementById('multiSubmitList');
  if (!modal || !lista) return;

  const filas = [];
  for (const e of resultado.exitosas) {
    filas.push(`<div class="multi-submit-row ok"><span>✅</span><strong>${esc(e.tranid)}</strong><span>${e.items} placa(s) enviadas</span></div>`);
  }
  resultado.fallidas.forEach((f, i) => {
    filas.push(`
      <div class="multi-submit-row fail" id="multiFailRow${i}">
        <span>❌</span>
        <strong>${esc(f.tranid)}</strong>
        <span>${esc(f.message || 'Error al enviar')}</span>
        <button class="btn btn-ghost" style="padding:4px 10px; font-size:12px;" onclick="reintentarIFMulti(${i})">Reintentar</button>
      </div>`);
  });
  lista.innerHTML = filas.join('');
  modal.classList.add('active');
}

function cerrarResumenEnvioMulti() {
  const modal = document.getElementById('multiSubmitModal');
  if (modal) modal.classList.remove('active');
}

/**
 * Reintento individual de una IF fallida (conserva sus placas y firmas).
 */
async function reintentarIFMulti(idx) {
  const fallida = multiEnvioPendiente.fallidas[idx];
  if (!fallida) return;
  const btn = document.querySelector(`#multiFailRow${idx} button`);
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }

  try {
    const resultado = await enviarUnaIF(fallida, multiEnvioPendiente.signatures);
    if (resultado.ok) {
      multiEnvioPendiente.fallidas = multiEnvioPendiente.fallidas.filter((_, i) => i !== idx);
      // Quitar sus registros de la tabla
      for (const r of (typeof getActiveRecords === 'function' ? getActiveRecords() : [])) {
        if (r.ifTranid === fallida.tranid) records[records.indexOf(r)] = null;
      }
      showToast(`✓ ${fallida.tranid} enviada`, 'success');
      if (multiEnvioPendiente.fallidas.length === 0) {
        cerrarResumenEnvioMulti();
        limpiarTrasEnvioGrupo();
        return;
      }
      mostrarResumenEnvioMulti({ exitosas: [], fallidas: multiEnvioPendiente.fallidas });
      if (typeof renderTableMulti === 'function') renderTableMulti();
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Reintentar'; }
      showToast(`⚠️ ${fallida.tranid}: ${resultado.message}`, 'error');
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Reintentar'; }
    showToast('Error al reintentar: ' + e.message, 'error');
  }
}

window.submitGrupoConSignatures = submitGrupoConSignatures;
window.mostrarResumenEnvioMulti = mostrarResumenEnvioMulti;
window.cerrarResumenEnvioMulti = cerrarResumenEnvioMulti;
window.reintentarIFMulti = reintentarIFMulti;
