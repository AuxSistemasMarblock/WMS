/**
 * Servicio IR -> pedimento.
 *
 * Sub-búsqueda sobre customsearch3677 (IR con pedimento). Dado el lote de una
 * existencia, trae TODAS las IRs (pagina con `start`, porque el RESTlet 2217
 * solo devuelve 1000 por request e IGNORA filtros server-side) y busca el lote
 * en memoria. El pedimento se determina SOLO por lote: la ubicación no aplica.
 *
 * Devuelve el pedimento como TEXTO (valor visible), NO el internalid
 * (fix del bug "pedimento como ID").
 *
 * Columnas verificadas de customsearch3677:
 *   id          -> internalid
 *   recordType  -> "itemreceipt"
 *   trandate    -> fecha
 *   location    -> ubicación ({value, text})
 *   tranid      -> IR
 *   inventorynumber -> lote ({value, text})
 *   custbody_pi_pedimento_de_importacion -> pedimento ({value: id, text: valor})
 */

const envConfig = require('../config/environments');
const netsuiteClient = require('../config/netsuiteRestlet');

const { scriptId, deployId, searchIdIRPedimento } = envConfig.netsuite.searchRestlet;
const restletPath = `/app/site/hosting/restlet.nl?script=${scriptId}&deploy=${deployId}`;

/**
 * Claves candidatas del campo pedimento. Se prueban en orden y se prefiere
 * el texto visible (.text) sobre el internalid (.value).
 */
const PEDIMENTO_KEYS = [
  process.env.NETSUITE_FIELD_PEDIMENTO,
  'custbody_pi_pedimento_de_importacion',
  'custbody_pedimento',
  'pedimento'
].filter(Boolean);

function extract(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val.text ?? val.value ?? null;
  return String(val);
}

/**
 * Normaliza el texto del pedimento: trim + colapso de espacios múltiples.
 * NetSuite devuelve el valor con espacios dobles (ej. "26  43  1637  6102487").
 */
