/**
 * WMS · Gestor de Casos — App (vanilla JS)
 *
 * Sigue los patrones de js/dashboard/app.js:
 *  - resolveBackendURL() + apiFetch() con Bearer y manejo de 401 -> logout.
 *  - helpers $, el, showToast, escapeHTML y render con template strings.
 *  - Guard de rol al DOMContentLoaded (jefe_almacen, gerente, admin).
 *
 * Vistas:
 *  - jefe_almacen: "Errores de mi almacén" (sync + discrepancias -> crear caso)
 *                  y "Mis casos" (seguimiento, reenviar, retirar).
 *  - gerente/admin: "Por aprobar" y "Historial" (aprobar/rechazar + timeline).
 *
 * API (T1/T2, ya mergeada): /api/casos/*
 */

// =================== CONFIG & HELPERS ===================
function resolveBackendURL() {
  const cfg = window.APP_CONFIG?.BACKEND_URL;
  if (cfg && !cfg.includes('localhost')) return cfg;
  return `http://${window.location.hostname}:3001`;
}
const BACKEND_URL = resolveBackendURL();

function $(id) { return document.getElementById(id); }

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') e.className = v;
    else if (k === 'onclick') e.onclick = v;
    else e.setAttribute(k, v);
  });
  children.forEach(c => {
    if (c == null) return;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return e;
}

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
  }, 3400);
}

