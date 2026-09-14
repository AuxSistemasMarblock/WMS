/**
 * Controller del gestor de casos de auditoría (WMS).
 *
 * Patrón: routes -> controller -> services.
 *  - Delega la confronta en confrontaCacheService.ejecutarConfronta() y la
 *    persistencia de discrepancias en casosService (T1). NO reimplementa
 *    fingerprint ni sync.
 *  - Accede a Supabase con la service role key (backend/config/supabase.js),
 *    que bypassa RLS (ver supabase/migrations/0001_gestor_casos.sql).
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

const supabase = require('../config/supabase');
const confrontaCacheService = require('../services/confrontaCacheService');
const casosService = require('../services/casosService');
const config = require('../config/environments');

const RESTRICTED_LOCATION_PREFIXES = config.netsuite.RESTRICTED_LOCATION_PREFIXES || ['MEX', 'MTY', 'GDL'];
const SHARED_LOCATIONS = config.netsuite.SHARED_LOCATIONS || ['TEMPORAL', 'PROYECTOS', 'Material Transformado', 'MATRIZ'];

const ESTADOS_CASO = ['pendiente_aprobacion', 'aprobado', 'rechazado'];
const ESTADOS_DISCREPANCIA = ['abierta', 'en_revision', 'justificada'];

// ============================================================
// Helpers
// ============================================================

function logError(contexto, e) {
  console.error(`${contexto} error:`, e && e.message ? e.message : e);
  if (e && e.stack && process.env.VERBOSE === '1') console.error(e.stack);
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
 * Verdadero si la ubicación es compartida (visible para todos).
 * Mismo criterio que netsuiteController.filterIFsByUserLocation.
 */
function esUbicacionCompartida(loc) {
  if (!loc) return false;
  if (SHARED_LOCATIONS.includes(loc)) return true;
  const tienePrefijoRestringido = RESTRICTED_LOCATION_PREFIXES.some(prefix => {
    return loc === prefix || loc.startsWith(prefix + ':') || loc.startsWith(prefix + ' ');
  });
  return !tienePrefijoRestringido;
}

/**
 * Verdadero si `loc` pertenece a la sucursal `userLocationName` por tokens.
 * Mismo criterio de tokens que filterIFsByUserLocation.
 */
function tokenMatch(loc, userLocationName) {
  if (!loc || !userLocationName) return false;
  if (loc === userLocationName) return true;
  const tokens = String(loc).split(/[\s:]+/).filter(Boolean);
  return tokens.includes(userLocationName);
}

/**
 * Obtiene el nombre de ubicación del usuario autenticado desde
 * req.user.ubicacion_id -> tabla ubicaciones (patrón auth/netsuiteController).
 * Devuelve null si no se puede resolver.
 */
async function getUserLocationName(req) {
  const ubicacionId = req.user?.ubicacion_id;
  if (!ubicacionId) return null;
  const { data, error } = await supabase
    .from('ubicaciones')
    .select('nombre')
    .eq('id', ubicacionId)
    .single();
  if (error || !data) return null;
  return data.nombre;
}

/**
 * Indica si una fila (caso o discrepancia) es visible para el usuario.
 * - gerente/admin: todo.
 * - jefe: ubicaciones compartidas o de su sucursal.
 */
