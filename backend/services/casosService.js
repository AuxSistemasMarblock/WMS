/**
 * Servicio del gestor de casos de auditoría.
 *
 * Responsabilidades:
 *  - calcularFingerprint(): huella estable de una discrepancia viva.
 *  - syncDiscrepancias(): upsert tolerante a errores en la tabla discrepancias.
 *  - anotarDiscrepancias(): adjunta el estado de justificación/caso a una lista
 *    de discrepancias vivas, resolviendo el folio con un join en lote a casos
 *    (sin N+1).
 *  - Toda la persistencia del gestor de casos (casos, discrepancias, eventos,
 *    tipos de justificación): consultas, transiciones y comentarios. El
 *    controller es solo HTTP/auth/scope.
 *  - crearCaso(): creación ATÓMICA vía la RPC transaccional
 *    public.crear_caso (supabase/migrations/0002_crear_caso_rpc.sql).
 *
 * El backend usa la service role key (backend/config/supabase.js), que bypassa
 * RLS; ver supabase/migrations/0001_gestor_casos.sql.
 */

const crypto = require('crypto');
const supabase = require('../config/supabase');
const confrontaCacheService = require('./confrontaCacheService');

/**
 * Normaliza un valor a string: null/undefined -> '' (evita "null"/"undefined").
 */
function str(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor).trim();
}

/**
 * Calcula el fingerprint (sha256 hex) de una discrepancia:
 *   `${tipo}|${if_tranid}|${sku}|${lote}|${sucursal}`
 * con null/undefined -> ''.
 *
 * @param {Object} disc - Discrepancia (de confrontaService).
 * @returns {string|null} Hash sha256 hex, o null si no hay objeto.
 */
function calcularFingerprint(disc) {
  if (!disc || typeof disc !== 'object') return null;
  const base = [
    str(disc.tipo),
    str(disc.if_tranid),
    str(disc.sku),
    str(disc.lote),
    str(disc.sucursal)
  ].join('|');
  return crypto.createHash('sha256').update(base).digest('hex');
}

/**
 * Resuelve la sucursal de una discrepancia viva. En confrontaService la
 * ubicación viaja como `if_location`; el fingerprint y la columna sucursal
 * deben usar el mismo valor para que sync y anotación coincidan.
 */
function sucursalDe(disc) {
  if (!disc || typeof disc !== 'object') return null;
  return disc.sucursal ?? disc.if_location ?? null;
}

/**
 * Construye el fingerprint usando la sucursal resuelta.
 */
function fingerprintDe(disc) {
  if (!disc || typeof disc !== 'object') return null;
  return calcularFingerprint({ ...disc, sucursal: sucursalDe(disc) });
}

/**
 * Convierte una discrepancia viva en una fila para la tabla `discrepancias`.
 *
 * IMPORTANTE: la fila NO incluye `estado`, `caso_id`, `primera_vista` ni
 * `created_at`. Con `upsert(..., { onConflict: 'fingerprint' })` Supabase genera
 * un INSERT ... ON CONFLICT DO UPDATE que solo actualiza las columnas presentes
 * en el payload; al omitir esas columnas, en un conflicto se refrescan
 * ultima_vista/datos/métricas pero NUNCA se sobrescriben el estado ni el caso
 * ya asignado. En un INSERT nuevo, las columnas omitidas toman su DEFAULT
 * ('abierta', null, now()).
 */
function construirFila(disc, ahora) {
  const fp = fingerprintDe(disc);
  if (!fp) return null;

  const placasEscaneadas = disc.placas_escaneadas ?? null;
  const areaPlaca = disc.area_placa_m2 ?? null;

  const m2Esperados = disc.m2_esperados != null
    ? Number(disc.m2_esperados)
    : (disc.cantidad_m2_esperada != null ? Number(disc.cantidad_m2_esperada) : null);

  const m2Escaneados = disc.m2_escaneados != null
    ? Number(disc.m2_escaneados)
    : ((areaPlaca != null && placasEscaneadas != null)
      ? Number((placasEscaneadas * areaPlaca).toFixed(2))
      : null);

  return {
    fingerprint: fp,
    tipo: disc.tipo ?? null,
    if_tranid: disc.if_tranid ?? null,
    if_id: disc.if_id ?? disc.if_internalid ?? disc.internalid ?? null,
    if_so: disc.if_so ?? disc.so ?? null,
    sucursal: sucursalDe(disc),
    if_fecha: disc.if_fecha ?? null,
    sku: disc.sku ?? null,
    lote: disc.lote ?? null,
    id_lote: disc.id_lote ?? null,
    placas_esperadas: disc.placas_esperadas ?? null,
    placas_escaneadas: placasEscaneadas,
    diferencia: disc.diferencia ?? null,
    diff_m2: disc.diff_m2 ?? null,
    m2_esperados: m2Esperados,
    m2_escaneados: m2Escaneados,
    es_cruzado: !!disc.es_cruzado,
    datos: { ...disc },
    ultima_vista: ahora,
    updated_at: ahora
  };
}

