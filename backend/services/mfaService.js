/**
 * WMS · Servicio de 2FA TOTP (WMS 2.0 · S2)
 *
 * - Secreto TOTP cifrado en reposo con AES-256-GCM (clave derivada de
 *   JWT_SECRET vía scrypt): en `usuarios.totp_secret`.
 * - Códigos de respaldo (10, formato XXXX-XXXX) guardados como hashes
 *   bcrypt en `usuarios.totp_backup_codes`.
 * - Tokens temporales (JWT de 10 min, purpose '2fa') para enlazar el paso
 *   de login con la verificación 2FA sin emitir la sesión todavía.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcryptjs = require('bcryptjs');
const { generateSecret, generate, verify, generateURI } = require('otplib');

// ────────────────────────────────────────────────────────────
// Cifrado del secreto TOTP (AES-256-GCM)
// ────────────────────────────────────────────────────────────

function claveCifrado() {
  return crypto.scryptSync(process.env.JWT_SECRET || 'wms-desarrollo', 'wms-2fa-aes-v1', 32);
}

function cifrarSecreto(texto) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', claveCifrado(), iv);
  const enc = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map(b => b.toString('base64')).join('.');
}

function descifrarSecreto(payload) {
  const [iv, tag, enc] = String(payload).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', claveCifrado(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ────────────────────────────────────────────────────────────
// Códigos de respaldo
// ────────────────────────────────────────────────────────────

const ALFABETO_BACKUP = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I

function generarCodigosRespaldo(cantidad = 10) {
  const codigos = [];
  for (let i = 0; i < cantidad; i++) {
    const bytes = crypto.randomBytes(8);
    let s = '';
    for (const b of bytes) s += ALFABETO_BACKUP[b % ALFABETO_BACKUP.length];
    codigos.push(`${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return codigos;
}

async function hashearCodigosRespaldo(codigos) {
  return Promise.all(codigos.map(c => bcryptjs.hash(c.toUpperCase(), 10)));
}

/**
 * Verifica el código contra los hashes de respaldo.
 * @returns {Promise<{ok: boolean, hashesRestantes: string[]}>}
 */
async function verificarCodigoRespaldo(hashes, codigo) {
  const limpio = String(codigo || '').trim().toUpperCase();
  const restantes = [];
  let ok = false;
  for (const h of hashes || []) {
    if (!ok && await bcryptjs.compare(limpio, h)) {
      ok = true; // consumido: no se conserva
    } else {
      restantes.push(h);
    }
  }
  return { ok, hashesRestantes: restantes };
}

// ────────────────────────────────────────────────────────────
// TOTP
// ────────────────────────────────────────────────────────────

async function generarEnrolamiento(email) {
  const secret = await generateSecret();
  const uri = await generateURI({
    secret,
    label: `WMS:${email}`,
    issuer: 'WMS Marblock'
  });
  const backupCodes = generarCodigosRespaldo();
  return {
    secret,
    uri,
    backupCodes,
    secretCifrado: cifrarSecreto(secret),
    backupHashes: await hashearCodigosRespaldo(backupCodes)
  };
}

/** Verifica un código TOTP de 6 dígitos contra el secreto descifrado. */
async function verificarTOTP(secretCifrado, codigo) {
  try {
    const secret = descifrarSecreto(secretCifrado);
    const resultado = await verify({ token: String(codigo || '').trim(), secret });
    return Boolean(resultado && resultado.valid);
  } catch (e) {
    console.error('[2fa] error verificando TOTP:', e.message);
    return false;
  }
}

/** Genera el URI otpauth para un secreto ya conocido (re-mostrar QR). */
async function generarURIAuth(email, secret) {
  return generateURI({ secret, label: `WMS:${email}`, issuer: 'WMS Marblock' });
}

// ────────────────────────────────────────────────────────────
// Tokens temporales del flujo 2FA
// ────────────────────────────────────────────────────────────

function generarTempToken(userId, paso) {
  return jwt.sign({ id: userId, purpose: '2fa', paso }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

function verificarTempToken(token, pasoEsperado) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== '2fa' || decoded.paso !== pasoEsperado) return null;
    return decoded;
  } catch (e) {
    return null;
  }
}

module.exports = {
  cifrarSecreto,
  descifrarSecreto,
  generarCodigosRespaldo,
  hashearCodigosRespaldo,
  verificarCodigoRespaldo,
  generarEnrolamiento,
  verificarTOTP,
  generarURIAuth,
  generarTempToken,
  verificarTempToken
};
