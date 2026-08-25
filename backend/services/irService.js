/**
 * Servicio IR -> pedimento.
 *
 * Sub-búsqueda sobre customsearch3677 (IR con pedimento). Dado el lote y la
 * ubicación de una existencia, trae TODAS las IRs (pagina con `start`, porque
 * el RESTlet 2217 solo devuelve 1000 por request e IGNORA filtros server-side)
 * y busca el lote en memoria para devolver el pedimento como TEXTO (valor
 * visible), NO el internalid (fix del bug "pedimento como ID").
 *
 * Columnas esperadas de customsearch3677 (según levantamiento; verificar en
 * producción con VERBOSE=1, en sandbox la búsqueda está vacía):
 *   id          -> internalid
 *   trandate    -> fecha
 *   location    -> ubicación ({value, text})
 *   tranid      -> IR
 *   inventorynumber -> lote
 *   <custbody pedimento> -> pedimento (objeto {value, text})
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
  'custbody_pedimento',
  'custbody_num_pedimento',
  'pedimento'
].filter(Boolean);

function extract(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val.text ?? val.value ?? null;
  return String(val);
}

/**
 * Extrae el pedimento priorizando SIEMPRE el texto visible (no el ID).
 */
function extractPedimento(fila) {
  for (const key of PEDIMENTO_KEYS) {
    if (fila[key] === undefined || fila[key] === null) continue;
    const raw = fila[key];
    if (typeof raw === 'object' && raw.text) return String(raw.text);
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
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
 * Compara por id (value) si se provee; si no, por nombre (text).
 */
function matchLocation(filaLocation, ubicacion, ubicacionId) {
  const value = filaLocation && typeof filaLocation === 'object' ? filaLocation.value : null;
  const text = filaLocation && typeof filaLocation === 'object' ? filaLocation.text : extract(filaLocation);

  if (ubicacionId) {
    return value != null && String(value) === String(ubicacionId);
  }
  if (ubicacion) {
    const tokens = String(text || '').split(/[\s:]+/).filter(Boolean).map(t => t.toUpperCase());
    return tokens.includes(String(ubicacion).toUpperCase());
  }
  return true;
}

/**
 * Obtiene el pedimento (y la IR) para un lote en una ubicación.
 *
 * Trae todas las IRs paginando con `start` y busca por lote en memoria.
 *
 * @param {Object} options
 * @param {string} options.lote - Lote (ej. "AG116-3.20X1.60")
 * @param {string} [options.ubicacion] - Nombre de ubicación (ej. "OUTLET MEX")
 * @param {string} [options.ubicacionId] - Id interno de ubicación (ej. "4")
 * @returns {Promise<{pedimento: string|null, ir: string|null}>}
 */
async function obtenerPedimento({ lote, ubicacion, ubicacionId }) {
  const loteNorm = normalizeLote(lote);
  const pageSize = 1000;
  let start = 0;

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
      if (!matchLocation(fila.location, ubicacion, ubicacionId)) continue;

      return {
        pedimento: extractPedimento(fila),
        ir: extract(fila.tranid) ?? extract(fila.ir) ?? null
      };
    }

    // El RESTlet solo devuelve hasta 1000 por request; si no hallamos el lote
    // en esta página, avanzamos con `start` hasta agotar los resultados.
    if (filas.length < pageSize) break;
    start += pageSize;
  }

  return { pedimento: null, ir: null };
}

module.exports = { obtenerPedimento, extractPedimento };
