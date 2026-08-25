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
 * Obtiene el pedimento (y la IR) para un lote. Match SOLO por lote.
 *
 * Trae todas las IRs paginando con `start`. Entre las IRs del mismo lote,
 * prefiere la que sí tenga pedimento.
 *
 * @param {Object} options
 * @param {string} options.lote - Lote (ej. "AG116-3.20X1.60")
 * @returns {Promise<{pedimento: string|null, ir: string|null}>}
 */
async function obtenerPedimento({ lote }) {
  const loteNorm = normalizeLote(lote);
  const pageSize = 1000;
  let start = 0;
  let firstIr = null;

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

      const ir = extract(fila.tranid) ?? extract(fila.ir) ?? null;
      if (!firstIr) firstIr = ir;

      const pedimento = extractPedimento(fila);
      if (pedimento) return { pedimento, ir };
    }

    // El RESTlet solo devuelve hasta 1000 por request; seguimos con `start`.
    if (filas.length < pageSize) break;
    start += pageSize;
  }

  return { pedimento: null, ir: firstIr };
}

module.exports = { obtenerPedimento, extractPedimento };
