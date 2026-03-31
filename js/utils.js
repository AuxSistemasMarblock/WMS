/**
 * WMS · Utilidades
 * Funciones auxiliares de UI y conversión
 */

let toastTimer;

/**
 * Muestra una notificación toast
 * @param {string} msg - Mensaje a mostrar
 * @param {string} type - Tipo: 'success', 'error', 'folio-ok'
 */
function showToast(msg, type = 'success') {
  clearTimeout(toastTimer);
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = type;
  requestAnimationFrame(() => t.classList.add('show'));
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

/**
 * Actualiza el estado del escáner
 * @param {string} msg - Mensaje de estado
 * @param {string} type - Tipo de estado: '', 'active', 'folio', 'error'
 */
function setStatus(msg, type) {
  document.getElementById('statusText').textContent = msg;
  document.getElementById('statusDot').className = 'status-dot' + (type ? ' ' + type : '');
}

/**
 * Escapa caracteres especiales HTML
 * @param {string} s - String a escapar
 * @returns {string} String escapado
 */
function esc(s) {
  const escapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return String(s).replace(/[&<>"']/g, (c) => escapeMap[c]);
}
