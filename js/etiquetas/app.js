/**
 * WMS Etiquetas — Entry point
 *
 * Flujo Dual:
 * 1. Por Stock / Lote: buscar existencias (paginado) → agregar lotes a un "carrito" → imprimir por USB.
 * 2. Por Recepción (IR): listar recepciones recientes / buscar por Folio IR, Embarque o Pedimento
 *    → previsualizar lotes con placas calculadas → ajustar cantidades → imprimir todo directo o agregar al carrito.
 */

// =================== CONFIG ===================
/**
 * Resuelve la URL del backend: usa la config si es remota; si no, deriva
 * del host desde el que se sirvió la página (mismo host, puerto 3001).
 */
function resolveBackendURL() {
  const cfg = window.APP_CONFIG?.BACKEND_URL;
  if (cfg && !cfg.includes('localhost')) return cfg;
  return `http://${window.location.hostname}:3001`;
}

const BACKEND_URL = resolveBackendURL();
if (!window.APP_CONFIG?.BACKEND_URL) {
  console.error('APP_CONFIG.BACKEND_URL no definido. Verifica js/config.js.');
}

// =================== ESTADO ===================
const state = {
  modo: 'stock',          // 'stock' | 'ir'
  existencias: [],        // todas las filas de existencias
  irs: [],                // lista de IRs recientes / filtradas
  selectedIR: null,       // objeto de IR seleccionada para el modal
  ubicaciones: [],
  filtroTexto: '',
  filtroUbicacion: '',
  pagina: 1
};

const carrito = [];       // { internalid, sku, descripcion, lote, ubicacion, ubicacionId, fisico, totalM2,
                          //   cantidad, pedimento, pedimentos, multiple, selectedPedimento, estado, embarque }

