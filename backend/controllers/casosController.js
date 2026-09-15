/**
 * Controller del gestor de casos de auditoría (WMS).
 *
 * Patrón: routes -> controller -> services.
 *  - Capa HTTP delgada: lee req (params/query/body), aplica validaciones de
 *    entrada y scope de ubicación, delega TODA la persistencia en casosService
 *    (incluida la RPC transaccional crear_caso) y responde con el contrato JSON
 *    existente.
 *  - La confronta se orquesta en casosService.sincronizar() (que a su vez usa
 *    confrontaCacheService).
 *
 * Scope de ubicación:
 *  - jefe_almacen ve/opera solo su ubicación (por prefijo de sucursal, con el
 *    mismo criterio de tokens que filterIFsByUserLocation en netsuiteController)
 *    y respetando las ubicaciones compartidas.
 *  - gerente y admin ven todo.
 *
 * Todas las respuestas de error siguen el estilo del dashboard:
 * 400 validación, 401/403 los emite el middleware, 404 no encontrado, 500 error
 * interno con console.error.
 */

const casosService = require('../services/casosService');
const { esUbicacionCompartida, esVisibleParaUbicacion } = require('../services/locationScope');

const ESTADOS_CASO = ['pendiente_aprobacion', 'aprobado', 'rechazado'];
const ESTADOS_DISCREPANCIA = ['abierta', 'en_revision', 'justificada'];

// ============================================================
// Helpers HTTP / scope
// ============================================================

function logError(contexto, e) {
  console.error(`${contexto} error:`, e && e.message ? e.message : e);
  if (e && e.stack && process.env.VERBOSE === '1') console.error(e.stack);
}

/**
 * Responde un error propagado por el service: usa `e.status` (400/500) y
 * adjunta `e.details` cuando existe. Errores inesperados -> 500.
 */
function responderError(res, e) {
  const status = e && e.status ? e.status : 500;
  const payload = { error: e && e.message ? e.message : String(e) };
  if (e && e.details !== undefined) payload.details = e.details;
  res.status(status).json(payload);
}

/**
 * Rol efectivo del usuario (normaliza igual que requireRole).
 */
function rolDe(req) {
  const rawRol = String(req.user?.rol ?? req.user?.cargo ?? '').toLowerCase().trim();
  if (rawRol === 'administrador') return 'admin';
  if (rawRol.includes('gerente')) return 'gerente';
  if (rawRol.includes('jefe')) return 'jefe_almacen';
  if (rawRol.includes('aux')) return 'aux_almacen';
  return rawRol;
}

function esAdmin(req) {
  return rolDe(req) === 'admin';
}

function esGerenteOAdmin(req) {
  const rol = rolDe(req);
  return rol === 'gerente' || rol === 'admin';
}

/**
 * Indica si una fila (caso o discrepancia) es visible para el usuario.
 * - gerente/admin: todo.
 * - jefe: su ubicación/sucursal (incluido su outlet) o la whitelist compartida.
 *
 * Usa el helper compartido backend/services/locationScope.js (mismo criterio que
 * el escáner).
 */
function esVisibleParaUsuario(req, sucursal, userLocationName) {
  if (esGerenteOAdmin(req)) return true;
  return esVisibleParaUbicacion(sucursal, userLocationName);
}

/**
 * Normaliza un id a entero positivo o null.
 */
function toId(valor) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Normaliza una lista de ids eliminando duplicados y valores inválidos.
 */
function normalizarIds(valor) {
  const lista = Array.isArray(valor) ? valor : (valor === undefined || valor === null ? [] : [valor]);
  const ids = lista.map(toId).filter(id => id !== null);
  return [...new Set(ids)];
}

/**
 * Extrae solo las discrepancias vivas (resultado de confronta).
 */
function discrepanciasDeResultado(resultado) {
  return (resultado && Array.isArray(resultado.todas_las_discrepancias))
    ? resultado.todas_las_discrepancias
    : [];
}

/**
 * Resuelve el nombre de ubicación del usuario en una sola consulta al service.
 * Devuelve null si no se puede resolver.
 */
async function ubicacionDelUsuario(req) {
  return casosService.obtenerNombreUbicacion(req.user?.ubicacion_id);
}

// ============================================================
// POST /api/casos/sync
// ============================================================