function cleanPedimento(val) {
  return String(val ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Extrae el pedimento priorizando SIEMPRE el texto visible (no el ID).
 */
function extractPedimento(fila) {
  for (const key of PEDIMENTO_KEYS) {
    if (fila[key] === undefined || fila[key] === null) continue;
    const raw = fila[key];
    if (typeof raw === 'object' && raw.text) return cleanPedimento(raw.text);
    if (typeof raw === 'string' && raw.trim()) return cleanPedimento(raw);
    if (typeof raw === 'object' && raw.value) return String(raw.value);
  }
  return null;
}

/**
 * Normaliza el lote para comparación (trim + guiones/espacios -> espacio + uppercase).
 */
function normalizeLote(lote) {
  return String(lote ?? '').trim().replace(/[\s-]+/g, ' ').toUpperCase();
}

/**
 * Indica si la ubicación de una fila IR coincide con la ubicación buscada.
 * Compara por id (value) si se provee; si no, por tokens de nombre (text).
 * El match por tokens es bidireccional para cubrir outlet->padre:
 *   existencias "OUTLET MEX" (id 4)  <->  IR "MEX" (id 3, padre)
 */
function matchLocation(filaLocation, ubicacion, ubicacionId) {
  if (!ubicacion && !ubicacionId) return true;

  const value = filaLocation && typeof filaLocation === 'object' ? filaLocation.value : null;
  const text = (filaLocation && typeof filaLocation === 'object'
    ? filaLocation.text
    : extract(filaLocation)) || '';

  if (ubicacionId && value != null && String(value) === String(ubicacionId)) return true;

  if (ubicacion) {
    const upper = s => String(s || '').toUpperCase();
    const irTokens = upper(text).split(/[\s:]+/).filter(Boolean);
    const uTokens = upper(ubicacion).split(/[\s:]+/).filter(Boolean);
    const irSet = new Set(irTokens);
    if (uTokens.some(t => irSet.has(t))) return true;
  }

  return false;
}

/**
 * Obtiene el/los pedimento(s) para un lote.
 *
 * Trae todas las IRs paginando con `start` y busca por lote. Luego filtra por
 * la ubicación de la existencia (si se indicó, con tolerancia outlet->padre).
 * Si en esa ubicación quedan varios pedimentos distintos (caso raro: mismo lote
 * recibido más de una vez en la misma ubicación), devuelve la lista para que el
 * usuario elija cuál usar.
 *
 * @param {Object} options
 * @param {string} options.lote - Lote (ej. "AG116-3.20X1.60")
 * @param {string} [options.ubicacion] - Nombre de ubicación (ej. "OUTLET MEX")
 * @param {string} [options.ubicacionId] - Id interno de ubicación (ej. "4")
 * @returns {Promise<{
 *   pedimento: string|null,
 *   ir: string|null,
 *   pedimentos: Array<{pedimento:string, ir:string|null, ubicacion:string|null, fecha:string|null}>,
 *   multiple: boolean,
 *   warning: string|null
 * }>}
 */
async function obtenerPedimento({ lote, ubicacion, ubicacionId }) {
  const loteNorm = normalizeLote(lote);
  const pageSize = 1000;
  let start = 0;
  const matches = [];

  while (true) {
    const response = await netsuiteClient.post(restletPath, {
      searchId: searchIdIRPedimento,
      limit: pageSize,
      start
    });

    if (!response.data || !response.data.success) {
      throw new Error(
        `Error del RESTlet de búsqueda (IR/pedimento): ${response.data?.error || 'sin detalle'}`
      );
    }

    const filas = response.data.data || [];

    if (process.env.VERBOSE === '1' && start === 0) {
      console.log(`[VERBOSE] IR/pedimento: filas=${filas.length}, count=${response.data.count}`);
      if (filas.length > 0) {
        console.log('[VERBOSE] Primera fila cruda IR/pedimento:');
        console.log(JSON.stringify(filas[0], null, 2));
      }
    }

    for (const fila of filas) {
      const filaLote = extract(fila.inventorynumber) ?? extract(fila.lote) ?? extract(fila.lot);
      if (!filaLote) continue;
      if (normalizeLote(filaLote) !== loteNorm) continue;

      matches.push({
        pedimento: extractPedimento(fila),
        ir: extract(fila.tranid) ?? extract(fila.ir) ?? null,
        ubicacion: extract(fila.location),
        fecha: extract(fila.trandate) ?? null,
        location: fila.location
      });
    }

    // El RESTlet solo devuelve hasta 1000 por request; seguimos con `start`.
    if (filas.length < pageSize) break;
    start += pageSize;
  }

  // Filtrar por la ubicación de la existencia (si se indicó).
  const locMatches = (ubicacion || ubicacionId)
    ? matches.filter(m => matchLocation(m.location, ubicacion, ubicacionId))
    : matches;

  // Deduplicar por pedimento (solo los no vacíos).
  const seen = new Map();
  for (const m of locMatches) {
    if (!m.pedimento) continue;
    if (!seen.has(m.pedimento)) seen.set(m.pedimento, m);
  }
  const pedimentos = Array.from(seen.values());

  if (pedimentos.length === 1) {
    return {
      pedimento: pedimentos[0].pedimento,
      ir: pedimentos[0].ir,
      pedimentos,
      multiple: false,
      warning: null
    };
  }

  if (pedimentos.length > 1) {
    return {
      pedimento: null,
      ir: null,
      pedimentos,
      multiple: true,
      warning: 'Existen múltiples pedimentos para este lote en esta ubicación; selecciona cuál usar'
    };
  }

  return {
    pedimento: null,
    ir: locMatches[0]?.ir ?? matches[0]?.ir ?? null,
    pedimentos: [],
    multiple: false,
    warning: 'No se encontró un pedimento para este lote'
  };
}

module.exports = { obtenerPedimento, extractPedimento };
