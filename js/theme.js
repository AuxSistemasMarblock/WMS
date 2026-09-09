/**
 * WMS · Detección y Sincronización de Modo Oscuro con Switch Manual
 * Soporta preferencia de sistema (prefers-color-scheme) y override manual
 * persistente en localStorage ("wms-theme").
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'wms-theme';
  var mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function getSaved() {
    try {
      var val = localStorage.getItem(STORAGE_KEY);
      if (val === 'dark' || val === 'light') {
        return val;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function updateThemeColorMeta(theme) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    // #0f1218 en dark para coincidir con el fondo; #004a99 en light para la barra Marblock
    meta.setAttribute('content', theme === 'dark' ? '#0f1218' : '#004a99');
  }

  function syncToggle(isDark) {
    var toggleBtn = document.getElementById('themeToggle');
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-checked', isDark ? 'true' : 'false');
      if (isDark) {
        toggleBtn.classList.add('dark');
      } else {
        toggleBtn.classList.remove('dark');
      }
    }
  }

  function applyTheme(isDarkOrTheme) {
    var isDark = (isDarkOrTheme === true || isDarkOrTheme === 'dark');
    var theme = isDark ? 'dark' : 'light';

    document.documentElement.setAttribute('data-theme', theme);
    updateThemeColorMeta(theme);
    syncToggle(isDark);

    // Disparar evento para componentes dinámicos (p. ej. Chart.js en dashboard)
    window.dispatchEvent(new CustomEvent('wms-theme-change', {
      detail: { theme: theme, isDark: isDark }
    }));
  }

  function setTheme(t) {
    applyTheme(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch (e) {}
  }

  // Tema inicial: override guardado si existe, si no preferencia del sistema
  var saved = getSaved();
  var initialTheme = saved !== null ? saved : (mediaQuery.matches ? 'dark' : 'light');
  applyTheme(initialTheme);

  // Escuchar cambios de preferencia en vivo (solo si no hay override)
  function handleMediaChange(e) {
    if (getSaved() === null) {
      applyTheme(e.matches);
    }
  }

  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', handleMediaChange);
  } else if (typeof mediaQuery.addListener === 'function') {
    mediaQuery.addListener(handleMediaChange);
  }

  // Escuchar cambios de storage entre pestañas abiertas
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY) {
      if (e.newValue === 'dark' || e.newValue === 'light') {
        applyTheme(e.newValue);
      } else if (e.newValue === null) {
        applyTheme(mediaQuery.matches);
      }
    }
  });

  // Enlazar click en toggle cuando el DOM esté listo
  function initToggle() {
    var toggleBtn = document.getElementById('themeToggle');
    if (!toggleBtn) return;

    var currentTheme = document.documentElement.getAttribute('data-theme') || (mediaQuery.matches ? 'dark' : 'light');
    syncToggle(currentTheme === 'dark');

    toggleBtn.addEventListener('click', function () {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      setTheme(isDark ? 'light' : 'dark');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initToggle);
  } else {
    initToggle();
  }

  // Exponer utilidades para integración y testing
  window.setTheme = setTheme;
  window.getSavedTheme = getSaved;
})();
