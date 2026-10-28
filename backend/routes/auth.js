const express = require('express');
const router = express.Router();
const { rateLimit } = require('express-rate-limit');
const authController = require('../controllers/authController');
const { verifyToken, requireAdmin, devOnly } = require('../middleware/auth');
const { requireTurnstile } = require('../middleware/turnstile');

// WMS 2.0 · S1: rate limiting en login (10 intentos / 15 min por IP),
// recomendación "Alta" de la nota Seguridad crítica.
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.' }
});

/**
 * POST /auth/login
 * Autentica usuario con email y contraseña.
 * WMS 2.0 · S1: pasa por rate limit y verificación de Turnstile (captcha).
 * WMS 2.0 · S2: para admin responde con tempToken y exige 2FA (o su
 * enrolamiento forzado) antes de emitir la sesión.
 */
router.post('/login', loginRateLimit, requireTurnstile, authController.login);

/**
 * POST /auth/login/2fa — segundo paso del login de admin (código TOTP o
 * código de respaldo). Rate limited para impedir fuerza bruta de códigos.
 */
router.post('/login/2fa', loginRateLimit, authController.login2FA);

/**
 * POST /auth/2fa/setup — inicia el enrolamiento forzado del admin (QR + códigos
 * de respaldo). Requiere tempToken de paso '2fa_enrolamiento'.
 */
router.post('/2fa/setup', loginRateLimit, authController.setup2FA);

/**
 * POST /auth/2fa/verify-setup — confirma el primer código y activa el 2FA.
 */
router.post('/2fa/verify-setup', loginRateLimit, authController.verifySetup2FA);

/**
 * POST /auth/register
 * Crea nuevo usuario (genera hash bcrypt automáticamente).
 * Requiere sesión de administrador.
 */
router.post('/register', verifyToken, requireAdmin, authController.register);

/**
 * GET /auth/user
 * Obtiene datos del usuario autenticado (requiere JWT)
 */
router.get('/user', verifyToken, authController.getUser);

/**
 * POST /auth/set-pin
 * Configura o actualiza PIN de autorización para jefes/admins
 */
router.post('/set-pin', verifyToken, authController.setPin);

/**
 * POST /auth/logout
 * Cierra sesión (stateless, se maneja en frontend)
 */
router.post('/logout', authController.logout);

/**
 * POST /auth/generate-hash
 * Genera hash bcrypt para una contraseña (SOLO PARA DESARROLLO)
 */
router.post('/generate-hash', devOnly, authController.generateHash);

module.exports = router;
