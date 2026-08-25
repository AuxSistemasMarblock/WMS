/**
 * Controlador de etiquetas.
 *
 * Flujo: jefe de almacén (o admin) consulta existencias filtradas por sus
 * ubicaciones permitidas, elige un lote, indica cuántas etiquetas imprimir
 * (máx = físico/m²) y recibe el ZPL con el pedimento (si existe).
 */

const supabase = require('../config/supabase');
const config = require('../config/environments');
const { getExistencias } = require('../services/existenciasService');
const { obtenerPedimento } = require('../services/irService');
const { buildZpl, maxLabels } = require('../services/zplService');

const RESTRICTED_LOCATION_PREFIXES = config.netsuite.RESTRICTED_LOCATION_PREFIXES;
const SHARED_LOCATIONS = config.netsuite.SHARED_LOCATIONS;

function startsWithRestrictedPrefix(loc) {
  return RESTRICTED_LOCATION_PREFIXES.some(prefix => {
    return loc === prefix || loc.startsWith(prefix + ':') || loc.startsWith(prefix + ' ');
  });
}

function isSharedLocation(loc) {
  if (!loc) return false;
  if (SHARED_LOCATIONS.includes(loc)) return true;
  return !startsWithRestrictedPrefix(loc);
}

/**
 * Filtra las filas de existencias por las ubicaciones permitidas del usuario:
 * su ubicación, su outlet (tokens), y las compartidas/whitelist.
 */
function filterByAllowedLocations(rows, userLocationName) {
  if (!userLocationName) return rows;
  return rows.filter(row => {
    const loc = row.ubicacion;
    if (!loc) return false;
    if (isSharedLocation(loc)) return true;
    if (loc === userLocationName) return true;
    const tokens = loc.split(/[\s:]+/).filter(Boolean);
    return tokens.includes(userLocationName);
  });
}

/**
 * Obtiene el nombre de la ubicación del usuario autenticado.
 */
async function getUserLocationName(req) {
  const { data: ubicacion, error } = await supabase
    .from('ubicaciones')
    .select('nombre')
    .eq('id', req.user.ubicacion_id)
    .single();

  if (error || !ubicacion) return null;
  return ubicacion.nombre;
}

function isAdmin(req) {
  const rol = req.user.rol ?? req.user.cargo;
  return rol === 'admin';
}

/**
 * GET /api/etiquetas/existencias?ubicacion=&sku=
 * Lista existencias filtradas por ubicaciones permitidas (admin ve todas).
 */
const getExistenciasHandler = async (req, res) => {
  try {
    const { ubicacion, sku } = req.query;

    const filas = await getExistencias({ sku: sku || undefined });

    let resultado;
    if (isAdmin(req)) {
      resultado = filas;
    } else {
      const userLoc = await getUserLocationName(req);
      resultado = filterByAllowedLocations(filas, userLoc);
    }

    // Filtro adicional por ubicación si el cliente lo pide (post-filtro rol)
    if (ubicacion) {
      const u = String(ubicacion).trim();
      resultado = resultado.filter(f => (f.ubicacion || '').includes(u));
    }

    res.json({ existencias: resultado, total: resultado.length });
  } catch (error) {
    console.error('Get existencias error:', error);
    res.status(500).json({ error: 'Error al obtener existencias', details: error.message });
  }
};

/**
 * GET /api/etiquetas/lotes?sku=&ubicacion=
 * Lotes disponibles para un SKU/ubicación dentro de las ubicaciones permitidas.
 */
const getLotesHandler = async (req, res) => {
  try {
    const { sku, ubicacion } = req.query;

    if (!sku) {
      return res.status(400).json({ error: 'sku es requerido' });
    }

    const filas = await getExistencias({ sku });

    let resultado;
    if (isAdmin(req)) {
      resultado = filas;
    } else {
      const userLoc = await getUserLocationName(req);
      resultado = filterByAllowedLocations(filas, userLoc);
    }

    if (ubicacion) {
      const u = String(ubicacion).trim();
      resultado = resultado.filter(f => (f.ubicacion || '').includes(u));
    }

    // Deduplicar por lote (una fila por lote)
    const porLote = new Map();
    for (const f of resultado) {
      if (f.lote && !porLote.has(f.lote)) porLote.set(f.lote, f);
    }

    const lotes = Array.from(porLote.values());
    res.json({ lotes, total: lotes.length });
  } catch (error) {
    console.error('Get lotes error:', error);
    res.status(500).json({ error: 'Error al obtener lotes', details: error.message });
  }
};