/**
 * Sincroniza las discrepancias del resultado de confronta con la tabla
 * `discrepancias` (upsert por fingerprint).
 *
 * Tolerante a errores: nunca lanza, siempre loguea.
 *
 * @param {Object} resultado - Resultado de confrontaService.confrontar().
 * @returns {Promise<{sincronizadas:number, error?:string}>}
 */
async function syncDiscrepancias(resultado) {
  try {
    const lista = (resultado && resultado.todas_las_discrepancias) || [];
    if (!Array.isArray(lista) || lista.length === 0) {
      return { sincronizadas: 0 };
    }

    const ahora = new Date().toISOString();

    // Deduplicar por fingerprint: la tabla tiene UNIQUE(fingerprint) y la
    // misma huella puede repetirse dentro del resultado de la confronta.
    const porFingerprint = new Map();
    for (const disc of lista) {
      const fila = construirFila(disc, ahora);
      if (fila) porFingerprint.set(fila.fingerprint, fila);
    }

    const filas = [...porFingerprint.values()];
    if (filas.length === 0) return { sincronizadas: 0 };

    const { error } = await supabase
      .from('discrepancias')
      .upsert(filas, { onConflict: 'fingerprint' });

    if (error) {
      console.error('[casosService.syncDiscrepancias] error:', error.message);
      return { sincronizadas: 0, error: error.message };
    }

    return { sincronizadas: filas.length };
  } catch (e) {
    console.error('[casosService.syncDiscrepancias] excepción:', e.message);
    return { sincronizadas: 0, error: e.message };
  }
}

/**
 * Adjunta a cada discrepancia viva su anotación de justificación.
 *
 * Para cada item agrega/establece `item.justificacion`:
 *   { estado, caso_id, folio, tipo } o null si la discrepancia no existe en BD.
 *
 * Usa 2 queries en lote (discrepancias por fingerprint IN (...) y casos por
 * id IN (...)), nunca N+1.
 *
 * @param {Array} lista - Discrepancias vivas con fingerprint calculable.
 * @returns {Promise<Array>} La misma lista, mutada.
 */
async function anotarDiscrepancias(lista) {
  const items = Array.isArray(lista) ? lista : [];
  if (items.length === 0) return items;

  // Por defecto, sin justificación registrada.
  for (const item of items) {
    if (item && typeof item === 'object') item.justificacion = null;
  }

  try {
    // Calcular fingerprints una sola vez y recordar a qué item pertenece.
    const conFingerprint = items
      .filter(item => item && typeof item === 'object')
      .map(item => ({ item, fingerprint: fingerprintDe(item) }))
      .filter(x => !!x.fingerprint);

    if (conFingerprint.length === 0) return items;

    const fingerprints = [...new Set(conFingerprint.map(x => x.fingerprint))];

    const { data: rows, error } = await supabase
      .from('discrepancias')
      .select('fingerprint, estado, caso_id')
      .in('fingerprint', fingerprints);

    if (error) {
      console.error('[casosService.anotarDiscrepancias] error:', error.message);
      return items;
    }

    const porFingerprint = new Map((rows || []).map(r => [r.fingerprint, r]));

    // Resolver los folios de los casos referenciados en un solo query.
    const casoIds = [...new Set(
      (rows || []).map(r => r.caso_id).filter(id => id !== null && id !== undefined)
    )];

    const casosPorId = new Map();
    if (casoIds.length > 0) {
      const { data: casos, error: errorCasos } = await supabase
        .from('casos')
        .select('id, folio, tipo_justificacion_id')
        .in('id', casoIds);

      if (errorCasos) {
        console.error('[casosService.anotarDiscrepancias] error casos:', errorCasos.message);
      } else {
        for (const c of (casos || [])) casosPorId.set(c.id, c);
      }
    }

    for (const { item, fingerprint } of conFingerprint) {
      const row = porFingerprint.get(fingerprint);
      if (!row) {
        item.justificacion = null;
        continue;
      }
      const caso = row.caso_id !== null && row.caso_id !== undefined
        ? casosPorId.get(row.caso_id)
        : null;
      item.justificacion = {
        estado: row.estado,
        caso_id: row.caso_id ?? null,
        folio: caso ? caso.folio : null,
        tipo: caso ? caso.tipo_justificacion_id : null
      };
    }
  } catch (e) {
    console.error('[casosService.anotarDiscrepancias] excepción:', e.message);
  }

  return items;
}

