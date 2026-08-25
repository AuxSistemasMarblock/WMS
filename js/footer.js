/**
 * WMS · Footer de crédito
 *
 * Inyecta el texto del pie de página en #appFooter en todas las vistas.
 * El texto se edita en un solo lugar: la constante APP_FOOTER_TEXT.
 */
window.APP_FOOTER_TEXT =
  '© 2026 Marblock · Sistema WMS · Desarrollado con ❤ por el equipo de TI';

(function () {
  document.addEventListener('DOMContentLoaded', function () {
    const el = document.getElementById('appFooter');
    if (el) el.innerHTML = window.APP_FOOTER_TEXT;
  });
})();
