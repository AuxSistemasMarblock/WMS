/**
 * Controller del Dashboard de Supply Chain.
 *
 * Endpoints que alimentan el dashboard.html. Internamente delega en:
 *  - confrontaCacheService.ejecutarConfronta() (caché TTL + single-flight:
 *    netsuiteSearchService + googleSheetsService + confrontaService).
 *  - casosService (persistencia/justificación de discrepancias).
 */

const confrontaCacheService = require('../services/confrontaCacheService');
const confrontaService = require('../services/confrontaService');
const casosService = require('../services/casosService');
const envConfig = require('../config/environments');

// Ejecuta la confronta con caché TTL + single-flight (movido a su servicio).
const ejecutarConfronta = confrontaCacheService.ejecutarConfronta;

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
 * Dispara la sincronización de discrepancias de forma fire-and-forget (una
 * sola vez por resultado). No bloquea la respuesta y no lanza.
 */
function dispararSync(resultado) {
  if (!resultado || !Array.isArray(resultado.todas_las_discrepancias)) return;
  if (resultado.__syncDisparado) return;
  Object.defineProperty(resultado, '__syncDisparado', {
    value: true, enumerable: false, writable: true, configurable: true
  });
  casosService.syncDiscrepancias(resultado).catch(e =>
    console.error('[dashboard] syncDiscrepancias error:', e.message)
  );
}

/**
 * Tras obtener el resultado de confronta:
 *  - dispara syncDiscrepancias de forma fire-and-forget (una vez por resultado).
 *  - adjunta la justificación a las discrepancias vivas (anotarDiscrepancias).
 *  - agrega `kpis.desglose_justificacion` {abiertas, en_revision, justificadas}
 *    sin tocar ningún otro KPI existente.
 */
async function anotarResultado(resultado) {
  if (!resultado || !Array.isArray(resultado.todas_las_discrepancias)) {
    return resultado;
  }

  dispararSync(resultado);

  await casosService.anotarDiscrepancias(resultado.todas_las_discrepancias);

  const desglose = { abiertas: 0, en_revision: 0, justificadas: 0 };
  for (const d of resultado.todas_las_discrepancias) {
    const estado = d && d.justificacion ? d.justificacion.estado : null;
    if (estado === 'en_revision') desglose.en_revision++;
    else if (estado === 'justificada') desglose.justificadas++;
    else desglose.abiertas++;
  }

  calcularKPIsConJustificadas(resultado);

  if (resultado.kpis) resultado.kpis.desglose_justificacion = desglose;

  return resultado;
}

/**
 * Recalcula los KPIs tratando las discrepancias `justificada` (caso aprobado)
 * como OK: se excluyen del cálculo y un IF cuyas discrepancias quedaron todas
 * justificadas se reclasifica como OK. Muta `resultado.kpis`/tops.
 *
 * Es puro respecto a la clasificación original: no mueve `ifs_ok`/
 * `ifs_con_errores`, por lo que es idempotente aunque `resultado` venga de caché.
 */
function calcularKPIsConJustificadas(resultado) {
  if (!resultado || !Array.isArray(resultado.todas_las_discrepancias)) return resultado;
  const esJustificada = d => !!(d && d.justificacion && d.justificacion.estado === 'justificada');

  const vigentes = resultado.todas_las_discrepancias.filter(d => !esJustificada(d));
  const ifsConErrorVigentes = (resultado.ifs_con_errores || []).filter(ifDoc =>
    (ifDoc.discrepancias || []).some(d => !esJustificada(d))
  );
  const ifsConErrorOriginales = (resultado.ifs_con_errores || []).length;
  const ifsOk = (resultado.ifs_ok || []).length + (ifsConErrorOriginales - ifsConErrorVigentes.length);
  const lineasConError = ifsConErrorVigentes.reduce((s, i) => s + (i.lineas_con_error || 0), 0);

  return confrontaService.calcularKPIs(resultado, vigentes, {
    ifsOk,
    ifsConErrores: ifsConErrorVigentes.length,
    lineasConError
  });
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
    await anotarResultado(resultado);

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
    await anotarResultado(resultado);
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
    await anotarResultado(resultado);

    // Incluimos tanto errores de surtido como canceladas en ERP
    let ifs = [...resultado.ifs_con_errores, ...resultado.ifs_canceladas_erp];

    // Filtrar por operador si se especifica
    if (operador) {
      ifs = ifs.filter(i => i.operador === operador);
    }

    // Filtrar por tipo de discrepancia si se especifica
    if (tipo) {
      if (tipo === 'sobrantes_grupo') {
        ifs = ifs.filter(i => i.discrepancias.some(d => d.tipo === 'cantidad_sobrante' || (d.tipo === 'sku_lote_no_esperado' && !d.es_cruzado)));
      } else if (tipo === 'faltantes_grupo') {
        ifs = ifs.filter(i => i.discrepancias.some(d => d.tipo === 'linea_faltante' || (d.tipo === 'cantidad_faltante' && !d.es_cruzado)));
      } else {
        ifs = ifs.filter(i => i.discrepancias.some(d => d.tipo === tipo));
      }
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
      tipos_error: [...new Set(i.discrepancias.map(d => d.es_cruzado ? 'lote_cruzado' : d.tipo))]
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
    await anotarResultado(resultado);

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
    await anotarResultado(resultado);

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
    await anotarResultado(resultado);

    let discrepancias = resultado.todas_las_discrepancias;

    if (tipo) {
      if (tipo === 'sobrantes_grupo') {
        discrepancias = discrepancias.filter(d => d.tipo === 'cantidad_sobrante' || (d.tipo === 'sku_lote_no_esperado' && !d.es_cruzado));
      } else if (tipo === 'faltantes_grupo') {
        discrepancias = discrepancias.filter(d => d.tipo === 'linea_faltante' || (d.tipo === 'cantidad_faltante' && !d.es_cruzado));
      } else {
        discrepancias = discrepancias.filter(d => d.tipo === tipo);
      }
    }
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
    dispararSync(resultado);

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
    dispararSync(resultado);

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
    dispararSync(resultado);

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
  // Exportados para tests / compatibilidad
  _ejecutarConfronta: confrontaCacheService.ejecutarConfronta,
  _clearCache: confrontaCacheService._clearCache,
  _calcularKPIsConJustificadas: calcularKPIsConJustificadas
};
