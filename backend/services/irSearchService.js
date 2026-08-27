/**
 * Servicio de búsqueda y detalle de Recepciones de Artículo (IRs) en NetSuite.
 *
 * Consulta la saved search de IRs ordenadas por más recientes (customsearch3678 por default)
 * vía el RESTlet 2217, agrupa las líneas por transacción, calcula placas estimadas
 * por lote y proporciona búsqueda y detalle para el módulo de etiquetas.
 */

const envConfig = require('../config/environments');
const netsuiteClient = require('../config/netsuiteRestlet');
const { getExistencias } = require('./existenciasService');

const { scriptId, deployId, searchIdIRList } = envConfig.netsuite.searchRestlet;
const restletPath = `/app/site/hosting/restlet.nl?script=${scriptId}&deploy=${deployId}`;

const IR_CACHE_TTL = 60000;
let irCache = { rows: null, at: 0 };

function extract(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val.text ?? val.value ?? null;
  return String(val);
}

function cleanPedimento(val) {
  return String(val ?? '').trim().replace(/\s+/g, ' ');
}

function parseNum(val) {
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Extrae las medidas (largo y alto) a partir del nombre del lote.
 * Ej: "10082-2.74X1.88" -> { largo: 2.74, alto: 1.88, totalM2: 5.1512 }
 */
function extractDimensionsFromLote(lote) {
  const match = String(lote || '').match(/(\d+\.?\d*)\s*[xX*]\s*(\d+\.?\d*)/);
  if (!match) return { largo: 0, alto: 0, totalM2: 0 };
  const largo = parseFloat(match[1]) || 0;
  const alto = parseFloat(match[2]) || 0;
  const totalM2 = parseFloat((largo * alto).toFixed(4)) || 0;
  return { largo, alto, totalM2 };
}

/**
 * Separa el texto del artículo en SKU y Descripción.
 * Ej: "117XPB VOLAKAS PLACA 2.0cm PB" -> { sku: "117XPB", descripcion: "VOLAKAS PLACA 2.0cm PB" }
 */
function parseItemText(itemText) {
  const text = String(itemText || '').trim();
  const parts = text.split(/\s+/);
  if (parts.length <= 1) return { sku: text, descripcion: text };
  const sku = parts[0];
  const descripcion = parts.slice(1).join(' ');
  return { sku, descripcion };
}

/**
 * Consulta todas las filas de la saved search de IRs (paginado) con caché en memoria TTL 60s.
 */
async function fetchAllIRRows(maxRegistros = 3000) {
  if (irCache.rows && (Date.now() - irCache.at) < IR_CACHE_TTL) {
    return irCache.rows;
  }

  const pageSize = 1000;
  let start = 0;
  let all = [];

  while (all.length < maxRegistros) {
    const response = await netsuiteClient.post(restletPath, {
      searchId: searchIdIRList,
      limit: pageSize,
      start
    });

    const data = response?.data;
    const rows = Array.isArray(data) ? data : (data?.data || data?.results || []);
    if (!rows.length) break;

    all = all.concat(rows);
    if (rows.length < pageSize) break;
    start += rows.length;
  }

  irCache = { rows: all, at: Date.now() };
  return all;
}

/**
 * Agrupa las filas crudas en objetos de Recepción (IR) con sus líneas y cálculos.
 */
function groupIRs(rows) {
  const irsMap = new Map();

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const irId = String(row.id || '');
    const tranid = String(row.tranid || irId || '').trim();
    if (!tranid) continue;

    const groupKey = tranid;

    if (!irsMap.has(groupKey)) {
      const pedRaw = row.custbody_pi_pedimento_de_importacion?.text || row.custbody_pi_pedimento_de_importacion || '';
      const embarqueRaw = row.custbody_imr_embarque || '';
      const locationName = row.location?.text || extract(row.location) || '';
      const locationId = row.location?.value != null ? String(row.location.value) : null;

      irsMap.set(groupKey, {
        id: irId,
        tranid,
        trandate: row.trandate || '',
        location: locationName,
        locationId,
        pedimento: cleanPedimento(pedRaw),
        embarque: String(embarqueRaw).trim(),
        lineas: []
      });
    }

    const irObj = irsMap.get(groupKey);
    const itemInfo = parseItemText(row.item?.text || row.item);
    const lote = String(row.inventorynumber?.text || extract(row.inventorynumber) || '').trim();
    const dim = extractDimensionsFromLote(lote);
    const cantidadM2 = parseNum(row.quantity);
    const totalM2 = dim.totalM2 > 0 ? dim.totalM2 : (cantidadM2 > 0 ? cantidadM2 : 1);
    const placas = totalM2 > 0 ? Math.max(1, Math.round(cantidadM2 / totalM2)) : 1;

    irObj.lineas.push({
      lineIndex: irObj.lineas.length + 1,
      sku: itemInfo.sku,
      descripcion: itemInfo.descripcion,
      lote,
      cantidadM2,
      totalM2,
      largo: dim.largo,
      alto: dim.alto,
      placas
    });
  }

  const list = Array.from(irsMap.values());

  // Agregar totales a cada IR
  for (const ir of list) {
    ir.totalLineas = ir.lineas.length;
    ir.totalPlacas = ir.lineas.reduce((acc, l) => acc + l.placas, 0);
    ir.totalM2 = parseFloat(ir.lineas.reduce((acc, l) => acc + l.cantidadM2, 0).toFixed(4));
  }

  return list;
}