function esVisibleParaUsuario(req, sucursal, userLocationName) {
  if (esGerenteOAdmin(req)) return true;
  if (!sucursal) return false;
  if (esUbicacionCompartida(sucursal)) return true;
  return tokenMatch(sucursal, userLocationName);
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
 * Lee un valor de body o query (body tiene prioridad).
 */
function valor(req, clave) {
  if (req.body && req.body[clave] !== undefined && req.body[clave] !== null && req.body[clave] !== '') {
    return req.body[clave];
  }
  return req.query ? req.query[clave] : undefined;
}

// ============================================================
// Folio
// ============================================================

/**
 * Genera el siguiente folio CASO-<YYYY>-<secuencial 4 dígitos>.
 * Usa MAX(folio) del año para calcular el secuencial. El llamador reintenta
 * ante colisión de folio (unique + código 23505).
 */
async function generarFolio(anio) {
  const prefijo = `CASO-${anio}-`;
  const { data, error } = await supabase
    .from('casos')
    .select('folio')
    .like('folio', `${prefijo}%`)
    .order('folio', { ascending: false })
    .limit(1);

  if (error) throw new Error(`Error generando folio: ${error.message}`);

  let secuencial = 1;
  if (data && data.length > 0 && data[0].folio) {
    const partes = String(data[0].folio).split('-');
    const ultimo = parseInt(partes[partes.length - 1], 10);
    if (Number.isInteger(ultimo)) secuencial = ultimo + 1;
  }
  return `${prefijo}${String(secuencial).padStart(4, '0')}`;
}

/**
 * Extrae solo las discrepancias vivas (resultado de confronta).
 */
function discrepanciasDeResultado(resultado) {
  return (resultado && Array.isArray(resultado.todas_las_discrepancias))
    ? resultado.todas_las_discrepancias
    : [];
}

// ============================================================
// POST /api/casos/sync
// ============================================================

const postSync = async (req, res) => {
  try {
    const { desde, hasta, sucursal } = { ...req.query, ...(req.body || {}) };
    const filtros = { desde, hasta, sucursal: sucursal || null };

    const resultado = await confrontaCacheService.ejecutarConfronta(filtros);
    const sync = await casosService.syncDiscrepancias(resultado);

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
    res.status(500).json({ error: e.message });
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

    let query = supabase.from('discrepancias').select('*');

    if (estado) query = query.eq('estado', estado);
    if (tipo) query = query.eq('tipo', tipo);
    if (sucursal) query = query.eq('sucursal', sucursal);
    if (if_tranid) query = query.eq('if_tranid', if_tranid);
    if (desde) query = query.gte('if_fecha', desde);
    if (hasta) query = query.lte('if_fecha', hasta);

    const { data, error } = await query.order('ultima_vista', { ascending: false });

    if (error) {
      console.error('getDiscrepancias db error:', error.message);
      return res.status(500).json({ error: 'Error al leer discrepancias' });
    }

    // Scope de ubicación para jefe_almacen.
    let discrepancias = data || [];
    if (!esGerenteOAdmin(req)) {
      const ubicacionNombre = await getUserLocationName(req);
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
    res.status(500).json({ error: e.message });
  }
};

// ============================================================
// GET /api/casos/tipos-justificacion
// ============================================================

const getTiposJustificacion = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tipos_justificacion')
      .select('*')
      .eq('activo', true)
      .order('orden', { ascending: true });

    if (error) {
      console.error('getTiposJustificacion db error:', error.message);
      return res.status(500).json({ error: 'Error al leer tipos de justificación' });
    }

    res.json({ tipos_justificacion: data || [] });
  } catch (e) {
    logError('getTiposJustificacion', e);
    res.status(500).json({ error: e.message });
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
      ubicacionNombre = await getUserLocationName(req);
      if (!ubicacionNombre) {
        return res.status(403).json({ error: 'Ubicación no encontrada para el usuario' });
      }
    }

    // Validar tipo de justificación activo.
    const { data: tipo, error: tipoError } = await supabase
      .from('tipos_justificacion')
      .select('id, clave, nombre, activo')
      .eq('id', tipoJustificacionId)
      .eq('activo', true)
      .maybeSingle();

    if (tipoError) {
      console.error('postCaso tipo db error:', tipoError.message);
      return res.status(500).json({ error: 'Error al validar tipo de justificación' });
    }
    if (!tipo) {
      return res.status(400).json({ error: 'Tipo de justificación inválido o inactivo' });
    }

    // Validar discrepancias: existen, están 'abierta' y son de la ubicación del jefe.
    const { data: discRows, error: discError } = await supabase
      .from('discrepancias')
      .select('id, estado, sucursal, caso_id')
      .in('id', discrepanciaIds);

    if (discError) {
      console.error('postCaso discrepancias db error:', discError.message);
      return res.status(500).json({ error: 'Error al validar discrepancias' });
    }

    const encontradas = discRows || [];
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

    // Crear caso con reintento ante colisión de folio (unique).
    const anio = new Date().getFullYear();
    const ahora = new Date().toISOString();
    const sucursalCaso = encontradas[0]?.sucursal || ubicacionNombre || null;

    let caso = null;
    let ultimoError = null;
    for (let intento = 0; intento < 5; intento++) {
      const folio = await generarFolio(anio);
      const { data, error } = await supabase
        .from('casos')
        .insert({
          folio,
          ubicacion_id: req.user?.ubicacion_id ?? null,
          sucursal: sucursalCaso,
          tipo_justificacion_id: tipoJustificacionId,
          justificacion,
          estado: 'pendiente_aprobacion',
          creado_por: req.user?.id ?? null,
          enviado_at: ahora
        })
        .select('*')
        .single();

      if (!error) {
        caso = data;
        break;
      }
      ultimoError = error;
      // 23505 = unique_violation (colisión de folio). Reintentar con nuevo folio.
      if (error.code !== '23505') break;
    }

    if (!caso) {
      console.error('postCaso insert error:', ultimoError && ultimoError.message);
      return res.status(500).json({ error: 'No se pudo crear el caso', details: ultimoError && ultimoError.message });
    }

    // Actualizar discrepancias a 'en_revision' con caso_id.
    const { error: updError } = await supabase
      .from('discrepancias')
      .update({ estado: 'en_revision', caso_id: caso.id, updated_at: new Date().toISOString() })
      .in('id', discrepanciaIds);

    if (updError) {
      console.error('postCaso update discrepancias error:', updError.message);
      return res.status(500).json({ error: 'Caso creado pero no se pudieron actualizar las discrepancias', details: updError.message });
    }

    // Registrar eventos: caso_creado y justificacion_enviada.
    const eventos = [
      { caso_id: caso.id, evento: 'caso_creado', actor_id: req.user?.id ?? null, datos: { folio: caso.folio, discrepancia_ids: discrepanciaIds } },
      { caso_id: caso.id, evento: 'justificacion_enviada', actor_id: req.user?.id ?? null, datos: { tipo_justificacion_id: tipoJustificacionId, justificacion } }
    ];
    const { error: eventosError } = await supabase.from('caso_eventos').insert(eventos);
    if (eventosError) {
      console.error('postCaso eventos error:', eventosError.message);
    }

    res.status(201).json({ caso });
  } catch (e) {
    logError('postCaso', e);
    res.status(500).json({ error: e.message });
  }
};