// ============================================================
// Errores HTTP
// ============================================================

/**
 * Construye un Error con `status` HTTP para que el controller lo traduzca a
 * una respuesta. `details` se adjunta al JSON cuando está presente.
 */
function httpError(status, message, details) {
  const e = new Error(message);
  e.status = status;
  if (details !== undefined) e.details = details;
  return e;
}

// ============================================================
// Ubicaciones / catálogos
// ============================================================

/**
 * Nombre de la ubicación del usuario (tabla ubicaciones). null si no se puede
 * resolver. Mismo patrón que auth/netsuiteController.
 */
async function obtenerNombreUbicacion(ubicacionId) {
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
 * Catálogo de tipos de justificación activos, ordenados por `orden`.
 */
async function listarTiposJustificacion() {
  const { data, error } = await supabase
    .from('tipos_justificacion')
    .select('*')
    .eq('activo', true)
    .order('orden', { ascending: true });

  if (error) {
    console.error('[casosService.listarTiposJustificacion] error:', error.message);
    throw httpError(500, 'Error al leer tipos de justificación');
  }
  return data || [];
}

/**
 * Tipo de justificación activo o null si no existe/inactivo. Lanza 500 si la
 * consulta falla.
 */
async function obtenerTipoJustificacionActivo(id) {
  const { data, error } = await supabase
    .from('tipos_justificacion')
    .select('id, clave, nombre, activo')
    .eq('id', id)
    .eq('activo', true)
    .maybeSingle();

  if (error) {
    console.error('[casosService.obtenerTipoJustificacionActivo] error:', error.message);
    throw httpError(500, 'Error al validar tipo de justificación');
  }
  return data || null;
}

// ============================================================
// Discrepancias (lectura)
// ============================================================

/**
 * Discrepancias persistidas con filtros opcionales.
 */
async function listarDiscrepancias(filtros = {}) {
  const { estado, tipo, sucursal, desde, hasta, if_tranid } = filtros;

  let query = supabase.from('discrepancias').select('*');
  if (estado) query = query.eq('estado', estado);
  if (tipo) query = query.eq('tipo', tipo);
  if (sucursal) query = query.eq('sucursal', sucursal);
  if (if_tranid) query = query.eq('if_tranid', if_tranid);
  if (desde) query = query.gte('if_fecha', desde);
  if (hasta) query = query.lte('if_fecha', hasta);

  const { data, error } = await query.order('ultima_vista', { ascending: false });

  if (error) {
    console.error('[casosService.listarDiscrepancias] error:', error.message);
    throw httpError(500, 'Error al leer discrepancias');
  }
  return data || [];
}

/**
 * Discrepancias por ids. `opciones.select` permite variar columnas y
 * `opciones.mensaje` el mensaje de error, para preservar los contratos.
 */
async function obtenerDiscrepanciasPorIds(ids, opciones = {}) {
  const select = opciones.select || 'id, estado, sucursal, caso_id';
  const mensaje = opciones.mensaje || 'Error al validar discrepancias';
  const { data, error } = await supabase
    .from('discrepancias')
    .select(select)
    .in('id', ids);

  if (error) {
    console.error('[casosService.obtenerDiscrepanciasPorIds] error:', error.message);
    throw httpError(500, mensaje);
  }
  return data || [];
}

/**
 * Discrepancias asignadas a un caso.
 */
async function obtenerDiscrepanciasDelCaso(casoId) {
  const { data, error } = await supabase
    .from('discrepancias')
    .select('id, estado, caso_id, sucursal')
    .eq('caso_id', casoId);

  if (error) {
    console.error('[casosService.obtenerDiscrepanciasDelCaso] error:', error.message);
    throw httpError(500, 'Error al leer discrepancias del caso');
  }
  return data || [];
}

/**
 * Subconjunto de `ids` que pertenecen al caso.
 */
async function obtenerIdsDiscrepanciasDelCaso(casoId, ids) {
  const { data, error } = await supabase
    .from('discrepancias')
    .select('id')
    .eq('caso_id', casoId)
    .in('id', ids);

  if (error) {
    console.error('[casosService.obtenerIdsDiscrepanciasDelCaso] error:', error.message);
    throw httpError(500, 'Error al leer discrepancias del caso');
  }
  return data || [];
}

// ============================================================
// Casos (lectura)
// ============================================================

/**
 * Casos con filtros opcionales (sin scope de ubicación; lo aplica el controller).
 */
async function listarCasos(filtros = {}) {
  const { estado, sucursal, desde, hasta } = filtros;

  let query = supabase.from('casos').select('*');
  if (estado) query = query.eq('estado', estado);
  if (sucursal) query = query.eq('sucursal', sucursal);
  if (desde) query = query.gte('created_at', desde);
  if (hasta) query = query.lte('created_at', hasta);

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) {
    console.error('[casosService.listarCasos] error:', error.message);
    throw httpError(500, 'Error al leer casos');
  }
  return data || [];
}