const postSync = async (req, res) => {
  try {
    const { desde, hasta, sucursal } = { ...req.query, ...(req.body || {}) };
    const filtros = { desde, hasta, sucursal: sucursal || null };

    const sync = await casosService.sincronizar(filtros);

    if (sync.error) {
      return res.status(500).json({ error: 'Error al sincronizar discrepancias', details: sync.error });
    }

    res.json({
      filtros,
      sincronizadas: sync.sincronizadas,
      generado_en: new Date().toISOString()
    });
  } catch (e) {
    logError('postSync', e);
    responderError(res, e);
  }
};

// ============================================================
// GET /api/casos/discrepancias
// ============================================================

const getDiscrepancias = async (req, res) => {
  try {
    const { estado, tipo, sucursal, desde, hasta, if_tranid } = req.query;

    if (estado && !ESTADOS_DISCREPANCIA.includes(estado)) {
      return res.status(400).json({ error: `estado debe ser ${ESTADOS_DISCREPANCIA.join('|')}` });
    }

    let discrepancias = await casosService.listarDiscrepancias({ estado, tipo, sucursal, desde, hasta, if_tranid });

    // Scope de ubicación para jefe_almacen.
    if (!esGerenteOAdmin(req)) {
      const ubicacionNombre = await ubicacionDelUsuario(req);
      if (!ubicacionNombre) {
        return res.status(403).json({ error: 'Ubicación no encontrada para el usuario' });
      }
      discrepancias = discrepancias.filter(d => esVisibleParaUsuario(req, d.sucursal, ubicacionNombre));
    }

    res.json({
      filtros: { estado, tipo, sucursal, desde, hasta, if_tranid },
      total: discrepancias.length,
      discrepancias
    });
  } catch (e) {
    logError('getDiscrepancias', e);
    responderError(res, e);
  }
};

// ============================================================
// GET /api/casos/tipos-justificacion
// ============================================================

const getTiposJustificacion = async (req, res) => {
  try {
    const tipos = await casosService.listarTiposJustificacion();
    res.json({ tipos_justificacion: tipos });
  } catch (e) {
    logError('getTiposJustificacion', e);
    responderError(res, e);
  }
};

// ============================================================
// POST /api/casos
// ============================================================

const postCaso = async (req, res) => {
  try {
    const discrepanciaIds = normalizarIds(req.body?.discrepancia_ids);
    const tipoJustificacionId = toId(req.body?.tipo_justificacion_id);
    const justificacion = String(req.body?.justificacion ?? '').trim();

    if (discrepanciaIds.length === 0) {
      return res.status(400).json({ error: 'discrepancia_ids es obligatorio (al menos un id)' });
    }
    if (!tipoJustificacionId) {
      return res.status(400).json({ error: 'tipo_justificacion_id es obligatorio' });
    }
    if (!justificacion) {
      return res.status(400).json({ error: 'justificacion no puede estar vacía' });
    }

    // Scope de ubicación (jefe limitado a su sucursal; admin puede todo).
    let ubicacionNombre = null;
    if (!esGerenteOAdmin(req)) {
      ubicacionNombre = await ubicacionDelUsuario(req);
      if (!ubicacionNombre) {
        return res.status(403).json({ error: 'Ubicación no encontrada para el usuario' });
      }
    }

    // Validar tipo de justificación activo.
    const tipo = await casosService.obtenerTipoJustificacionActivo(tipoJustificacionId);
    if (!tipo) {
      return res.status(400).json({ error: 'Tipo de justificación inválido o inactivo' });
    }

    // Validar discrepancias: existen, están 'abierta' y son de la ubicación del jefe.
    const encontradas = await casosService.obtenerDiscrepanciasPorIds(discrepanciaIds);
    const porId = new Map(encontradas.map(d => [d.id, d]));

    const faltantes = discrepanciaIds.filter(id => !porId.has(id));
    if (faltantes.length > 0) {
      return res.status(400).json({ error: `Discrepancias no encontradas: ${faltantes.join(', ')}` });
    }

    const noAbiertas = encontradas.filter(d => d.estado !== 'abierta').map(d => d.id);
    if (noAbiertas.length > 0) {
      return res.status(400).json({ error: `Discrepancias que no están abiertas: ${noAbiertas.join(', ')}` });
    }

    if (ubicacionNombre) {
      const fueraDeUbicacion = encontradas
        .filter(d => !esVisibleParaUsuario(req, d.sucursal, ubicacionNombre))
        .map(d => d.id);
      if (fueraDeUbicacion.length > 0) {
        return res.status(403).json({ error: `Discrepancias fuera de su ubicación: ${fueraDeUbicacion.join(', ')}` });
      }
    }

    const sucursalCaso = encontradas[0]?.sucursal || ubicacionNombre || null;

    // Creación ATÓMICA vía RPC transaccional public.crear_caso.
    const caso = await casosService.crearCaso({
      discrepanciaIds,
      tipoJustificacionId,
      justificacion,
      ubicacionId: req.user?.ubicacion_id ?? null,
      sucursal: sucursalCaso,
      creadoPor: req.user?.id ?? null
    });

    res.status(201).json({ caso });
  } catch (e) {
    logError('postCaso', e);
    responderError(res, e);
  }
};

