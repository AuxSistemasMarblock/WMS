/**
 * WMS Dashboard — Supply Chain Control Center
 */

// =================== ESTADO ===================
const state = {
  desde: null,
  hasta: null,
  sucursal: null,
  periodo: 'hoy',
  loading: false,
  sucursales: [],
  sucursalUsuario: null,
  currentKPIs: null
};

const PAGE_SIZE = 10;
const tables = {
  malSacadas: { data: [], filtradas: [], page: 1, sortKey: 'trandate', sortDir: -1 },
  ifsOK:      { data: [], page: 1, sortKey: 'trandate', sortDir: -1 }
};

let chartExactitud = null;
let chartTopArticulos = null;

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
  setTimeout(() => t.style.display = 'none', 3000);
}

function escapeHTML(s) {
  if (s == null) return '';
  return String(s).toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function badgeTipo(tipo) {
  switch (tipo) {
    case 'lote_cruzado':
    case 'sku_cruzado':
      return '<span class="tipo-badge cruzado">🔀 Lote / SKU Cruzado</span>';
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
      return '<span class="tipo-badge" style="background:#fee2e2; color:#b91c1c; font-weight:700;">🚨 Cancelada en ERP</span>';
    case 'ubicacion_incorrecta':
      return '<span class="tipo-badge warn">📍 Ubicación</span>';
    default:
      return `<span class="tipo-badge">${escapeHTML(tipo.replace(/_/g, ' '))}</span>`;
  }
}

// =================== TABLAS: ORDENAMIENTO Y PAGINACIÓN ===================
function valorOrdenable(row, key) {
  if (key === 'errores') return row.discrepancias ? row.discrepancias.length : 0;
  const v = row[key];
  if (v === null || v === undefined) return '';
  return v;
}

function ordenarFilas(rows, key, dir) {
  const mult = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = valorOrdenable(a, key);
    const vb = valorOrdenable(b, key);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult;
    return String(va).localeCompare(String(vb), 'es') * mult;
  });
}

function paginarFilas(rows, page) {
  const start = (page - 1) * PAGE_SIZE;
  return rows.slice(start, start + PAGE_SIZE);
}

function renderPaginador(tableKey) {
  const t = tables[tableKey];
  const containerId = tableKey === 'malSacadas' ? 'pagMalSacadas' : 'pagOK';
  const container = $(containerId);
  if (!container) return;

  const dataset = tableKey === 'malSacadas' ? t.filtradas : t.data;
  const total = dataset.length;
  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (total <= PAGE_SIZE) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = '';
  const prev = el('button', { class: 'btn btn-ghost' }, '‹ Anterior');
  prev.disabled = t.page <= 1;
  prev.onclick = () => { t.page--; renderTabla(tableKey); };

  const info = el('span', { class: 'pagination-info' }, `Página ${t.page} de ${totalPaginas} · ${total} registros`);

  const next = el('button', { class: 'btn btn-ghost' }, 'Siguiente ›');
  next.disabled = t.page >= totalPaginas;
  next.onclick = () => { t.page++; renderTabla(tableKey); };

  container.appendChild(prev);
  container.appendChild(info);
  container.appendChild(next);
}

function renderTabla(tableKey) {
  if (tableKey === 'malSacadas') renderMalSacadas();
  else if (tableKey === 'ifsOK') renderIFsOK();
}

function initSortableHeaders() {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const tableKey = th.dataset.table;
      const sortKey = th.dataset.sort;
      const t = tables[tableKey];
      if (!t) return;
      if (t.sortKey === sortKey) {
        t.sortDir = t.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        t.sortKey = sortKey;
        t.sortDir = 'asc';
      }
      t.page = 1;
      document.querySelectorAll(`th[data-table="${tableKey}"]`).forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(t.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      renderTabla(tableKey);
    });
  });
}

// =================== AUTH ===================
function getToken() { return sessionStorage.getItem('authToken'); }
function getCurrentUser() {
  const s = sessionStorage.getItem('currentUser');
  return s ? JSON.parse(s) : null;
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

// =================== PERÍODOS ===================
function ymd(d) { return d.toISOString().split('T')[0]; }

function calcularPeriodo(preset) {
  const hoy = new Date();
  const desde = new Date();
  let hasta = new Date();

  switch (preset) {
    case 'hoy': break;
    case 'semana':
      const day = hoy.getDay() || 7;
      desde.setDate(hoy.getDate() - (day - 1));
      break;
    case 'mes':
      desde.setDate(1);
      break;
    case 'mes_pasado':
      desde.setMonth(hoy.getMonth() - 1, 1);
      hasta.setDate(0);
      break;
    case 'personalizado': return null;
    default:
  }
  return { desde: ymd(desde), hasta: ymd(hasta) };
}

function setPeriodo(preset) {
  state.periodo = preset;
  document.querySelectorAll('.preset-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === preset);
  });

  if (preset === 'personalizado') {
    $('customRange').style.display = 'flex';
    return;
  } else {
    $('customRange').style.display = 'none';
  }

  const r = calcularPeriodo(preset);
  if (r) {
    state.desde = r.desde;
    state.hasta = r.hasta;
    $('filtroDesde').value = r.desde;
    $('filtroHasta').value = r.hasta;
  }
}

