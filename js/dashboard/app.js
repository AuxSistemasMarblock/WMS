/**
 * WMS Dashboard — Entry point
 *
 * Asume que la sesión ya está activa (el login se hace en index.html).
 * Si no hay token, redirige a index.html.
 */

// =================== ESTADO ===================
const state = {
  desde: null,
  hasta: null,
  sucursal: null,
  periodo: 'mes',
  loading: false,
  sucursales: [],
  sucursalUsuario: null
};

// Estado por tabla: dataset completo + paginación + ordenamiento
const PAGE_SIZE = 10;
const tables = {
  malSacadas:   { data: [], page: 1, sortKey: null, sortDir: 'asc' },
  discrepancias: { data: [], page: 1, sortKey: null, sortDir: 'asc' },
  ifsOK:        { data: [], page: 1, sortKey: null, sortDir: 'asc' }
};

// Charts (inicializados lazy)
let chartExactitud = null;
let chartTopArticulos = null;

// =================== CONFIG ===================
// Misma convención que js/auth.js: el URL se lee de window.APP_CONFIG.BACKEND_URL
// (config.js lo setea en el build de Docker). Fallback a localhost solo para dev.
const BACKEND_URL = window.APP_CONFIG?.BACKEND_URL || 'http://localhost:3001';
if (!window.APP_CONFIG?.BACKEND_URL) {
  console.error('APP_CONFIG.BACKEND_URL no definido. Verifica js/config.js.');
}

// =================== HELPERS ===================
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
  const cls = ['cantidad_faltante', 'sku_lote_no_esperado', 'linea_faltante', 'if_no_encontrada'].includes(tipo) ? 'error'
            : ['cantidad_sobrante', 'ubicacion_incorrecta'].includes(tipo) ? 'warn'
            : '';
  return `<span class="tipo-badge ${cls}">${tipo.replace(/_/g, ' ')}</span>`;
}

function formatearFecha(s) {
  if (!s) return '—';
  return s;
}

// =================== TABLAS: ORDENAMIENTO Y PAGINACIÓN ===================

function valorOrdenable(row, key) {
  if (key === 'errores') return row.discrepancias ? row.discrepancias.length : 0;
  const v = row[key];
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.text) return v.text;
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
  const container = $('pag' + (tableKey === 'malSacadas' ? 'MalSacadas' : tableKey === 'discrepancias' ? 'Discrepancias' : 'OK'));
  if (!container) return;
  const total = t.data.length;
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
  else if (tableKey === 'discrepancias') renderDiscrepancias();
  else if (tableKey === 'ifsOK') renderIFsOK();
}

function initSortableHeaders() {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const tableKey = th.dataset.table;
      const sortKey = th.dataset.sort;
      const t = tables[tableKey];
      if (t.sortKey === sortKey) {
        t.sortDir = t.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        t.sortKey = sortKey;
        t.sortDir = 'asc';
      }
      t.page = 1;
      // Quitar indicadores previos y marcar el actual
      document.querySelectorAll(`th[data-table="${tableKey}"]`).forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(t.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      renderTabla(tableKey);
    });
  });
}

// =================== AUTH ===================
function getToken() {
  return sessionStorage.getItem('authToken');
}

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

// =================== PERÍODOS PRESET ===================
function ymd(d) { return d.toISOString().split('T')[0]; }

