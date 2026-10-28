/**
 * Rutas de Auditoría (WMS 2.0 · A2).
 * Montadas en /api/auditoria en server.js.
 * SOLO rol admin (la bitácora es un insumo de administración).
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/auditoriaController');
const { verifyToken, requireRole } = require('../middleware/auth');

router.get('/', verifyToken, requireRole('admin'), controller.getAuditoria);

module.exports = router;
