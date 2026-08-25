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
 * Obtiene el/los pedimento(s) para un lote. Match SOLO por lote.
 *
 * Trae todas las IRs paginando con `start` y recolecta los pedimentos distintos
 * del lote. Si hay más de un pedimento distinto (caso raro: mismo lote en
 * varias ubicaciones con distinto pedimento), se devuelve la lista para que el
 * usuario elija cuál usar.
 *
 * @param {Object} options
 * @param {string} options.lote - Lote (ej. "AG116-3.20X1.60")
 * @returns {Promise<{
 *   pedimento: string|null,
 *   ir: string|null,
 *   pedimentos: Array<{pedimento:string, ir:string|null, ubicacion:string|null, fecha:string|null}>,
 *   multiple: boolean,
 *   warning: string|null
 * }>}
 */
async function obtenerPedimento({ lote }) {
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
        fecha: extract(fila.trandate) ?? null
      });
    }

    // El RESTlet solo devuelve hasta 1000 por request; seguimos con `start`.
    if (filas.length < pageSize) break;
    start += pageSize;
  }

  // Deduplicar por pedimento (solo los no vacíos).
  const seen = new Map();
  for (const m of matches) {
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
      warning: 'Existen múltiples pedimentos para este lote; selecciona cuál usar'
    };
  }

  return {
    pedimento: null,
    ir: matches[0]?.ir ?? null,
    pedimentos: [],
    multiple: false,
    warning: 'No se encontró un pedimento para este lote'
  };
}

module.exports = { obtenerPedimento, extractPedimento };
