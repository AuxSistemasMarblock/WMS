/**
 * Servicio del gestor de casos de auditoría.
 *
 * Responsabilidades:
 *  - calcularFingerprint(): huella estable de una discrepancia viva.
 *  - syncDiscrepancias(): upsert tolerante a errores en la tabla discrepancias.
 *  - anotarDiscrepancias(): adjunta el estado de justificación/caso a una lista
 *    de discrepancias vivas, resolviendo el folio con un join en lote a casos
 *    (sin N+1).
 *
 * El backend usa la service role key (backend/config/supabase.js), que bypassa
 * RLS; ver supabase/migrations/0001_gestor_casos.sql.
 */

const crypto = require('crypto');
const supabase = require('../config/supabase');

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

module.exports = {
  calcularFingerprint,
  syncDiscrepancias,
  anotarDiscrepancias,
  // Exports internos para tests
  _str: str,
  _sucursalDe: sucursalDe,
  _fingerprintDe: fingerprintDe,
  _construirFila: construirFila
};