// =================== SUCURSALES ===================
async function cargarSucursales() {
  try {
    const data = await apiFetch('/api/dashboard/sucursales');
    state.sucursales = data.sucursales || [];
    const user = getCurrentUser();
    state.sucursalUsuario = user?.ubicacion?.nombre || null;

    const sel = $('filtroSucursal');
    sel.innerHTML = '';

    if (user?.cargo === 'admin' || user?.rol === 'admin') {
      const optTodas = el('option', { value: '' }, 'Todas las sucursales');
      sel.appendChild(optTodas);
    }

    state.sucursales.forEach(s => {
      const opt = el('option', { value: s.nombre }, s.nombre);
      sel.appendChild(opt);
    });

    if (state.sucursalUsuario && state.sucursales.some(s => s.nombre === state.sucursalUsuario)) {
      sel.value = state.sucursalUsuario;
      state.sucursal = state.sucursalUsuario;
    } else {
      sel.value = '';
      state.sucursal = null;
    }
  } catch (e) {
    showToast('Error cargando sucursales: ' + e.message, 'error');
  }
}

// =================== FILTROS & CARGA ===================
function buildParams() {
  const p = new URLSearchParams({ desde: state.desde, hasta: state.hasta });
  if (state.sucursal) p.append('sucursal', state.sucursal);
  return p;
}

function aplicarFiltros() {
  if (state.periodo === 'personalizado') {
    state.desde = $('filtroDesde').value;
    state.hasta = $('filtroHasta').value;
    if (!state.desde || !state.hasta) {
      showToast('Selecciona un rango personalizado válido', 'error');
      return;
    }
  }
  state.sucursal = $('filtroSucursal').value || null;
  cargarTodo();
}

function cargarTodo() {
  cargarKPIs();
  cargarMalSacadas();
  cargarIFsOK();
  cargarTopArticulos();
}

// =================== KPIs ===================
async function cargarKPIs() {
  try {
    const data = await apiFetch('/api/dashboard/resumen?' + buildParams());
    const k = data.kpis;
    if (!k) return;
    state.currentKPIs = k;

    // Fila 1: Indicadores Clave
    $('kpiExactitud').textContent = (k.tasa_exactitud || 0).toFixed(1) + '%';
    $('kpiExactitudSub').textContent = `Conforme a pedidos sin error (${k.ifs_ok} de ${k.ifs_totales})`;

    const escPlacas = k.placas_escaneadas || 0;
    const espPlacas = k.placas_esperadas || 0;
    const diffPlacasRaw = escPlacas - espPlacas;
    const diffPlacas = Math.abs(diffPlacasRaw - Math.round(diffPlacasRaw)) < 0.05
      ? Math.round(diffPlacasRaw)
      : parseFloat(diffPlacasRaw.toFixed(1));
    const diffSign = diffPlacas > 0 ? '+' : '';

    $('kpiVolumen').textContent = `${escPlacas} / ${espPlacas}`;
    $('kpiVolumenSub').textContent = `${diffSign}${diffPlacas} placas de variación física`;

    const m2 = k.m2 || {};
    $('kpiDesviacion').textContent = (m2.desviacion_total || 0).toFixed(2) + ' m²';
    $('kpiDesviacionSub').textContent = `+${(m2.sobrante || 0).toFixed(2)}m² sob | -${(m2.faltante || 0).toFixed(2)}m² falt`;

    $('kpiCanceladas').textContent = `${k.ifs_canceladas_erp || 0} IFs (${k.placas_canceladas || 0} pzs)`;
    $('kpiCanceladasSub').textContent = `${(m2.canceladas_erp || 0).toFixed(2)} m² fuera de ERP`;

    // Fila 2: Sub-KPIs de Diagnóstico Rápido
    const desglose = k.desglose_errores || {};
    const imp = k.impacto_placas || {};

    $('kpiMediaPlaca').textContent = `${desglose.media_placa || 0} casos`;
    $('kpiMediaPlacaSub').textContent = `+${imp.media_placa || 0} pzs (+${(m2.media_placa || 0).toFixed(2)} m²)`;

    $('kpiCruzados').textContent = `${desglose.lote_cruzado || 0} casos`;
    $('kpiCruzadosSub').textContent = `${imp.lote_cruzado || 0} pzs entregadas (Neto: 0)`;

    const totalSobrantesCasos = (desglose.cantidad_sobrante || 0) + (desglose.huerfanos_puros || 0);
    const totalSobrantesPzs = (imp.sobrantes || 0) + (imp.huerfanos_puros || 0);
    $('kpiSobrantes').textContent = `${totalSobrantesCasos} casos`;
    $('kpiSobrantesSub').textContent = `+${totalSobrantesPzs} pzs (+${(m2.sobrante_puro || 0).toFixed(2)} m²)`;

    const totalFaltantesCasos = (desglose.cantidad_faltante || 0) + (desglose.linea_faltante || 0);
    const totalFaltantesPzs = (imp.faltantes_reales || 0) + (imp.lineas_omitidas || 0);
    $('kpiFaltantes').textContent = `${totalFaltantesCasos} casos`;
    $('kpiFaltantesSub').textContent = `-${totalFaltantesPzs} pzs (-${(m2.faltante || 0).toFixed(2)} m²)`;

    renderChartExactitud(k.ifs_ok, k.ifs_con_errores, k.tasa_exactitud);
  } catch (e) {
    showToast('Error cargando KPIs: ' + e.message, 'error');
  }
}

