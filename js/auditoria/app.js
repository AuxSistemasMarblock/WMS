/**
 * WMS · Auditoría — App (vanilla JS) (WMS 2.0 · A2)
 *
 * Visor de la bitácora central (audit_logs) — SOLO rol admin.
 * Sigue los patrones de js/dashboard/app.js (apiFetch con Bearer, guard de
 * rol, filtros instantáneos U1, paginación server-side).
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
  if (!v) return '—';
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
  if (res.status === 403) { throw new Error('Sin permisos para ver la bitácora'); }
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
  total: 0
};

// =================== BADGES ===================
function badgeTipoEvento(tipo) {
  switch (tipo) {
    case 'login_exitoso':
      return '<span class="tipo-badge ok">✅ Login exitoso</span>';
    case 'login_fallido':
      return '<span class="tipo-badge error">🔴 Login fallido</span>';
    case 'cambio':
      return '<span class="tipo-badge warn">✏️ Cambio</span>';
    case 'envio':
      return '<span class="tipo-badge sobrante">📤 Envío</span>';
    default:
      return `<span class="tipo-badge">${escapeHTML(String(tipo || '—'))}</span>`;
  }
}

function detalleHTML(ev) {
  const partes = [];
  if (ev.email_intento) partes.push(`email: ${escapeHTML(ev.email_intento)}`);
  const cambios = ev.cambios;
  if (cambios && typeof cambios === 'object') {
    const txt = escapeHTML(JSON.stringify(cambios));
    partes.push(`<span title="${txt}" style="cursor:help;">${txt.length > 90 ? txt.slice(0, 90) + '…' : txt}</span>`);
  }
  if (ev.registro_id != null) partes.push(`#${escapeHTML(String(ev.registro_id))}`);
  return partes.join(' · ') || '<span style="color:var(--muted);">—</span>';
}

function usuarioHTML(ev) {
  if (ev.usuario) {
    return `<div style="font-weight:600;">${escapeHTML(ev.usuario.nombre_completo || '—')}</div>
            <div style="font-size:11px; color:var(--muted);">${escapeHTML(ev.usuario.email || '')}</div>`;
  }
  return '<span style="color:var(--muted);">—</span>';
}

// =================== CARGA Y RENDER ===================
function buildParams() {
  const p = new URLSearchParams({ page: state.page, pageSize: PAGE_SIZE });
  const tipo = $('filtroTipo').value;
  const texto = $('filtroTexto').value.trim();
  const desde = $('filtroDesde').value;
  const hasta = $('filtroHasta').value;
  if (tipo) p.set('tipo', tipo);
  if (texto) p.set('texto', texto);
  if (desde) p.set('desde', desde);
  if (hasta) p.set('hasta', hasta);
  return p;
}

// Filtros instantáneos (U1): cualquier cambio reinicia en la página 1 y consulta.
function aplicarFiltros() {
  state.page = 1;
  cargarAuditoria();
}

async function cargarAuditoria() {
  const tbody = $('tbodyAuditoria');
  tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Cargando bitácora…</div></td></tr>';
  try {
    const data = await apiFetch('/api/auditoria?' + buildParams());
    state.total = data.total || 0;
    renderTabla(data.eventos || []);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Error: ${escapeHTML(e.message)}</div></td></tr>`;
  }
}

function renderTabla(eventos) {
  const tbody = $('tbodyAuditoria');
  $('countEventos').textContent = String(state.total);

  if (!eventos.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Sin eventos para los filtros seleccionados</div></td></tr>';
    renderPaginador();
    return;
  }

  tbody.innerHTML = eventos.map(ev => `
    <tr>
      <td style="white-space:nowrap;">${escapeHTML(fmtFechaHora(ev.created_at))}</td>
      <td>${badgeTipoEvento(ev.tipo_evento)}</td>
      <td><span style="font-family:'IBM Plex Mono',monospace; font-size:12px;">${escapeHTML(ev.accion || '—')}</span></td>
      <td>${usuarioHTML(ev)}</td>
      <td style="font-size:11.5px;">${detalleHTML(ev)}</td>
      <td style="font-family:'IBM Plex Mono',monospace; font-size:11px;">${escapeHTML(ev.ip_address || '—')}</td>
      <td style="font-size:11px; color:var(--muted); max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHTML(ev.user_agent || '')}">${escapeHTML(ev.user_agent || '—')}</td>
    </tr>
  `).join('');

  renderPaginador();
}

function renderPaginador() {
  const c = $('pagAuditoria');
  const totalPaginas = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  const startIdx = state.total === 0 ? 0 : (state.page - 1) * PAGE_SIZE + 1;
  const endIdx = Math.min(state.total, state.page * PAGE_SIZE);
  c.innerHTML = `
    <button class="btn btn-ghost" type="button" ${state.page <= 1 ? 'disabled' : ''} onclick="cambiarPagina(-1)">‹ Anterior</button>
    <span class="pagination-info">Página ${state.page} de ${totalPaginas} · Mostrando ${startIdx}-${endIdx} de ${state.total} (${PAGE_SIZE} por pág.)</span>
    <button class="btn btn-ghost" type="button" ${state.page >= totalPaginas ? 'disabled' : ''} onclick="cambiarPagina(1)">Siguiente ›</button>
  `;
}

function cambiarPagina(delta) {
  const totalPaginas = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  state.page = Math.min(Math.max(1, state.page + delta), totalPaginas);
  cargarAuditoria();
}

// =================== INIT ===================
document.addEventListener('DOMContentLoaded', async () => {
  const token = getToken();
  if (!token) { window.location.href = 'index.html'; return; }

  const user = getCurrentUser();
  const rol = (user?.rol || '').toLowerCase().trim();
  // WMS 2.0 · A2: la bitácora es solo para admin
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
  await cargarAuditoria();
});
