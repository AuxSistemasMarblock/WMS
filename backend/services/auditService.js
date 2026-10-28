/**
 * WMS · Servicio de auditoría (WMS 2.0 · A1)
 *
 * Bitácora central en la tabla `audit_logs`: inicios de sesión (exitosos y
 * fallidos), cambios y envíos. Retención indefinida.
 *
 * Todas las escrituras son FIRE-AND-FORGET: nunca bloquean ni rompen el
 * flujo principal si fallan (el error se reporta por consola). Los
 * consumidores NO deben hacer await salvo que el flujo lo requiera.
 */

const supabase = require('../config/supabase');

const TIPOS = {
  LOGIN_EXITOSO: 'login_exitoso',
  LOGIN_FALLIDO: 'login_fallido',
  CAMBIO: 'cambio',
  ENVIO: 'envio'
};

/** IP real del cliente (requiere `app.set('trust proxy', true)` detrás de Traefik). */
function ipDe(req) {
  return req?.ip || req?.socket?.remoteAddress || null;
}

function userAgentDe(req) {
  return req?.headers?.['user-agent'] || null;
}

/**
 * Registra un evento de auditoría en la tabla `audit_logs`.
 * Mapea al esquema existente: accion, tabla, registro_id, cambios,
 * ip_address, user_agent + las columnas nuevas tipo_evento/email_intento.
 *
 * @param {Object} ev
 * @param {number|null} ev.usuarioId    - Usuario afectado (null en login fallido)
 * @param {string|null} ev.emailIntento - Email intentado (login fallido)
 * @param {string} ev.tipoEvento        - Uno de TIPOS
 * @param {string} ev.accion            - Descripción corta (ej. 'login', 'caso_aprobado')
 * @param {string|null} ev.entidad      - Tabla/entidad afectada (ej. 'usuarios', 'casos')
 * @param {string|number|null} ev.entidadId - Id de la entidad (numérico; otros van en detalle)
 * @param {Object|null} ev.detalle      - Contexto libre (jsonb `cambios`)
 * @param {string|null} ev.ip
 * @param {string|null} ev.userAgent
 */
async function registrar(ev) {
  try {
    const registroId = Number(ev.entidadId);
    const { error } = await supabase.from('audit_logs').insert({
      usuario_id: ev.usuarioId ?? null,
      email_intento: ev.emailIntento ?? null,
      tipo_evento: ev.tipoEvento,
      accion: ev.accion,
      tabla: ev.entidad || 'sistema',
      registro_id: Number.isInteger(registroId) && registroId > 0 ? registroId : null,
      cambios: ev.detalle ?? null,
      ip_address: ev.ip ?? null,
      user_agent: ev.userAgent ?? null
    });
    if (error) {
      console.error('[audit] error registrando evento:', error.message);
    }
  } catch (e) {
    // La auditoría jamás debe tumbar el flujo principal.
    console.error('[audit] excepción registrando evento:', e.message);
  }
}

/**
 * Atajo para eventos ligados a una request: completa usuario, ip y user-agent.
 */
function registrarDesdeReq(req, ev) {
  return registrar({
    usuarioId: ev.usuarioId ?? req?.user?.id ?? null,
    ip: ipDe(req),
    userAgent: userAgentDe(req),
    ...ev
  });
}

module.exports = { TIPOS, registrar, registrarDesdeReq, ipDe, userAgentDe };
