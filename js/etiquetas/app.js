/**
 * WMS Etiquetas — Entry point
 *
 * Página de impresión de etiquetas Zebra para jefe de almacén y admin.
 * Asume sesión activa (login en index.html). Si no hay token o el rol no está
 * permitido, redirige.
 */

// =================== CONFIG ===================
const BACKEND_URL = window.APP_CONFIG?.BACKEND_URL || 'http://localhost:3001';
if (!window.APP_CONFIG?.BACKEND_URL) {
  console.error('APP_CONFIG.BACKEND_URL no definido. Verifica js/config.js.');
}

// =================== ESTADO ===================
const state = {
  existencias: [],
  ubicaciones: [],
  seleccion: null,       // fila de existencias seleccionada
  pedimento: null,       // pedimento único (string) o null
  ir: null,
  pedimentos: [],        // lista de opciones cuando multiple
  multiple: false,
  zpl: null
};

// =================== HELPERS ===================
function $(id) { return document.getElementById(id); }

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
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

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

async function request(path, opts = {}) {
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
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function apiFetch(path, opts = {}) {
  const { status, data } = await request(path, opts);
  if (!resOk(status)) {
    throw new Error(data.error || `Error ${status}`);
  }
  return data;
}

function resOk(status) { return status >= 200 && status < 300; }

function maxEtiquetas(fila) {
  const totalM2 = parseFloat(fila.totalM2) || 0;
  const fisico = parseFloat(fila.fisico) || 0;
  if (!totalM2 || totalM2 <= 0) return 1;
  return Math.max(1, Math.floor(fisico / totalM2));
}

// =================== CARGA DE EXISTENCIAS ===================
async function loadExistencias() {
  try {
    const data = await apiFetch('/api/etiquetas/existencias');
    state.existencias = data.existencias || [];

    const set = new Set();
    state.existencias.forEach(e => { if (e.ubicacion) set.add(e.ubicacion); });
    state.ubicaciones = Array.from(set).sort();

    const sel = $('filtroUbicacion');
    const actual = sel.value;
    sel.innerHTML = '<option value="">Todas</option>' +
      state.ubicaciones.map(u => `<option value="${escapeHTML(u)}">${escapeHTML(u)}</option>`).join('');
    sel.value = actual;

    aplicarFiltros();
    showToast(`Existencias cargadas: ${state.existencias.length}`, 'success');
  } catch (e) {
    showToast('Error cargando existencias: ' + e.message, 'error');
  }
}

function aplicarFiltros() {
  const ubicacion = $('filtroUbicacion').value;
  const sku = $('filtroSku').value.trim().toLowerCase();

  const filas = state.existencias.filter(e => {
    if (ubicacion && e.ubicacion !== ubicacion) return false;
    if (sku && !(e.sku || '').toLowerCase().includes(sku)) return false;
    return true;
  });

  $('countExist').textContent = filas.length;
  renderTabla(filas);
}

function renderTabla(filas) {
  const tbody = $('tbodyExistencias');
  if (filas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Sin resultados</div></td></tr>';
    return;
  }

  tbody.innerHTML = filas.map(f => {
    const max = maxEtiquetas(f);
    const seleccionado = state.seleccion && state.seleccion.internalid === f.internalid;
    return `<tr class="seleccionable${seleccionado ? ' seleccionado' : ''}" data-internalid="${escapeHTML(f.internalid)}">
      <td>${escapeHTML(f.sku)}</td>
      <td>${escapeHTML(f.descripcion)}</td>
      <td>${escapeHTML(f.lote)}</td>
      <td>${escapeHTML(f.ubicacion)}</td>
      <td>${escapeHTML(f.fisico)}</td>
      <td>${escapeHTML(f.totalM2)}</td>
      <td>${max}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr.seleccionable').forEach(tr => {
    tr.addEventListener('click', () => selectRow(tr.dataset.internalid));
  });
}

// =================== SELECCIÓN ===================
function selectRow(internalid) {
  const fila = state.existencias.find(e => String(e.internalid) === String(internalid));
  if (!fila) return;

  state.seleccion = fila;
  state.pedimento = null;
  state.ir = null;
  state.pedimentos = [];
  state.multiple = false;
  state.zpl = null;

  // Detalle
  $('detalleVacio').style.display = 'none';
  $('detalleContenido').style.display = 'block';
  $('dSku').textContent = fila.sku || '–';
  $('dDescripcion').textContent = fila.descripcion || '–';
  $('dLote').textContent = fila.lote || '–';
  $('dUbicacion').textContent = fila.ubicacion || '–';
  $('dFisico').textContent = fila.fisico ?? '–';
  $('dTotalM2').textContent = fila.totalM2 ?? '–';

  const max = maxEtiquetas(fila);
  $('cantidad').max = max;
  $('cantidad').value = 1;
  $('cantidadHint').textContent = `Máx: ${max} etiquetas (físico / m² por pieza)`;

  $('pedimentoBox').innerHTML = '<span style="color:#6b7280;font-size:13px;">Consultando pedimento…</span>';
  $('previewBox').style.display = 'none';
  $('zplPreview').textContent = '';

  renderTabla(aplicarFiltrosFilas());

  fetchPedimento(fila);
}

function aplicarFiltrosFilas() {
  const ubicacion = $('filtroUbicacion').value;
  const sku = $('filtroSku').value.trim().toLowerCase();
  return state.existencias.filter(e => {
    if (ubicacion && e.ubicacion !== ubicacion) return false;
    if (sku && !(e.sku || '').toLowerCase().includes(sku)) return false;
    return true;
  });
}

// =================== PEDIMENTO ===================
async function fetchPedimento(fila) {
  try {
    const { status, data } = await request('/api/etiquetas/pedimento', {
      method: 'POST',
      body: JSON.stringify({
        lote: fila.lote,
        ubicacion: fila.ubicacion,
        ubicacionId: fila.ubicacionId
      })
    });

    if (!resOk(status)) {
      throw new Error(data.error || `Error ${status}`);
    }

    state.pedimento = data.pedimento || null;
    state.ir = data.ir || null;
    state.pedimentos = data.pedimentos || [];
    state.multiple = !!data.multiple;

    renderPedimento(data);
  } catch (e) {
    state.pedimento = null;
    state.multiple = false;
    $('pedimentoBox').innerHTML = `<div class="pedimento-warning">Error: ${escapeHTML(e.message)}</div>`;
  }
}

function renderPedimento(data) {
  const box = $('pedimentoBox');

  if (data.multiple) {
    const opciones = (data.pedimentos || []).map(p =>
      `<option value="${escapeHTML(p.pedimento)}">${escapeHTML(p.pedimento)} · ${escapeHTML(p.ubicacion || p.ir || '')}</option>`
    ).join('');
    box.innerHTML = `
      <div class="pedimento-warning">⚠️ ${escapeHTML(data.warning || 'Múltiples pedimentos')}</div>
      <select id="pedimentoSelect">${opciones}</select>`;
    return;
  }

  if (data.pedimento) {
    box.innerHTML = `<div class="pedimento-valor">${escapeHTML(data.pedimento)}</div>` +
      (data.ir ? `<small style="color:#6b7280;">IR: ${escapeHTML(data.ir)}</small>` : '');
    return;
  }

  box.innerHTML = `<div class="pedimento-warning">${escapeHTML(data.warning || 'No se encontró un pedimento para este lote')}</div>`;
}

function pedimentoSeleccionado() {
  if (!state.multiple) return state.pedimento;
  const sel = $('pedimentoSelect');
  return sel ? sel.value : null;
}

// =================== ZPL ===================
async function generarZpl() {
  const fila = state.seleccion;
  if (!fila) { showToast('Selecciona un artículo', 'error'); return; }

  const cantidad = parseInt($('cantidad').value, 10);
  const max = maxEtiquetas(fila);
  if (!Number.isInteger(cantidad) || cantidad < 1) {
    showToast('Cantidad inválida', 'error');
    return;
  }
  if (cantidad > max) {
    showToast(`La cantidad máxima es ${max}`, 'error');
    return;
  }

  try {
    const { status, data } = await request('/api/etiquetas/zpl', {
      method: 'POST',
      body: JSON.stringify({
        sku: fila.sku,
        lote: fila.lote,
        ubicacion: fila.ubicacion,
        cantidad,
        pedimento: pedimentoSeleccionado() || undefined
      })
    });

    if (status === 409) {
      state.multiple = true;
      state.pedimentos = data.pedimentos || [];
      renderPedimento({ multiple: true, pedimentos: state.pedimentos, warning: data.warning });
      showToast('Selecciona el pedimento a imprimir', 'error');
      return;
    }

    if (!resOk(status)) {
      showToast(data.error || 'Error generando ZPL', 'error');
      return;
    }

    state.zpl = data.zpl;
    if (data.warning) showToast(data.warning, 'info');

    $('previewBox').style.display = 'block';
    $('zplPreview').textContent = data.zpl;
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// =================== IMPRESIÓN USB ===================
async function imprimir() {
  if (!state.zpl) {
    await generarZpl();
    if (!state.zpl) return;
  }

  if (!navigator.usb) {
    showToast('Este navegador no soporta WebUSB. Usa Chromium/Edge.', 'error');
    return;
  }

  try {
    showToast('Solicitando acceso al puerto USB…', 'info');
    const device = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x0a5f }] });

    await device.open();
    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }
    await device.claimInterface(0);

    let endpointOut = null;
    for (const ep of device.configuration.interfaces[0].alternate.endpoints) {
      if (ep.direction === 'out') { endpointOut = ep.endpointNumber; break; }
    }
    if (!endpointOut) {
      throw new Error('No se encontró un canal de salida en la impresora');
    }

    const dataBytes = new TextEncoder().encode(state.zpl);
    await device.transferOut(endpointOut, dataBytes);
    await device.close();

    showToast('Impresión enviada correctamente', 'success');
  } catch (e) {
    if (e.name === 'NotFoundError') {
      showToast('No se seleccionó ninguna impresora', 'error');
    } else {
      showToast('Error de impresión: ' + e.message, 'error');
    }
    console.error('Detalles WebUSB:', e);
  }
}

// =================== INIT ===================
document.addEventListener('DOMContentLoaded', async () => {
  const token = getToken();
  if (!token) {
    window.location.href = 'index.html';
    return;
  }

  const user = getCurrentUser();
  const rol = user?.rol || user?.cargo;

  // Gating por rol: solo jefe_almacen y admin
  if (rol !== 'jefe_almacen' && rol !== 'admin') {
    window.location.href = 'index.html';
    return;
  }

  if (user) {
    $('currentUserName').textContent = user.nombre || user.email || 'Usuario';
    $('currentUserLocation').textContent = user.ubicacion?.nombre || 'N/A';
    $('currentUserRole').textContent = getRoleLabel(rol);
  }

  $('mainApp').style.display = 'block';
  loadExistencias();
});