// ============================================================
// GET /api/casos
// ============================================================

const getCasos = async (req, res) => {
  try {
    const { estado, sucursal, desde, hasta } = req.query;

    if (estado && !ESTADOS_CASO.includes(estado)) {
      return res.status(400).json({ error: `estado debe ser ${ESTADOS_CASO.join('|')}` });
    }

    let query = supabase.from('casos').select('*');
    if (estado) query = query.eq('estado', estado);
    if (sucursal) query = query.eq('sucursal', sucursal);
    if (desde) query = query.gte('created_at', desde);
    if (hasta) query = query.lte('created_at', hasta);

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      console.error('getCasos db error:', error.message);
      return res.status(500).json({ error: 'Error al leer casos' });
    }

    let casos = data || [];
    if (!esGerenteOAdmin(req)) {
      const ubicacionNombre = await getUserLocationName(req);
      if (!ubicacionNombre) {
        return res.status(403).json({ error: 'Ubicación no encontrada para el usuario' });
      }
      // jefe: solo los suyos o de su ubicación.
      casos = casos.filter(c => c.creado_por === req.user?.id || esVisibleParaUsuario(req, c.sucursal, ubicacionNombre));
    }

    const casoIds = casos.map(c => c.id);

    // Conteo de discrepancias por caso.
    const conteoPorCaso = new Map();
    if (casoIds.length > 0) {
      const { data: discRows, error: discError } = await supabase
        .from('discrepancias')
        .select('caso_id')
        .in('caso_id', casoIds);
      if (discError) {
        console.error('getCasos conteo db error:', discError.message);
      } else {
        for (const d of (discRows || [])) {
          conteoPorCaso.set(d.caso_id, (conteoPorCaso.get(d.caso_id) || 0) + 1);
        }
      }
    }

    // Nombre de tipo de justificación.
    const tipoIds = [...new Set(casos.map(c => c.tipo_justificacion_id).filter(id => id !== null && id !== undefined))];
    const tiposPorId = new Map();
    if (tipoIds.length > 0) {
      const { data: tipos, error: tiposError } = await supabase
        .from('tipos_justificacion')
        .select('id, nombre, clave')
        .in('id', tipoIds);
      if (tiposError) {
        console.error('getCasos tipos db error:', tiposError.message);
      } else {
        for (const t of (tipos || [])) tiposPorId.set(t.id, t);
      }
    }

    const resultado = casos.map(c => ({
      ...c,
      total_discrepancias: conteoPorCaso.get(c.id) || 0,
      tipo_justificacion: tiposPorId.get(c.tipo_justificacion_id) || null
    }));

    res.json({ total: resultado.length, casos: resultado });
  } catch (e) {
    logError('getCasos', e);
    res.status(500).json({ error: e.message });
  }
};

