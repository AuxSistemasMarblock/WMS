/**
 * Rutas de etiquetas (impresión Zebra).
 * Acceso restringido a jefe de almacén y admin.
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/etiquetasController');
const { verifyToken, requireRole } = require('../middleware/auth');

const allowedRoles = ['jefe_almacen', 'admin'];

router.get('/existencias', verifyToken, requireRole(...allowedRoles), controller.getExistencias);
router.get('/lotes', verifyToken, requireRole(...allowedRoles), controller.getLotes);
router.post('/pedimento', verifyToken, requireRole(...allowedRoles), controller.postPedimento);
router.post('/zpl', verifyToken, requireRole(...allowedRoles), controller.postZpl);

module.exports = router;
