/**
 * Servicio IR -> pedimento.
 *
 * Sub-búsqueda sobre customsearch3677 (IR con pedimento). Dado el lote y la
 * ubicación de una existencia, trae TODAS las IRs (pagina con `start`, porque
 * el RESTlet 2217 solo devuelve 1000 por request e IGNORA filtros server-side)
 * y busca el lote en memoria para devolver el pedimento como TEXTO (valor
 * visible), NO el internalid (fix del bug "pedimento como ID").
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
 * Obtiene el pedimento (y la IR) para un lote en una ubicación.
 *
 * Trae todas las IRs paginando con `start` y busca por lote en memoria.
 * Entre los candidatos del mismo lote, prefiere: (1) match de ubicación,
 * (2) pedimento no vacío.
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

  const loteMatches = [];

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

      loteMatches.push({
        pedimento: extractPedimento(fila),
        ir: extract(fila.tranid) ?? extract(fila.ir) ?? null,
        location: fila.location
      });
    }

    // El RESTlet solo devuelve hasta 1000 por request; seguimos con `start`.
    if (filas.length < pageSize) break;
    start += pageSize;
  }

  if (loteMatches.length === 0) {
    return { pedimento: null, ir: null };
  }

  // 1) Preferir coincidencia de ubicación (si se indicó).
  const locMatches = loteMatches.filter(m => matchLocation(m.location, ubicacion, ubicacionId));
  const pool = locMatches.length > 0 ? locMatches : loteMatches;

  // 2) Preferir el que sí tenga pedimento.
  const conPedimento = pool.filter(m => m.pedimento);
  const best = (conPedimento.length > 0 ? conPedimento : pool)[0];

  return { pedimento: best.pedimento, ir: best.ir };
}

module.exports = { obtenerPedimento, extractPedimento };
