/**
 * WMS · 2FA TOTP (WMS 2.0 · S2)
 *
 * Modales del login para admin:
 *  - Verificación (código TOTP o de respaldo) cuando totp_activo.
 *  - Enrolamiento FORZADO al primer login post-rollout: QR de la app
 *    autenticadora + 10 códigos de respaldo + confirmación del primer código.
 *
 * La sesión definitiva la emite completarLogin() (js/auth.js) tras el OK.
 */

const BACKEND_URL_2FA = (function () {
  const cfg = window.APP_CONFIG?.BACKEND_URL;
  if (cfg && !cfg.includes('localhost')) return cfg;
  return `http://${window.location.hostname}:3001`;
})();

function toast2FA(msg, type) {
  if (typeof showToast === 'function') showToast(msg, type);
  else console.log(msg);
}

async function fetch2FA(path, body) {
  const res = await fetch(BACKEND_URL_2FA + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ────────────────────────────────────────────────────────────
// MODAL: verificación (segundo paso del login)
// ────────────────────────────────────────────────────────────

function mostrarModal2FA(tempToken) {
  const modal = document.getElementById('modal2FA');
  if (!modal) return;
  modal.dataset.tempToken = tempToken;
  const input = document.getElementById('codigo2FA');
  const errorEl = document.getElementById('error2FA');
  if (input) input.value = '';
  if (errorEl) errorEl.style.display = 'none';
  modal.classList.add('active');
  if (input) input.focus();
}

function cerrarModal2FA() {
  const modal = document.getElementById('modal2FA');
  if (modal) {
    modal.classList.remove('active');
    delete modal.dataset.tempToken;
  }
}

async function enviarCodigo2FA() {
  const modal = document.getElementById('modal2FA');
  const errorEl = document.getElementById('error2FA');
  const codigo = (document.getElementById('codigo2FA')?.value || '').trim();
  const tempToken = modal?.dataset.tempToken;

  const mostrarError = (msg) => {
    if (errorEl) { errorEl.textContent = msg; errorEl.style.display = 'block'; }
  };

  if (!codigo) return mostrarError('Ingresa el código de verificación');
  if (!tempToken) return mostrarError('Sesión expirada: vuelve a iniciar sesión');

  const btn = document.getElementById('btnVerificar2FA');
  if (btn) { btn.disabled = true; btn.textContent = 'Verificando...'; }

  try {
    const { ok, data } = await fetch2FA('/auth/login/2fa', { tempToken, code: codigo });
    if (btn) { btn.disabled = false; btn.textContent = 'Verificar'; }

    if (ok && data.token) {
      cerrarModal2FA();
      await completarLogin(data);
    } else {
      mostrarError(data.error || 'Código incorrecto');
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Verificar'; }
    mostrarError('Error de conexión: ' + e.message);
  }
}

// ────────────────────────────────────────────────────────────
// MODAL: enrolamiento forzado (primer login del admin)
// ────────────────────────────────────────────────────────────

async function mostrarModalEnrolamiento(tempToken) {
  const modal = document.getElementById('modal2FAEnroll');
  if (!modal) return;
  modal.dataset.tempToken = tempToken;
  const errorEl = document.getElementById('errorEnroll2FA');
  if (errorEl) errorEl.style.display = 'none';

  const qrBox = document.getElementById('qr2FA');
  const secretEl = document.getElementById('secreto2FA');
  const codesEl = document.getElementById('codigosRespaldo2FA');
  if (qrBox) qrBox.innerHTML = '<div class="empty-state">Generando QR...</div>';
  if (secretEl) secretEl.textContent = '—';
  if (codesEl) codesEl.innerHTML = '';
  modal.classList.add('active');

  try {
    const { ok, data } = await fetch2FA('/auth/2fa/setup', { tempToken });
    if (!ok) {
      if (qrBox) qrBox.innerHTML = '<div class="empty-state">' + (data.error || 'Error al generar el QR') + '</div>';
      return;
    }

    modal.dataset.secret = data.secret || '';
    if (secretEl) secretEl.textContent = data.secret || '—';
    if (codesEl) {
      codesEl.innerHTML = (data.backupCodes || []).map(c => `<code class="backup-code">${c}</code>`).join(' ');
    }

    // QR con la librería qrcodejs (carga diferida)
    await cargarLibreriaQR();
    if (qrBox && window.QRCode) {
      qrBox.innerHTML = '';
      new QRCode(qrBox, {
        text: data.otpauthURI,
        width: 180,
        height: 180,
        correctLevel: QRCode.CorrectLevel.M
      });
    } else if (qrBox) {
      // Fallback: sin librería se muestra el secreto para alta manual
      qrBox.innerHTML = '<div class="empty-state">Escanea el QR desde tu app autenticadora<br>(o introduce el secreto manualmente)</div>';
    }
  } catch (e) {
    if (qrBox) qrBox.innerHTML = '<div class="empty-state">Error de conexión: ' + e.message + '</div>';
  }
}

function cargarLibreriaQR() {
  return new Promise((resolve) => {
    if (window.QRCode) return resolve();
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js';
    script.async = true;
    script.onload = resolve;
    script.onerror = resolve; // el fallback muestra el secreto
    document.head.appendChild(script);
  });
}

function cerrarModalEnrolamiento() {
  const modal = document.getElementById('modal2FAEnroll');
  if (modal) {
    modal.classList.remove('active');
    delete modal.dataset.tempToken;
    delete modal.dataset.secret;
  }
}

function copiarCodigosRespaldo() {
  const codesEl = document.getElementById('codigosRespaldo2FA');
  if (!codesEl) return;
  const texto = codesEl.textContent.trim().replace(/\s+/g, '\n');
  navigator.clipboard?.writeText(texto)
    .then(() => toast2FA('Códigos copiados al portapapeles', 'success'))
    .catch(() => toast2FA('No se pudo copiar: selecciónalos manualmente', 'error'));
}

async function confirmarEnrolamiento2FA() {
  const modal = document.getElementById('modal2FAEnroll');
  const errorEl = document.getElementById('errorEnroll2FA');
  const codigo = (document.getElementById('codigoEnroll2FA')?.value || '').trim();
  const tempToken = modal?.dataset.tempToken;

  const mostrarError = (msg) => {
    if (errorEl) { errorEl.textContent = msg; errorEl.style.display = 'block'; }
  };

  if (!codigo) return mostrarError('Ingresa el código de tu app autenticadora');
  if (!tempToken) return mostrarError('Sesión expirada: vuelve a iniciar sesión');

  const btn = document.getElementById('btnConfirmarEnroll2FA');
  if (btn) { btn.disabled = true; btn.textContent = 'Activando...'; }

  try {
    const { ok, data } = await fetch2FA('/auth/2fa/verify-setup', { tempToken, code: codigo });
    if (btn) { btn.disabled = false; btn.textContent = 'Activar 2FA e ingresar'; }

    if (ok && data.token) {
      cerrarModalEnrolamiento();
      toast2FA('✓ 2FA activado correctamente', 'success');
      await completarLogin(data);
    } else {
      mostrarError(data.error || 'Código incorrecto');
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Activar 2FA e ingresar'; }
    mostrarError('Error de conexión: ' + e.message);
  }
}
