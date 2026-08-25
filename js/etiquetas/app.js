/**
 * WMS Etiquetas — Entry point
 *
 * Flujo: buscar existencias (paginado 10/pág.) → agregar lotes a un "carrito"
 * con la cantidad de etiquetas a imprimir de cada uno → imprimir todo por USB.
 * Mantiene las líneas seleccionadas mientras se vuelve a buscar.
 */

// =================== CONFIG ===================
const BACKEND_URL = window.APP_CONFIG?.BACKEND_URL || 'http://localhost:3001';
if (!window.APP_CONFIG?.BACKEND_URL) {
  console.error('APP_CONFIG.BACKEND_URL no definido. Verifica js/config.js.');
}

// =================== ESTADO ===================
const state = {
  existencias: [],        // todas las filas (ya filtradas por rol en backend)
  ubicaciones: [],
  filtroTexto: '',
  filtroUbicacion: '',
  pagina: 1
};

const carrito = [];       // { internalid, sku, descripcion, lote, ubicacion, ubicacionId, fisico, totalM2,
                          //   cantidad, pedimento, pedimentos, multiple, selectedPedimento, estado }

/**
 * Tamaño de página adaptativo: filas que caben en la altura disponible de la
 * tabla (aprox. 46px por fila), mínimo 8, para rellenar bien el espacio.
 */
function pageSize() {
  const wrap = document.querySelector('.results-card .table-wrap');
  const h = wrap ? wrap.clientHeight : 480;
  return Math.max(8, Math.floor(h / 46));
}

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
  if (status < 200 || status >= 300) throw new Error(data.error || `Error ${status}`);
  return data;
}

function maxEtiquetas(fila) {
  const totalM2 = parseFloat(fila.totalM2) || 0;
  const fisico = parseFloat(fila.fisico) || 0;
  if (!totalM2 || totalM2 <= 0) return 1;
  return Math.max(1, Math.floor(fisico / totalM2));
}

function enCarrito(internalid) {
  return carrito.some(i => String(i.internalid) === String(internalid));
}

// =================== CARGA INICIAL ===================
async function loadExistencias() {
  try {
    const data = await apiFetch('/api/etiquetas/existencias');
    state.existencias = data.existencias || [];

    const set = new Set();
    state.existencias.forEach(e => { if (e.ubicacion) set.add(e.ubicacion); });
    state.ubicaciones = Array.from(set).sort();

    const sel = $('filtroUbicacion');
    sel.innerHTML = '<option value="">Todas las ubicaciones</option>' +
      state.ubicaciones.map(u => `<option value="${escapeHTML(u)}">${escapeHTML(u)}</option>`).join('');

    buscar();
    showToast(`Existencias cargadas (${state.existencias.length})`, 'success');
  } catch (e) {
    showToast('Error cargando existencias: ' + e.message, 'error');
  }
}

// =================== BÚSQUEDA Y PAGINACIÓN ===================
function filtrados() {
  const texto = state.filtroTexto.toLowerCase();
  return state.existencias.filter(e => {
    if (state.filtroUbicacion && e.ubicacion !== state.filtroUbicacion) return false;
    if (!texto) return true;
    return (e.sku || '').toLowerCase().includes(texto) ||
           (e.lote || '').toLowerCase().includes(texto) ||
           (e.descripcion || '').toLowerCase().includes(texto);
  });
}

function buscar() {
  state.filtroTexto = $('searchInput').value.trim();
  state.filtroUbicacion = $('filtroUbicacion').value;
  state.pagina = 1;
  renderResultados();
}

function limpiarBusqueda() {
  $('searchInput').value = '';
  $('filtroUbicacion').value = '';
  buscar();
}

function cambiarPagina(delta) {
  const total = filtrados().length;
  const totalPaginas = Math.max(1, Math.ceil(total / pageSize()));
  state.pagina = Math.min(Math.max(1, state.pagina + delta), totalPaginas);
  renderResultados();
}