// ============================================================
// GET /api/casos/resumen
// ============================================================

const getResumen = async (req, res) => {
  try {
    let query = supabase.from('casos').select('id, estado, sucursal, creado_por');
    const { data, error } = await query;

    if (error) {
      console.error('getResumen db error:', error.message);
      return res.status(500).json({ error: 'Error al leer casos' });
    }

    let casos = data || [];
    if (!esGerenteOAdmin(req)) {
      const ubicacionNombre = await getUserLocationName(req);
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
    res.status(500).json({ error: e.message });
  }
};

// ============================================================
// GET /api/casos/:id
// ============================================================

const getCasoDetalle = async (req, res) => {
  try {
    const casoId = toId(req.params.id);
    if (!casoId) return res.status(400).json({ error: 'id inválido' });

    const { data: caso, error } = await supabase
      .from('casos')
      .select('*')
      .eq('id', casoId)
      .maybeSingle();

    if (error) {
      console.error('getCasoDetalle db error:', error.message);
      return res.status(500).json({ error: 'Error al leer el caso' });
    }
    if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });

    // Scope: jefe solo su ubicación o creador; gerente/admin todo.
    if (!esGerenteOAdmin(req)) {
      const ubicacionNombre = await getUserLocationName(req);
      const esCreador = caso.creado_por === req.user?.id;
      const visible = ubicacionNombre && esVisibleParaUsuario(req, caso.sucursal, ubicacionNombre);
      if (!esCreador && !visible) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    // Discrepancias asociadas.
    const { data: discrepancias, error: discError } = await supabase
      .from('discrepancias')
      .select('*')
      .eq('caso_id', casoId)
      .order('id', { ascending: true });
    if (discError) console.error('getCasoDetalle discrepancias db error:', discError.message);

    // Eventos (timeline).
    const { data: eventos, error: evError } = await supabase
      .from('caso_eventos')
      .select('*')
      .eq('caso_id', casoId)
      .order('created_at', { ascending: true });
    if (evError) console.error('getCasoDetalle eventos db error:', evError.message);

    // Nombres de actores (join manual a usuarios).
    const actorIds = [...new Set([
      caso.creado_por,
      caso.revisado_por,
      ...(eventos || []).map(ev => ev.actor_id)
    ].filter(id => id !== null && id !== undefined))];

    const actoresPorId = new Map();
    if (actorIds.length > 0) {
      const { data: usuarios, error: usError } = await supabase
        .from('usuarios')
        .select('id, nombre_completo, email')
        .in('id', actorIds);
      if (usError) {
        console.error('getCasoDetalle usuarios db error:', usError.message);
      } else {
        for (const u of (usuarios || [])) actoresPorId.set(u.id, u);
      }
    }

    const eventosConActor = (eventos || []).map(ev => ({
      ...ev,
      actor: actoresPorId.get(ev.actor_id) || null
    }));

    // Tipo de justificación.
    let tipoJustificacion = null;
    if (caso.tipo_justificacion_id) {
      const { data: tipo, error: tipoError } = await supabase
        .from('tipos_justificacion')
        .select('*')
        .eq('id', caso.tipo_justificacion_id)
        .maybeSingle();
      if (tipoError) console.error('getCasoDetalle tipo db error:', tipoError.message);
      tipoJustificacion = tipo || null;
    }

    res.json({
      caso: {
        ...caso,
        tipo_justificacion: tipoJustificacion,
        creador: actoresPorId.get(caso.creado_por) || null,
        revisor: actoresPorId.get(caso.revisado_por) || null
      },
      discrepancias: discrepancias || [],
      eventos: eventosConActor
    });
  } catch (e) {
    logError('getCasoDetalle', e);
    res.status(500).json({ error: e.message });
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
  const { data: caso, error } = await supabase
    .from('casos')
    .select('*')
    .eq('id', casoId)
    .maybeSingle();
  if (error) {
    console.error(`${contexto} db error:`, error.message);
    res.status(500).json({ error: 'Error al leer el caso' });
    return null;
  }
  if (!caso) {
    res.status(404).json({ error: 'Caso no encontrado' });
    return null;
  }
  return caso;
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
    const ahora = new Date().toISOString();

    const { data: actualizado, error } = await supabase
      .from('casos')
      .update({
        estado: 'aprobado',
        revisado_por: req.user?.id ?? null,
        revisado_at: ahora,
        comentario_revision: comentario,
        updated_at: ahora
      })
      .eq('id', caso.id)
      .select('*')
      .single();

    if (error) {
      console.error('postAprobar update error:', error.message);
      return res.status(500).json({ error: 'No se pudo aprobar el caso' });
    }

    const { error: discError } = await supabase
      .from('discrepancias')
      .update({ estado: 'justificada', updated_at: ahora })
      .eq('caso_id', caso.id);
    if (discError) console.error('postAprobar discrepancias error:', discError.message);

    const { error: evError } = await supabase.from('caso_eventos').insert({
      caso_id: caso.id,
      evento: 'aprobado',
      actor_id: req.user?.id ?? null,
      datos: comentario ? { comentario } : null
    });
    if (evError) console.error('postAprobar evento error:', evError.message);

    res.json({ caso: actualizado });
  } catch (e) {
    logError('postAprobar', e);
    res.status(500).json({ error: e.message });
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

    const ahora = new Date().toISOString();

    const { data: actualizado, error } = await supabase
      .from('casos')
      .update({
        estado: 'rechazado',
        revisado_por: req.user?.id ?? null,
        revisado_at: ahora,
        comentario_revision: comentario,
        updated_at: ahora
      })
      .eq('id', caso.id)
      .select('*')
      .single();

    if (error) {
      console.error('postRechazar update error:', error.message);
      return res.status(500).json({ error: 'No se pudo rechazar el caso' });
    }

    // Las discrepancias permanecen 'en_revision'.

    const { error: evError } = await supabase.from('caso_eventos').insert({
      caso_id: caso.id,
      evento: 'rechazado',
      actor_id: req.user?.id ?? null,
      datos: { comentario }
    });
    if (evError) console.error('postRechazar evento error:', evError.message);

    res.json({ caso: actualizado });
  } catch (e) {
    logError('postRechazar', e);
    res.status(500).json({ error: e.message });
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
      const { data: tipo, error: tipoError } = await supabase
        .from('tipos_justificacion')
        .select('id, activo')
        .eq('id', tipoJustificacionId)
        .eq('activo', true)
        .maybeSingle();
      if (tipoError) {
        console.error('putReenviar tipo db error:', tipoError.message);
        return res.status(500).json({ error: 'Error al validar tipo de justificación' });
      }
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

    // Actualizar discrepancias del caso si se envían.
    if (req.body?.discrepancia_ids !== undefined) {
      const nuevosIds = normalizarIds(req.body.discrepancia_ids);
      if (nuevosIds.length === 0) {
        return res.status(400).json({ error: 'discrepancia_ids no puede estar vacío' });
      }

      const { data: actuales, error: actualesError } = await supabase
        .from('discrepancias')
        .select('id, estado, caso_id, sucursal')
        .eq('caso_id', caso.id);
      if (actualesError) {
        console.error('putReenviar actuales db error:', actualesError.message);
        return res.status(500).json({ error: 'Error al leer discrepancias del caso' });
      }

      const { data: solicitadas, error: solicitadasError } = await supabase
        .from('discrepancias')
        .select('id, estado, sucursal')
        .in('id', nuevosIds);
      if (solicitadasError) {
        console.error('putReenviar solicitadas db error:', solicitadasError.message);
        return res.status(500).json({ error: 'Error al leer discrepancias' });
      }

      if ((solicitadas || []).length !== nuevosIds.length) {
        return res.status(400).json({ error: 'Una o más discrepancias no existen' });
      }

      // Scope de ubicación del jefe (creador): validar las nuevas.
      let ubicacionNombre = null;
      if (!esGerenteOAdmin(req)) {
        ubicacionNombre = await getUserLocationName(req);
      }
      if (ubicacionNombre) {
        const fuera = solicitadas.filter(d => !esVisibleParaUsuario(req, d.sucursal, ubicacionNombre)).map(d => d.id);
        if (fuera.length > 0) {
          return res.status(403).json({ error: `Discrepancias fuera de su ubicación: ${fuera.join(', ')}` });
        }
      }

      const idsActuales = new Set((actuales || []).map(d => d.id));
      const idsSolicitados = new Set(nuevosIds);

      // Nuevas: deben estar 'abierta' y sin caso.
      const aAgregar = (solicitadas || []).filter(d => !idsActuales.has(d.id));
      const noAbiertas = aAgregar.filter(d => d.estado !== 'abierta').map(d => d.id);
      if (noAbiertas.length > 0) {
        return res.status(400).json({ error: `Discrepancias que no están abiertas: ${noAbiertas.join(', ')}` });
      }

      const aQuitar = (actuales || []).filter(d => !idsSolicitados.has(d.id)).map(d => d.id);

      if (aQuitar.length > 0) {
        const { error: quitarError } = await supabase
          .from('discrepancias')
          .update({ estado: 'abierta', caso_id: null, updated_at: ahora })
          .in('id', aQuitar);
        if (quitarError) {
          console.error('putReenviar quitar db error:', quitarError.message);
          return res.status(500).json({ error: 'Error al actualizar discrepancias' });
        }
      }

      if (aAgregar.length > 0) {
        const { error: agregarError } = await supabase
          .from('discrepancias')
          .update({ estado: 'en_revision', caso_id: caso.id, updated_at: ahora })
          .in('id', aAgregar.map(d => d.id));
        if (agregarError) {
          console.error('putReenviar agregar db error:', agregarError.message);
          return res.status(500).json({ error: 'Error al actualizar discrepancias' });
        }
      }
    }

    const { data: actualizado, error } = await supabase
      .from('casos')
      .update(cambios)
      .eq('id', caso.id)
      .select('*')
      .single();

    if (error) {
      console.error('putReenviar update error:', error.message);
      return res.status(500).json({ error: 'No se pudo reenviar el caso' });
    }

    const { error: evError } = await supabase.from('caso_eventos').insert({
      caso_id: caso.id,
      evento: 'justificacion_reenviada',
      actor_id: req.user?.id ?? null,
      datos: {
        tipo_justificacion_id: cambios.tipo_justificacion_id ?? caso.tipo_justificacion_id,
        justificacion: cambios.justificacion ?? caso.justificacion,
        discrepancia_ids: req.body?.discrepancia_ids !== undefined ? normalizarIds(req.body.discrepancia_ids) : undefined
      }
    });
    if (evError) console.error('putReenviar evento error:', evError.message);

    res.json({ caso: actualizado });
  } catch (e) {
    logError('putReenviar', e);
    res.status(500).json({ error: e.message });
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

    const { data: delCaso, error: delCasoError } = await supabase
      .from('discrepancias')
      .select('id')
      .eq('caso_id', caso.id)
      .in('id', discrepanciaIds);

    if (delCasoError) {
      console.error('postRetirar db error:', delCasoError.message);
      return res.status(500).json({ error: 'Error al leer discrepancias del caso' });
    }

    const idsDelCaso = new Set((delCaso || []).map(d => d.id));
    const fueraDelCaso = discrepanciaIds.filter(id => !idsDelCaso.has(id));
    if (fueraDelCaso.length > 0) {
      return res.status(400).json({ error: `Discrepancias que no pertenecen al caso: ${fueraDelCaso.join(', ')}` });
    }

    const ahora = new Date().toISOString();
    const { error } = await supabase
      .from('discrepancias')
      .update({ estado: 'abierta', caso_id: null, updated_at: ahora })
      .in('id', discrepanciaIds);

    if (error) {
      console.error('postRetirar update error:', error.message);
      return res.status(500).json({ error: 'No se pudieron retirar las discrepancias' });
    }

    const { error: evError } = await supabase.from('caso_eventos').insert({
      caso_id: caso.id,
      evento: 'discrepancia_retirada',
      actor_id: req.user?.id ?? null,
      datos: { discrepancia_ids: discrepanciaIds }
    });
    if (evError) console.error('postRetirar evento error:', evError.message);

    res.json({ retiradas: discrepanciaIds.length, discrepancia_ids: discrepanciaIds });
  } catch (e) {
    logError('postRetirar', e);
    res.status(500).json({ error: e.message });
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

    const { data: evento, error } = await supabase
      .from('caso_eventos')
      .insert({
        caso_id: caso.id,
        evento: 'comentario',
        actor_id: req.user?.id ?? null,
        datos: { comentario }
      })
      .select('*')
      .single();

    if (error) {
      console.error('postComentario db error:', error.message);
      return res.status(500).json({ error: 'No se pudo registrar el comentario' });
    }

    res.status(201).json({ evento });
  } catch (e) {
    logError('postComentario', e);
    res.status(500).json({ error: e.message });
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
  _tokenMatch: tokenMatch,
  _normalizarIds: normalizarIds,
  _generarFolio: generarFolio,
  _discrepanciasDeResultado: discrepanciasDeResultado
};