/**
 * Agrega `total_discrepancias` y `tipo_justificacion` a cada caso (2 queries
 * en lote, sin N+1).
 */
async function enriquecerCasos(casos) {
  const lista = Array.isArray(casos) ? casos : [];
  const casoIds = lista.map(c => c.id);

  const conteoPorCaso = new Map();
  if (casoIds.length > 0) {
    const { data: discRows, error: discError } = await supabase
      .from('discrepancias')
      .select('caso_id')
      .in('caso_id', casoIds);
    if (discError) {
      console.error('[casosService.enriquecerCasos] conteo error:', discError.message);
    } else {
      for (const d of (discRows || [])) {
        conteoPorCaso.set(d.caso_id, (conteoPorCaso.get(d.caso_id) || 0) + 1);
      }
    }
  }

  const tipoIds = [...new Set(lista.map(c => c.tipo_justificacion_id).filter(id => id !== null && id !== undefined))];
  const tiposPorId = new Map();
  if (tipoIds.length > 0) {
    const { data: tipos, error: tiposError } = await supabase
      .from('tipos_justificacion')
      .select('id, nombre, clave')
      .in('id', tipoIds);
    if (tiposError) {
      console.error('[casosService.enriquecerCasos] tipos error:', tiposError.message);
    } else {
      for (const t of (tipos || [])) tiposPorId.set(t.id, t);
    }
  }

  return lista.map(c => ({
    ...c,
    total_discrepancias: conteoPorCaso.get(c.id) || 0,
    tipo_justificacion: tiposPorId.get(c.tipo_justificacion_id) || null
  }));
}

/**
 * Filas mínimas para el resumen por estado (id, estado, sucursal, creado_por).
 */
async function resumenCasos() {
  const { data, error } = await supabase
    .from('casos')
    .select('id, estado, sucursal, creado_por');

  if (error) {
    console.error('[casosService.resumenCasos] error:', error.message);
    throw httpError(500, 'Error al leer casos');
  }
  return data || [];
}

/**
 * Caso por id o null si no existe. Lanza 500 si la consulta falla.
 */
async function obtenerCaso(id) {
  const { data, error } = await supabase
    .from('casos')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[casosService.obtenerCaso] error:', error.message);
    throw httpError(500, 'Error al leer el caso');
  }
  return data || null;
}

/**
 * Detalle completo del caso (tipo, creador/revisor, discrepancias y timeline
 * con actor). Recibe el caso ya cargado para no repetir el query.
 */