function renderResultados() {
  const ps = pageSize();
  const filas = filtrados();
  const totalPaginas = Math.max(1, Math.ceil(filas.length / ps));
  state.pagina = Math.min(state.pagina, totalPaginas);

  const start = (state.pagina - 1) * ps;
  const pagina = filas.slice(start, start + ps);

  $('countResult').textContent = filas.length;
  const tbody = $('tbodyResult');

  if (filas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">Sin resultados. Ajusta la búsqueda.</div></td></tr>';
  } else {
    tbody.innerHTML = pagina.map(f => {
      const max = maxEtiquetas(f);
      const agregado = enCarrito(f.internalid);
      return `<tr>
        <td class="sku-cell">${escapeHTML(f.sku)}</td>
        <td class="descripcion-cell">${escapeHTML(f.descripcion)}</td>
        <td class="lote-cell">${escapeHTML(f.lote)}</td>
        <td>${escapeHTML(f.ubicacion)}</td>
        <td class="num">${escapeHTML(f.fisico)}</td>
        <td class="num">${escapeHTML(f.totalM2)}</td>
        <td class="num">${max}</td>
        <td class="num">
          <button class="btn-agregar${agregado ? ' agregado' : ''}" data-id="${escapeHTML(f.internalid)}"
            ${agregado ? 'disabled' : ''} onclick="agregarAlCarrito('${escapeHTML(f.internalid)}')">
            ${agregado ? '✓ Agregado' : '+ Agregar'}
          </button>
        </td>
      </tr>`;
    }).join('');
  }

  // Paginación
  const pag = $('pagination');
  if (filas.length > pageSize()) {
    pag.style.display = 'flex';
    $('pageInfo').textContent = `Página ${state.pagina} de ${totalPaginas}`;
    $('btnPrev').disabled = state.pagina <= 1;
    $('btnNext').disabled = state.pagina >= totalPaginas;
  } else {
    pag.style.display = 'none';
  }
}

// =================== CARRITO ===================
async function agregarAlCarrito(internalid) {
  if (enCarrito(internalid)) return;

  const fila = state.existencias.find(e => String(e.internalid) === String(internalid));
  if (!fila) return;

  const item = {
    internalid: fila.internalid,
    sku: fila.sku,
    descripcion: fila.descripcion,
    lote: fila.lote,
    ubicacion: fila.ubicacion,
    ubicacionId: fila.ubicacionId,
    fisico: fila.fisico,
    totalM2: fila.totalM2,
    cantidad: 1,
    pedimento: null,
    pedimentos: [],
    multiple: false,
    selectedPedimento: null,
    estado: 'cargando'
  };

  carrito.push(item);
  renderCarrito();
  renderResultados();   // marcar la fila como "agregada" en la tabla
  actualizarBotones();

  // Buscar pedimento
  try {
    const { status, data } = await request('/api/etiquetas/pedimento', {
      method: 'POST',
      body: JSON.stringify({ lote: item.lote, ubicacion: item.ubicacion, ubicacionId: item.ubicacionId })
    });

    if (status < 200 || status >= 300) {
      throw new Error(data.error || `Error ${status}`);
    }

    item.pedimento = data.pedimento || null;
    item.pedimentos = data.pedimentos || [];
    item.multiple = !!data.multiple;
    item.selectedPedimento = item.multiple ? null : item.pedimento;
    item.estado = 'listo';
  } catch (e) {
    item.estado = 'error';
    item.error = e.message;
  }

  renderCarrito();
  renderResultados();
  actualizarBotones();
}

function eliminarDelCarrito(internalid) {
  const idx = carrito.findIndex(i => String(i.internalid) === String(internalid));
  if (idx >= 0) carrito.splice(idx, 1);
  renderCarrito();
  renderResultados();
  actualizarBotones();
}

function vaciarCarrito() {
  carrito.length = 0;
  renderCarrito();
  renderResultados();
  actualizarBotones();
}

function cambiarCantidad(internalid, delta) {
  const item = carrito.find(i => String(i.internalid) === String(internalid));
  if (!item) return;
  const max = maxEtiquetas(item);
  item.cantidad = Math.min(Math.max(1, item.cantidad + delta), max);
  renderCarrito();
  actualizarBotones();
}