/**
 * Obtiene la lista de IRs con filtros de búsqueda y ubicación.
 *
 * @param {Object} options
 * @param {string} [options.query] - Búsqueda por tranid (ej. "879", "IR879"), embarque, pedimento, etc.
 * @param {string} [options.ubicacion] - Nombre o prefijo de ubicación del usuario
 * @param {number} [options.limit] - Límite de IRs a devolver
 * @returns {Promise<Array<Object>>}
 */
async function getIRsList({ query, ubicacion, limit = 50 } = {}) {
  const rows = await fetchAllIRRows();
  let irs = groupIRs(rows);

  // Filtro por ubicación si aplica
  if (ubicacion) {
    const u = String(ubicacion).trim().toUpperCase();
    irs = irs.filter(ir => {
      if (!ir.location) return true;
      const loc = ir.location.toUpperCase();
      return loc === u || loc.includes(u) || u.includes(loc);
    });
  }

  // Filtro de texto universal
  if (query) {
    const q = String(query).trim().toUpperCase();
    irs = irs.filter(ir => {
      const matchTranid = ir.tranid.toUpperCase().includes(q) || ir.id.includes(q);
      const matchEmbarque = ir.embarque.toUpperCase().includes(q);
      const matchPedimento = ir.pedimento.toUpperCase().includes(q);
      const matchFecha = ir.trandate.includes(q);
      const matchLote = ir.lineas.some(l => l.lote.toUpperCase().includes(q) || l.sku.toUpperCase().includes(q));
      return matchTranid || matchEmbarque || matchPedimento || matchFecha || matchLote;
    });
  }

  return irs.slice(0, limit);
}

/**
 * Obtiene el detalle completo de una IR específica (por ID o tranid).
 *
 * @param {string} idOrTranid - Folio visible (ej: "IR879", "879") o internalid
 * @returns {Promise<Object|null>}
 */
async function getIRDetail(idOrTranid) {
  if (!idOrTranid) return null;
  const target = String(idOrTranid).trim().toUpperCase();

  const rows = await fetchAllIRRows();
  const irs = groupIRs(rows);

  const ir = irs.find(i =>
    i.tranid.toUpperCase() === target ||
    i.id === target ||
    i.tranid.toUpperCase() === `IR${target}` ||
    `IR${i.tranid.toUpperCase()}` === target
  );

  if (!ir) return null;

  // Enriquecer con existencias si es posible para afinar descripciones o totalM2
  try {
    const existencias = await getExistencias({});
    const exMap = new Map();
    for (const ex of existencias) {
      if (ex.lote && !exMap.has(ex.lote)) exMap.set(ex.lote, ex);
    }

    for (const linea of ir.lineas) {
      if (linea.lote && exMap.has(linea.lote)) {
        const ex = exMap.get(linea.lote);
        if (ex.descripcion && ex.descripcion.length > linea.descripcion.length) {
          linea.descripcion = ex.descripcion;
        }
        if (ex.totalM2 && ex.totalM2 > 0) {
          linea.totalM2 = ex.totalM2;
          if (linea.cantidadM2 > 0) {
            linea.placas = Math.max(1, Math.round(linea.cantidadM2 / ex.totalM2));
          }
        }
      }
    }
  } catch (err) {
    console.warn('Advertencia al cruzar con existencias:', err.message);
  }

  return ir;
}

module.exports = {
  fetchAllIRRows,
  getIRsList,
  getIRDetail
};
