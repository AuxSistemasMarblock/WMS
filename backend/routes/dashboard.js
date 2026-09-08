/**
 * Rutas del Dashboard de Supply Chain.
 * Montadas en /api/dashboard en server.js.
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/dashboardController');
const { verifyToken, requireRole } = require('../middleware/auth');
const allowedRoles = ['admin', 'gerente'];

// Healthcheck (sin auth)
router.get('/health', controller.health);

// Endpoints protegidos (requieren JWT y rol admin o gerente)
router.get('/confronta', verifyToken, requireRole(...allowedRoles), controller.getConfrontaFull);
router.get('/resumen',         verifyToken, requireRole(...allowedRoles), controller.getResumen);
router.get('/sucursales',      verifyToken, requireRole(...allowedRoles), controller.getSucursales);
router.get('/ifs-mal-sacadas', verifyToken, requireRole(...allowedRoles), controller.getIFsMalSacadas);
router.get('/ifs-canceladas',  verifyToken, requireRole(...allowedRoles), controller.getIFsCanceladas);
router.get('/if/:tranid/detalle', verifyToken, requireRole(...allowedRoles), controller.getIFDetalle);
router.get('/discrepancias',   verifyToken, requireRole(...allowedRoles), controller.getDiscrepancias);
router.get('/top-errores',     verifyToken, requireRole(...allowedRoles), controller.getTopErrores);
router.get('/ifs-ok',          verifyToken, requireRole(...allowedRoles), controller.getIFsOK);
router.get('/articulos-mas-salidas', verifyToken, requireRole(...allowedRoles), controller.getArticulosMasSalidas);

module.exports = router;
