/**
 * WMS · Usuarios — App (vanilla JS) (WMS 2.0 · R2)
 *
 * Gestión completa de usuarios para rol admin: alta, edición (nombre/rol/
 * ubicación/estado), reset de contraseña y filtros instantáneos.
 * Cada cambio queda en la bitácora de auditoría (A2).
 *
 * Sigue los patrones de js/auditoria/app.js.
 */

// =================== CONFIG & HELPERS ===================
function resolveBackendURL() {
  const cfg = window.APP_CONFIG?.BACKEND_URL;
  if (cfg && !cfg.includes('localhost')) return cfg;
  return `http://${window.location.hostname}:3001`;
}
const BACKEND_URL = resolveBackendURL();

function $(id) { return document.getElementById(id); }

function showToast(msg, type = 'info') {
  const t = $('toast');
  if (!t) return console.log(`[${type}] ${msg}`);
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.style.display = 'block';
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    t.classList.remove('show');
    t.style.display = 'none';
  }, 3000);
}

function escapeHTML(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function fmtFechaHora(v) {
  if (!v) return 'Nunca';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleString('es-MX', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

// =================== AUTH ===================
function getToken() { return sessionStorage.getItem('authToken'); }
function getCurrentUser() {
  const s = sessionStorage.getItem('currentUser');
  try { return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
function handleLogout() {
  sessionStorage.removeItem('authToken');
  sessionStorage.removeItem('currentUser');
  window.location.href = 'index.html';
}

async function apiFetch(path, opts = {}) {
  const token = getToken();
  if (!token) { handleLogout(); throw new Error('No autenticado'); }
  const res = await fetch(BACKEND_URL + path, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (res.status === 401) { handleLogout(); throw new Error('Sesión expirada'); }
  if (res.status === 403) { throw new Error('Sin permisos para gestionar usuarios'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// =================== ESTADO ===================
const PAGE_SIZE = 25;
const state = {
  page: 1,
  usuarios: [],
  catalogos: { roles: [], ubicaciones: [] },
  editandoId: null,
  passwordId: null
};

const ROL_LABELS = {
  'admin': 'Administrador',
  'jefe_almacen': 'Jefe de Almacén',
  'aux_almacen': 'Aux. Almacén',
  'lider': 'Líder de Almacén',
  'gerente': 'Gerente',
  'cliente': 'Cliente'
};
function rolLabel(rol) { return ROL_LABELS[rol] || rol || '—'; }

// =================== CARGA ===================
function buildParams() {
  const p = new URLSearchParams();
  const q = $('filtroQ').value.trim();
  const rol = $('filtroRol').value;
  const activo = $('filtroActivo').value;
  if (q) p.set('q', q);
  if (rol) p.set('rol', rol);
  if (activo) p.set('activo', activo);
  return p;
}

// Filtros instantáneos (U1)
function aplicarFiltros() {
  state.page = 1;
  cargarUsuarios();
}

async function cargarUsuarios() {
  const tbody = $('tbodyUsuarios');
  tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">Cargando usuarios…</div></td></tr>';
  try {
    const data = await apiFetch('/api/usuarios?' + buildParams());
    state.usuarios = data.usuarios || [];
    renderTabla();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">Error: ${escapeHTML(e.message)}</div></td></tr>`;
  }
}

async function cargarCatalogos() {
  try {
    const data = await apiFetch('/api/usuarios/catalogos');
    state.catalogos = data;

    const selRol = $('filtroRol');
    (data.roles || []).forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.clave;
      opt.textContent = r.nombre || rolLabel(r.clave);
      selRol.appendChild(opt);
    });
  } catch (e) {
    showToast('Error cargando catálogos: ' + e.message, 'error');
  }
}

// =================== RENDER ===================
function renderTabla() {
  const tbody = $('tbodyUsuarios');
  const total = state.usuarios.length;
  $('countUsuarios').textContent = String(total);

  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
  state.page = Math.min(state.page, totalPaginas);
  const inicio = (state.page - 1) * PAGE_SIZE;
  const visibles = state.usuarios.slice(inicio, inicio + PAGE_SIZE);

  if (!visibles.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">Sin usuarios para los filtros seleccionados</div></td></tr>';
    renderPaginador(total, totalPaginas);
    return;
  }

  const yo = getCurrentUser();
  tbody.innerHTML = visibles.map(u => `
    <tr>
      <td style="font-weight:600;">${escapeHTML(u.nombre_completo || '—')}</td>
      <td style="font-size:12px;">${escapeHTML(u.email || '—')}</td>
      <td>${escapeHTML(rolLabel(u.rol))}</td>
      <td>${escapeHTML(u.ubicacion || '—')}</td>
      <td>${u.activo
        ? '<span class="tipo-badge ok">Activo</span>'
        : '<span class="tipo-badge error">Inactivo</span>'}</td>
      <td style="font-size:11.5px; white-space:nowrap;">${escapeHTML(fmtFechaHora(u.ultimo_login))}</td>
      <td style="font-size:11px; white-space:nowrap;">
        ${u.totp_activo ? '<span class="tipo-badge ok" title="2FA activo">2FA</span> ' : ''}
        ${u.tiene_pin ? '<span class="tipo-badge warn" title="PIN configurado">PIN</span>' : ''}
        ${!u.totp_activo && !u.tiene_pin ? '<span style="color:var(--muted);">—</span>' : ''}
      </td>
      <td class="cell-center" style="white-space:nowrap;">
        <button class="btn-detalle" type="button" onclick="abrirModalUsuario(${u.id})">Editar</button>
        <button class="btn-detalle" type="button" onclick="abrirModalPassword(${u.id})" title="Resetear contraseña">🔑</button>
        <button class="btn-detalle" type="button" onclick="toggleActivo(${u.id}, ${!u.activo})"
          title="${u.activo ? 'Desactivar' : 'Activar'}">${u.activo ? '⛔' : '✅'}</button>
      </td>
    </tr>
  `).join('');

  renderPaginador(total, totalPaginas);
}

function renderPaginador(total, totalPaginas) {
  const c = $('pagUsuarios');
  const startIdx = total === 0 ? 0 : (state.page - 1) * PAGE_SIZE + 1;
  const endIdx = Math.min(total, state.page * PAGE_SIZE);
  c.innerHTML = `
    <button class="btn btn-ghost" type="button" ${state.page <= 1 ? 'disabled' : ''} onclick="cambiarPagina(-1)">‹ Anterior</button>
    <span class="pagination-info">Página ${state.page} de ${totalPaginas} · Mostrando ${startIdx}-${endIdx} de ${total} (${PAGE_SIZE} por pág.)</span>
    <button class="btn btn-ghost" type="button" ${state.page >= totalPaginas ? 'disabled' : ''} onclick="cambiarPagina(1)">Siguiente ›</button>
  `;
}

function cambiarPagina(delta) {
  state.page = Math.max(1, state.page + delta);
  renderTabla();
}

// =================== MODAL USUARIO (alta / edición) ===================
function abrirModalUsuario(id = null) {
  state.editandoId = id;
  const esEdicion = id != null;
  const u = esEdicion ? state.usuarios.find(x => x.id === id) : null;

  $('modalUsuarioTitle').textContent = esEdicion ? 'Editar usuario' : 'Nuevo usuario';
  $('uNombre').value = u?.nombre_completo || '';
  $('uEmail').value = u?.email || '';
  $('uEmail').disabled = esEdicion; // el email no se edita
  $('uPassword').value = '';
  $('grupoPassword').style.display = esEdicion ? 'none' : 'block';
  $('grupoActivo').style.display = esEdicion ? 'block' : 'none';
  $('uActivo').checked = u ? Boolean(u.activo) : true;
  $('errorUsuario').style.display = 'none';

  const selRol = $('uRol');
  selRol.innerHTML = state.catalogos.roles.map(r =>
    `<option value="${escapeHTML(r.clave)}"${u?.rol === r.clave ? ' selected' : ''}>${escapeHTML(r.nombre || rolLabel(r.clave))}</option>`
  ).join('');

  const selUbic = $('uUbicacion');
  selUbic.innerHTML = (state.catalogos.ubicaciones || []).map(ub =>
    `<option value="${ub.id}"${u?.ubicacion_id === ub.id ? ' selected' : ''}>${escapeHTML(ub.nombre)}</option>`
  ).join('');

  $('modalUsuario').classList.add('active');
}

function cerrarModalUsuario() {
  $('modalUsuario').classList.remove('active');
  state.editandoId = null;
}

async function guardarUsuario() {
  const errorEl = $('errorUsuario');
  const mostrarError = (msg) => { errorEl.textContent = msg; errorEl.style.display = 'block'; };
  errorEl.style.display = 'none';

  const nombre = $('uNombre').value.trim();
  const email = $('uEmail').value.trim();
  const password = $('uPassword').value;
  const rol = $('uRol').value;
  const ubicacionId = Number($('uUbicacion').value);

  if (!nombre) return mostrarError('El nombre es obligatorio');
  if (!email) return mostrarError('El email es obligatorio');
  if (state.editandoId == null && (!password || password.length < 8)) {
    return mostrarError('La contraseña inicial debe tener al menos 8 caracteres');
  }
  if (!rol) return mostrarError('Selecciona un rol');
  if (!ubicacionId) return mostrarError('Selecciona una ubicación');

  const btn = $('btnGuardarUsuario');
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    let data;
    if (state.editandoId == null) {
      data = await apiFetch('/api/usuarios', {
        method: 'POST',
        body: JSON.stringify({ email, password, nombre_completo: nombre, rol, ubicacion_id: ubicacionId })
      });
      showToast(`✓ Usuario ${data.user?.email || email} creado`, 'success');
    } else {
      data = await apiFetch('/api/usuarios/' + state.editandoId, {
        method: 'PATCH',
        body: JSON.stringify({
          nombre_completo: nombre,
          rol,
          ubicacion_id: ubicacionId,
          activo: $('uActivo').checked
        })
      });
      showToast('✓ Usuario actualizado', 'success');
    }
    btn.disabled = false;
    btn.textContent = 'Guardar';
    cerrarModalUsuario();
    await cargarUsuarios();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Guardar';
    mostrarError(e.message);
  }
}

// =================== ACTIVAR / DESACTIVAR ===================
async function toggleActivo(id, activo) {
  const u = state.usuarios.find(x => x.id === id);
  const etiqueta = u ? (u.nombre_completo || u.email) : ('#' + id);
  if (!window.confirm(`¿${activo ? 'Activar' : 'Desactivar'} a ${etiqueta}?`)) return;

  try {
    await apiFetch('/api/usuarios/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ activo })
    });
    showToast(`✓ Usuario ${activo ? 'activado' : 'desactivado'}`, 'success');
    await cargarUsuarios();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// =================== RESET DE CONTRASEÑA ===================
function abrirModalPassword(id) {
  const u = state.usuarios.find(x => x.id === id);
  state.passwordId = id;
  $('pwUsuario').textContent = u ? (u.nombre_completo || u.email) : ('#' + id);
  $('pwNueva').value = '';
  $('pwConfirmar').value = '';
  $('errorPassword').style.display = 'none';
  $('modalPassword').classList.add('active');
}

function cerrarModalPassword() {
  $('modalPassword').classList.remove('active');
  state.passwordId = null;
}

async function guardarPassword() {
  const errorEl = $('errorPassword');
  const mostrarError = (msg) => { errorEl.textContent = msg; errorEl.style.display = 'block'; };
  errorEl.style.display = 'none';

  const nueva = $('pwNueva').value;
  const confirmar = $('pwConfirmar').value;

  if (nueva.length < 8) return mostrarError('La contraseña debe tener al menos 8 caracteres');
  if (nueva !== confirmar) return mostrarError('Las contraseñas no coinciden');
  if (state.passwordId == null) return mostrarError('Sesión inválida: vuelve a intentar');

  const btn = $('btnGuardarPassword');
  btn.disabled = true;
  btn.textContent = 'Resetando...';

  try {
    await apiFetch('/api/usuarios/' + state.passwordId + '/password', {
      method: 'POST',
      body: JSON.stringify({ nueva_password: nueva })
    });
    btn.disabled = false;
    btn.textContent = 'Resetear';
    cerrarModalPassword();
    showToast('✓ Contraseña actualizada', 'success');
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Resetear';
    mostrarError(e.message);
  }
}

// =================== INIT ===================
document.addEventListener('DOMContentLoaded', async () => {
  const token = getToken();
  if (!token) { window.location.href = 'index.html'; return; }

  const user = getCurrentUser();
  const rol = (user?.rol || '').toLowerCase().trim();
  // WMS 2.0 · R2: gestión de usuarios solo para admin
  if (rol !== 'admin') {
    window.location.href = rol === 'gerente' ? 'dashboard.html' : (rol === 'lider' ? 'casos.html' : 'index.html');
    return;
  }

  if (user) {
    const nameEl = $('currentUserName');
    const locEl = $('currentUserLocation');
    const roleEl = $('currentUserRole');
    if (nameEl) nameEl.textContent = user.nombre || user.email || 'Usuario';
    if (locEl) locEl.textContent = user.ubicacion?.nombre || 'N/A';
    if (roleEl) roleEl.textContent = 'Administrador';
  }

  $('mainApp').style.display = 'block';
  await cargarCatalogos();
  await cargarUsuarios();
});