// =================== INTERACTIVIDAD: SINCRONIZACIÓN Y FILTRO SUB-KPIS ===================
function syncSubKpiHighlight(filtro) {
  document.querySelectorAll('.sub-kpi-card').forEach(c => c.classList.remove('active-filter'));
  if (filtro === 'media_placa' && $('subKpiMediaPlaca')) $('subKpiMediaPlaca').classList.add('active-filter');
  else if (filtro === 'lote_cruzado' && $('subKpiCruzados')) $('subKpiCruzados').classList.add('active-filter');
  else if ((filtro === 'cantidad_sobrante' || filtro === 'sku_lote_no_esperado') && $('subKpiSobrantes')) $('subKpiSobrantes').classList.add('active-filter');
  else if ((filtro === 'linea_faltante' || filtro === 'cantidad_faltante' || filtro === 'faltantes_grupo') && $('subKpiFaltantes')) $('subKpiFaltantes').classList.add('active-filter');
}

function filtrarPorSubKpi(tipo) {
  const sel = $('filtroTipoError');
  if (tipo === 'faltantes_grupo') {
    sel.value = 'linea_faltante';
  } else {
    sel.value = tipo;
  }

  syncSubKpiHighlight(tipo);
  filtrarTablaMalSacadas();

  const seccion = $('seccionTablaIncidencias');
  if (seccion) {
    seccion.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const nombres = {
    'media_placa': 'Medias Placas (Etiquetado)',
    'lote_cruzado': 'Lotes / SKUs Cruzados',
    'cantidad_sobrante': 'Placas de Más (Sobrantes)',
    'faltantes_grupo': 'Líneas Faltantes / Omitidas',
    'linea_faltante': 'Líneas Faltantes / Omitidas',
    'sku_lote_no_esperado': 'Huérfanas Puras'
  };
  showToast(`Filtrando tabla por: ${nombres[tipo] || tipo}`, 'info');
}

// =================== MODAL: CONCILIACIÓN MATEMÁTICA DE KPI ===================
function abrirModalConciliacion(kpiTipo) {
  const k = state.currentKPIs;
  if (!k) return;

  const titleEl = $('conciliacionTitle');
  const bodyEl = $('conciliacionBody');
  const quickActionsEl = $('conciliacionQuickActions');

  const escPlacas = k.placas_escaneadas || 0;
  const espPlacas = k.placas_esperadas || 0;
  const diffPlacasRaw = escPlacas - espPlacas;
  const diffPlacas = Math.abs(diffPlacasRaw - Math.round(diffPlacasRaw)) < 0.05
    ? Math.round(diffPlacasRaw)
    : parseFloat(diffPlacasRaw.toFixed(1));
  const diffSign = diffPlacas > 0 ? '+' : '';

  const m2 = k.m2 || {};
  const desglose = k.desglose_errores || {};
  const imp = k.impacto_placas || {};
  const totalFaltantesCasos = (desglose.cantidad_faltante || 0) + (desglose.linea_faltante || 0);
  const totalFaltantesPzs = (imp.faltantes_reales || 0) + (imp.lineas_omitidas || 0);

  quickActionsEl.innerHTML = '';

  if (kpiTipo === 'volumen') {
    titleEl.textContent = '📦 Conciliación Matemática: Volumen Despachado';
    const linkMediaPlaca = (desglose.media_placa || 0) > 0
      ? `<button class="tabla-filtro-link" onclick="cerrarConciliacion(); filtrarPorSubKpi('media_placa');">Ver ${desglose.media_placa} ↗</button>`
      : '';
    const linkCruzados = (desglose.lote_cruzado || 0) > 0
      ? `<button class="tabla-filtro-link" onclick="cerrarConciliacion(); filtrarPorSubKpi('lote_cruzado');">Ver ${desglose.lote_cruzado} ↗</button>`
      : '';
    const linkHuerfanos = (desglose.huerfanos_puros || 0) > 0
      ? `<button class="tabla-filtro-link" onclick="cerrarConciliacion(); filtrarPorSubKpi('sku_lote_no_esperado');">Ver ${desglose.huerfanos_puros} ↗</button>`
      : '';
    const linkSobrantes = (desglose.cantidad_sobrante || 0) > 0
      ? `<button class="tabla-filtro-link" onclick="cerrarConciliacion(); filtrarPorSubKpi('cantidad_sobrante');">Ver ${desglose.cantidad_sobrante} ↗</button>`
      : '';
    const linkFaltantes = totalFaltantesCasos > 0
      ? `<button class="tabla-filtro-link" onclick="cerrarConciliacion(); filtrarPorSubKpi('faltantes_grupo');">Ver ${totalFaltantesCasos} ↗</button>`
      : '';

    bodyEl.innerHTML = `
      <div class="balance-card-summary">
        <div style="font-size:15px; font-weight:700; color:#004a99; margin-bottom:6px;">
          ${escPlacas} placas físicas escaneadas vs ${espPlacas} placas requeridas en ERP
        </div>
        <div style="color:var(--gray-7, #374151); font-size:13px; line-height:1.4;">
          Variación neta de <strong>${diffSign}${diffPlacas} placas físicas</strong> en este período. A continuación se desglosa el balance exacto por causa raíz:
        </div>
      </div>

      <div class="detalle-table-wrap">
        <table class="detalle-table">
          <thead>
            <tr>
              <th>Causa Raíz Operativa</th>
              <th style="text-align:center;">Órdenes / Casos</th>
              <th style="text-align:center;">Impacto en Placas</th>
              <th style="text-align:right;">Impacto en Área</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>🖨️ Medias Placas (Error de etiquetado)</strong><br><small style="color:var(--gray-6);">Se pidió fracción (ej. 0.5 o 1.5) y se escaneó placa completa</small></td>
              <td style="text-align:center;">
                <div style="font-weight:600; font-size:13px;">${desglose.media_placa || 0} órdenes</div>
                ${linkMediaPlaca ? `<div style="margin-top:3px;">${linkMediaPlaca}</div>` : ''}
              </td>
              <td style="text-align:center; font-weight:700; color:#8b5cf6;">+${imp.media_placa || 0} pzs</td>
              <td style="text-align:right; font-weight:600;">+${(m2.media_placa || 0).toFixed(2)} m²</td>
            </tr>
            <tr>
              <td><strong>🔀 Lotes / SKUs Cruzados (Swap en patio)</strong><br><small style="color:var(--gray-6);">Placa física sí se entregó pero con lote/código cambiado (mismo pedido)</small></td>
              <td style="text-align:center;">
                <div style="font-weight:600; font-size:13px;">${desglose.lote_cruzado || 0} casos (${imp.lote_cruzado || 0} pzs)</div>
                ${linkCruzados ? `<div style="margin-top:3px;">${linkCruzados}</div>` : ''}
              </td>
              <td style="text-align:center; font-weight:700; color:#d97706;">0 pzs <small style="color:var(--gray-6); font-weight:400;">(Entregado 1 a 1)</small></td>
              <td style="text-align:right; color:var(--gray-5);">—</td>
            </tr>
            <tr>
              <td><strong>🔄 Huérfanos Puros (Placas extra sin orden)</strong><br><small style="color:var(--gray-6);">Placas físicas escaneadas que no sustituyeron a ninguna faltante</small></td>
              <td style="text-align:center;">
                <div style="font-weight:600; font-size:13px;">${desglose.huerfanos_puros || 0} piezas</div>
                ${linkHuerfanos ? `<div style="margin-top:3px;">${linkHuerfanos}</div>` : ''}
              </td>
              <td style="text-align:center; font-weight:700; color:#4b5563;">+${imp.huerfanos_puros || 0} pzs</td>
              <td style="text-align:right; color:var(--gray-5);">—</td>
            </tr>
            <tr>
              <td><strong>📦 Placas de Más (Sobrantes puros)</strong><br><small style="color:var(--gray-6);">Partidas donde se escanearon placas completas adicionales</small></td>
              <td style="text-align:center;">
                <div style="font-weight:600; font-size:13px;">${desglose.cantidad_sobrante || 0} partidas</div>
                ${linkSobrantes ? `<div style="margin-top:3px;">${linkSobrantes}</div>` : ''}
              </td>
              <td style="text-align:center; font-weight:700; color:#2563eb;">+${imp.sobrantes || 0} pzs</td>
              <td style="text-align:right; font-weight:600;">+${(m2.sobrante_puro || 0).toFixed(2)} m²</td>
            </tr>
            <tr>
              <td><strong>🔻 Faltantes Físicos + Órdenes No Escaneadas</strong><br><small style="color:var(--gray-6);">${desglose.cantidad_faltante || 0} faltantes en rampa · ${desglose.linea_faltante || 0} líneas de ERP sin escaneo</small></td>
              <td style="text-align:center;">
                <div style="font-weight:600; font-size:13px;">${totalFaltantesCasos} partidas</div>
                ${linkFaltantes ? `<div style="margin-top:3px;">${linkFaltantes}</div>` : ''}
              </td>
              <td style="text-align:center; font-weight:700; color:#dc2626;">-${totalFaltantesPzs} pzs</td>
              <td style="text-align:right; font-weight:600; color:#dc2626;">-${(m2.faltante || 0).toFixed(2)} m²</td>
            </tr>
            <tr style="background:#f8fafc; font-weight:700;">
              <td>VARIACIÓN FÍSICA NETA TOTAL</td>
              <td style="text-align:center;">${k.total_discrepancias} incidencias</td>
              <td style="text-align:center; color:#004a99; font-size:14px;">${diffSign}${diffPlacas} placas</td>
              <td style="text-align:right; color:#dc2626; font-size:14px;">${(m2.desviacion_total || 0).toFixed(2)} m²</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;

    // Generar botones de acción rápida DINÁMICAMENTE y COMPACTOS
    const actionBtns = [];
    if ((desglose.media_placa || 0) > 0) {
      actionBtns.push(`<button class="conciliacion-filter-btn" onclick="cerrarConciliacion(); filtrarPorSubKpi('media_placa');">🖨️ Medias Placas (${desglose.media_placa})</button>`);
    }
    if ((desglose.lote_cruzado || 0) > 0) {
      actionBtns.push(`<button class="conciliacion-filter-btn" onclick="cerrarConciliacion(); filtrarPorSubKpi('lote_cruzado');">🔀 Lotes Cruzados (${desglose.lote_cruzado})</button>`);
    }
    if ((desglose.huerfanos_puros || 0) > 0) {
      actionBtns.push(`<button class="conciliacion-filter-btn" onclick="cerrarConciliacion(); filtrarPorSubKpi('sku_lote_no_esperado');">🔄 Huérfanos Puros (${desglose.huerfanos_puros})</button>`);
    }
    if ((desglose.cantidad_sobrante || 0) > 0) {
      actionBtns.push(`<button class="conciliacion-filter-btn" onclick="cerrarConciliacion(); filtrarPorSubKpi('cantidad_sobrante');">📦 Sobrantes (${desglose.cantidad_sobrante})</button>`);
    }
    if (totalFaltantesCasos > 0) {
      actionBtns.push(`<button class="conciliacion-filter-btn" onclick="cerrarConciliacion(); filtrarPorSubKpi('faltantes_grupo');">🔻 Faltantes/Omitidas (${totalFaltantesCasos})</button>`);
    }
    quickActionsEl.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <span style="font-size:12px; font-weight:600; color:var(--gray-6, #6b7280);">🔍 Filtrar en tabla:</span>
        ${actionBtns.join('')}
      </div>
    `;

  } else if (kpiTipo === 'desviacion') {
    titleEl.textContent = '📐 Conciliación Matemática: Desviación Total de Área (m²)';
    bodyEl.innerHTML = `
      <div class="balance-card-summary">
        <div style="font-size:15px; font-weight:700; color:#dc2626; margin-bottom:6px;">
          ${(m2.desviacion_total || 0).toFixed(2)} m² de Desviación Absoluta Total
        </div>
        <div style="color:var(--gray-7, #374151); font-size:13px; line-height:1.4;">
          El impacto físico se compone de <strong>+${(m2.sobrante || 0).toFixed(2)} m²</strong> despachados de más (por no re-etiquetar fracciones o surtir placas extra) y <strong>-${(m2.faltante || 0).toFixed(2)} m²</strong> de material pendiente/omitido.
        </div>
      </div>
      <div class="detalle-table-wrap">
        <table class="detalle-table">
          <thead>
            <tr>
              <th>Concepto de Impacto</th>
              <th style="text-align:center;">Casos</th>
              <th style="text-align:right;">Metros Cuadrados (m²)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>🖨️ Medias Placas (Exceso por falta de re-etiquetado)</td>
              <td style="text-align:center;">
                <div style="font-weight:600; font-size:13px;">${desglose.media_placa || 0}</div>
                ${(desglose.media_placa || 0) > 0 ? `<div style="margin-top:3px;"><button class="tabla-filtro-link" onclick="cerrarConciliacion(); filtrarPorSubKpi('media_placa');">Ver ↗</button></div>` : ''}
              </td>
              <td style="text-align:right; font-weight:600; color:#8b5cf6;">+${(m2.media_placa || 0).toFixed(2)} m²</td>
            </tr>
            <tr>
              <td>📦 Placas de Más (Sobrantes físicos completos)</td>
              <td style="text-align:center;">
                <div style="font-weight:600; font-size:13px;">${desglose.cantidad_sobrante || 0}</div>
                ${(desglose.cantidad_sobrante || 0) > 0 ? `<div style="margin-top:3px;"><button class="tabla-filtro-link" onclick="cerrarConciliacion(); filtrarPorSubKpi('cantidad_sobrante');">Ver ↗</button></div>` : ''}
              </td>
              <td style="text-align:right; font-weight:600; color:#2563eb;">+${(m2.sobrante_puro || 0).toFixed(2)} m²</td>
            </tr>
            <tr>
              <td>🔻 Faltantes Físicos + Líneas Omitidas en NetSuite</td>
              <td style="text-align:center;">
                <div style="font-weight:600; font-size:13px;">${totalFaltantesCasos}</div>
                ${totalFaltantesCasos > 0 ? `<div style="margin-top:3px;"><button class="tabla-filtro-link" onclick="cerrarConciliacion(); filtrarPorSubKpi('faltantes_grupo');">Ver ↗</button></div>` : ''}
              </td>
              <td style="text-align:right; font-weight:600; color:#dc2626;">-${(m2.faltante || 0).toFixed(2)} m²</td>
            </tr>
            <tr style="background:#f8fafc; font-weight:700;">
              <td>DESVIACIÓN TOTAL ACUMULADA</td>
              <td style="text-align:center;">—</td>
              <td style="text-align:right; color:#dc2626; font-size:14px;">${(m2.desviacion_total || 0).toFixed(2)} m²</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;

    const actionBtns = [];
    if ((desglose.media_placa || 0) > 0) {
      actionBtns.push(`<button class="conciliacion-filter-btn" onclick="cerrarConciliacion(); filtrarPorSubKpi('media_placa');">🖨️ Medias Placas (${desglose.media_placa})</button>`);
    }
    if ((desglose.lote_cruzado || 0) > 0) {
      actionBtns.push(`<button class="conciliacion-filter-btn" onclick="cerrarConciliacion(); filtrarPorSubKpi('lote_cruzado');">🔀 Lotes Cruzados (${desglose.lote_cruzado})</button>`);
    }
    if (totalFaltantesCasos > 0) {
      actionBtns.push(`<button class="conciliacion-filter-btn" onclick="cerrarConciliacion(); filtrarPorSubKpi('faltantes_grupo');">🔻 Faltantes/Omitidas (${totalFaltantesCasos})</button>`);
    }
    quickActionsEl.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <span style="font-size:12px; font-weight:600; color:var(--gray-6, #6b7280);">🔍 Filtrar en tabla:</span>
        ${actionBtns.join('')}
      </div>
    `;
  }

  $('conciliacionModal').style.display = 'flex';
}

function cerrarConciliacion() {
  $('conciliacionModal').style.display = 'none';
}

// =================== TABLA 1: IFs MAL SACADAS Y CANCELADAS ===================
async function cargarMalSacadas() {
  const tbody = $('tbodyMalSacadas');
  tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state">Cargando…</div></td></tr>';
  try {
    const data = await apiFetch('/api/dashboard/ifs-mal-sacadas?' + buildParams());
    tables.malSacadas.data = data.ifs || [];
    tables.malSacadas.filtradas = [...tables.malSacadas.data];
    $('badCount').textContent = tables.malSacadas.data.length;
    tables.malSacadas.page = 1;
    filtrarTablaMalSacadas();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">Error: ${escapeHTML(e.message)}</div></td></tr>`;
  }
}

function filtrarTablaMalSacadas() {
  const filtro = $('filtroTipoError').value;
  syncSubKpiHighlight(filtro);
  const t = tables.malSacadas;

  if (!filtro) {
    t.filtradas = [...t.data];
  } else if (filtro === 'linea_faltante' || filtro === 'cantidad_faltante') {
    t.filtradas = t.data.filter(i => (i.tipos_error || []).some(te => te === 'linea_faltante' || te === 'cantidad_faltante'));
  } else {
    t.filtradas = t.data.filter(i => (i.tipos_error || []).includes(filtro));
  }
  t.page = 1;
  renderMalSacadas();
}

function renderMalSacadas() {
  const tbody = $('tbodyMalSacadas');
  const t = tables.malSacadas;
  let filas = ordenarFilas(t.filtradas, t.sortKey, t.sortDir);
  const paginadas = paginarFilas(filas, t.page);

  if (t.filtradas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state">✅ Sin incidencias ni alertas en este período</div></td></tr>';
    renderPaginador('malSacadas');
    return;
  }

  tbody.innerHTML = '';
  paginadas.forEach(i => {
    const isCancelada = (i.status === 'cancelada_erp') || (i.tipos_error || []).includes('if_no_encontrada');
    const isOnlyCruzados = !isCancelada && (i.tipos_error || []).length === 1 && i.tipos_error[0] === 'lote_cruzado';

    const semaforoBadge = isCancelada
      ? '<span class="tipo-badge" style="background:#fee2e2; color:#b91c1c; font-weight:700;">🚨 Alerta ERP</span>'
      : (isOnlyCruzados
        ? '<span class="tipo-badge warn" style="font-weight:700;">🟡 Discrepancia Lote</span>'
        : '<span class="tipo-badge error" style="font-weight:700;">🔴 Error Surtido</span>');

    const cruzadasCount = (i.discrepancias || []).filter(d => d.es_cruzado && (d.tipo === 'linea_faltante' || d.tipo === 'cantidad_faltante')).length;
    const noCruzadasCount = (i.discrepancias || []).filter(d => !d.es_cruzado).length;
    const totalIncidencias = cruzadasCount + noCruzadasCount;

    const tiposBadges = (i.tipos_error || []).map(t => badgeTipo(t)).join(' ');
    const tr = el('tr');
    tr.innerHTML = `
      <td><strong>${escapeHTML(i.tranid)}</strong></td>
      <td>${escapeHTML(i.trandate || '—')}</td>
      <td>${escapeHTML(i.so || '—')}</td>
      <td>${escapeHTML(i.location || '—')}</td>
      <td>${escapeHTML(i.operador || '—')}</td>
      <td style="text-align:center; font-weight:700; color:#dc2626;">${totalIncidencias}</td>
      <td style="text-align:center;">${semaforoBadge}</td>
      <td>${tiposBadges}</td>
      <td style="text-align:center;"><button class="btn btn-ghost" onclick="verDetalle('${i.tranid}')">Ver detalle</button></td>
    `;
    tbody.appendChild(tr);
  });
  renderPaginador('malSacadas');
}

// =================== TABLA 2: IFs OK ===================
async function cargarIFsOK() {
  const tbody = $('tbodyOK');
  tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Cargando…</div></td></tr>';
  try {
    const data = await apiFetch('/api/dashboard/ifs-ok?' + buildParams());
    tables.ifsOK.data = data.ifs || [];
    $('okCount').textContent = tables.ifsOK.data.length;
    tables.ifsOK.page = 1;
    renderIFsOK();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Error: ${escapeHTML(e.message)}</div></td></tr>`;
  }
}

function renderIFsOK() {
  const tbody = $('tbodyOK');
  const t = tables.ifsOK;
  let filas = ordenarFilas(t.data, t.sortKey, t.sortDir);
  const paginadas = paginarFilas(filas, t.page);

  if (t.data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Sin IFs OK en este período</div></td></tr>';
    renderPaginador('ifsOK');
    return;
  }

  tbody.innerHTML = '';
  paginadas.forEach(i => {
    const tr = el('tr');
    tr.innerHTML = `
      <td><strong>${escapeHTML(i.tranid)}</strong></td>
      <td>${escapeHTML(i.trandate || '—')}</td>
      <td>${escapeHTML(i.so || '—')}</td>
      <td>${escapeHTML(i.location || '—')}</td>
      <td>${escapeHTML(i.operador || '—')}</td>
      <td style="text-align:center;">${i.total_lineas}</td>
      <td style="text-align:center;"><button class="btn btn-ghost" onclick="verDetalle('${i.tranid}')">Ver detalle</button></td>
    `;
    tbody.appendChild(tr);
  });
  renderPaginador('ifsOK');
}

// =================== MODAL 2: DETALLE CONSOLIDADO (SIN REPETICIÓN) ===================
async function verDetalle(tranid) {
  $('detalleTitle').textContent = 'Auditoría y Detalle de ' + tranid;
  $('detalleBody').innerHTML = '<div class="empty-state">Cargando análisis partida por partida…</div>';
  $('detalleModal').style.display = 'flex';
  try {
    const data = await apiFetch(`/api/dashboard/if/${encodeURIComponent(tranid)}/detalle?` + buildParams());
    if (data.if) {
      renderDetalle(data.if);
    } else {
      $('detalleBody').innerHTML = '<div class="empty-state">No se encontraron datos para esta IF.</div>';
    }
  } catch (e) {
    $('detalleBody').innerHTML = `<div class="empty-state">Error cargando detalle: ${escapeHTML(e.message)}</div>`;
  }
}

function renderDetalle(ifDoc) {
  const isCancelada = ifDoc.status === 'cancelada_erp' || (ifDoc.discrepancias || []).some(d => d.tipo === 'if_no_encontrada');
  const allCruzados = (ifDoc.discrepancias && ifDoc.discrepancias.length > 0) && ifDoc.discrepancias.every(d => d.es_cruzado);
  const statusBadge = isCancelada
    ? '<span class="tipo-badge" style="background:#fee2e2; color:#b91c1c; font-weight:700;">🚨 Cancelada en NetSuite</span>'
    : (allCruzados
      ? '<span class="tipo-badge warn" style="font-weight:700;">🟡 Discrepancia de Lote (Mercancía entregada)</span>'
      : ((ifDoc.discrepancias && ifDoc.discrepancias.length > 0)
        ? '<span class="tipo-badge error" style="font-weight:700;">🔴 Con Errores de Surtido</span>'
        : '<span class="tipo-badge ok" style="font-weight:700;">🟢 100% Correcta</span>'));

  const html = [];
  html.push(`
    <div class="detalle-modal-header">
      <div class="detalle-header-grid">
        <div><span class="label">Folio IF:</span> <strong class="val">${escapeHTML(ifDoc.tranid)}</strong></div>
        <div><span class="label">SO Origen:</span> <span class="val">${escapeHTML(ifDoc.so || '—')}</span></div>
        <div><span class="label">Fecha:</span> <span class="val">${escapeHTML(ifDoc.trandate || '—')}</span></div>
        <div><span class="label">Sucursal:</span> <span class="val">${escapeHTML(ifDoc.location || '—')}</span></div>
        <div><span class="label">Operador:</span> <span class="val">${escapeHTML(ifDoc.operador || '—')}</span></div>
        <div><span class="label">Estatus General:</span> ${statusBadge}</div>
      </div>
    </div>
  `);

  html.push(`
    <div class="detalle-table-wrap">
      <table class="detalle-table">
        <thead>
          <tr>
            <th style="width: 14%;">SKU</th>
            <th style="width: 18%;">Lote / Medidas</th>
            <th style="width: 12%; text-align:center;">Esperado</th>
            <th style="width: 12%; text-align:center;">Escaneado</th>
            <th style="width: 16%; text-align:center;">Diagnóstico</th>
            <th style="width: 28%;">Plan de Acción Específico</th>
          </tr>
        </thead>
        <tbody>
  `);

  // Agrupar discrepancias por clave SKU|LOTE
  const discPorLinea = new Map();
  (ifDoc.discrepancias || []).forEach(d => {
    const key = `${d.sku || ''}|${d.lote || ''}`;
    if (!discPorLinea.has(key)) discPorLinea.set(key, []);
    discPorLinea.get(key).push(d);
  });

  // Renderizar cada línea esperada
  (ifDoc.lineas || []).forEach(l => {
    const key = `${l.sku || ''}|${l.lote || ''}`;
    const discs = discPorLinea.get(key) || [];
    discPorLinea.delete(key);

    const parsedArea = l.evaluacion_cantidad?.area_placa_m2 || 0;
    const m2Esp = l.quantity ? parseFloat(l.quantity).toFixed(2) + 'm²' : '—';
    const m2Esc = parsedArea ? ((l.placas_escaneadas || 0) * parsedArea).toFixed(2) + 'm²' : '0.00m²';
    const espPlacas = l.evaluacion_cantidad?.placas_esperadas ?? (l.placas_esperadas ?? '—');
    const escPlacas = l.placas_escaneadas ?? 0;

    let diagnosticoBadge = '<span class="tipo-badge ok">🟢 OK</span>';
    let planAccionTexto = '<span style="color:var(--gray-5, #9ca3af);">—</span>';

    if (discs.length > 0) {
      diagnosticoBadge = discs.map(d => badgeTipo(d.es_cruzado ? 'lote_cruzado' : d.tipo)).join(' ');
      planAccionTexto = discs.map(d => `<div style="margin-bottom:4px; font-weight:500;">${escapeHTML(d.plan_accion || d.mensaje)}</div>`).join('');
    } else if (isCancelada) {
      diagnosticoBadge = '<span class="tipo-badge" style="background:#fee2e2; color:#b91c1c; font-weight:600;">🚨 No en ERP</span>';
      planAccionTexto = 'IF cancelada en NetSuite. Notificar a facturación / retorno.';
    }

    const medidasTexto = parsedArea > 0 ? `<div style="font-size:11px; color:var(--gray-5, #6b7280);">${parsedArea.toFixed(2)} m²/pza</div>` : '';

    html.push(`
      <tr>
        <td><strong>${escapeHTML(l.sku || '—')}</strong></td>
        <td>
          <div>${escapeHTML(l.lote || '—')}</div>
          ${medidasTexto}
        </td>
        <td style="text-align:center;">
          <div style="font-weight:600;">${espPlacas} ${typeof espPlacas === 'number' ? (espPlacas === 1 ? 'pza' : 'pzs') : ''}</div>
          <div style="font-size:11px; color:var(--gray-5, #6b7280);">${m2Esp}</div>
        </td>
        <td style="text-align:center;">
          <div style="font-weight:700;">${escPlacas} ${escPlacas === 1 ? 'pza' : 'pzs'}</div>
          <div style="font-size:11px; color:var(--gray-5, #6b7280);">${m2Esc}</div>
        </td>
        <td style="text-align:center;">${diagnosticoBadge}</td>
        <td style="font-size:12px; color:var(--gray-8, #1f2937); line-height:1.4;">${planAccionTexto}</td>
      </tr>
    `);
  });

  // Renderizar discrepancias huérfanas
  discPorLinea.forEach((discs, key) => {
    const d = discs[0];
    const skuStr = d.sku || '—';
    const loteStr = d.lote || '—';
    const diagBadge = discs.map(x => badgeTipo(x.es_cruzado ? 'lote_cruzado' : x.tipo)).join(' ');
    const planText = discs.map(x => `<div style="margin-bottom:4px; font-weight:500;">${escapeHTML(x.plan_accion || x.mensaje)}</div>`).join('');

    html.push(`
      <tr style="background:#fffbeb;">
        <td><strong>${escapeHTML(skuStr)}</strong></td>
        <td>${escapeHTML(loteStr)}</td>
        <td style="text-align:center; color:var(--gray-5);">0 pzs</td>
        <td style="text-align:center; font-weight:700; color:#dc2626;">+1 pza</td>
        <td style="text-align:center;">${diagBadge}</td>
        <td style="font-size:12px; color:var(--gray-8); line-height:1.4;">${planText}</td>
      </tr>
    `);
  });

  html.push(`
        </tbody>
      </table>
    </div>
  `);

  $('detalleBody').innerHTML = html.join('');
}

function cerrarDetalle() {
  $('detalleModal').style.display = 'none';
}

// =================== GRÁFICAS ===================
async function cargarTopArticulos() {
  try {
    const params = buildParams();
    const articulos = await apiFetch('/api/dashboard/articulos-mas-salidas?' + params);
    renderChartTopArticulos(articulos.top || []);
  } catch (e) {
    renderChartTopArticulos([]);
  }
}

function renderChartExactitud(ok, errores, tasa) {
  const ctx = $('chartExactitud');
  if (!ctx) return;

  $('tasaExactitudTexto').textContent = (tasa || 0).toFixed(1) + '%';

  if (chartExactitud) chartExactitud.destroy();
  chartExactitud = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['IFs OK', 'IFs con error'],
      datasets: [{
        data: [ok, errores],
        backgroundColor: ['#10b981', '#dc2626'],
        borderWidth: 2,
        borderColor: '#fff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { size: 11 }, padding: 6, boxWidth: 12 }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = ok + errores;
              const pct = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
              return `${ctx.label}: ${ctx.parsed} (${pct}%)`;
            }
          }
        }
      }
    }
  });
}

function renderChartTopArticulos(items) {
  const ctx = $('chartTopArticulos');
  if (!ctx) return;

  if (chartTopArticulos) chartTopArticulos.destroy();

  const top5 = (items || []).slice(0, 5);
  const labels = top5.map(i => i.key);
  const data = top5.map(i => i.count);
  const total = data.reduce((a, b) => a + b, 0);

  const subtitleEl = $('topArticulosTotal');
  if (subtitleEl) subtitleEl.textContent = total > 0 ? `${total} placas` : '–';

  chartTopArticulos = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Placas escaneadas',
        data,
        backgroundColor: ['#1e40af', '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6'],
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.parsed.y} placas`
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { precision: 0, font: { size: 11 } },
          title: { display: true, text: 'Placas', font: { size: 10 } }
        },
        x: {
          ticks: { font: { size: 10 }, maxRotation: 30, minRotation: 0 }
        }
      }
    }
  });
}

// =================== INIT ===================
document.addEventListener('DOMContentLoaded', async () => {
  const token = getToken();
  if (!token) {
    window.location.href = 'index.html';
    return;
  }

  const user = getCurrentUser();
  if (user) {
    const rol = user.rol || user.cargo;
    const nameEl = $('currentUserName');
    const locEl = $('currentUserLocation');
    const roleEl = $('currentUserRole');
    if (nameEl) nameEl.textContent = user.nombre || user.email || 'Usuario';
    if (locEl) locEl.textContent = user.ubicacion?.nombre || 'N/A';
    if (roleEl) roleEl.textContent = getRoleLabel(rol);
  }

  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setPeriodo(btn.dataset.preset);
      if (state.periodo !== 'personalizado') {
        aplicarFiltros();
      }
    });
  });

  setPeriodo('hoy');
  initSortableHeaders();
  await cargarSucursales();

  $('mainApp').style.display = 'block';
  cargarTodo();
});

function getRoleLabel(cargo) {
  const roles = {
    'aux_almacen': 'Aux. Almacén',
    'jefe_almacen': 'Jefe de Almacén',
    'gerente': 'Gerente',
    'cliente': 'Cliente',
    'admin': 'Administrador'
  };
  return roles[cargo] || cargo;
}
