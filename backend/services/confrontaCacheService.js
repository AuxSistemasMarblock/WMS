/**
 * Servicio de caché y orquestación de la confronta.
 *
 * Extrae del dashboardController el flujo completo:
 *  - googleSheetsService.getEscaneos()
 *  - netsuiteSearchService.getIFsEsperadasAgrupadas()
 *  - confrontaService.confrontar()
 *
 * y conserva el MISMO comportamiento y resultado: caché en memoria con TTL de
 * 15s + single-flight para que los ~9 endpoints que dispara el dashboard por
 * cada cambio de filtro compartan UNA sola ejecución por cache key.
 */

const netsuiteSearchService = require('./netsuiteSearchService');
const googleSheetsService = require('./googleSheetsService');
const confrontaService = require('./confrontaService');

const CACHE_TTL_MS = 15_000; // 15 segundos
const cache = new Map(); // key: JSON.stringify(filtros), value: { ts, data }
const inFlight = new Map(); // key: JSON.stringify(filtros), value: Promise (single-flight)

/**
 * Construye la clave de caché a partir de los filtros
 */
function cacheKey(filtros) {
  return JSON.stringify(filtros);
}

/**
 * Devuelve el cache si está vigente
 */
function getCached(filtros) {
  const key = cacheKey(filtros);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * Guarda en caché
 */
function setCached(filtros, data) {
  cache.set(cacheKey(filtros), { ts: Date.now(), data });
}

/**
 * Ejecuta la confronta completa con caché y single-flight.
 *
 * El dashboard dispara ~9 endpoints en paralelo por cada cambio de filtro
 * (cargarTodo). Sin single-flight, todos fallan el caché a la vez y ejecutan
 * la confronta completa concurrentemente, generando una ráfaga de llamadas a
 * NetSuite que deriva en errores transitorios (400). Con single-flight todos
 * comparten UNA sola ejecución por cache key.
 */
async function ejecutarConfronta({ desde, hasta, sucursal }) {
  const filtros = { desde, hasta, sucursal };
  const cached = getCached(filtros);
  if (cached) return cached;

  const key = cacheKey(filtros);
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    try {
      // 1) Escaneos: la ventana de fechas se aplica sobre la FECHA DE ESCANEO (Sheets).
      const escaneos = await googleSheetsService.getEscaneos({
        desde, hasta, sucursal
      });

      // 2) IFs esperadas: UNA sola llamada a NetSuite que devuelve las IFs del
      //    período (trandate en ventana, para detectar linea_faltante) Y además
      //    conserva las IFs escaneadas aunque su trandate quede fuera de la
      //    ventana (la fecha relevante para la confronta es la del escaneo).
      const tranidsEscaneados = [...new Set(
        escaneos.map(e => e.if_tranid).filter(Boolean)
      )];

      let ifsEsperadas = [];
      try {
        ifsEsperadas = await netsuiteSearchService.getIFsEsperadasAgrupadas({
          desde, hasta, sucursal,
          tranidsRelevantes: tranidsEscaneados
        });
      } catch (e) {
        // No derribar el dashboard por un error transitorio de NetSuite:
        // degradamos a sin IFs esperadas (las escaneadas saldrán como
        // if_no_encontrada en la confronta) y logueamos el detalle real.
        console.error('[ejecutarConfronta] Error leyendo IFs de NetSuite:', e.message);
        if (e.response) {
          console.error('[ejecutarConfronta] NetSuite response:', JSON.stringify(e.response.data));
        }
        if (process.env.VERBOSE === '1' && e.stack) console.error(e.stack);
      }

      const resultado = confrontaService.confrontar(ifsEsperadas, escaneos);
      if (ifsEsperadas.length === 0 && tranidsEscaneados.length > 0) {
        resultado.warnings = ['No se pudieron leer las IFs esperadas de NetSuite; se reportan las IFs escaneadas como no localizadas.'];
      }
      setCached(filtros, resultado);
      return resultado;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/**
 * Limpia la caché en memoria (expuesto para tests).
 */
function clearCache() {
  cache.clear();
  inFlight.clear();
}

module.exports = {
  ejecutarConfronta,
  // Exports para tests / compatibilidad
  _cacheKey: cacheKey,
  _getCached: getCached,
  _setCached: setCached,
  _clearCache: clearCache
};
