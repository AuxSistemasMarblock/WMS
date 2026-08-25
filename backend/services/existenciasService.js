/**
 * Servicio de existencias (artículos/lotes con cantidad a mano) en NetSuite.
 *
 * Consulta la saved search de existencias (customsearch_imr_items por default)
 * vía el RESTlet 2217, igual que netsuiteSearchService.
 *
 * Columnas verificadas de customsearch_imr_items (RESTlet devuelve):
 *   id                        -> internalid (inventorynumber)
 *   upccode                   -> SKU
 *   displayname               -> descripción del artículo
 *   inventorynumber           -> lote (string, ej: "AG116-3.20X1.60")
 *   formulatext               -> bloque (código, ej: "AG116")
 *   location.{value,text}     -> ubicación/almacén (ej: "OUTLET MEX")
 *   quantityonhand            -> físico (m²)
 *   quantityavailable         -> disponible (m²)
 *   custitemnumber_imr_largo_mts  -> largo
 *   custitemnumber_imr_ancho_mts  -> alto
 *   custitemnumber_imr_total_m2   -> total m² por pieza
 *   custitemnumber_imr_atributo.{value,text} -> acabado (ej: "LTH")
 *   formulahtml               -> imagen (actualmente vacío)
 *   class.{value,text}        -> clase (ej: "SINTERIZADO")
 */

const envConfig = require('../config/environments');
const netsuiteClient = require('../config/netsuiteRestlet');

const { scriptId, deployId, searchIdExistencias } = envConfig.netsuite.searchRestlet;
const restletPath = `/app/site/hosting/restlet.nl?script=${scriptId}&deploy=${deployId}`;

/**
 * Extrae un valor de celda del RESTlet priorizando el texto visible.
 * Maneja strings planos y objetos {value, text}.
 */
function extract(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val.text ?? val.value ?? null;
  return String(val);
}

function parseNum(val) {
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normaliza una fila cruda del RESTlet a un objeto de existencia.
 */
function normalizarExistencia(fila) {
  return {
    internalid: extract(fila.id) ?? extract(fila.internalid),
    sku: extract(fila.upccode) ?? extract(fila.sku),
    descripcion: extract(fila.displayname) ?? extract(fila.description),
    lote: extract(fila.inventorynumber) ?? extract(fila.lote) ?? extract(fila.lot),
    bloque: extract(fila.formulatext),
    ubicacion: extract(fila.location),
    fisico: parseNum(fila.quantityonhand ?? fila.fisico),
    disponible: parseNum(fila.quantityavailable ?? fila.disponible),
    largo: parseNum(fila.custitemnumber_imr_largo_mts ?? fila.largo),
    alto: parseNum(fila.custitemnumber_imr_ancho_mts ?? fila.alto),
    totalM2: parseNum(fila.custitemnumber_imr_total_m2 ?? fila.totalM2),
    acabado: extract(fila.custitemnumber_imr_atributo),
    imagen: extract(fila.formulahtml),
    clase: extract(fila.class)
  };
}

/**
 * Consulta las existencias de NetSuite.
 *
 * @param {Object} options
 * @param {string} [options.ubicacion] - Ubicación a filtrar (se pasa al RESTlet como
 *   hint y se filtra en memoria; el filtro por rol lo hace el controller).
 * @param {string} [options.sku] - SKU a filtrar (en memoria).
 * @param {number} [options.maxRegistros] - Tope de seguridad (default 5000).
 * @returns {Promise<Array<Object>>} Filas normalizadas.
 */
async function getExistencias({ ubicacion, sku, maxRegistros = 5000 } = {}) {
  const pageSize = 1000;
  let filas = [];
  let start = 0;

  while (filas.length < maxRegistros) {
    const payload = {
      searchId: searchIdExistencias,
      limit: pageSize,
      start
    };
    if (ubicacion) payload.location = ubicacion;

    const response = await netsuiteClient.post(restletPath, payload);

    if (!response.data || !response.data.success) {
      throw new Error(
        `Error del RESTlet de búsqueda (existencias): ${response.data?.error || 'sin detalle'}`
      );
    }

    const pagina = response.data.data || [];
    if (pagina.length === 0) break;

    filas = filas.concat(pagina);

    if (process.env.VERBOSE === '1' && start === 0) {
      console.log(`[VERBOSE] Existencias: success=${response.data.success}, filas=${pagina.length}`);
      console.log(`[VERBOSE] Primera fila cruda:`);
      console.log(JSON.stringify(pagina[0], null, 2));
    }

    if (pagina.length < pageSize) break;
    start += pageSize;
  }

  let normalizadas = filas.map(normalizarExistencia);

  if (sku) {
    const s = String(sku).trim().toLowerCase();
    normalizadas = normalizadas.filter(f => (f.sku || '').toLowerCase() === s);
  }

  return normalizadas;
}

module.exports = { getExistencias, normalizarExistencia };
