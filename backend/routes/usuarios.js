/**
 * Rutas de gestión de Usuarios (WMS 2.0 · R2).
 * Montadas en /api/usuarios en server.js.
 * SOLO rol admin (requireAdmin en todas).
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/usuariosController');
const authController = require('../controllers/authController');
const { verifyToken, requireAdmin } = require('../middleware/auth');

// Literales antes que ':id'
router.get('/catalogos', verifyToken, requireAdmin, controller.getCatalogos);
router.get('/', verifyToken, requireAdmin, controller.getUsuarios);

// Alta: reutiliza el registro existente (ya audita usuario_creado)
router.post('/', verifyToken, requireAdmin, authController.register);

router.patch('/:id', verifyToken, requireAdmin, controller.putUsuario);
router.post('/:id/password', verifyToken, requireAdmin, controller.postResetPassword);

module.exports = router;