// ============================================================
// GET /api/casos
// ============================================================

const getCasos = async (req, res) => {
  try {
    const { estado, sucursal, desde, hasta, if_tranid } = req.query;

    if (estado && !ESTADOS_CASO.includes(estado)) {
      return res.status(400).json({ error: `estado debe ser ${ESTADOS_CASO.join('|')}` });
    }

    let casos = await casosService.listarCasos({ estado, sucursal, desde, hasta, if_tranid });

    if (!esGerenteOAdmin(req)) {
      const ubicacionNombre = await ubicacionDelUsuario(req);
      if (!ubicacionNombre) {
        return res.status(403).json({ error: 'Ubicación no encontrada para el usuario' });
      }
      // jefe: solo los suyos o de su ubicación.
      casos = casos.filter(c => c.creado_por === req.user?.id || esVisibleParaUsuario(req, c.sucursal, ubicacionNombre));
    }

    const resultado = await casosService.enriquecerCasos(casos);

    res.json({ total: resultado.length, casos: resultado });
  } catch (e) {
    logError('getCasos', e);
    responderError(res, e);
  }
};

// ============================================================
// GET /api/casos/resumen
// ============================================================

const getResumen = async (req, res) => {
  try {
    let casos = await casosService.resumenCasos();

    if (!esGerenteOAdmin(req)) {
      const ubicacionNombre = await ubicacionDelUsuario(req);
      if (!ubicacionNombre) {
        return res.status(403).json({ error: 'Ubicación no encontrada para el usuario' });
      }
      casos = casos.filter(c => c.creado_por === req.user?.id || esVisibleParaUsuario(req, c.sucursal, ubicacionNombre));
    }

    const conteos = { pendiente_aprobacion: 0, aprobado: 0, rechazado: 0, total: casos.length };
    for (const c of casos) {
      if (conteos[c.estado] !== undefined) conteos[c.estado]++;
    }

    res.json({ conteos });
  } catch (e) {
    logError('getResumen', e);
    responderError(res, e);
  }
};

// ============================================================
// GET /api/casos/:id
// ============================================================

const getCasoDetalle = async (req, res) => {
  try {
    const casoId = toId(req.params.id);
    if (!casoId) return res.status(400).json({ error: 'id inválido' });

    const caso = await casosService.obtenerCaso(casoId);
    if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });

    // Scope: jefe solo su ubicación o creador; gerente/admin todo.
    if (!esGerenteOAdmin(req)) {
      const ubicacionNombre = await ubicacionDelUsuario(req);
      const esCreador = caso.creado_por === req.user?.id;
      const visible = ubicacionNombre && esVisibleParaUsuario(req, caso.sucursal, ubicacionNombre);
      if (!esCreador && !visible) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const detalle = await casosService.obtenerDetalleCaso(caso);
    res.json(detalle);
  } catch (e) {
    logError('getCasoDetalle', e);
    responderError(res, e);
  }
};

// ============================================================
// Helpers de transición
// ============================================================

/**
 * Carga un caso o responde 400/404. Devuelve el caso o null (ya respondió).
 */
async function cargarCaso(req, res, contexto) {
  const casoId = toId(req.params.id);
  if (!casoId) {
    res.status(400).json({ error: 'id inválido' });
    return null;
  }
  try {
    const caso = await casosService.obtenerCaso(casoId);
    if (!caso) {
      res.status(404).json({ error: 'Caso no encontrado' });
      return null;
    }
    return caso;
  } catch (e) {
    logError(contexto, e);
    res.status(500).json({ error: 'Error al leer el caso' });
    return null;
  }
}

// ============================================================
// POST /api/casos/:id/aprobar
// ============================================================

