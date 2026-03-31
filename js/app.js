/**
 * WMS · Aplicación Principal
 * Gestión de modos y estado general
 */

let scanMode = 'placa'; // 'placa' | 'folio'

/**
 * Cambia el modo de escaneo
 * @param {string} mode - Nuevo modo: 'placa' | 'folio'
 */
function setMode(mode) {
    scanMode = mode;
    document.getElementById('btnModeplaca').className =
        'mode-btn' + (mode === 'placa' ? ' active-placa' : '');
    document.getElementById('btnModeFolio').className =
        'mode-btn' + (mode === 'folio' ? ' active-folio' : '');

    const overlay = document.getElementById('scanOverlay');
    const label = document.getElementById('modeLabel');
    const hint = document.getElementById('scanHint');
    const title = document.getElementById('scanCardTitle');

    if (mode === 'folio') {
        overlay.classList.add('mode-folio');
        label.className = 'mode-label folio';
        label.textContent = 'MODO: FOLIO';
        hint.textContent = 'Apunta al QR de la IF';
        title.textContent = 'Escáner QR — Modo: Folio IF';
        if (scanning) setStatus('Esperando QR de folio...', 'folio');
    } else {
        overlay.classList.remove('mode-folio');
        label.className = 'mode-label';
        label.textContent = 'MODO: placa';
        hint.textContent = 'Apunta al QR de la placa';
        title.textContent = 'Escáner QR — Modo: placas';
        if (scanning) setStatus('Cámara activa — apunta al QR', 'active');
    }
}

/**
 * Define el folio capturado
 * @param {string} valor - Valor del folio
 */
function setFolio(valor) {
    const inp = document.getElementById('folioInput');
    inp.value = valor;
    inp.classList.add('folio-filled');
    document.getElementById('folioBadgeText').textContent = valor;
    document.getElementById('folioBadge').classList.add('visible');
    showToast('📋 Folio: ' + valor, 'folio-ok');
    setStatus('Folio capturado: ' + valor, '');
}

/**
 * Limpia el folio capturado
 */
function clearFolio() {
    document.getElementById('folioInput').value = '';
    document.getElementById('folioInput').classList.remove('folio-filled');
    document.getElementById('folioBadge').classList.remove('visible');
}

/**
 * Botón "Completar registro"
 * Dispara el envío del webhook
 */
function completarRegistro() {
    exportJSON();
}

/**
 * Inicializa la aplicación
 * Se ejecuta cuando el DOM está listo
 */
function initApp() {
    // El modo inicial es 'placa'
    setMode('placa');
    renderEmpty();
}

// Inicializa la app cuando el DOM está listo
document.addEventListener('DOMContentLoaded', initApp);
