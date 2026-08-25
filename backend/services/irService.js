/**
 * Servicio IR -> pedimento.
 *
 * Sub-búsqueda sobre customsearch3677 (IR con pedimento). Dado el lote y la
 * ubicación de una existencia, encuentra la IR y devuelve el pedimento como
 * TEXTO (valor visible), NO el internalid (fix del bug "pedimento como ID").
 *
 * Columnas esperadas de customsearch3677 (según levantamiento; verificar en
 * producción con VERBOSE=1, en sandbox la búsqueda está vacía):
 *   id          -> internalid
 *   trandate    -> fecha
 *   location    -> ubicación
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
  'custbody_pedimento',
  'custbody_num_pedimento',
  'pedimento'
];

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
    // Para el fix del bug "pedimento como ID", el texto va primero.
    const raw = fila[key];
    if (typeof raw === 'object' && raw.text) return String(raw.text);
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (typeof raw === 'object' && raw.value) return String(raw.value);
  }
  return null;
}

/**
 * Normaliza el lote para comparación (trim + colapso de espacios + uppercase).
 */
function normalizeLote(lote) {
  return String(lote ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Obtiene el pedimento (y la IR) para un lote en una ubicación.
 *
 * @param {Object} options
 * @param {string} options.ubicacion - Nombre de la ubicación (ej. "OUTLET MEX")
 * @param {string} options.lote - Lote (ej. "AG116-3.20X1.60")
 * @returns {Promise<{pedimento: string|null, ir: string|null}>}
 */
async function obtenerPedimento({ ubicacion, lote }) {
  const payload = {
    searchId: searchIdIRPedimento,
    limit: 1000,
    start: 0
  };
  if (ubicacion) payload.location = ubicacion;

  const response = await netsuiteClient.post(restletPath, payload);

  if (!response.data || !response.data.success) {
    throw new Error(
      `Error del RESTlet de búsqueda (IR/pedimento): ${response.data?.error || 'sin detalle'}`
    );
  }

  const filas = response.data.data || [];

  if (process.env.VERBOSE === '1') {
    console.log(`[VERBOSE] IR/pedimento: filas=${filas.length} para ubicacion=${ubicacion}`);
    if (filas.length > 0) {
      console.log('[VERBOSE] Primera fila cruda IR/pedimento:');
      console.log(JSON.stringify(filas[0], null, 2));
    }
  }

  const loteNorm = normalizeLote(lote);

  for (const fila of filas) {
    const filaLote = extract(fila.inventorynumber) ?? extract(fila.lote) ?? extract(fila.lot);
    if (!filaLote) continue;

    if (normalizeLote(filaLote) === loteNorm) {
      return {
        pedimento: extractPedimento(fila),
        ir: extract(fila.tranid) ?? extract(fila.ir) ?? null
      };
    }
  }

  return { pedimento: null, ir: null };
}

module.exports = { obtenerPedimento, extractPedimento };