/**
 * Tamaño de página adaptativo para la tabla de stock
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

// =================== CONTROL DE PESTAÑAS (MODOS) ===================
function switchModo(modo) {
  if (state.modo === modo) return;
  state.modo = modo;

  $('tabStock').classList.toggle('active', modo === 'stock');
  $('tabIR').classList.toggle('active', modo === 'ir');

  $('viewStock').style.display = modo === 'stock' ? 'block' : 'none';
  $('viewIR').style.display = modo === 'ir' ? 'block' : 'none';

  $('titleResultados').textContent = modo === 'stock'
    ? 'Resultados de Existencias'
    : 'Recepciones Recientes (IR)';

  $('searchInput').placeholder = modo === 'stock'
    ? 'Buscar por SKU, lote o descripción en stock…'
    : 'Buscar por Folio IR (ej. 879, IR879), Embarque o Pedimento…';

  $('searchInput').value = '';
  state.filtroTexto = '';

  if (modo === 'ir') {
    if (state.irs.length === 0) {
      loadIRs();
    } else {
      renderIRs();
    }
  } else {
    buscar();
  }
}

// =================== CARGA DE DATOS ===================
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

async function loadIRs(query = '') {
  try {
    const tbody = $('tbodyIR');
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">Consultando recepciones de NetSuite…</div></td></tr>';

    const u = state.filtroUbicacion ? `&ubicacion=${encodeURIComponent(state.filtroUbicacion)}` : '';
    const q = query ? `&q=${encodeURIComponent(query)}` : '';
    const data = await apiFetch(`/api/etiquetas/irs?limit=100${u}${q}`);
    state.irs = data.irs || [];
    renderIRs();
  } catch (e) {
    showToast('Error al consultar recepciones (IRs): ' + e.message, 'error');
    $('tbodyIR').innerHTML = `<tr><td colspan="8"><div class="empty-state error">Error: ${escapeHTML(e.message)}</div></td></tr>`;
  }
}

// =================== BÚSQUEDA ===================
function filtradosStock() {
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

  if (state.modo === 'stock') {
    state.pagina = 1;
    renderResultados();
  } else {
    loadIRs(state.filtroTexto);
  }
}

function limpiarBusqueda() {
  $('searchInput').value = '';
  $('filtroUbicacion').value = '';
  state.filtroTexto = '';
  state.filtroUbicacion = '';
  if (state.modo === 'stock') {
    buscar();
  } else {
    loadIRs('');
  }
}

function cambiarPagina(delta) {
  const total = filtradosStock().length;
  const totalPaginas = Math.max(1, Math.ceil(total / pageSize()));
  state.pagina = Math.min(Math.max(1, state.pagina + delta), totalPaginas);
  renderResultados();
}

// =================== RENDER VISTA STOCK ===================
function renderResultados() {
  const ps = pageSize();
  const filas = filtradosStock();
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

  // Paginación de stock
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

// =================== RENDER VISTA RECEPCIONES (IR) ===================
function renderIRs() {
  const tbody = $('tbodyIR');
  const irs = state.irs;
  $('countResult').textContent = irs.length;

  if (!irs.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">No se encontraron recepciones de artículo.</div></td></tr>';
    $('pagination').style.display = 'none';
    return;
  }

  tbody.innerHTML = irs.map(ir => {
    const embarqueHTML = ir.embarque
      ? `<span class="tag-badge embarque-badge">${escapeHTML(ir.embarque)}</span>`
      : '<span class="sin-pedimento">—</span>';
    const pedimentoHTML = ir.pedimento
      ? `<span class="tag-badge pedimento-badge">${escapeHTML(ir.pedimento)}</span>`
      : '<span class="sin-pedimento">—</span>';

    return `<tr>
      <td><span class="ir-badge">${escapeHTML(ir.tranid)}</span></td>
      <td>${escapeHTML(ir.trandate)}</td>
      <td><strong>${escapeHTML(ir.location || '—')}</strong></td>
      <td>${embarqueHTML}</td>
      <td>${pedimentoHTML}</td>
      <td class="num">${escapeHTML(ir.totalLineas)}</td>
      <td class="num"><strong>${escapeHTML(ir.totalPlacas)}</strong></td>
      <td class="num">
        <button class="btn-ir-action" onclick="abrirDetalleIR('${escapeHTML(ir.tranid)}')">
          🔍 Ver / Imprimir
        </button>
      </td>
    </tr>`;
  }).join('');

  $('pagination').style.display = 'none';
}

// =================== MODAL DETALLE DE IR ===================
async function abrirDetalleIR(idOrTranid) {
  try {
    showToast('Cargando detalle de la recepción…', 'info');
    const data = await apiFetch(`/api/etiquetas/ir/${encodeURIComponent(idOrTranid)}`);
    const ir = data.ir;
    if (!ir) throw new Error('No se recibió la información de la IR');

    state.selectedIR = {
      ...ir,
      lineas: (ir.lineas || []).map(l => ({
        ...l,
        selected: true,
        cantidadAImprimir: l.placas || 1
      }))
    };

    $('modalIRTranid').textContent = ir.tranid;
    $('modalIRFecha').textContent = ir.trandate || '--/--/----';
    $('modalIRUbicacion').textContent = ir.location || 'Ubicación no especificada';
    $('modalIREmbarque').textContent = ir.embarque ? `Embarque: ${ir.embarque}` : 'Sin embarque';
    $('modalIRPedimento').textContent = ir.pedimento ? `Pedimento: ${ir.pedimento}` : 'Sin pedimento';
    $('chkSelectAllIR').checked = true;

    renderModalIRLineas();
    $('modalIR').style.display = 'flex';
  } catch (e) {
    showToast('Error al abrir detalle de IR: ' + e.message, 'error');
  }
}

function cerrarDetalleIR() {
  $('modalIR').style.display = 'none';
  state.selectedIR = null;
}

function renderModalIRLineas() {
  const ir = state.selectedIR;
  if (!ir) return;

  const tbody = $('tbodyIRLineas');
  if (!ir.lineas.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Esta IR no tiene líneas registradas.</div></td></tr>';
    actualizarResumenModalIR();
    return;
  }

  tbody.innerHTML = ir.lineas.map((l, idx) => {
    const medidas = (l.largo && l.alto) ? `(${l.largo} × ${l.alto} m)` : '';
    return `<tr>
      <td style="text-align: center;">
        <input type="checkbox" ${l.selected ? 'checked' : ''} onchange="toggleIRLine(${idx}, this.checked)" />
      </td>
      <td class="sku-cell">${escapeHTML(l.sku)}</td>
      <td class="descripcion-cell">${escapeHTML(l.descripcion)}</td>
      <td class="lote-cell">
        <strong>${escapeHTML(l.lote)}</strong>
        ${medidas ? `<div class="sub-meta">${escapeHTML(medidas)}</div>` : ''}
      </td>
      <td class="num">${escapeHTML(l.cantidadM2)} m²</td>
      <td class="num">${escapeHTML(l.totalM2)} m²</td>
      <td class="num">
        <div class="qty-stepper" style="justify-content: flex-end;">
          <button onclick="cambiarCantidadIRLinea(${idx}, -1)" ${l.cantidadAImprimir <= 1 ? 'disabled' : ''}>−</button>
          <input type="number" value="${l.cantidadAImprimir}" min="1" max="999"
            onchange="setCantidadIRLinea(${idx}, this.value)" style="width: 50px;" />
          <button onclick="cambiarCantidadIRLinea(${idx}, 1)">+</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  actualizarResumenModalIR();
}

function toggleSelectAllIRLines(checked) {
  if (!state.selectedIR) return;
  state.selectedIR.lineas.forEach(l => l.selected = !!checked);
  renderModalIRLineas();
}

function toggleIRLine(idx, checked) {
  if (!state.selectedIR || !state.selectedIR.lineas[idx]) return;
  state.selectedIR.lineas[idx].selected = !!checked;
  const allChecked = state.selectedIR.lineas.every(l => l.selected);
  $('chkSelectAllIR').checked = allChecked;
  actualizarResumenModalIR();
}

function cambiarCantidadIRLinea(idx, delta) {
  if (!state.selectedIR || !state.selectedIR.lineas[idx]) return;
  const linea = state.selectedIR.lineas[idx];
  linea.cantidadAImprimir = Math.max(1, (linea.cantidadAImprimir || 1) + delta);
  renderModalIRLineas();
}

function setCantidadIRLinea(idx, valor) {
  if (!state.selectedIR || !state.selectedIR.lineas[idx]) return;
  let n = parseInt(valor, 10);
  if (!Number.isInteger(n) || n < 1) n = 1;
  state.selectedIR.lineas[idx].cantidadAImprimir = n;
  actualizarResumenModalIR();
}

function actualizarResumenModalIR() {
  if (!state.selectedIR) return;
  const totalLineas = state.selectedIR.lineas.length;
  const selectedLines = state.selectedIR.lineas.filter(l => l.selected);
  const totalPlacas = selectedLines.reduce((acc, l) => acc + (l.cantidadAImprimir || 1), 0);

  $('modalIRTotalCount').textContent = totalLineas;
  $('modalIRSelectedCount').textContent = selectedLines.length;
  $('modalIRTotalPlacas').textContent = totalPlacas;

  const btnImprimir = $('btnImprimirIR');
  btnImprimir.disabled = selectedLines.length === 0;
  btnImprimir.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> 🖨️ Imprimir ${totalPlacas} Etiquetas de esta IR`;
}

// =================== ACCIONES MODAL IR ===================
async function imprimirIRDirecto() {
  if (!state.selectedIR) return;
  const ir = state.selectedIR;
  const seleccionadas = ir.lineas.filter(l => l.selected && l.cantidadAImprimir > 0);

  if (!seleccionadas.length) {
    showToast('Selecciona al menos una línea para imprimir', 'error');
    return;
  }

  showToast('Generando código ZPL masivo…', 'info');

  const items = seleccionadas.map(l => ({
    sku: l.sku,
    lote: l.lote,
    ubicacion: ir.location || '',
    descripcion: l.descripcion,
    totalM2: l.totalM2,
    pedimento: ir.pedimento || null,
    embarque: ir.embarque || null,
    cantidad: l.cantidadAImprimir
  }));

  try {
    const data = await apiFetch('/api/etiquetas/zpl-bulk', {
      method: 'POST',
      body: JSON.stringify({ items })
    });

    if (!data.zpl) {
      throw new Error('No se generó código ZPL');
    }

    if (!navigator.usb) {
      showToast(mensajeNoWebUSB(), 'error');
      descargarZPL(data.zpl);
      return;
    }

    await enviarZpl(data.zpl);
  } catch (e) {
    showToast('Error al imprimir IR: ' + e.message, 'error');
  }
}

function cargarIRAlCarrito() {
  if (!state.selectedIR) return;
  const ir = state.selectedIR;
  const seleccionadas = ir.lineas.filter(l => l.selected && l.cantidadAImprimir > 0);

  if (!seleccionadas.length) {
    showToast('Selecciona al menos una línea para agregar al carrito', 'error');
    return;
  }

  let agregadas = 0;
  for (const l of seleccionadas) {
    const cartId = `ir_${ir.id}_${l.lote}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    carrito.push({
      internalid: cartId,
      sku: l.sku,
      descripcion: l.descripcion,
      lote: l.lote,
      ubicacion: ir.location,
      ubicacionId: ir.locationId,
      fisico: l.cantidadM2,
      totalM2: l.totalM2,
      cantidad: l.cantidadAImprimir,
      pedimento: ir.pedimento || null,
      embarque: ir.embarque || null,
      pedimentos: ir.pedimento ? [{ pedimento: ir.pedimento, ubicacion: ir.location }] : [],
      multiple: false,
      selectedPedimento: ir.pedimento || null,
      estado: 'listo'
    });
    agregadas++;
  }

  cerrarDetalleIR();
  renderCarrito();
  actualizarBotones();
  showToast(`Se agregaron ${agregadas} lotes de la IR al carrito`, 'success');
}

// =================== CARRITO DE ETIQUETAS ===================
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
    embarque: null,
    pedimentos: [],
    multiple: false,
    selectedPedimento: null,
    estado: 'cargando'
  };

  carrito.push(item);
  renderCarrito();
  renderResultados();
  actualizarBotones();

  // Buscar pedimento y embarque
  try {
    const { status, data } = await request('/api/etiquetas/pedimento', {
      method: 'POST',
      body: JSON.stringify({ lote: item.lote, ubicacion: item.ubicacion, ubicacionId: item.ubicacionId })
    });

    if (status < 200 || status >= 300) {
      throw new Error(data.error || `Error ${status}`);
    }

    item.pedimento = data.pedimento || null;
    item.embarque = data.embarque || null;
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
    $('cartTotal').textContent = '0';
    $('countCart').textContent = '0';
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
  $('countCart').textContent = carrito.length;
}

// =================== IMPRESIÓN CARRITO ===================
async function imprimirTodo() {
  if (carrito.length === 0) { showToast('No hay etiquetas seleccionadas', 'error'); return; }

  const faltante = carrito.find(i => i.multiple && !i.selectedPedimento);
  if (faltante) {
    showToast(`Selecciona el pedimento del lote ${faltante.lote}`, 'error');
    return;
  }

  showToast('Generando etiquetas…', 'info');

  const items = carrito.map(item => ({
    sku: item.sku,
    lote: item.lote,
    ubicacion: item.ubicacion,
    descripcion: item.descripcion,
    totalM2: item.totalM2,
    pedimento: item.selectedPedimento || item.pedimento || null,
    embarque: item.embarque || null,
    cantidad: item.cantidad
  }));

  try {
    const data = await apiFetch('/api/etiquetas/zpl-bulk', {
      method: 'POST',
      body: JSON.stringify({ items })
    });

    if (!data.zpl) {
      throw new Error('No se generó código ZPL');
    }

    if (!navigator.usb) {
      showToast(mensajeNoWebUSB(), 'error');
      descargarZPL(data.zpl);
      return;
    }

    await enviarZpl(data.zpl);
  } catch (e) {
    showToast('Error de impresión: ' + e.message, 'error');
  }
}

function esFirefox() { return /Firefox/i.test(navigator.userAgent || ''); }
function esChromium() { return !esFirefox() && /Edg\/|Chrome\/|Chromium/i.test(navigator.userAgent || ''); }

function mensajeNoWebUSB() {
  const host = window.location.host;
  if (esFirefox()) {
    return 'Firefox no soporta WebUSB. Usa Chrome o Edge e imprime desde ahí. Se descargó el .zpl como respaldo.';
  }
  if (!window.isSecureContext && esChromium()) {
    return 'WebUSB requiere HTTPS/localhost. En Edge/Chrome abre chrome://flags/#unsafely-treat-insecure-origin-as-secure, habilítalo, agrega "http://' + host + '" y relanza el navegador. Se descargó el .zpl como respaldo.';
  }
  return 'WebUSB no está disponible en este navegador/contexto. Se descargó el .zpl como respaldo.';
}

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
  window.addEventListener('resize', () => {
    if (state.modo === 'stock') renderResultados();
  });

  loadExistencias();
});
