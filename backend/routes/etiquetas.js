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
// WMS 2.0 · R3: catálogo real de ubicaciones para el filtro (antes derivado de datos)
router.get('/ubicaciones', verifyToken, requireRole(...allowedRoles), controller.getUbicaciones);
router.post('/pedimento', verifyToken, requireRole(...allowedRoles), controller.postPedimento);
router.post('/zpl', verifyToken, requireRole(...allowedRoles), controller.postZpl);
router.get('/irs', verifyToken, requireRole(...allowedRoles), controller.getIRs);
router.get('/ir/:idOrTranid', verifyToken, requireRole(...allowedRoles), controller.getIRDetail);
router.post('/zpl-bulk', verifyToken, requireRole(...allowedRoles), controller.postZplBulk);

module.exports = router;
