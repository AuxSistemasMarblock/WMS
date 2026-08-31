/**
 * Controller del Dashboard de Supply Chain.
 *
 * Endpoints que alimentan el dashboard.html. Internamente:
 *  - Llama a netsuiteSearchService.getIFsEsperadasAgrupadas() (paginado)
 *  - Llama a googleSheetsService.getEscaneos()
 *  - Llama a confrontaService.confrontar()
 *
 * Caché en memoria con TTL para evitar recalcular en cada request.
 */

const netsuiteSearchService = require('../services/netsuiteSearchService');
const googleSheetsService = require('../services/googleSheetsService');
const confrontaService = require('../services/confrontaService');
const envConfig = require('../config/environments');

const CACHE_TTL_MS = 15_000; // 15 segundos
const cache = new Map(); // key: JSON.stringify(filtros), value: { ts, data }
const inFlight = new Map(); // key: JSON.stringify(filtros), value: Promise (single-flight)

/**
 * Loguea un error incluyendo el detalle de la respuesta HTTP (útil para
 * ver el código/mensaje real de NetSuite, que en el mensaje plano queda oculto).
 */
function logError(contexto, e) {
  console.error(`${contexto} error:`, e.message);
  if (e.response) {
    console.error(`${contexto} response data:`, JSON.stringify(e.response.data));
  }
  if (process.env.VERBOSE === '1' && e.stack) console.error(e.stack);
}

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
 * Normaliza filtros desde query string
 */
function normalizarFiltros(req) {
  const { desde, hasta, sucursal } = req.query;
  return { desde, hasta, sucursal: sucursal || null };
}

/**
 * GET /api/dashboard/resumen
 * Devuelve los KPIs principales: tasa de exactitud, IFs con error, etc.
 */
const getResumen = async (req, res) => {
  try {
    const filtros = normalizarFiltros(req);
    const resultado = await ejecutarConfronta(filtros);

    res.json({
      filtros,
      kpis: resultado.kpis,
      generado_en: new Date().toISOString()
    });
  } catch (e) {
    logError('getResumen', e);
    res.status(500).json({ error: e.message });
  }
};

/**
 * GET /api/dashboard/ifs-mal-sacadas
 * Lista las IFs que tienen discrepancias.
 * Query params opcionales: operador, tipo (de discrepancia)
 */