/**
 * POST /api/etiquetas/pedimento
 * body: { lote }
 * Devuelve el pedimento (texto) del lote. Si hay varios pedimentos distintos,
 * devuelve la lista (`pedimentos`) con `multiple: true` para que el usuario elija.
 */
const postPedimentoHandler = async (req, res) => {
  try {
    const { lote } = req.body;
    if (!lote) {
      return res.status(400).json({ error: 'lote es requerido' });
    }

    const resultado = await obtenerPedimento({ lote });

    res.json({
      pedimento: resultado.pedimento,
      ir: resultado.ir || null,
      pedimentos: resultado.pedimentos,
      multiple: resultado.multiple,
      warning: resultado.warning || undefined
    });
  } catch (error) {
    console.error('Post pedimento error:', error);
    res.status(500).json({ error: 'Error al consultar pedimento', details: error.message });
  }
};

/**
 * POST /api/etiquetas/zpl
 * body: { sku, lote, ubicacion, cantidad, pedimento? }
 * Revalida contra la fila de existencias (autoritativa), consulta el pedimento
 * y arma el ZPL. Si hay múltiples pedimentos para el lote, `pedimento` debe
 * venir seleccionado; si no, responde 409 con la lista para elegir.
 */
const postZplHandler = async (req, res) => {
  try {
    const { sku, lote, ubicacion, cantidad, pedimento: pedimentoSeleccionado } = req.body;
    if (!sku || !lote || !ubicacion || !cantidad) {
      return res.status(400).json({ error: 'sku, lote, ubicacion y cantidad son requeridos' });
    }

    const n = parseInt(cantidad, 10);
    if (!Number.isInteger(n) || n < 1) {
      return res.status(400).json({ error: 'cantidad debe ser un entero mayor a 0' });
    }

    // Buscar la fila de existencias autoritativa (ya restringida por rol)
    const filas = await getExistencias({});
    let fila;
    if (isAdmin(req)) {
      fila = filas.find(f =>
        (f.sku || '').toLowerCase() === String(sku).toLowerCase() &&
        f.lote === lote && f.ubicacion === ubicacion
      );
    } else {
      const userLoc = await getUserLocationName(req);
      const permitidas = filterByAllowedLocations(filas, userLoc);
      fila = permitidas.find(f =>
        (f.sku || '').toLowerCase() === String(sku).toLowerCase() &&
        f.lote === lote && f.ubicacion === ubicacion
      );
    }

    if (!fila) {
      return res.status(404).json({ error: 'No se encontró la existencia indicada' });
    }

    const max = maxLabels(fila.fisico, fila.totalM2);
    if (n > max) {
      return res.status(400).json({
        error: `La cantidad máxima de etiquetas es ${max}`,
        maxLabels: max
      });
    }

    const resultado = await obtenerPedimento({ lote });

    // Resolver el pedimento a imprimir
    let pedimento = pedimentoSeleccionado || null;

    if (resultado.multiple && !pedimento) {
      return res.status(409).json({
        error: 'Existen múltiples pedimentos para este lote',
        pedimentos: resultado.pedimentos,
        multiple: true,
        warning: resultado.warning
      });
    }

    if (pedimento && !resultado.pedimentos.some(p => p.pedimento === pedimento)) {
      return res.status(400).json({
        error: 'Pedimento seleccionado no válido',
        pedimentos: resultado.pedimentos
      });
    }

    if (!pedimento) {
      pedimento = resultado.pedimento; // único o null
    }

    const selMatch = pedimento
      ? resultado.pedimentos.find(p => p.pedimento === pedimento)
      : null;

    const zpl = buildZpl({
      sku: fila.sku,
      lote: fila.lote,
      ubicacion: fila.ubicacion,
      descripcion: fila.descripcion,
      totalM2: fila.totalM2,
      pedimento,
      cantidad: n
    });

    res.json({
      zpl,
      pedimento,
      ir: selMatch?.ir ?? resultado.ir ?? null,
      maxLabels: max,
      multiple: resultado.multiple,
      warning: resultado.warning || (pedimento ? undefined : 'No se encontró un pedimento para este lote')
    });
  } catch (error) {
    console.error('Post zpl error:', error);
    res.status(500).json({ error: 'Error al generar ZPL', details: error.message });
  }
};

module.exports = {
  getExistencias: getExistenciasHandler,
  getLotes: getLotesHandler,
  postPedimento: postPedimentoHandler,
  postZpl: postZplHandler
};
