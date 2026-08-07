/**
 * Rutas del Dashboard de Supply Chain.
 * Montadas en /api/dashboard en server.js.
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/dashboardController');
const { verifyToken } = require('../middleware/auth');

// Healthcheck (sin auth)
router.get('/health', controller.health);

// Endpoints protegidos (requieren JWT)
router.get('/resumen',         verifyToken, controller.getResumen);
router.get('/sucursales',      verifyToken, controller.getSucursales);
router.get('/ifs-mal-sacadas', verifyToken, controller.getIFsMalSacadas);
router.get('/if/:tranid/detalle', verifyToken, controller.getIFDetalle);
router.get('/discrepancias',   verifyToken, controller.getDiscrepancias);
router.get('/top-errores',     verifyToken, controller.getTopErrores);
router.get('/ifs-ok',          verifyToken, controller.getIFsOK);
router.get('/articulos-mas-salidas', verifyToken, controller.getArticulosMasSalidas);

module.exports = router;