const postAprobar = async (req, res) => {
  try {
    const caso = await cargarCaso(req, res, 'postAprobar');
    if (!caso) return;

    if (caso.estado !== 'pendiente_aprobacion') {
      return res.status(400).json({ error: `El caso debe estar pendiente_aprobacion (actual: ${caso.estado})` });
    }

    const comentario = String(req.body?.comentario ?? '').trim() || null;

    const actualizado = await casosService.aprobarCaso(caso.id, req.user?.id ?? null, comentario);

    res.json({ caso: actualizado });
  } catch (e) {
    logError('postAprobar', e);
    responderError(res, e);
  }
};

// ============================================================
// POST /api/casos/:id/rechazar
// ============================================================

const postRechazar = async (req, res) => {
  try {
    const caso = await cargarCaso(req, res, 'postRechazar');
    if (!caso) return;

    if (caso.estado !== 'pendiente_aprobacion') {
      return res.status(400).json({ error: `El caso debe estar pendiente_aprobacion (actual: ${caso.estado})` });
    }

    const comentario = String(req.body?.comentario ?? '').trim();
    if (!comentario) {
      return res.status(400).json({ error: 'comentario es obligatorio para rechazar' });
    }

    const actualizado = await casosService.rechazarCaso(caso.id, req.user?.id ?? null, comentario);

    res.json({ caso: actualizado });
  } catch (e) {
    logError('postRechazar', e);
    responderError(res, e);
  }
};

// ============================================================
// PUT /api/casos/:id/reenviar
// ============================================================

