/**
 * WMS Dashboard — Entry point
 * Orquesta: KPIs, IFs mal sacadas, discrepancias, top errores, IFs OK.
 */

// =================== ESTADO ===================
const state = {
  desde: null,
  hasta: null,
  sucursal: null,
  loading: false
};

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
  if (typeof window.showToast === 'function') return window.showToast(msg, type);
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
  const cls = ['cantidad_faltante', 'sku_lote_no_esperado', 'linea_faltante'].includes(tipo) ? 'error'
            : ['cantidad_sobrante', 'ubicacion_incorrecta'].includes(tipo) ? 'warn'
            : '';
  return `<span class="tipo-badge ${cls}">${tipo.replace(/_/g, ' ')}</span>`;
}

// =================== AUTH ===================
async function handleLogin(event) {
  event.preventDefault();
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;

  try {
    const res = await fetch((window.BACKEND_URL || 'http://localhost:3001') + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Login fallido');
    }
    const data = await res.json();
    localStorage.setItem('wms_token', data.token);
    if (data.user) {
      localStorage.setItem('wms_user', JSON.stringify(data.user));
      $('currentUserName').textContent = data.user.nombre || data.user.email;
      $('currentUserLocation').textContent = data.user.ubicacion_nombre || 'N/A';
      $('currentUserRole').textContent = data.user.cargo || 'N/A';
    }
    $('loginContainer').style.display = 'none';
    $('mainApp').style.display = 'block';
    initFiltrosDefault();
    cargarTodo();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

function handleLogout() {
  localStorage.removeItem('wms_token');
  localStorage.removeItem('wms_user');
  location.reload();
}

function getToken() {
  return localStorage.getItem('wms_token');
}

async function apiFetch(path, opts = {}) {
  const token = getToken();
  if (!token) throw new Error('No autenticado');
  const res = await fetch((window.BACKEND_URL || 'http://localhost:3001') + path, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (res.status === 401) {
    handleLogout();
    throw new Error('Sesión expirada');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// =================== FILTROS ===================
function initFiltrosDefault() {
  // Default: último mes
  const hoy = new Date();
  const haceUnMes = new Date();
  haceUnMes.setDate(haceUnMes.getDate() - 30);
  state.desde = haceUnMes.toISOString().split('T')[0];
  state.hasta = hoy.toISOString().split('T')[0];
  $('filtroDesde').value = state.desde;
  $('filtroHasta').value = state.hasta;
}

function aplicarFiltros() {
  state.desde = $('filtroDesde').value;
  state.hasta = $('filtroHasta').value;
  state.sucursal = $('filtroSucursal').value.trim() || null;
  cargarTodo();
}

function cargarTodo() {
  cargarKPIs();
  cargarMalSacadas();
  cargarDiscrepancias();
  cargarTopErrores();
  cargarIFsOK();
}

// =================== KPIs ===================
async function cargarKPIs() {
  try {
    const params = new URLSearchParams({ desde: state.desde, hasta: state.hasta });
    if (state.sucursal) params.append('sucursal', state.sucursal);
    const data = await apiFetch('/api/dashboard/resumen?' + params);
    $('kpiTasa').textContent = data.kpis.tasa_exactitud.toFixed(1) + '%';
    $('kpiErrores').textContent = data.kpis.ifs_con_errores;
    $('kpiLineas').textContent = data.kpis.lineas_con_error + ' / ' + data.kpis.lineas_totales;
    $('kpiPlacas').textContent = data.kpis.placas_escaneadas + ' / ' + data.kpis.placas_esperadas;
    $('kpiDiscrepancias').textContent = data.kpis.total_discrepancias;
    $('kpiOK').textContent = data.kpis.ifs_ok;
  } catch (e) {
    showToast('Error cargando KPIs: ' + e.message, 'error');
  }
}

// =================== IFs MAL SACADAS ===================
async function cargarMalSacadas() {
  const tbody = $('tbodyMalSacadas');
  tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Cargando…</div></td></tr>';
  try {
    const params = new URLSearchParams({ desde: state.desde, hasta: state.hasta });
    if (state.sucursal) params.append('sucursal', state.sucursal);
    const data = await apiFetch('/api/dashboard/ifs-mal-sacadas?' + params);
    $('badCount').textContent = data.total;
    if (data.ifs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">✅ Sin IFs mal sacadas en este período</div></td></tr>';
      return;
    }
    tbody.innerHTML = '';
    data.ifs.forEach(i => {
      const tr = el('tr');
      tr.innerHTML = `
        <td><strong>${escapeHTML(i.tranid)}</strong></td>
        <td>${escapeHTML(i.so || '—')}</td>
        <td>${escapeHTML(i.location || '—')}</td>
        <td>${escapeHTML(i.operador || '—')}</td>
        <td>${i.discrepancias.length}</td>
        <td>${(i.tipos_error || []).map(t => badgeTipo(t)).join(' ')}</td>
        <td><button class="btn btn-ghost" onclick="verDetalle('${i.tranid}')">Ver detalle</button></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Error: ${escapeHTML(e.message)}</div></td></tr>`;
  }
}

// =================== DETALLE ===================
async function verDetalle(tranid) {
  $('detalleTitle').textContent = 'Detalle de ' + tranid;
  $('detalleBody').innerHTML = '<div class="empty-state">Cargando…</div>';
  $('detalleModal').style.display = 'flex';
  try {
    const params = new URLSearchParams({ desde: state.desde, hasta: state.hasta });
    if (state.sucursal) params.append('sucursal', state.sucursal);
    const data = await apiFetch(`/api/dashboard/if/${encodeURIComponent(tranid)}/detalle?` + params);
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
      <div><strong>SO origen:</strong> ${escapeHTML(ifDoc.sourceDoc || '—')}</div>
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
    html.push(`
      <div class="detalle-section">
        <h4>Discrepancias (${ifDoc.discrepancias.length})</h4>
    `);
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
      } else if (d.tipo === 'sin_medidas') {
        detalle = d.mensaje;
      }
      html.push(`<div style="margin: 4px 0;">${badgeTipo(d.tipo)} ${escapeHTML(detalle)}</div>`);
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
  tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Cargando…</div></td></tr>';
  try {
    const params = new URLSearchParams({ desde: state.desde, hasta: state.hasta });
    if (state.sucursal) params.append('sucursal', state.sucursal);
    const tipo = $('filtroTipoDisc').value;
    if (tipo) params.append('tipo', tipo);
    const data = await apiFetch('/api/dashboard/discrepancias?' + params);
    $('discCount').textContent = data.total;
    if (data.discrepancias.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Sin discrepancias</div></td></tr>';
      return;
    }
    tbody.innerHTML = '';
    data.discrepancias.slice(0, 200).forEach(d => {
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
        <td>${escapeHTML(d.if_so || '—')}</td>
        <td>${escapeHTML(d.if_location || '—')}</td>
        <td>${escapeHTML(d.sku || '—')}</td>
        <td>${escapeHTML(d.lote || '—')}</td>
        <td>${badgeTipo(d.tipo)}</td>
        <td>${escapeHTML(detalle)}</td>
      `;
      tbody.appendChild(tr);
    });
    if (data.discrepancias.length > 200) {
      tbody.appendChild(el('tr', {}, el('td', { colspan: '7', class: 'empty-state' }, `(mostrando primeras 200 de ${data.total})`)));
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Error: ${escapeHTML(e.message)}</div></td></tr>`;
  }
}

// =================== TOP ERRORES ===================
async function cargarTopErrores() {
  try {
    const params = new URLSearchParams({ desde: state.desde, hasta: state.hasta });
    if (state.sucursal) params.append('sucursal', state.sucursal);

    const [skus, lotes, operadores] = await Promise.all([
      apiFetch('/api/dashboard/top-errores?' + params + '&dimension=sku'),
      apiFetch('/api/dashboard/top-errores?' + params + '&dimension=lote'),
      apiFetch('/api/dashboard/top-errores?' + params + '&dimension=operador')
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
  tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">Cargando…</div></td></tr>';
  try {
    const params = new URLSearchParams({ desde: state.desde, hasta: state.hasta, limit: '50' });
    if (state.sucursal) params.append('sucursal', state.sucursal);
    const data = await apiFetch('/api/dashboard/ifs-ok?' + params);
    $('okCount').textContent = data.total;
    if (data.ifs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">Sin IFs OK en este período</div></td></tr>';
      return;
    }
    tbody.innerHTML = '';
    data.ifs.forEach(i => {
      const tr = el('tr');
      tr.innerHTML = `
        <td><strong>${escapeHTML(i.tranid)}</strong></td>
        <td>${escapeHTML(i.so || '—')}</td>
        <td>${escapeHTML(i.location || '—')}</td>
        <td>${escapeHTML(i.operador || '—')}</td>
        <td>${i.total_lineas}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Error: ${escapeHTML(e.message)}</div></td></tr>`;
  }
}

// =================== INIT ===================
document.addEventListener('DOMContentLoaded', () => {
  const token = getToken();
  if (token) {
    const user = JSON.parse(localStorage.getItem('wms_user') || '{}');
    $('currentUserName').textContent = user.nombre || user.email || 'Usuario';
    $('currentUserLocation').textContent = user.ubicacion_nombre || 'N/A';
    $('currentUserRole').textContent = user.cargo || 'N/A';
    $('loginContainer').style.display = 'none';
    $('mainApp').style.display = 'block';
    initFiltrosDefault();
    cargarTodo();
  }
});