async function obtenerDetalleCaso(caso) {
  const { data: discrepancias, error: discError } = await supabase
    .from('discrepancias')
    .select('*')
    .eq('caso_id', caso.id)
    .order('id', { ascending: true });
  if (discError) console.error('[casosService.obtenerDetalleCaso] discrepancias error:', discError.message);

  const { data: eventos, error: evError } = await supabase
    .from('caso_eventos')
    .select('*')
    .eq('caso_id', caso.id)
    .order('created_at', { ascending: true });
  if (evError) console.error('[casosService.obtenerDetalleCaso] eventos error:', evError.message);

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
      console.error('[casosService.obtenerDetalleCaso] usuarios error:', usError.message);
    } else {
      for (const u of (usuarios || [])) actoresPorId.set(u.id, u);
    }
  }

  const eventosConActor = (eventos || []).map(ev => ({
    ...ev,
    actor: actoresPorId.get(ev.actor_id) || null
  }));

  let tipoJustificacion = null;
  if (caso.tipo_justificacion_id) {
    const { data: tipo, error: tipoError } = await supabase
      .from('tipos_justificacion')
      .select('*')
      .eq('id', caso.tipo_justificacion_id)
      .maybeSingle();
    if (tipoError) console.error('[casosService.obtenerDetalleCaso] tipo error:', tipoError.message);
    tipoJustificacion = tipo || null;
  }

  return {
    caso: {
      ...caso,
      tipo_justificacion: tipoJustificacion,
      creador: actoresPorId.get(caso.creado_por) || null,
      revisor: actoresPorId.get(caso.revisado_por) || null
    },
    discrepancias: discrepancias || [],
    eventos: eventosConActor
  };
}

// ============================================================
// Casos (escritura / transiciones)
// ============================================================

/**
 * UPDATE de un caso devolviendo la fila. Lanza 500 con `mensajeError`.
 */
async function actualizarCaso(casoId, cambios, mensajeError) {
  const { data, error } = await supabase
    .from('casos')
    .update(cambios)
    .eq('id', casoId)
    .select('*')
    .single();

  if (error) {
    console.error('[casosService.actualizarCaso] error:', error.message);
    throw httpError(500, mensajeError || 'Error al actualizar el caso');
  }
  return data;
}

/**
 * UPDATE de discrepancias por id. Lanza 500 con `mensajeError`.
 */
async function actualizarDiscrepancias(ids, cambios, mensajeError) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const { error } = await supabase
    .from('discrepancias')
    .update(cambios)
    .in('id', ids);

  if (error) {
    console.error('[casosService.actualizarDiscrepancias] error:', error.message);
    throw httpError(500, mensajeError || 'Error al actualizar discrepancias');
  }
}

/**
 * Inserta un evento de bitácora. Tolerante a errores (nunca lanza).
 */
async function registrarEvento(evento) {
  if (!evento) return null;
  const { error } = await supabase.from('caso_eventos').insert(evento);
  if (error) {
    console.error('[casosService.registrarEvento] error:', error.message);
    return null;
  }
  return true;
}

/**
 * Crea el caso de forma ATÓMICA vía la RPC `public.crear_caso` (una sola
 * transacción: insert caso + update discrepancias + bitácora).
 *
 * Los errores de validación de la función (errcode 22023) se traducen a 400;
 * cualquier otro error a 500 (con details).
 */
async function crearCaso({ discrepanciaIds, tipoJustificacionId, justificacion, ubicacionId = null, sucursal = null, creadoPor = null }) {
  const { data, error } = await supabase.rpc('crear_caso', {
    p_discrepancia_ids: discrepanciaIds,
    p_tipo_justificacion_id: tipoJustificacionId,
    p_justificacion: justificacion,
    p_ubicacion_id: ubicacionId ?? null,
    p_sucursal: sucursal ?? null,
    p_creado_por: creadoPor ?? null
  });

  if (error) {
    console.error('[casosService.crearCaso] rpc error:', error.message);
    if (error.code === '22023') throw httpError(400, error.message);
    throw httpError(500, 'No se pudo crear el caso', error.message);
  }
  return data;
}

/**
 * Aprueba un caso: caso -> aprobado, discrepancias -> justificada, evento.
 */
async function aprobarCaso(casoId, actorId, comentario) {
  const ahora = new Date().toISOString();

  const actualizado = await actualizarCaso(casoId, {
    estado: 'aprobado',
    revisado_por: actorId ?? null,
    revisado_at: ahora,
    comentario_revision: comentario,
    updated_at: ahora
  }, 'No se pudo aprobar el caso');

  const { error: discError } = await supabase
    .from('discrepancias')
    .update({ estado: 'justificada', updated_at: ahora })
    .eq('caso_id', casoId);
  if (discError) console.error('[casosService.aprobarCaso] discrepancias error:', discError.message);

  await registrarEvento({
    caso_id: casoId,
    evento: 'aprobado',
    actor_id: actorId ?? null,
    datos: comentario ? { comentario } : null
  });

  return actualizado;
}