const putReenviar = async (req, res) => {
  try {
    const caso = await cargarCaso(req, res, 'putReenviar');
    if (!caso) return;

    if (caso.estado !== 'rechazado') {
      return res.status(400).json({ error: `Solo se puede reenviar un caso rechazado (actual: ${caso.estado})` });
    }

    // Solo el creador (jefe) o admin.
    if (!esAdmin(req) && caso.creado_por !== req.user?.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const ahora = new Date().toISOString();
    const cambios = { estado: 'pendiente_aprobacion', enviado_at: ahora, updated_at: ahora };

    const tipoJustificacionId = toId(req.body?.tipo_justificacion_id);
    if (req.body?.tipo_justificacion_id !== undefined && req.body?.tipo_justificacion_id !== null && req.body?.tipo_justificacion_id !== '') {
      if (!tipoJustificacionId) {
        return res.status(400).json({ error: 'tipo_justificacion_id inválido' });
      }
      const tipo = await casosService.obtenerTipoJustificacionActivo(tipoJustificacionId);
      if (!tipo) return res.status(400).json({ error: 'Tipo de justificación inválido o inactivo' });
      cambios.tipo_justificacion_id = tipoJustificacionId;
    }

    if (req.body?.justificacion !== undefined) {
      const justificacion = String(req.body.justificacion ?? '').trim();
      if (!justificacion) {
        return res.status(400).json({ error: 'justificacion no puede estar vacía' });
      }
      cambios.justificacion = justificacion;
    }

    // Ajustar discrepancias del caso si se envían (el diff/scope es HTTP).
    let aAgregar = [];
    let aQuitar = [];
    if (req.body?.discrepancia_ids !== undefined) {
      const nuevosIds = normalizarIds(req.body.discrepancia_ids);
      if (nuevosIds.length === 0) {
        return res.status(400).json({ error: 'discrepancia_ids no puede estar vacío' });
      }

      const actuales = await casosService.obtenerDiscrepanciasDelCaso(caso.id);
      const solicitadas = await casosService.obtenerDiscrepanciasPorIds(nuevosIds, {
        select: 'id, estado, sucursal',
        mensaje: 'Error al leer discrepancias'
      });

      if (solicitadas.length !== nuevosIds.length) {
        return res.status(400).json({ error: 'Una o más discrepancias no existen' });
      }

      // Scope de ubicación del jefe (creador): validar las nuevas.
      let ubicacionNombre = null;
      if (!esGerenteOAdmin(req)) {
        ubicacionNombre = await ubicacionDelUsuario(req);
      }
      if (ubicacionNombre) {
        const fuera = solicitadas.filter(d => !esVisibleParaUsuario(req, d.sucursal, ubicacionNombre)).map(d => d.id);
        if (fuera.length > 0) {
          return res.status(403).json({ error: `Discrepancias fuera de su ubicación: ${fuera.join(', ')}` });
        }
      }

      const idsActuales = new Set(actuales.map(d => d.id));
      const idsSolicitados = new Set(nuevosIds);

      // Nuevas: deben estar 'abierta' y sin caso.
      aAgregar = solicitadas.filter(d => !idsActuales.has(d.id));
      const noAbiertas = aAgregar.filter(d => d.estado !== 'abierta').map(d => d.id);
      if (noAbiertas.length > 0) {
        return res.status(400).json({ error: `Discrepancias que no están abiertas: ${noAbiertas.join(', ')}` });
      }

      aQuitar = actuales.filter(d => !idsSolicitados.has(d.id)).map(d => d.id);
    }

    const evento = {
      caso_id: caso.id,
      evento: 'justificacion_reenviada',
      actor_id: req.user?.id ?? null,
      datos: {
        tipo_justificacion_id: cambios.tipo_justificacion_id ?? caso.tipo_justificacion_id,
        justificacion: cambios.justificacion ?? caso.justificacion,
        discrepancia_ids: req.body?.discrepancia_ids !== undefined ? normalizarIds(req.body.discrepancia_ids) : undefined
      }
    };

    const actualizado = await casosService.reenviarCaso(caso.id, cambios, {
      aAgregar: aAgregar.map(d => d.id),
      aQuitar,
      evento
    });

    res.json({ caso: actualizado });
  } catch (e) {
    logError('putReenviar', e);
    responderError(res, e);
  }
};

// ============================================================
// POST /api/casos/:id/retirar
// ============================================================

const postRetirar = async (req, res) => {
  try {
    const caso = await cargarCaso(req, res, 'postRetirar');
    if (!caso) return;

    if (caso.estado !== 'rechazado') {
      return res.status(400).json({ error: `Solo se pueden retirar discrepancias de un caso rechazado (actual: ${caso.estado})` });
    }

    // Solo el creador (jefe) o admin.
    if (!esAdmin(req) && caso.creado_por !== req.user?.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const discrepanciaIds = normalizarIds(req.body?.discrepancia_ids);
    if (discrepanciaIds.length === 0) {
      return res.status(400).json({ error: 'discrepancia_ids es obligatorio (al menos un id)' });
    }

    const delCaso = await casosService.obtenerIdsDiscrepanciasDelCaso(caso.id, discrepanciaIds);
    const idsDelCaso = new Set(delCaso.map(d => d.id));
    const fueraDelCaso = discrepanciaIds.filter(id => !idsDelCaso.has(id));
    if (fueraDelCaso.length > 0) {
      return res.status(400).json({ error: `Discrepancias que no pertenecen al caso: ${fueraDelCaso.join(', ')}` });
    }

    await casosService.retirarCaso(caso.id, req.user?.id ?? null, discrepanciaIds);

    res.json({ retiradas: discrepanciaIds.length, discrepancia_ids: discrepanciaIds });
  } catch (e) {
    logError('postRetirar', e);
    responderError(res, e);
  }
};

// ============================================================
// POST /api/casos/:id/comentarios
// ============================================================

const postComentario = async (req, res) => {
  try {
    const caso = await cargarCaso(req, res, 'postComentario');
    if (!caso) return;

    // Participantes: jefe dueño, gerente, admin.
    if (!esGerenteOAdmin(req) && caso.creado_por !== req.user?.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const comentario = String(req.body?.comentario ?? '').trim();
    if (!comentario) {
      return res.status(400).json({ error: 'comentario no puede estar vacío' });
    }

    const evento = await casosService.comentarCaso(caso.id, req.user?.id ?? null, comentario);

    res.status(201).json({ evento });
  } catch (e) {
    logError('postComentario', e);
    responderError(res, e);
  }
};

module.exports = {
  postSync,
  getDiscrepancias,
  getTiposJustificacion,
  postCaso,
  getCasos,
  getResumen,
  getCasoDetalle,
  postAprobar,
  postRechazar,
  putReenviar,
  postRetirar,
  postComentario,
  // Helpers exportados para tests
  _rolDe: rolDe,
  _esUbicacionCompartida: esUbicacionCompartida,
  _tokenMatch: esVisibleParaUbicacion,
  _esVisibleParaUsuario: esVisibleParaUsuario,
  _normalizarIds: normalizarIds,
  _discrepanciasDeResultado: discrepanciasDeResultado
};
