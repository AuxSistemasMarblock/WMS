/**
 * WMS · Configuración del PIN de autorización (compartido: Dashboard y Casos)
 *
 * WMS 2.0 · R1: el PIN que autoriza discrepancias de confronta lo configuran
 * jefe_almacen, lider y admin. En el escáner vive en js/confronta.js; este
 * módulo lo expone en el header de Confronta (dashboard.html) y Casos
 * (casos.html) para que el lider —que no usa el escáner— pueda configurarlo.
 *
 * Autocontenido: inyecta el botón y el modal en el DOM y usa su propio fetch
 * con el token de sessionStorage. Solo se activa para los roles con PIN.
 */
(function () {
  const ROLES_CON_PIN = ['jefe_almacen', 'lider', 'admin'];

  function getToken() { return sessionStorage.getItem('authToken'); }

  function getRol() {
    try {
      const u = JSON.parse(sessionStorage.getItem('currentUser') || 'null');
      return String(u?.rol || '').toLowerCase().trim();
    } catch (e) { return ''; }
  }

  function resolveBackendURL() {
    const cfg = window.APP_CONFIG?.BACKEND_URL;
    if (cfg && !cfg.includes('localhost')) return cfg;
    return `http://${window.location.hostname}:3001`;
  }

  async function pinFetch(path, opts = {}) {
    const res = await fetch(resolveBackendURL() + path, {
      ...opts,
      headers: {
        'Authorization': 'Bearer ' + getToken(),
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    return res;
  }

  // ── Handlers del modal (mismos ids y contrato que en index.html) ──

  window.abrirModalConfigurarPin = function () {
    const modal = document.getElementById('modalConfigurarPin');
    if (!modal) return;
    const form = document.getElementById('formConfigurarPin');
    if (form) form.reset();
    const errorEl = document.getElementById('pinConfigError');
    if (errorEl) errorEl.style.display = 'none';
    modal.classList.add('active');
  };

  window.cerrarModalConfigurarPin = function () {
    const modal = document.getElementById('modalConfigurarPin');
    if (modal) modal.classList.remove('active');
  };

  window.guardarPinJefe = async function (event) {
    if (event) event.preventDefault();
    const pass = (document.getElementById('pinCurrentPassword')?.value || '').trim();
    const pin1 = (document.getElementById('pinNuevo')?.value || '').trim();
    const pin2 = (document.getElementById('pinConfirmar')?.value || '').trim();
    const errorEl = document.getElementById('pinConfigError');
    const btn = document.getElementById('btnGuardarPin');

    const mostrarError = (msg) => {
      if (errorEl) { errorEl.textContent = msg; errorEl.style.display = 'block'; }
    };

    if (!pass) return mostrarError('Ingresa tu contraseña actual');
    if (!/^\d{4,6}$/.test(pin1)) return mostrarError('El PIN debe ser numérico de 4 a 6 dígitos');
    if (pin1 !== pin2) return mostrarError('Los PINs no coinciden');

    if (errorEl) errorEl.style.display = 'none';
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

    try {
      const response = await pinFetch('/auth/set-pin', {
        method: 'POST',
        body: JSON.stringify({ password: pass, pin: pin1 })
      });
      const data = await response.json().catch(() => ({}));
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar PIN'; }

      if (response.ok && data.success) {
        window.cerrarModalConfigurarPin();
        if (typeof showToast === 'function') {
          showToast('✓ PIN configurado correctamente', 'success');
        }
      } else if (response.status === 401) {
        mostrarError('Sesión expirada: cierra sesión y vuelve a entrar');
      } else {
        mostrarError(data.error || 'Error al configurar el PIN');
      }
    } catch (err) {
      console.error('Error al guardar PIN:', err);
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar PIN'; }
      mostrarError('Error de conexión al configurar el PIN');
    }
  };

  // ── Inyección del botón y el modal ──

  function inyectarUI() {
    const rol = getRol();
    if (!ROLES_CON_PIN.includes(rol)) return;

    // Botón en el header (mismo estilo que en index.html), antes del theme toggle
    const headerRight = document.querySelector('.header-right');
    const themeToggle = document.getElementById('themeToggle');
    if (headerRight && !document.getElementById('btnConfigurarPin')) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-logout';
      btn.id = 'btnConfigurarPin';
      btn.title = 'Configurar PIN de autorización';
      btn.onclick = window.abrirModalConfigurarPin;
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> PIN';
      headerRight.insertBefore(btn, themeToggle || null);
    }

    // Modal (mismos ids que index.html)
    if (!document.getElementById('modalConfigurarPin')) {
      const wrap = document.createElement('div');
      wrap.innerHTML = `
<div class="confirm-modal" id="modalConfigurarPin">
  <div class="confirm-card" style="max-width: 380px; text-align: left;">
    <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
      <div style="font-size:24px;">🔑</div>
      <h3 class="confirm-title" style="margin:0;">Configurar PIN de autorización</h3>
    </div>
    <p style="font-size:13px; color:var(--muted); margin-bottom:16px;">
      Define tu PIN numérico (4 a 6 dígitos) para autorizar discrepancias en el escáner.
    </p>
    <form id="formConfigurarPin" onsubmit="guardarPinJefe(event)">
      <div class="form-group" style="margin-bottom:12px;">
        <label for="pinCurrentPassword" style="font-size:12px; font-weight:600;">Tu contraseña actual</label>
        <input type="password" id="pinCurrentPassword" required placeholder="Contraseña de usuario" style="width:100%;" />
      </div>
      <div class="form-group" style="margin-bottom:12px;">
        <label for="pinNuevo" style="font-size:12px; font-weight:600;">Nuevo PIN (4 a 6 números)</label>
        <input type="password" id="pinNuevo" required maxlength="6" inputmode="numeric" pattern="[0-9]{4,6}" placeholder="Ej. 1234" style="width:100%;" />
      </div>
      <div class="form-group" style="margin-bottom:16px;">
        <label for="pinConfirmar" style="font-size:12px; font-weight:600;">Confirmar nuevo PIN</label>
        <input type="password" id="pinConfirmar" required maxlength="6" inputmode="numeric" pattern="[0-9]{4,6}" placeholder="Repite el PIN" style="width:100%;" />
      </div>
      <div id="pinConfigError" class="confronta-pin-error" style="display:none; margin-bottom:12px; text-align:left;"></div>
      <div class="confirm-actions" style="justify-content: flex-end; gap:8px;">
        <button type="button" class="btn btn-ghost" onclick="cerrarModalConfigurarPin()">Cancelar</button>
        <button type="submit" class="btn btn-primary" id="btnGuardarPin">Guardar PIN</button>
      </div>
    </form>
  </div>
</div>`;
      while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
    }
  }

  document.addEventListener('DOMContentLoaded', inyectarUI);
})();