function escapeHTML(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Mismo criterio de badge de tipo que js/dashboard/app.js
function badgeTipo(tipo) {
  switch (tipo) {
    case 'lote_cruzado':
      return '<span class="tipo-badge cruzado">🔀 Lote Cruzado</span>';
    case 'media_placa':
      return '<span class="tipo-badge media">🖨️ Media Placa (Etiquetado)</span>';
    case 'cantidad_sobrante':
      return '<span class="tipo-badge sobrante">📦 Placas de más</span>';
    case 'cantidad_faltante':
      return '<span class="tipo-badge error">🔻 Faltante físico</span>';
    case 'linea_faltante':
      return '<span class="tipo-badge error">📋 Línea omitida</span>';
    case 'sku_lote_no_esperado':
      return '<span class="tipo-badge warn">🔄 Huérfana pura</span>';
    case 'if_no_encontrada':
      return '<span class="tipo-badge error" style="font-weight:700;">🚨 Cancelada en ERP</span>';
    case 'ubicacion_incorrecta':
      return '<span class="tipo-badge warn">📍 Ubicación</span>';
    default:
      return `<span class="tipo-badge">${escapeHTML(String(tipo || '').replace(/_/g, ' '))}</span>`;
  }
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
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// =================== ESTADO ===================
const state = {
  rol: '',
  user: null,
  tab: '',
  discrepancias: [],
  discSeleccion: new Set(),
  casos: [],
  tipos: [],
  detalleActual: null,
  revisionMode: null,
  filtros: {
    disc: { desde: '', hasta: '', tipo: '', estado: '', if_tranid: '' },
    caso: { estado: '', desde: '', hasta: '' },
    rev: { estado: '', sucursal: '', desde: '', hasta: '' }
  }
};

// =================== CONSTANTES ===================
const ROLES_PERMITIDOS = ['jefe_almacen', 'gerente', 'admin'];
const MIN_OTRO = 15;

const TIPOS_DISCREPANCIA = [
  { value: 'lote_cruzado', label: 'Lotes Cruzados' },
  { value: 'media_placa', label: 'Error de Etiquetado (Media Placa)' },
  { value: 'cantidad_sobrante', label: 'Placas de más' },
  { value: 'sku_lote_no_esperado', label: 'Huérfana pura' },
  { value: 'cantidad_faltante', label: 'Faltante físico' },
  { value: 'linea_faltante', label: 'Línea omitida' },
  { value: 'if_no_encontrada', label: 'Cancelada en ERP' },
  { value: 'ubicacion_incorrecta', label: 'Ubicación incorrecta' }
];

const ESTADOS_DISCREPANCIA = [
  { value: 'abierta', label: 'Abierta' },
  { value: 'en_revision', label: 'En revisión' },
  { value: 'justificada', label: 'Justificada' }
];

const EVENTOS_LABEL = {
  caso_creado: 'Caso creado',
  justificacion_enviada: 'Justificación enviada',
  justificacion_reenviada: 'Justificación reenviada',
  aprobado: 'Caso aprobado',
  rechazado: 'Caso rechazado',
  discrepancia_retirada: 'Discrepancia retirada',
  comentario: 'Comentario'
};

// =================== ROL ===================
function normalizarRol(raw) {
  let rol = String(raw || '').toLowerCase().trim();
  if (rol === 'administrador') rol = 'admin';
  if (rol.includes('gerente')) rol = 'gerente';
  if (rol.includes('jefe')) rol = 'jefe_almacen';
  if (rol.includes('aux')) rol = 'aux_almacen';
  return rol;
}
function esGerenteOAdmin() { return state.rol === 'gerente' || state.rol === 'admin'; }
function esAdmin() { return state.rol === 'admin'; }
function getRoleLabel(rol) {
  const roles = {
    'aux_almacen': 'Aux. Almacén',
    'jefe_almacen': 'Jefe de Almacén',
    'gerente': 'Gerente',
    'cliente': 'Cliente',
    'admin': 'Administrador'
  };
  return roles[rol] || rol;
}

// =================== FORMATO ===================
function fmtFecha(v) {
  if (!v) return '—';
  const s = String(v);
  const d = s.length >= 10 ? s.slice(0, 10) : s;
  const partes = d.split('-');
  if (partes.length === 3 && partes[0].length === 4) return `${partes[2]}/${partes[1]}/${partes[0]}`;
  return s;
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
function fmtNum(v) { return v === null || v === undefined || v === '' ? '—' : String(v); }

function nombreTipoJustificacion(caso) {
  const t = caso && caso.tipo_justificacion;
  if (!t) return '—';
  return t.nombre || t.clave || '—';
}
function nombreTipoPorId(id) {
  const t = state.tipos.find(x => String(x.id) === String(id));
  return t ? (t.nombre || t.clave) : (id != null ? `Tipo #${id}` : '—');
}

function estadoCasoBadge(estado) {
  switch (estado) {
    case 'pendiente_aprobacion':
      return '<span class="caso-badge pendiente">🟡 Pendiente</span>';
    case 'aprobado':
      return '<span class="caso-badge aprobado">🟢 Aprobado</span>';
    case 'rechazado':
      return '<span class="caso-badge rechazado">🔴 Rechazado</span>';
    default:
      return `<span class="caso-badge">${escapeHTML(String(estado || '—'))}</span>`;
  }
}

function estadoDiscPill(estado) {
  const label = (ESTADOS_DISCREPANCIA.find(e => e.value === estado) || {}).label || estado || '—';
  return `<span class="estado-pill ${escapeHTML(estado || '')}">${escapeHTML(label)}</span>`;
}

// =================== MODALES ===================
function abrirModal(id) { const m = $(id); if (m) m.classList.add('active'); }
function cerrarModal(id) { const m = $(id); if (m) m.classList.remove('active'); }

// =================== TABS ===================
function tabsPorRol() {
  if (esGerenteOAdmin()) {
    return [
      { id: 'por-aprobar', label: 'Por aprobar', count: 'tabCountPend' },
      { id: 'historial', label: 'Historial', count: 'tabCountHist' }
    ];
  }
  return [
    { id: 'errores', label: 'Errores de mi almacén', count: null },
    { id: 'mis-casos', label: 'Mis casos', count: 'tabCountCasos' }
  ];
}

function renderTabs() {
  const cont = $('casosTabs');
  if (!cont) return;
  const tabs = tabsPorRol();
  if (!tabs.some(t => t.id === state.tab)) state.tab = tabs[0].id;
  cont.innerHTML = tabs.map(t => {
    const active = t.id === state.tab ? ' active' : '';
    const badge = t.count ? `<span class="tab-count" id="${t.count}">0</span>` : '';
    return `<button type="button" class="casos-tab${active}" onclick="switchTab('${t.id}')">${escapeHTML(t.label)}${badge}</button>`;
  }).join('');
}

function actualizarTabCount(id, n) { const e = $(id); if (e) e.textContent = String(n); }

function switchTab(tab) {
  state.tab = tab;
  renderTabs();
  renderMain();
}

// =================== RENDER PRINCIPAL ===================
function renderMain() {
  if (state.tab === 'errores') {
    renderErroresView();
    cargarDiscrepancias();
  } else if (state.tab === 'mis-casos') {
    renderMisCasosView();
    cargarCasosJefe();
  } else if (state.tab === 'por-aprobar') {
    renderRevisionView();
    cargarCasosRevision();
  } else if (state.tab === 'historial') {
    renderRevisionView();
    cargarCasosRevision();
  }
}

// =================== TIPOS DE JUSTIFICACIÓN ===================
async function cargarTipos() {
  if (state.tipos.length) return state.tipos;
  const data = await apiFetch('/api/casos/tipos-justificacion');
  state.tipos = data.tipos_justificacion || [];
  return state.tipos;
}

function renderTipoOptions(select, selectedId) {
  if (!select) return;
  select.innerHTML = '';
  select.appendChild(el('option', { value: '' }, '— Selecciona un tipo —'));
  state.tipos.forEach(t => {
    const opt = el('option', { value: t.id }, t.nombre || t.clave || ('Tipo #' + t.id));
    if (String(t.id) === String(selectedId)) opt.selected = true;
    select.appendChild(opt);
  });
}

function tipoPorId(id) {
  return state.tipos.find(t => String(t.id) === String(id)) || null;
}

// =================== VISTA JEFE: ERRORES ===================
function renderErroresView() {
  const f = state.filtros.disc;
  const tipoOpts = TIPOS_DISCREPANCIA.map(t =>
    `<option value="${t.value}"${f.tipo === t.value ? ' selected' : ''}>${escapeHTML(t.label)}</option>`).join('');
  const estadoOpts = ESTADOS_DISCREPANCIA.map(e =>
    `<option value="${e.value}"${f.estado === e.value ? ' selected' : ''}>${escapeHTML(e.label)}</option>`).join('');

  $('viewContent').innerHTML = `
    <section class="filters-card">
      <div class="filters-row">
        <div class="filter-group">
          <label for="fDiscDesde">Fecha desde</label>
          <input type="date" id="fDiscDesde" class="filter-select" value="${escapeHTML(f.desde)}" />
        </div>
        <div class="filter-group">
          <label for="fDiscHasta">Fecha hasta</label>
          <input type="date" id="fDiscHasta" class="filter-select" value="${escapeHTML(f.hasta)}" />
        </div>
        <div class="filter-group">
          <label for="fDiscTipo">Tipo</label>
          <select id="fDiscTipo" class="filter-select">
            <option value="">Todos los tipos</option>
            ${tipoOpts}
          </select>
        </div>
        <div class="filter-group">
          <label for="fDiscEstado">Estado</label>
          <select id="fDiscEstado" class="filter-select">
            <option value="">Todos los estados</option>
            ${estadoOpts}
          </select>
        </div>
        <div class="filter-group">
          <label for="fDiscIf">IF</label>
          <input type="text" id="fDiscIf" class="filter-select" placeholder="IF-1234" value="${escapeHTML(f.if_tranid)}" />
        </div>
        <button class="btn btn-primary" type="button" onclick="cargarDiscrepancias()">Aplicar</button>
      </div>
    </section>

    <section class="table-card">
      <div class="table-header">
        <div class="table-title">
          🔴 Errores de mi almacén
          <span class="count-badge text-error" id="countDisc">0</span>
        </div>
        <div class="table-actions">
          <span class="cell-muted" id="syncInfo"></span>
          <button class="btn btn-primary" type="button" id="btnJustificar" onclick="abrirJustificar()" disabled>
            Justificar selección (<span id="selCount">0</span>)
          </button>
        </div>
      </div>
      <div class="table-wrap">
        <table class="casos-table">
          <thead>
            <tr>
              <th style="width:34px;" class="cell-center">
                <input type="checkbox" title="Seleccionar todas las abiertas" onchange="toggleTodasDisc(this.checked)" />
              </th>
              <th>IF</th>
              <th>Fecha</th>
              <th>Sucursal</th>
              <th>SKU</th>
              <th>Lote</th>
              <th>Tipo</th>
              <th class="cell-num">Esperadas</th>
              <th class="cell-num">Escaneadas</th>
              <th class="cell-num">Dif.</th>
              <th class="cell-center">Estado</th>
            </tr>
          </thead>
          <tbody id="tbodyDisc">
            <tr><td colspan="11"><div class="empty-state">Cargando errores…</div></td></tr>
          </tbody>
        </table>
      </div>
    </section>
  `;
  actualizarBotonJustificar();
}

function leerFiltrosDisc() {
  const val = id => { const e = $(id); return e ? e.value.trim() : ''; };
  state.filtros.disc = {
    desde: val('fDiscDesde'),
    hasta: val('fDiscHasta'),
    tipo: val('fDiscTipo'),
    estado: val('fDiscEstado'),
    if_tranid: val('fDiscIf')
  };
  return state.filtros.disc;
}

async function cargarDiscrepancias() {
  const tbody = $('tbodyDisc');
  if (!tbody) return;
  const f = leerFiltrosDisc();
  const info = $('syncInfo');
  if (info) info.textContent = 'Sincronizando…';
  tbody.innerHTML = '<tr><td colspan="11"><div class="empty-state">Sincronizando y cargando errores…</div></td></tr>';

  try {
    const syncBody = {};
    if (f.desde) syncBody.desde = f.desde;
    if (f.hasta) syncBody.hasta = f.hasta;
    try {
      const sync = await apiFetch('/api/casos/sync', { method: 'POST', body: JSON.stringify(syncBody) });
      if (info) info.textContent = `Sync: ${sync.sincronizadas ?? 0} huellas · ${fmtFechaHora(sync.generado_en)}`;
    } catch (eSync) {
      if (info) info.textContent = 'Sync no disponible';
      showToast('Aviso: no se pudo sincronizar (' + eSync.message + ')', 'error');
    }

    const p = new URLSearchParams();
    if (f.desde) p.set('desde', f.desde);
    if (f.hasta) p.set('hasta', f.hasta);
    if (f.tipo) p.set('tipo', f.tipo);
    if (f.estado) p.set('estado', f.estado);
    if (f.if_tranid) p.set('if_tranid', f.if_tranid);

    const data = await apiFetch('/api/casos/discrepancias?' + p.toString());
    state.discrepancias = data.discrepancias || [];
    state.discSeleccion.clear();
    renderDiscTable();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state">Error: ${escapeHTML(e.message)}</div></td></tr>`;
  }
}

function renderDiscTable() {
  const tbody = $('tbodyDisc');
  if (!tbody) return;
  const rows = state.discrepancias;
  const count = $('countDisc');
  if (count) count.textContent = String(rows.length);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="11"><div class="empty-state">No hay errores para los filtros seleccionados.</div></td></tr>';
    actualizarBotonJustificar();
    return;
  }

  tbody.innerHTML = rows.map(d => {
    const abierta = d.estado === 'abierta';
    const checked = state.discSeleccion.has(Number(d.id)) ? ' checked' : '';
    return `<tr>
      <td class="cell-center">
        <input type="checkbox" data-disc-id="${d.id}" ${abierta ? '' : 'disabled'}${checked}
          onchange="onDiscCheck(this)" title="${abierta ? 'Seleccionar' : 'Solo errores abiertos'}">
      </td>
      <td class="cell-tranid">${escapeHTML(d.if_tranid || '—')}</td>
      <td>${escapeHTML(fmtFecha(d.if_fecha))}</td>
      <td>${escapeHTML(d.sucursal || '—')}</td>
      <td>${escapeHTML(d.sku || '—')}</td>
      <td>${escapeHTML(d.lote || d.id_lote || '—')}</td>
      <td>${badgeTipo(d.tipo)}</td>
      <td class="cell-num">${escapeHTML(fmtNum(d.placas_esperadas))}</td>
      <td class="cell-num">${escapeHTML(fmtNum(d.placas_escaneadas))}</td>
      <td class="cell-num">${escapeHTML(fmtNum(d.diferencia))}</td>
      <td class="cell-center">${estadoDiscPill(d.estado)}</td>
    </tr>`;
  }).join('');

  actualizarBotonJustificar();
}

function onDiscCheck(input) {
  const id = Number(input.getAttribute('data-disc-id'));
  if (input.checked) state.discSeleccion.add(id);
  else state.discSeleccion.delete(id);
  actualizarBotonJustificar();
}

function toggleTodasDisc(checked) {
  if (checked) {
    state.discrepancias.forEach(d => { if (d.estado === 'abierta') state.discSeleccion.add(Number(d.id)); });
  } else {
    state.discSeleccion.clear();
  }
  document.querySelectorAll('#tbodyDisc input[data-disc-id]').forEach(cb => {
    cb.checked = state.discSeleccion.has(Number(cb.getAttribute('data-disc-id')));
  });
  actualizarBotonJustificar();
}

function actualizarBotonJustificar() {
  const btn = $('btnJustificar');
  const n = state.discSeleccion.size;
  const sel = $('selCount');
  if (sel) sel.textContent = String(n);
  if (btn) btn.disabled = n < 1;
}

async function abrirJustificar() {
  if (state.discSeleccion.size < 1) return;
  try {
    await cargarTipos();
  } catch (e) {
    showToast('Error cargando tipos de justificación: ' + e.message, 'error');
    return;
  }
  renderTipoOptions($('justTipo'), '');
  $('justTexto').value = '';
  $('justError').textContent = '';
  renderJustResumen();
  abrirModal('justificarModal');
}

function renderJustResumen() {
  const cont = $('justResumen');
  if (!cont) return;
  const sel = state.discrepancias.filter(d => state.discSeleccion.has(Number(d.id)));
  cont.innerHTML = sel.map(d => `
    <div class="resumen-item">
      <span class="resumen-if">${escapeHTML(d.if_tranid || '—')}</span>
      ${badgeTipo(d.tipo)}
      <span class="cell-muted">${escapeHTML(d.sku || '—')} · ${escapeHTML(d.lote || d.id_lote || '—')}</span>
    </div>`).join('') || '<div class="empty-state">Sin errores seleccionados</div>';
}

async function enviarJustificacion() {
  const errEl = $('justError');
  errEl.textContent = '';
  const tipoId = $('justTipo').value;
  const texto = $('justTexto').value.trim();
  const tipo = tipoPorId(tipoId);

  if (!tipoId || !tipo) { errEl.textContent = 'Selecciona un tipo de justificación.'; return; }
  if (!texto) { errEl.textContent = 'La justificación es obligatoria.'; return; }
  if (tipo.clave === 'otro' && texto.length < MIN_OTRO) {
    errEl.textContent = `Para "Otro" la justificación debe tener al menos ${MIN_OTRO} caracteres.`;
    return;
  }
  if (state.discSeleccion.size < 1) { errEl.textContent = 'Selecciona al menos un error.'; return; }

  const btn = $('btnEnviarJust');
  btn.disabled = true;
  try {
    const data = await apiFetch('/api/casos', {
      method: 'POST',
      body: JSON.stringify({
        discrepancia_ids: [...state.discSeleccion],
        tipo_justificacion_id: Number(tipoId),
        justificacion: texto
      })
    });
    showToast(`Caso ${data.caso?.folio || ''} creado y enviado a revisión`, 'success');
    cerrarModal('justificarModal');
    state.discSeleccion.clear();
    await cargarDiscrepancias();
  } catch (e) {
    errEl.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// =================== VISTA JEFE: MIS CASOS ===================
function renderMisCasosView() {
  const f = state.filtros.caso;
  $('viewContent').innerHTML = `
    <section class="filters-card">
      <div class="filters-row">
        <div class="filter-group">
          <label for="fCasoEstado">Estado</label>
          <select id="fCasoEstado" class="filter-select">
            <option value="">Todos</option>
            <option value="pendiente_aprobacion"${f.estado === 'pendiente_aprobacion' ? ' selected' : ''}>Pendiente</option>
            <option value="aprobado"${f.estado === 'aprobado' ? ' selected' : ''}>Aprobado</option>
            <option value="rechazado"${f.estado === 'rechazado' ? ' selected' : ''}>Rechazado</option>
          </select>
        </div>
        <div class="filter-group">
          <label for="fCasoDesde">Desde</label>
          <input type="date" id="fCasoDesde" class="filter-select" value="${escapeHTML(f.desde)}" />
        </div>
        <div class="filter-group">
          <label for="fCasoHasta">Hasta</label>
          <input type="date" id="fCasoHasta" class="filter-select" value="${escapeHTML(f.hasta)}" />
        </div>
        <button class="btn btn-primary" type="button" onclick="cargarCasosJefe()">Aplicar</button>
      </div>
    </section>

    <section class="table-card">
      <div class="table-header">
        <div class="table-title">
          📂 Mis casos
          <span class="count-badge" id="countCasos">0</span>
        </div>
      </div>
      <div class="table-wrap">
        <table class="casos-table">
          <thead>
            <tr>
              <th>Folio</th>
              <th>Estado</th>
              <th class="cell-num"># Errores</th>
              <th>Tipo</th>
              <th>Sucursal</th>
              <th>Fecha</th>
              <th class="cell-center">Acción</th>
            </tr>
          </thead>
          <tbody id="tbodyCasos">
            <tr><td colspan="7"><div class="empty-state">Cargando casos…</div></td></tr>
          </tbody>
        </table>
      </div>
    </section>
  `;
}

async function cargarCasosJefe() {
  const tbody = $('tbodyCasos');
  if (!tbody) return;
  state.filtros.caso = {
    estado: ($('fCasoEstado') || {}).value || '',
    desde: ($('fCasoDesde') || {}).value || '',
    hasta: ($('fCasoHasta') || {}).value || ''
  };
  const f = state.filtros.caso;
  const p = new URLSearchParams();
  if (f.estado) p.set('estado', f.estado);
  if (f.desde) p.set('desde', f.desde);
  if (f.hasta) p.set('hasta', f.hasta);

  try {
    const data = await apiFetch('/api/casos?' + p.toString());
    state.casos = data.casos || [];
    renderCasosTable('tbodyCasos', state.casos);
    const count = $('countCasos'); if (count) count.textContent = String(state.casos.length);
    actualizarTabCount('tabCountCasos', state.casos.length);
    if (!f.estado) {
      const pend = state.casos.filter(c => c.estado === 'pendiente_aprobacion').length;
      actualizarTabCount('tabCountCasos', pend);
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Error: ${escapeHTML(e.message)}</div></td></tr>`;
  }
}

function renderCasosTable(tbodyId, casos) {
  const tbody = $(tbodyId);
  if (!tbody) return;
  if (!casos.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">No hay casos.</div></td></tr>';
    return;
  }
  tbody.innerHTML = casos.map(c => `
    <tr>
      <td class="cell-tranid">${escapeHTML(c.folio || '—')}</td>
      <td>${estadoCasoBadge(c.estado)}</td>
      <td class="cell-num">${escapeHTML(fmtNum(c.total_discrepancias ?? 0))}</td>
      <td>${escapeHTML(nombreTipoJustificacion(c))}</td>
      <td>${escapeHTML(c.sucursal || '—')}</td>
      <td>${escapeHTML(fmtFechaHora(c.created_at))}</td>
      <td class="cell-center"><button class="btn-detalle" type="button" onclick="abrirDetalleCaso(${Number(c.id)})">Ver detalle</button></td>
    </tr>
  `).join('');
}

// =================== VISTA GERENTE / ADMIN ===================
function renderRevisionView() {
  const esPorAprobar = state.tab === 'por-aprobar';
  const f = state.filtros.rev;
  $('viewContent').innerHTML = `
    <section class="filters-card">
      <div class="filters-row">
        <div class="filter-group">
          <label for="fRevSucursal">Sucursal</label>
          <input type="text" id="fRevSucursal" class="filter-select" placeholder="Todas" value="${escapeHTML(f.sucursal)}" />
        </div>
        <div class="filter-group">
          <label for="fRevDesde">Desde</label>
          <input type="date" id="fRevDesde" class="filter-select" value="${escapeHTML(f.desde)}" />
        </div>
        <div class="filter-group">
          <label for="fRevHasta">Hasta</label>
          <input type="date" id="fRevHasta" class="filter-select" value="${escapeHTML(f.hasta)}" />
        </div>
        ${esPorAprobar ? '' : `
        <div class="filter-group">
          <label for="fHistEstado">Estado</label>
          <select id="fHistEstado" class="filter-select">
            <option value="">Todos</option>
            <option value="pendiente_aprobacion"${f.estado === 'pendiente_aprobacion' ? ' selected' : ''}>Pendiente</option>
            <option value="aprobado"${f.estado === 'aprobado' ? ' selected' : ''}>Aprobado</option>
            <option value="rechazado"${f.estado === 'rechazado' ? ' selected' : ''}>Rechazado</option>
          </select>
        </div>`}
        <button class="btn btn-primary" type="button" onclick="cargarCasosRevision()">Aplicar</button>
      </div>
    </section>

    <section class="table-card">
      <div class="table-header">
        <div class="table-title">
          ${esPorAprobar ? '⏳ Casos por aprobar' : '🗂️ Historial de casos'}
          <span class="count-badge" id="countRev">0</span>
        </div>
      </div>
      <div class="table-wrap">
        <table class="casos-table">
          <thead>
            <tr>
              <th>Folio</th>
              <th>Estado</th>
              <th>Sucursal</th>
              <th class="cell-num"># Errores</th>
              <th>Tipo</th>
              <th>Solicitante</th>
              <th>Enviado</th>
              <th class="cell-center">Acción</th>
            </tr>
          </thead>
          <tbody id="tbodyRev">
            <tr><td colspan="8"><div class="empty-state">Cargando casos…</div></td></tr>
          </tbody>
        </table>
      </div>
    </section>
  `;
}

async function cargarCasosRevision() {
  const tbody = $('tbodyRev');
  if (!tbody) return;
  const f = state.filtros.rev;
  f.sucursal = ($('fRevSucursal') || {}).value || '';
  f.desde = ($('fRevDesde') || {}).value || '';
  f.hasta = ($('fRevHasta') || {}).value || '';
  f.estado = state.tab === 'por-aprobar'
    ? 'pendiente_aprobacion'
    : ((($('fHistEstado') || {}).value) || '');

  const p = new URLSearchParams();
  p.set('estado', f.estado);
  if (f.sucursal) p.set('sucursal', f.sucursal.trim());
  if (f.desde) p.set('desde', f.desde);
  if (f.hasta) p.set('hasta', f.hasta);

  try {
    const data = await apiFetch('/api/casos?' + p.toString());
    state.casos = data.casos || [];
    renderRevisionTable(state.casos);
    const count = $('countRev'); if (count) count.textContent = String(state.casos.length);
    if (state.tab === 'por-aprobar') actualizarTabCount('tabCountPend', state.casos.length);
    else actualizarTabCount('tabCountHist', state.casos.length);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">Error: ${escapeHTML(e.message)}</div></td></tr>`;
  }
}

function renderRevisionTable(casos) {
  const tbody = $('tbodyRev');
  if (!tbody) return;
  if (!casos.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">No hay casos con estos filtros.</div></td></tr>';
    return;
  }
  tbody.innerHTML = casos.map(c => `
    <tr>
      <td class="cell-tranid">${escapeHTML(c.folio || '—')}</td>
      <td>${estadoCasoBadge(c.estado)}</td>
      <td>${escapeHTML(c.sucursal || '—')}</td>
      <td class="cell-num">${escapeHTML(fmtNum(c.total_discrepancias ?? 0))}</td>
      <td>${escapeHTML(nombreTipoJustificacion(c))}</td>
      <td>${escapeHTML(c.creador?.nombre_completo || (c.creado_por ? 'Usuario #' + c.creado_por : '—'))}</td>
      <td>${escapeHTML(fmtFechaHora(c.enviado_at || c.created_at))}</td>
      <td class="cell-center"><button class="btn-detalle" type="button" onclick="abrirDetalleCaso(${Number(c.id)})">${c.estado === 'pendiente_aprobacion' ? 'Revisar' : 'Ver detalle'}</button></td>
    </tr>
  `).join('');
}

// =================== DETALLE DE CASO ===================
async function abrirDetalleCaso(id) {
  abrirModal('detalleCasoModal');
  $('detalleCasoTitle').textContent = 'Caso #' + id;
  $('detalleCasoBody').innerHTML = '<div class="empty-state"><span class="loading-inline">Cargando detalle…</span></div>';
  try {
    const data = await apiFetch('/api/casos/' + encodeURIComponent(id));
    state.detalleActual = data;
    renderDetalleCaso(data);
  } catch (e) {
    $('detalleCasoBody').innerHTML = `<div class="empty-state">Error: ${escapeHTML(e.message)}</div>`;
  }
}

function renderDetalleCaso(data) {
  const c = data.caso || {};
  const disc = data.discrepancias || [];
  const eventos = data.eventos || [];
  $('detalleCasoTitle').textContent = 'Caso ' + (c.folio || ('#' + c.id));

  const solicitante = c.creador?.nombre_completo || c.creador?.email || (c.creado_por ? 'Usuario #' + c.creado_por : '—');
  const revisor = c.revisor?.nombre_completo || c.revisor?.email || (c.revisado_por ? 'Usuario #' + c.revisado_por : '—');
  const puedeRevisar = esGerenteOAdmin() && c.estado === 'pendiente_aprobacion';
  const esCreadorOAdmin = esAdmin() || (state.user && c.creado_por != null && String(c.creado_por) === String(state.user.id));
  const puedeRetirar = esCreadorOAdmin && c.estado === 'rechazado';
  const puedeReenviar = esCreadorOAdmin && c.estado === 'rechazado';

  const grupos = agruparPorIF(disc);

  const acciones = [];
  if (puedeRevisar) {
    acciones.push(`<button class="btn btn-primary" type="button" onclick="abrirRevision('aprobar')">✅ Aprobar</button>`);
    acciones.push(`<button class="btn btn-danger" type="button" onclick="abrirRevision('rechazar')">⛔ Rechazar</button>`);
  }
  if (puedeReenviar) {
    acciones.push(`<button class="btn btn-secondary" type="button" onclick="abrirReenviar()">✏️ Editar y reenviar</button>`);
  }
  if (puedeRetirar) {
    acciones.push(`<span class="spacer"></span><button class="btn btn-ghost" type="button" onclick="retirarSeleccionados()">↩️ Retirar errores seleccionados</button>`);
  }

  $('detalleCasoBody').innerHTML = `
    <div class="caso-resumen">
      <div><span class="label">Estado</span><span class="val">${estadoCasoBadge(c.estado)}</span></div>
      <div><span class="label">Sucursal / Ubicación</span><span class="val">${escapeHTML(c.sucursal || '—')}</span></div>
      <div><span class="label">Tipo de justificación</span><span class="val">${escapeHTML(nombreTipoJustificacion(c))}</span></div>
      <div><span class="label">Solicitante</span><span class="val">${escapeHTML(solicitante)}</span></div>
      <div><span class="label">Enviado</span><span class="val">${escapeHTML(fmtFechaHora(c.enviado_at || c.created_at))}</span></div>
      <div><span class="label"># Errores</span><span class="val">${escapeHTML(String(disc.length))}</span></div>
      ${c.revisado_at ? `<div><span class="label">Revisado por</span><span class="val">${escapeHTML(revisor)}</span></div>
      <div><span class="label">Revisado</span><span class="val">${escapeHTML(fmtFechaHora(c.revisado_at))}</span></div>` : ''}
    </div>

    <div class="form-field">
      <label>Justificación</label>
      <div class="timeline-comment" style="margin-top:0;">${escapeHTML(c.justificacion || '—')}</div>
    </div>

    ${c.comentario_revision ? `
    <div class="form-field">
      <label>Comentario de revisión</label>
      <div class="timeline-comment" style="margin-top:0;">${escapeHTML(c.comentario_revision)}</div>
    </div>` : ''}

    <div class="caso-subtitle">Errores del caso (${disc.length})</div>
    ${disc.length ? grupos.map(g => `
      <div class="disc-group">
        <div class="disc-group-head">
          <span class="disc-if">${escapeHTML(g.if_tranid || '—')}</span>
          <span class="cell-muted">${escapeHTML(g.sucursal || '—')}</span>
          <span class="cell-muted">${escapeHTML(fmtFecha(g.if_fecha))}</span>
        </div>
        <div class="disc-group-body">
          ${g.items.map(d => `
            <div class="disc-row">
              ${puedeRetirar ? `<input type="checkbox" data-retirar-id="${d.id}" title="Seleccionar para retirar">` : ''}
              ${badgeTipo(d.tipo)}
              <span class="disc-sku">${escapeHTML(d.sku || '—')}</span>
              <span class="disc-meta">Lote: ${escapeHTML(d.lote || d.id_lote || '—')}</span>
              <span class="disc-meta">Esp: ${escapeHTML(fmtNum(d.placas_esperadas))} · Esc: ${escapeHTML(fmtNum(d.placas_escaneadas))} · Dif: ${escapeHTML(fmtNum(d.diferencia))}</span>
              ${estadoDiscPill(d.estado)}
            </div>`).join('')}
        </div>
      </div>`).join('') : '<div class="empty-state">Sin discrepancias asociadas.</div>'}

    <div class="caso-subtitle">Actividad del caso</div>
    ${renderTimeline(eventos)}

    <div class="form-field" style="margin-top:14px;">
      <label for="detalleComentario">Agregar comentario</label>
      <div class="comentario-box">
        <textarea id="detalleComentario" placeholder="Escribe un comentario para el caso..."></textarea>
        <button class="btn btn-secondary" type="button" onclick="enviarComentario()">Comentar</button>
      </div>
    </div>

    ${acciones.length ? `<div class="detalle-actions">${acciones.join('')}</div>` : ''}
  `;
}

function agruparPorIF(disc) {
  const map = new Map();
  (disc || []).forEach(d => {
    const key = d.if_tranid || '—';
    if (!map.has(key)) map.set(key, { if_tranid: d.if_tranid, sucursal: d.sucursal, if_fecha: d.if_fecha, items: [] });
    map.get(key).items.push(d);
  });
  return [...map.values()];
}

function renderTimeline(eventos) {
  if (!eventos || !eventos.length) return '<div class="empty-state">Sin eventos registrados.</div>';
  return `<ul class="timeline">
    ${eventos.map(ev => {
      const label = EVENTOS_LABEL[ev.evento] || String(ev.evento || '').replace(/_/g, ' ');
      const actor = ev.actor?.nombre_completo || ev.actor?.email || (ev.actor_id ? 'Usuario #' + ev.actor_id : 'Sistema');
      const comentario = ev.datos && (ev.datos.comentario || ev.datos.justificacion)
        ? `<div class="timeline-comment">${escapeHTML(ev.datos.comentario || ev.datos.justificacion)}</div>` : '';
      return `<li class="timeline-item evento-${escapeHTML(ev.evento || '')}">
        <div class="timeline-head">
          <span class="timeline-title">${escapeHTML(label)}</span>
          <span class="timeline-date">${escapeHTML(fmtFechaHora(ev.created_at))}</span>
        </div>
        <div class="timeline-actor">${escapeHTML(actor)}</div>
        ${comentario}
      </li>`;
    }).join('')}
  </ul>`;
}

// =================== REVISIÓN (APROBAR / RECHAZAR) ===================
function abrirRevision(mode) {
  const c = state.detalleActual?.caso;
  if (!c) return;
  state.revisionMode = mode;
  const esRechazo = mode === 'rechazar';
  $('revTitle').textContent = esRechazo ? '⛔ Rechazar caso' : '✅ Aprobar caso';
  $('revCasoInfo').innerHTML = `Caso <strong>${escapeHTML(c.folio || '')}</strong> · ${escapeHTML(c.sucursal || '—')} · ${escapeHTML(nombreTipoJustificacion(c))}`;
  $('revComentarioLabel').innerHTML = esRechazo ? 'Comentario <span class="req">*</span>' : 'Comentario (opcional)';
  $('revHint').textContent = esRechazo
    ? 'El comentario es obligatorio para rechazar el caso.'
    : 'Puedes adjuntar un comentario para el solicitante.';
  $('revComentario').value = '';
  $('revError').textContent = '';
  const btn = $('btnRevConfirmar');
  btn.className = esRechazo ? 'btn btn-danger' : 'btn btn-primary';
  btn.textContent = esRechazo ? 'Rechazar' : 'Aprobar';
  abrirModal('revisionModal');
}

async function enviarRevision() {
  const c = state.detalleActual?.caso;
  if (!c) return;
  const errEl = $('revError');
  errEl.textContent = '';
  const comentario = $('revComentario').value.trim();
  const mode = state.revisionMode;

  if (mode === 'rechazar' && !comentario) {
    errEl.textContent = 'El comentario es obligatorio para rechazar.';
    return;
  }

  const btn = $('btnRevConfirmar');
  btn.disabled = true;
  try {
    await apiFetch(`/api/casos/${encodeURIComponent(c.id)}/${mode}`, {
      method: 'POST',
      body: JSON.stringify({ comentario: comentario || undefined })
    });
    showToast(mode === 'aprobar' ? 'Caso aprobado' : 'Caso rechazado', 'success');
    cerrarModal('revisionModal');
    await abrirDetalleCaso(c.id);
    if (state.tab === 'por-aprobar') cargarCasosRevision();
  } catch (e) {
    errEl.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// =================== REENVIAR ===================
async function abrirReenviar() {
  const c = state.detalleActual?.caso;
  if (!c) return;
  try {
    await cargarTipos();
  } catch (e) {
    showToast('Error cargando tipos de justificación: ' + e.message, 'error');
    return;
  }
  renderTipoOptions($('reenvTipo'), c.tipo_justificacion_id);
  $('reenvTexto').value = c.justificacion || '';
  $('reenvError').textContent = '';
  abrirModal('reenviarModal');
}

async function enviarReenvio() {
  const c = state.detalleActual?.caso;
  if (!c) return;
  const errEl = $('reenvError');
  errEl.textContent = '';
  const tipoId = $('reenvTipo').value;
  const texto = $('reenvTexto').value.trim();
  const tipo = tipoPorId(tipoId);

  if (!tipoId || !tipo) { errEl.textContent = 'Selecciona un tipo de justificación.'; return; }
  if (!texto) { errEl.textContent = 'La justificación es obligatoria.'; return; }
  if (tipo.clave === 'otro' && texto.length < MIN_OTRO) {
    errEl.textContent = `Para "Otro" la justificación debe tener al menos ${MIN_OTRO} caracteres.`;
    return;
  }

  try {
    await apiFetch(`/api/casos/${encodeURIComponent(c.id)}/reenviar`, {
      method: 'PUT',
      body: JSON.stringify({ tipo_justificacion_id: Number(tipoId), justificacion: texto })
    });
    showToast('Caso reenviado a revisión', 'success');
    cerrarModal('reenviarModal');
    await abrirDetalleCaso(c.id);
    if (state.tab === 'mis-casos') cargarCasosJefe();
  } catch (e) {
    errEl.textContent = 'Error: ' + e.message;
  }
}

// =================== RETIRAR ERRORES ===================
async function retirarSeleccionados() {
  const c = state.detalleActual?.caso;
  if (!c) return;
  const ids = [...document.querySelectorAll('#detalleCasoBody input[data-retirar-id]:checked')]
    .map(cb => Number(cb.getAttribute('data-retirar-id')));
  if (!ids.length) { showToast('Selecciona al menos un error para retirar', 'error'); return; }
  if (!window.confirm(`¿Retirar ${ids.length} error(es) del caso? Volverán a estado abierto.`)) return;

  try {
    const data = await apiFetch(`/api/casos/${encodeURIComponent(c.id)}/retirar`, {
      method: 'POST',
      body: JSON.stringify({ discrepancia_ids: ids })
    });
    showToast(`${data.retiradas ?? ids.length} error(es) retirado(s)`, 'success');
    await abrirDetalleCaso(c.id);
    if (state.tab === 'mis-casos') cargarCasosJefe();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// =================== COMENTARIO ===================
async function enviarComentario() {
  const c = state.detalleActual?.caso;
  if (!c) return;
  const ta = $('detalleComentario');
  const texto = (ta?.value || '').trim();
  if (!texto) { showToast('Escribe un comentario antes de enviarlo', 'error'); return; }
  try {
    await apiFetch(`/api/casos/${encodeURIComponent(c.id)}/comentarios`, {
      method: 'POST',
      body: JSON.stringify({ comentario: texto })
    });
    showToast('Comentario agregado', 'success');
    await abrirDetalleCaso(c.id);
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// =================== INIT ===================
document.addEventListener('DOMContentLoaded', async () => {
  const token = getToken();
  if (!token) { window.location.href = 'index.html'; return; }

  const user = getCurrentUser();
  const rol = normalizarRol(user?.rol || user?.cargo);
  if (!ROLES_PERMITIDOS.includes(rol)) { window.location.href = 'index.html'; return; }

  state.rol = rol;
  state.user = user;

  if (user) {
    const nameEl = $('currentUserName');
    const locEl = $('currentUserLocation');
    const roleEl = $('currentUserRole');
    if (nameEl) nameEl.textContent = user.nombre || user.nombre_completo || user.email || 'Usuario';
    if (locEl) locEl.textContent = user.ubicacion?.nombre || 'N/A';
    if (roleEl) roleEl.textContent = getRoleLabel(rol);
  }

  const params = new URLSearchParams(window.location.search);
  const casoId = params.get('caso');
  state.tab = casoId ? (esGerenteOAdmin() ? 'historial' : 'mis-casos') : (tabsPorRol()[0].id);

  renderTabs();
  $('mainApp').style.display = 'block';
  renderMain();

  if (casoId) abrirDetalleCaso(Number(casoId));
});