const getConfrontaFull = async (req, res) => {
  try {
    const filtros = normalizarFiltros(req);
    const resultado = await ejecutarConfronta(filtros);
    res.json({ filtros, resultado, generado_en: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

const getIFsMalSacadas = async (req, res) => {
  try {
    const filtros = normalizarFiltros(req);
    const { operador, tipo } = req.query;
    const resultado = await ejecutarConfronta(filtros);

    // Incluimos tanto errores de surtido como canceladas en ERP
    let ifs = [...resultado.ifs_con_errores, ...resultado.ifs_canceladas_erp];

    // Filtrar por operador si se especifica
    if (operador) {
      ifs = ifs.filter(i => i.operador === operador);
    }

    // Filtrar por tipo de discrepancia si se especifica
    if (tipo) {
      ifs = ifs.filter(i => i.discrepancias.some(d => d.tipo === tipo));
    }

    // Compactar para la respuesta
    const compact = ifs.map(i => ({
      tranid: i.tranid,
      so: i.so,
      trandate: i.trandate,
      location: i.location,
      operador: i.operador,
      total_lineas: i.total_lineas,
      lineas_con_error: i.lineas_con_error,
      discrepancias: i.discrepancias,
      status: i.status,
      tipos_error: [...new Set(i.discrepancias.map(d => d.tipo))]
    }));

    res.json({
      filtros,
      total: compact.length,
      ifs: compact
    });
  } catch (e) {
    logError('getIFsMalSacadas', e);
    res.status(500).json({ error: e.message });
  }
};

/**
 * GET /api/dashboard/ifs-canceladas
 * Lista las IFs escaneadas en Sheets que no existen en NetSuite (canceladas/fugas)
 */
const getIFsCanceladas = async (req, res) => {
  try {
    const filtros = normalizarFiltros(req);
    const resultado = await ejecutarConfronta(filtros);

    const compact = resultado.ifs_canceladas_erp.map(i => ({
      tranid: i.tranid,
      so: i.so,
      trandate: i.trandate,
      location: i.location,
      operador: i.operador,
      total_lineas: i.total_lineas,
      lineas: i.lineas,
      discrepancias: i.discrepancias,
      tipos_error: ['if_no_encontrada']
    }));

    res.json({
      filtros,
      total: compact.length,
      ifs: compact
    });
  } catch (e) {
    logError('getIFsCanceladas', e);
    res.status(500).json({ error: e.message });
  }
};

/**
 * GET /api/dashboard/if/:tranid/detalle
 * Detalle de una IF específica: cabecera + esperado vs escaneado + timeline
 */
const getIFDetalle = async (req, res) => {
  try {
    const { tranid } = req.params;
    const filtros = normalizarFiltros(req);
    const resultado = await ejecutarConfronta(filtros);

    const ifDoc = resultado.ifs.find(i => i.tranid === tranid);
    if (!ifDoc) {
      return res.status(404).json({ error: `IF ${tranid} no encontrada en el rango` });
    }

    res.json({ if: ifDoc });
  } catch (e) {
    logError('getIFDetalle', e);
    res.status(500).json({ error: e.message });
  }
};

/**
 * GET /api/dashboard/discrepancias
 * Tabla plana de todas las discrepancias.
 * Query params opcionales: tipo, operador, sku
 */
const getDiscrepancias = async (req, res) => {
  try {
    const filtros = normalizarFiltros(req);
    const { tipo, operador, sku } = req.query;
    const resultado = await ejecutarConfronta(filtros);

    let discrepancias = resultado.todas_las_discrepancias;

    if (tipo) discrepancias = discrepancias.filter(d => d.tipo === tipo);
    if (operador) discrepancias = discrepancias.filter(d => d.escaneo_operador === operador);
    if (sku) discrepancias = discrepancias.filter(d => d.sku === sku);

    // Las discrepancias ya vienen con if_tranid, if_so, if_location desde confrontaService
    res.json({
      filtros,
      total: discrepancias.length,
      discrepancias
    });
  } catch (e) {
    logError('getDiscrepancias', e);
    res.status(500).json({ error: e.message });
  }
};

/**
 * GET /api/dashboard/top-errores
 * Top errores por dimensión: sku, lote, ubicacion, operador
 * Query params: dimension (default: sku)
 */
const getTopErrores = async (req, res) => {
  try {
    const filtros = normalizarFiltros(req);
    const { dimension = 'sku' } = req.query;
    const resultado = await ejecutarConfronta(filtros);

    let top;
    switch (dimension) {
      case 'sku': top = resultado.top_skus; break;
      case 'lote': top = resultado.top_lotes; break;
      case 'ubicacion': top = resultado.top_ubicaciones; break;
      case 'operador': top = resultado.top_operadores; break;
      default:
        return res.status(400).json({ error: 'dimension debe ser sku|lote|ubicacion|operador' });
    }

    res.json({
      filtros,
      dimension,
      top: top.slice(0, 20)
    });
  } catch (e) {
    logError('getTopErrores', e);
    res.status(500).json({ error: e.message });
  }
};

/**
 * GET /api/dashboard/ifs-ok
 * IFs que NO tienen discrepancias (refuerzo visual)
 */
const getIFsOK = async (req, res) => {
  try {
    const filtros = normalizarFiltros(req);
    const { limit } = req.query;
    const resultado = await ejecutarConfronta(filtros);

    let compact = resultado.ifs_ok.map(i => ({
      tranid: i.tranid,
      so: i.so,
      trandate: i.trandate,
      location: i.location,
      operador: i.operador,
      total_lineas: i.total_lineas
    }));

    if (limit !== undefined && limit !== '') {
      compact = compact.slice(0, parseInt(limit, 10) || compact.length);
    }

    res.json({
      filtros,
      total: resultado.ifs_ok.length,
      ifs: compact
    });
  } catch (e) {
    logError('getIFsOK', e);
    res.status(500).json({ error: e.message });
  }
};

/**
 * GET /api/dashboard/articulos-mas-salidas
 * Top artículos por volumen de escaneos (no por errores).
 * Query params: dimension (sku|lote|operador, default sku)
 */
const getArticulosMasSalidas = async (req, res) => {
  try {
    const filtros = normalizarFiltros(req);
    const { dimension = 'sku' } = req.query;
    const resultado = await ejecutarConfronta(filtros);

    let top;
    switch (dimension) {
      case 'sku':       top = resultado.top_articulos_mas_salidas?.top_skus || []; break;
      case 'lote':      top = resultado.top_articulos_mas_salidas?.top_lotes || []; break;
      case 'operador':  top = resultado.top_articulos_mas_salidas?.top_operadores || []; break;
      default:
        return res.status(400).json({ error: 'dimension debe ser sku|lote|operador' });
    }

    res.json({
      filtros,
      dimension,
      top: top.slice(0, 20)
    });
  } catch (e) {
    logError('getArticulosMasSalidas', e);
    res.status(500).json({ error: e.message });
  }
};

/**
 * GET /api/dashboard/health
 * Healthcheck del módulo dashboard (no requiere auth)
 */
const health = async (req, res) => {
  res.json({ status: 'ok', modulo: 'dashboard', timestamp: new Date().toISOString() });
};

/**
 * GET /api/dashboard/sucursales
 * Lista las sucursales principales para el filtro del dashboard.
 * Solo devuelve las 3 restringidas (GDL, MEX, MTY); los outlets se incluyen
 * implícitamente cuando el usuario selecciona la principal.
 */
const getSucursales = async (req, res) => {
  try {
    const prefixes = envConfig.netsuite.RESTRICTED_LOCATION_PREFIXES || ['MEX', 'MTY', 'GDL'];
    const todas = Object.values(envConfig.netsuite.ubicaciones);
    // Filtrar solo las 3 principales (no outlets, no compartidas)
    const principales = todas
      .filter(u => prefixes.includes(u.nombre))
      .map(u => ({ id: u.id, nombre: u.nombre }))
      // Ordenar alfabéticamente
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
    res.json({ sucursales: principales });
  } catch (e) {
    logError('getSucursales', e);
    res.status(500).json({ error: e.message });
  }
};

module.exports = {
  getResumen,
  getConfrontaFull,
  getIFsMalSacadas,
  getIFsCanceladas,
  getIFDetalle,
  getDiscrepancias,
  getTopErrores,
  getIFsOK,
  getSucursales,
  getArticulosMasSalidas,
  health,
  // Exportados para tests
  _ejecutarConfronta: ejecutarConfronta,
  _clearCache: () => cache.clear()
};
