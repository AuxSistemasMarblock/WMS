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
 */
router.post('/login', loginRateLimit, requireTurnstile, authController.login);

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
