/**
 * WMS · Controller de Auditoría (WMS 2.0 · A2)
 *
 * Visor de la bitácora central (tabla `audit_logs`) — SOLO rol admin.
 * Filtros instantáneos: tipo_evento, rango de fechas, texto (acción/email).
 * Paginación server-side.
 */

const supabase = require('../config/supabase');

const PAGE_SIZE_MAX = 100;

/**
 * GET /api/auditoria?tipo=&texto=&desde=&hasta=&page=&pageSize=
 */
const getAuditoria = async (req, res) => {
  try {
    const { tipo, texto, desde, hasta } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const desdeIdx = (page - 1) * pageSize;

    let q = supabase
      .from('audit_logs')
      .select(
        'id, tipo_evento, accion, tabla, registro_id, cambios, ip_address, user_agent, email_intento, created_at, usuario:usuarios(id, nombre_completo, email)',
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .range(desdeIdx, desdeIdx + pageSize - 1);

    if (tipo) q = q.eq('tipo_evento', String(tipo));

    // Texto libre sobre acción o email intentado (PostgREST or() solo admite
    // columnas propias; se limpia el valor para evitar romper la sintaxis).
    const limpio = String(texto || '').replace(/[,%()]/g, '').trim();
    if (limpio) q = q.or(`accion.ilike.%${limpio}%,email_intento.ilike.%${limpio}%`);

    if (desde) q = q.gte('created_at', `${desde}T00:00:00`);
    if (hasta) q = q.lte('created_at', `${hasta}T23:59:59.999`);

    const { data, error, count } = await q;
    if (error) {
      console.error('[auditoria] error consultando audit_logs:', error.message);
      return res.status(500).json({ error: 'Error consultando la bitácora' });
    }

    res.json({
      total: count ?? 0,
      page,
      pageSize,
      eventos: data || []
    });
  } catch (e) {
    console.error('getAuditoria error:', e);
    res.status(500).json({ error: e.message });
  }
};

module.exports = { getAuditoria };