function setCantidad(internalid, valor) {
  const item = carrito.find(i => String(i.internalid) === String(internalid));
  if (!item) return;
  const max = maxEtiquetas(item);
  let n = parseInt(valor, 10);
  if (!Number.isInteger(n) || n < 1) n = 1;
  item.cantidad = Math.min(n, max);
  renderCarrito();
  actualizarBotones();
}

function cambiarPedimento(internalid, valor) {
  const item = carrito.find(i => String(i.internalid) === String(internalid));
  if (!item) return;
  item.selectedPedimento = valor;
  actualizarBotones();
}

function renderCarrito() {
  const list = $('cartList');

  if (carrito.length === 0) {
    list.innerHTML = '<div class="cart-empty">' +
      '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4"/><path d="M9 12h6M9 16h6"/></svg>' +
      'Agrega artículos desde los resultados</div>';
    return;
  }

  list.innerHTML = carrito.map(item => {
    const max = maxEtiquetas(item);
    const pedHTML = renderPedimentoHTML(item);
    return `<div class="cart-item">
      <div class="cart-item-top">
        <div>
          <div class="cart-item-sku">${escapeHTML(item.sku)}</div>
          <div class="cart-item-lote">${escapeHTML(item.lote)}</div>
          <div class="cart-item-desc">${escapeHTML(item.descripcion)}</div>
        </div>
        <button class="cart-item-remove" onclick="eliminarDelCarrito('${escapeHTML(item.internalid)}')" title="Quitar">✕</button>
      </div>
      <div class="cart-item-meta">
        <span class="cart-item-ubicacion">${escapeHTML(item.ubicacion)}</span>
        <span class="qty-max">Máx ${max}</span>
      </div>
      ${pedHTML}
      <div class="cart-item-qty">
        <div class="qty-stepper">
          <button onclick="cambiarCantidad('${escapeHTML(item.internalid)}',-1)" ${item.cantidad <= 1 ? 'disabled' : ''}>−</button>
          <input type="number" value="${item.cantidad}" min="1" max="${max}"
            onchange="setCantidad('${escapeHTML(item.internalid)}',this.value)" />
          <button onclick="cambiarCantidad('${escapeHTML(item.internalid)}',1)" ${item.cantidad >= max ? 'disabled' : ''}>+</button>
        </div>
      </div>
    </div>`;
  }).join('');

  const total = carrito.reduce((acc, i) => acc + i.cantidad, 0);
  $('cartTotal').textContent = total;
  $('countCart').textContent = carrito.length;
}

function renderPedimentoHTML(item) {
  if (item.estado === 'cargando') {
    return '<div class="cart-item-loading">Consultando pedimento…</div>';
  }
  if (item.estado === 'error') {
    return `<div class="cart-item-error">${escapeHTML(item.error || 'Error al consultar pedimento')}</div>`;
  }

  if (item.multiple) {
    const opts = item.pedimentos.map(p =>
      `<option value="${escapeHTML(p.pedimento)}" ${String(item.selectedPedimento) === String(p.pedimento) ? 'selected' : ''}>${escapeHTML(p.pedimento)} · ${escapeHTML(p.ubicacion || '')}</option>`
    ).join('');
    return `<div class="cart-item-pedimento">
      <div class="cart-item-pedimento-label"><span class="warning">⚠️</span> Selecciona pedimento</div>
      <select onchange="cambiarPedimento('${escapeHTML(item.internalid)}',this.value)">${opts}</select>
    </div>`;
  }

  if (item.pedimento) {
    return `<div class="cart-item-pedimento">
      <div class="cart-item-pedimento-label">Pedimento</div>
      <div class="cart-item-pedimento-valor">${escapeHTML(item.pedimento)}</div>
    </div>`;
  }

  return `<div class="cart-item-pedimento">
    <div class="cart-item-pedimento-label"><span class="warning">⚠️</span> Sin pedimento</div>
    <div class="cart-item-pedimento-valor sin-pedimento">No se encontró pedimento. La etiqueta se imprimirá sin pedimento.</div>
  </div>`;
}

