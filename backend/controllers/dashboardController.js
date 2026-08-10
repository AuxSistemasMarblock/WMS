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
 * Ejecuta la confronta completa con caché.
 * Esta es la función core: la usan casi todos los endpoints.
 */
async function ejecutarConfronta({ desde, hasta, sucursal }) {
  const filtros = { desde, hasta, sucursal };
  const cached = getCached(filtros);
  if (cached) return cached;

  const ifsEsperadas = await netsuiteSearchService.getIFsEsperadasAgrupadas({
    desde, hasta, sucursal
  });
  const escaneos = await googleSheetsService.getEscaneos({
    desde, hasta, sucursal
  });

  const resultado = confrontaService.confrontar(ifsEsperadas, escaneos);
  setCached(filtros, resultado);
  return resultado;
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
      kpis: {
        ifs_totales: resultado.ifs.length,
        ifs_ok: resultado.ifs_ok.length,
        ifs_con_errores: resultado.ifs_con_errores.length,
        lineas_totales: resultado.total_lineas,
        lineas_con_error: resultado.lineas_con_error,
        placas_esperadas: resultado.total_placas_esperadas,
        placas_escaneadas: resultado.total_placas_escaneadas,
        placas_escaneadas_matcheadas: resultado.placas_escaneadas_matcheadas || 0,
        placas_escaneadas_huerfanas: resultado.placas_escaneadas_huerfanas || 0,
        tasa_exactitud: resultado.tasa_exactitud,
        total_discrepancias: resultado.todas_las_discrepancias.length
      },
      generado_en: new Date().toISOString()
    });
  } catch (e) {
    console.error('getResumen error:', e);
    res.status(500).json({ error: e.message });
  }
};

/**
 * GET /api/dashboard/ifs-mal-sacadas
 * Lista las IFs que tienen discrepancias.
 * Query params opcionales: operador, tipo (de discrepancia)
 */
const getIFsMalSacadas = async (req, res) => {
  try {
    const filtros = normalizarFiltros(req);
    const { operador, tipo } = req.query;
    const resultado = await ejecutarConfronta(filtros);

    let ifs = resultado.ifs_con_errores;

    // Filtrar por operador si se especifica
    if (operador) {
      ifs = ifs.filter(i => i.operador === operador);
    }

    // Filtrar por tipo de discrepancia si se especifica
    if (tipo) {
      ifs = ifs.filter(i => i.discrepancias.some(d => d.tipo === tipo));
    }

    // Compactar para la respuesta (sin escaneos completos)
    const compact = ifs.map(i => ({
      tranid: i.tranid,
      so: i.sourceDoc,
      trandate: i.trandate,
      location: i.location,
      operador: i.operador,
      total_lineas: i.total_lineas,
      lineas_con_error: i.lineas_con_error,
      discrepancias: i.discrepancias,
      tipos_error: [...new Set(i.discrepancias.map(d => d.tipo))]
    }));

    res.json({
      filtros,
      total: compact.length,
      ifs: compact
    });
  } catch (e) {
    console.error('getIFsMalSacadas error:', e);
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
    console.error('getIFDetalle error:', e);
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
    console.error('getDiscrepancias error:', e);
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
    console.error('getTopErrores error:', e);
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
      so: i.sourceDoc,
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
    console.error('getIFsOK error:', e);
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
    console.error('getArticulosMasSalidas error:', e);
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
    console.error('getSucursales error:', e);
    res.status(500).json({ error: e.message });
  }
};

module.exports = {
  getResumen,
  getIFsMalSacadas,
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