/**
 * Rechaza un caso (comentario obligatorio, validado en el controller). Las
 * discrepancias permanecen `en_revision`.
 */
async function rechazarCaso(casoId, actorId, comentario) {
  const ahora = new Date().toISOString();

  const actualizado = await actualizarCaso(casoId, {
    estado: 'rechazado',
    revisado_por: actorId ?? null,
    revisado_at: ahora,
    comentario_revision: comentario,
    updated_at: ahora
  }, 'No se pudo rechazar el caso');

  await registrarEvento({
    caso_id: casoId,
    evento: 'rechazado',
    actor_id: actorId ?? null,
    datos: { comentario }
  });

  return actualizado;
}

/**
 * Reenvía un caso rechazado: ajusta discrepancias (retirar/agregar), actualiza
 * el caso y registra el evento. El controller precomputa `aQuitar`/`aAgregar`
 * (dependen del scope de ubicación).
 */
async function reenviarCaso(casoId, cambios, opciones = {}) {
  const ahora = new Date().toISOString();
  const aQuitar = Array.isArray(opciones.aQuitar) ? opciones.aQuitar : [];
  const aAgregar = Array.isArray(opciones.aAgregar) ? opciones.aAgregar : [];

  if (aQuitar.length > 0) {
    await actualizarDiscrepancias(aQuitar, { estado: 'abierta', caso_id: null, updated_at: ahora }, 'Error al actualizar discrepancias');
  }
  if (aAgregar.length > 0) {
    await actualizarDiscrepancias(aAgregar, { estado: 'en_revision', caso_id: casoId, updated_at: ahora }, 'Error al actualizar discrepancias');
  }

  const actualizado = await actualizarCaso(casoId, cambios, 'No se pudo reenviar el caso');
  await registrarEvento(opciones.evento);
  return actualizado;
}

/**
 * Retira discrepancias de un caso (vuelven a `abierta`) y registra el evento.
 */
async function retirarCaso(casoId, actorId, discrepanciaIds) {
  const ahora = new Date().toISOString();

  await actualizarDiscrepancias(
    discrepanciaIds,
    { estado: 'abierta', caso_id: null, updated_at: ahora },
    'No se pudieron retirar las discrepancias'
  );

  await registrarEvento({
    caso_id: casoId,
    evento: 'discrepancia_retirada',
    actor_id: actorId ?? null,
    datos: { discrepancia_ids: discrepanciaIds }
  });
}

/**
 * Registra un comentario en el timeline. Devuelve el evento creado o lanza 500.
 */
async function comentarCaso(casoId, actorId, comentario) {
  const { data, error } = await supabase
    .from('caso_eventos')
    .insert({
      caso_id: casoId,
      evento: 'comentario',
      actor_id: actorId ?? null,
      datos: { comentario }
    })
    .select('*')
    .single();

  if (error) {
    console.error('[casosService.comentarCaso] error:', error.message);
    throw httpError(500, 'No se pudo registrar el comentario');
  }
  return data;
}

/**
 * Ejecuta la confronta y sincroniza las discrepancias (upsert por fingerprint).
 * Devuelve { sincronizadas, error? }.
 */
async function sincronizar(filtros) {
  const resultado = await confrontaCacheService.ejecutarConfronta(filtros);
  return syncDiscrepancias(resultado);
}

module.exports = {
  calcularFingerprint,
  syncDiscrepancias,
  anotarDiscrepancias,
  // Persistencia / consultas del gestor de casos
  obtenerNombreUbicacion,
  listarTiposJustificacion,
  obtenerTipoJustificacionActivo,
  listarDiscrepancias,
  obtenerDiscrepanciasPorIds,
  obtenerDiscrepanciasDelCaso,
  obtenerIdsDiscrepanciasDelCaso,
  listarCasos,
  enriquecerCasos,
  resumenCasos,
  obtenerCaso,
  obtenerDetalleCaso,
  crearCaso,
  aprobarCaso,
  rechazarCaso,
  reenviarCaso,
  retirarCaso,
  comentarCaso,
  sincronizar,
  // Exports internos para tests
  _str: str,
  _sucursalDe: sucursalDe,
  _fingerprintDe: fingerprintDe,
  _construirFila: construirFila,
  _httpError: httpError
};
