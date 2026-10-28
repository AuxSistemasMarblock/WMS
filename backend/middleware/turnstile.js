/**
 * WMS · Verificación de Cloudflare Turnstile (WMS 2.0 · S1)
 *
 * Valida el token `cf-turnstile-response` del login contra el endpoint
 * siteverify de Cloudflare ANTES de tocar credenciales.
 *
 * Si TURNSTILE_SECRET no está configurado (desarrollo local), la verificación
 * se omite con un aviso — en producción la variable SIEMPRE debe existir.
 * Falla CERRADA: si siteverify no responde o rechaza, no se permite el login.
 */

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verificarTokenTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) {
    console.warn('[turnstile] TURNSTILE_SECRET no configurado: verificación OMITIDA (solo válido en desarrollo)');
    return { ok: true, omitido: true };
  }

  if (!token || typeof token !== 'string') {
    return { ok: false, motivo: 'token_faltante' };
  }

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.append('remoteip', remoteIp);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body,
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.error('[turnstile] siteverify HTTP', res.status);
      return { ok: false, motivo: 'siteverify_http_' + res.status };
    }

    const data = await res.json();
    return data.success
      ? { ok: true }
      : { ok: false, motivo: 'token_invalido', errores: data['error-codes'] || [] };
  } catch (e) {
    // Falla cerrada: sin verificación no hay login.
    console.error('[turnstile] error consultando siteverify:', e.message);
    return { ok: false, motivo: 'siteverify_inaccesible' };
  }
}

/**
 * Middleware Express para el POST /auth/login.
 * Acepta el token como `turnstileToken` (contrato de la app) o
 * `cf-turnstile-response` (contrato nativo del widget).
 */
const requireTurnstile = async (req, res, next) => {
  const token = req.body?.turnstileToken || req.body?.['cf-turnstile-response'] || '';
  const remoteIp = req.ip || req.socket?.remoteAddress || null;

  const resultado = await verificarTokenTurnstile(token, remoteIp);
  if (!resultado.ok) {
    return res.status(403).json({ error: 'Verificación de seguridad fallida', motivo: resultado.motivo });
  }
  next();
};

module.exports = { requireTurnstile, verificarTokenTurnstile };