function calcularPeriodo(preset) {
  const hoy = new Date();
  const desde = new Date();
  let hasta = new Date();

  switch (preset) {
    case 'hoy':
      // desde = hoy
      break;
    case 'semana':
      // lunes de esta semana
      const day = hoy.getDay() || 7; // lunes=1, domingo=7
      desde.setDate(hoy.getDate() - (day - 1));
      break;
    case 'mes':
      desde.setDate(1);
      break;
    case 'mes_pasado':
      desde.setMonth(hoy.getMonth() - 1, 1);
      hasta.setDate(0); // último día del mes anterior
      break;
    case 'personalizado':
      return null; // se usan los inputs
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

    // Opción "Todas" solo si NO es admin (los admins pueden ver todo por default)
    if (user?.cargo === 'admin') {
      const optTodas = el('option', { value: '' }, 'Todas las sucursales');
      sel.appendChild(optTodas);
    }

    state.sucursales.forEach(s => {
      const opt = el('option', { value: s.nombre }, s.nombre);
      sel.appendChild(opt);
    });

    // Default: la ubicación del usuario
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

// =================== FILTROS ===================
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
  cargarDiscrepancias();
  cargarTopErrores();
  cargarIFsOK();
  cargarTopArticulos();
}

// =================== KPIs ===================
async function cargarKPIs() {
  try {
    const params = buildParams();
    const data = await apiFetch('/api/dashboard/resumen?' + params);
    const k = data.kpis;
    $('kpiErrores').textContent = k.ifs_con_errores;
    $('kpiLineas').textContent = k.lineas_con_error + ' / ' + k.lineas_totales;
    $('kpiPlacas').textContent = k.placas_escaneadas + ' / ' + k.placas_esperadas;
    if (k.placas_escaneadas_huerfanas > 0) {
      $('kpiPlacas').title = `${k.placas_escaneadas_matcheadas} matchearon con IFs, ${k.placas_escaneadas_huerfanas} no matchearon (huérfanas)`;
    }
    $('kpiDiscrepancias').textContent = k.total_discrepancias;
    $('kpiOK').textContent = k.ifs_ok;
    renderChartExactitud(k.ifs_ok, k.ifs_con_errores, k.tasa_exactitud);
  } catch (e) {
    showToast('Error cargando KPIs: ' + e.message, 'error');
  }
}

function buildParams() {
  const p = new URLSearchParams({ desde: state.desde, hasta: state.hasta });
  if (state.sucursal) p.append('sucursal', state.sucursal);
  return p;
}

// =================== GRÁFICAS ===================
function renderChartExactitud(ok, errores, tasa) {
  const ctx = $('chartExactitud');
  if (!ctx) return;

  $('tasaExactitudTexto').textContent = tasa.toFixed(1) + '%';

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

async function cargarTopArticulos() {
  try {
    const params = buildParams();
    const articulos = await apiFetch('/api/dashboard/articulos-mas-salidas?' + params);
    renderChartTopArticulos(articulos.top || []);
  } catch (e) {
    // fallback: si el endpoint no existe, dejamos el chart vacío
    renderChartTopArticulos([]);
  }
}

function renderChartTopArticulos(items) {
  const ctx = $('chartTopArticulos');
  if (!ctx) return;

  if (chartTopArticulos) chartTopArticulos.destroy();

  const top5 = (items || []).slice(0, 5);
  const labels = top5.map(i => i.key);
  const data = top5.map(i => i.count);
  const total = data.reduce((a, b) => a + b, 0);

  // Subtitle con el total
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

// =================== IFs MAL SACADAS ===================
async function cargarMalSacadas() {
  const tbody = $('tbodyMalSacadas');
  tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">Cargando…</div></td></tr>';
  try {
    const data = await apiFetch('/api/dashboard/ifs-mal-sacadas?' + buildParams());
    $('badCount').textContent = data.total;
    tables.malSacadas.data = data.ifs || [];
    tables.malSacadas.page = 1;
    tables.malSacadas.sortKey = null;
    tables.malSacadas.sortDir = 'asc';
    document.querySelectorAll('th[data-table="malSacadas"]').forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
    renderMalSacadas();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">Error: ${escapeHTML(e.message)}</div></td></tr>`;
  }
}

function renderMalSacadas() {
  const tbody = $('tbodyMalSacadas');
  const t = tables.malSacadas;
  let filas = ordenarFilas(t.data, t.sortKey, t.sortDir);
  const paginadas = paginarFilas(filas, t.page);

  if (t.data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">✅ Sin IFs mal sacadas en este período</div></td></tr>';
    renderPaginador('malSacadas');
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
      <td>${i.discrepancias.length}</td>
      <td>${(i.tipos_error || []).map(t => badgeTipo(t)).join(' ')}</td>
      <td><button class="btn btn-ghost" onclick="verDetalle('${i.tranid}')">Ver detalle</button></td>
    `;
    tbody.appendChild(tr);
  });
  renderPaginador('malSacadas');
}

// =================== DETALLE ===================
async function verDetalle(tranid) {
  $('detalleTitle').textContent = 'Detalle de ' + tranid;
  $('detalleBody').innerHTML = '<div class="empty-state">Cargando…</div>';
  $('detalleModal').style.display = 'flex';
  try {
    const data = await apiFetch(`/api/dashboard/if/${encodeURIComponent(tranid)}/detalle?` + buildParams());
    renderDetalle(data.if);
  } catch (e) {
    $('detalleBody').innerHTML = `<div class="empty-state">Error: ${escapeHTML(e.message)}</div>`;
  }
}

function renderDetalle(ifDoc) {
  const html = [];
  html.push(`
    <div class="detalle-section">
      <h4>Cabecera</h4>
      <div><strong>SO origen:</strong> ${escapeHTML(ifDoc.so || ifDoc.sourceDoc || '—')}</div>
      <div><strong>Fecha:</strong> ${escapeHTML(ifDoc.trandate || '—')}</div>
      <div><strong>Ubicación:</strong> ${escapeHTML(ifDoc.location || '—')}</div>
      <div><strong>Operador:</strong> ${escapeHTML(ifDoc.operador || '—')}</div>
    </div>
  `);
  html.push(`
    <div class="detalle-section">
      <h4>Esperado vs Escaneado</h4>
      <div class="detalle-linea" style="font-weight: 600; background: var(--gray-2);">
        <div>SKU</div><div>Lote</div><div>Esperado</div><div>Escaneado</div><div>Ubicación</div><div>Status</div>
      </div>
  `);
  ifDoc.lineas.forEach(l => {
    const status = l.status || 'ok';
    const ubicacion = l.escaneos && l.escaneos.length > 0
      ? l.escaneos.map(e => e.ubicacion_escaneada).filter((v, i, a) => a.indexOf(v) === i).join(', ')
      : '—';
    html.push(`
      <div class="detalle-linea">
        <div>${escapeHTML(l.sku || '—')}</div>
        <div>${escapeHTML(l.lote || '—')}</div>
        <div>${l.evaluacion_cantidad?.placas_esperadas ?? '—'}</div>
        <div>${l.placas_escaneadas}</div>
        <div>${escapeHTML(ubicacion)}</div>
        <div class="status-${status}">${status}</div>
      </div>
    `);
  });
  html.push('</div>');

  if (ifDoc.discrepancias && ifDoc.discrepancias.length > 0) {
    html.push('<div class="detalle-section"><h4>Discrepancias (' + ifDoc.discrepancias.length + ')</h4>');
    ifDoc.discrepancias.forEach(d => {
      let detalle = '';
      if (d.tipo === 'cantidad_faltante') {
        detalle = `Esperaba ${d.placas_esperadas} placas, escaneadas ${d.placas_escaneadas} (diff -${d.diferencia}, área ${d.area_placa_m2} m²)`;
      } else if (d.tipo === 'cantidad_sobrante') {
        detalle = `Esperaba ${d.placas_esperadas} placas, escaneadas ${d.placas_escaneadas} (diff +${d.diferencia}, área ${d.area_placa_m2} m²)`;
      } else if (d.tipo === 'ubicacion_incorrecta') {
        detalle = `Esperaba "${d.ubicacion_esperada}", se escaneó "${d.ubicacion_escaneada}" (operador: ${d.escaneo_operador || '—'})`;
      } else if (d.tipo === 'sku_lote_no_esperado') {
        detalle = `SKU/lote no estaba en la IF (operador: ${d.escaneo_operador || '—'})`;
      } else if (d.tipo === 'linea_faltante') {
        detalle = 'No se escaneó ninguna placa de este item';
      } else if (d.tipo === 'if_no_encontrada') {
        detalle = d.mensaje || 'IF escaneada pero no localizada en NetSuite';
      } else if (d.tipo === 'sin_medidas') {
        detalle = d.mensaje;
      }
      html.push('<div style="margin: 4px 0;">' + badgeTipo(d.tipo) + ' ' + escapeHTML(detalle) + '</div>');
    });
    html.push('</div>');
  }
  $('detalleBody').innerHTML = html.join('');
}

function cerrarDetalle() {
  $('detalleModal').style.display = 'none';
}

// =================== DISCREPANCIAS ===================
async function cargarDiscrepancias() {
  const tbody = $('tbodyDiscrepancias');
  tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">Cargando…</div></td></tr>';
  try {
    const p = buildParams();
    const tipo = $('filtroTipoDisc').value;
    if (tipo) p.append('tipo', tipo);
    const data = await apiFetch('/api/dashboard/discrepancias?' + p);
    $('discCount').textContent = data.total;
    tables.discrepancias.data = data.discrepancias || [];
    tables.discrepancias.page = 1;
    tables.discrepancias.sortKey = null;
    tables.discrepancias.sortDir = 'asc';
    document.querySelectorAll('th[data-table="discrepancias"]').forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
    renderDiscrepancias();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">Error: ${escapeHTML(e.message)}</div></td></tr>`;
  }
}

function renderDiscrepancias() {
  const tbody = $('tbodyDiscrepancias');
  const t = tables.discrepancias;
  let filas = ordenarFilas(t.data, t.sortKey, t.sortDir);
  const paginadas = paginarFilas(filas, t.page);

  if (t.data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">Sin discrepancias</div></td></tr>';
    renderPaginador('discrepancias');
    return;
  }

  tbody.innerHTML = '';
  paginadas.forEach(d => {
    let detalle = '';
    if (d.placas_esperadas !== undefined) {
      detalle = `Esp: ${d.placas_esperadas} / Esc: ${d.placas_escaneadas}`;
    } else if (d.ubicacion_esperada) {
      detalle = `${d.ubicacion_esperada} → ${d.ubicacion_escaneada}`;
    } else {
      detalle = d.mensaje || '—';
    }
    const tr = el('tr');
    tr.innerHTML = `
      <td><strong>${escapeHTML(d.if_tranid || '—')}</strong></td>
      <td>${escapeHTML(d.if_fecha || '—')}</td>
      <td>${escapeHTML(d.if_so || '—')}</td>
      <td>${escapeHTML(d.if_location || '—')}</td>
      <td>${escapeHTML(d.sku || '—')}</td>
      <td>${escapeHTML(d.lote || '—')}</td>
      <td>${badgeTipo(d.tipo)}</td>
      <td>${escapeHTML(detalle)}</td>
    `;
    tbody.appendChild(tr);
  });
  renderPaginador('discrepancias');
}

// =================== TOP ERRORES ===================
async function cargarTopErrores() {
  try {
    const p = buildParams();
    const [skus, lotes, operadores] = await Promise.all([
      apiFetch('/api/dashboard/top-errores?' + p + '&dimension=sku'),
      apiFetch('/api/dashboard/top-errores?' + p + '&dimension=lote'),
      apiFetch('/api/dashboard/top-errores?' + p + '&dimension=operador')
    ]);
    renderTopList('topSkus', skus.top);
    renderTopList('topLotes', lotes.top);
    renderTopList('topOperadores', operadores.top);
  } catch (e) {
    showToast('Error cargando top errores: ' + e.message, 'error');
  }
}

function renderTopList(id, items) {
  const ol = $(id);
  if (!items || items.length === 0) {
    ol.innerHTML = '<li style="color: var(--gray-5);">Sin datos</li>';
    return;
  }
  ol.innerHTML = items.slice(0, 5).map(i =>
    `<li>${escapeHTML(i.key || '—')} — <strong>${i.count}</strong> errores</li>`
  ).join('');
}

// =================== IFs OK ===================
async function cargarIFsOK() {
  const tbody = $('tbodyOK');
  tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Cargando…</div></td></tr>';
  try {
    const data = await apiFetch('/api/dashboard/ifs-ok?' + buildParams());
    $('okCount').textContent = data.total;
    tables.ifsOK.data = data.ifs || [];
    tables.ifsOK.page = 1;
    tables.ifsOK.sortKey = null;
    tables.ifsOK.sortDir = 'asc';
    document.querySelectorAll('th[data-table="ifsOK"]').forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
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
      <td>${i.total_lineas}</td>
      <td><button class="btn btn-ghost" onclick="verDetalle('${i.tranid}')">Ver detalle</button></td>
    `;
    tbody.appendChild(tr);
  });
  renderPaginador('ifsOK');
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
    $('currentUserName').textContent = user.nombre || user.email || 'Usuario';
    $('currentUserLocation').textContent = user.ubicacion?.nombre || 'N/A';
    $('currentUserRole').textContent = getRoleLabel(user.cargo);
  }

  // Preset buttons
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setPeriodo(btn.dataset.preset);
      if (state.periodo !== 'personalizado') {
        aplicarFiltros();
      }
    });
  });

  // Período default: hoy
  setPeriodo('hoy');

  // Headers ordenables de las tablas
  initSortableHeaders();

  // Cargar sucursales (necesario para el select)
  await cargarSucursales();

  $('mainApp').style.display = 'block';
  cargarTodo();
});

function getRoleLabel(cargo) {
  const roles = {
    'aux_almacen': 'Aux. Almacén',
    'admin': 'Administrador'
  };
  return roles[cargo] || cargo;
}
