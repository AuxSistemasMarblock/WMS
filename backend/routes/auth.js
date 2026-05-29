const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifyToken } = require('../middleware/auth');

/**
 * POST /auth/login
 * Autentica usuario con email y contraseña
 */
router.post('/login', authController.login);

/**
 * POST /auth/register
 * Crea nuevo usuario (genera hash bcrypt automáticamente)
 */
router.post('/register', authController.register);

/**
 * GET /auth/user
 * Obtiene datos del usuario autenticado (requiere JWT)
 */
router.get('/user', verifyToken, authController.getUser);

/**
 * POST /auth/logout
 * Cierra sesión (stateless, se maneja en frontend)
 */
router.post('/logout', authController.logout);

/**
 * POST /auth/generate-hash
 * Genera hash bcrypt para una contraseña (SOLO PARA TESTING/DESARROLLO)
 */
router.post('/generate-hash', authController.generateHash);

module.exports = router;
