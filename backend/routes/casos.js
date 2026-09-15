/**
 * Rutas del gestor de casos de auditoría (WMS).
 * Montadas en /api/casos en server.js.
 *
 * Patrón: routes -> controller -> services.
 * Todas las rutas requieren verifyToken + requireRole por endpoint.
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/casosController');
const { verifyToken, requireRole } = require('../middleware/auth');

const ROLES_JEFE = ['jefe_almacen', 'gerente', 'admin'];
const ROLES_GERENTE = ['gerente', 'admin'];
const ROLES_CREAR = ['jefe_almacen', 'admin'];
const ROLES_JEFE_ADMIN = ['jefe_almacen', 'admin'];

// Rutas literales primero (evitan que ':id' capture 'resumen'/'tipos-justificacion').
router.get('/resumen', verifyToken, requireRole(...ROLES_JEFE), controller.getResumen);
router.get('/tipos-justificacion', verifyToken, requireRole(...ROLES_JEFE), controller.getTiposJustificacion);
router.get('/discrepancias', verifyToken, requireRole(...ROLES_JEFE), controller.getDiscrepancias);

// Sync y listado/creación.
router.post('/sync', verifyToken, requireRole(...ROLES_JEFE), controller.postSync);
router.get('/', verifyToken, requireRole(...ROLES_JEFE), controller.getCasos);
router.post('/', verifyToken, requireRole(...ROLES_CREAR), controller.postCaso);

// Detalle y transiciones por id.
router.get('/:id', verifyToken, requireRole(...ROLES_JEFE), controller.getCasoDetalle);
router.post('/:id/aprobar', verifyToken, requireRole(...ROLES_GERENTE), controller.postAprobar);
router.post('/:id/rechazar', verifyToken, requireRole(...ROLES_GERENTE), controller.postRechazar);
router.put('/:id/reenviar', verifyToken, requireRole(...ROLES_JEFE_ADMIN), controller.putReenviar);
router.post('/:id/retirar', verifyToken, requireRole(...ROLES_JEFE_ADMIN), controller.postRetirar);
router.post('/:id/comentarios', verifyToken, requireRole(...ROLES_JEFE), controller.postComentario);

module.exports = router;