function actualizarBotones() {
  const btn = $('btnImprimir');
  const tieneItems = carrito.length > 0 &&
    carrito.every(i => i.estado === 'listo' && (!i.multiple || i.selectedPedimento));
  btn.disabled = !tieneItems || carrito.length === 0;
  $('cartTotal').textContent = carrito.reduce((acc, i) => acc + i.cantidad, 0);
}

// =================== IMPRESIÓN ===================
async function imprimirTodo() {
  if (carrito.length === 0) { showToast('No hay etiquetas seleccionadas', 'error'); return; }

  const faltante = carrito.find(i => i.multiple && !i.selectedPedimento);
  if (faltante) {
    showToast(`Selecciona el pedimento del lote ${faltante.lote}`, 'error');
    return;
  }

  showToast('Generando etiquetas…', 'info');

  // Generar ZPL de cada artículo y concatenar
  let zplFinal = '';
  let total = 0;
  const errores = [];

  for (const item of carrito) {
    try {
      const { status, data } = await request('/api/etiquetas/zpl', {
        method: 'POST',
        body: JSON.stringify({
          sku: item.sku,
          lote: item.lote,
          ubicacion: item.ubicacion,
          cantidad: item.cantidad,
          pedimento: item.selectedPedimento || undefined
        })
      });

      if (status < 200 || status >= 300) {
        throw new Error(data.error || `Error ${status}`);
      }
      zplFinal += data.zpl || '';
      total += item.cantidad;
    } catch (e) {
      errores.push(`${item.sku} ${item.lote}: ${e.message}`);
    }
  }

  if (!zplFinal) {
    showToast('No se pudo generar ninguna etiqueta', 'error');
    if (errores.length) console.error(errores);
    return;
  }

  if (errores.length) {
    showToast(`${total} generadas, ${errores.length} con error`, 'info');
  }

  // WebUSB solo existe en Chromium (Chrome/Edge) y en contexto seguro (HTTPS/localhost).
  if (!navigator.usb) {
    showToast(mensajeNoWebUSB(), 'error');
    descargarZPL(zplFinal); // respaldo para comprobar que la etiqueta sí se generó
    return;
  }

  await enviarZpl(zplFinal);
}

/**
 * Devuelve un mensaje claro según el navegador cuando WebUSB no está disponible.
 */
function mensajeNoWebUSB() {
  const ua = navigator.userAgent.toUpperCase();
  if (ua.includes('FIREFOX')) {
    return 'Firefox no soporta WebUSB. Usa Chrome o Edge e imprime desde ahí. Se descargó el .zpl como respaldo.';
  }
  return 'WebUSB requiere contexto seguro. Sobre http://IP activa chrome://flags/#unsafely-treat-insecure-origin-as-secure. Se descargó el .zpl como respaldo.';
}

/**
 * Descarga el ZPL generado como archivo local (fallback).
 */
function descargarZPL(zplData) {
  const blob = new Blob([zplData], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'etiquetas.zpl';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function enviarZpl(zplData) {
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
    if (!endpointOut) throw new Error('No se encontró un canal de salida');

    const dataBytes = new TextEncoder().encode(zplData);
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
  if (!token) { window.location.href = 'index.html'; return; }

  const user = getCurrentUser();
  const rol = user?.rol || user?.cargo;
  if (rol !== 'jefe_almacen' && rol !== 'admin') {
    window.location.href = 'index.html';
    return;
  }

  if (user) {
    $('currentUserName').textContent = user.nombre || user.email || 'Usuario';
    $('currentUserLocation').textContent = user.ubicacion?.nombre || 'N/A';
    $('currentUserRole').textContent = getRoleLabel(rol);
  }

  $('mainApp').style.display = 'flex';

  // Buscar con Enter
  $('searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') buscar();
  });

  // Re-paginar al cambiar el tamaño del navegador
  window.addEventListener('resize', () => renderResultados());

  loadExistencias();
});
