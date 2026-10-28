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

// WMS 2.0 · R1: el rol 'lider' audita y aprueba casos (antes lo hacía el
// gerente). El gerente queda fuera del gestor de casos (solo ve Confronta).
const ROLES_LECTURA = ['jefe_almacen', 'lider', 'admin'];
const ROLES_APROBAR = ['lider', 'admin'];
// WMS 2.0 · R3: el lider "gestiona los casos" — puede crearlos desde la vista
// "Por crear" (además del jefe que detecta el error y el admin).
const ROLES_CREAR = ['jefe_almacen', 'lider', 'admin'];
const ROLES_JEFE_ADMIN = ['jefe_almacen', 'admin'];

// Rutas literales primero (evitan que ':id' capture 'resumen'/'tipos-justificacion').
router.get('/resumen', verifyToken, requireRole(...ROLES_LECTURA), controller.getResumen);
router.get('/tipos-justificacion', verifyToken, requireRole(...ROLES_LECTURA), controller.getTiposJustificacion);
router.get('/discrepancias', verifyToken, requireRole(...ROLES_LECTURA), controller.getDiscrepancias);

// Sync y listado/creación.
router.post('/sync', verifyToken, requireRole(...ROLES_LECTURA), controller.postSync);
router.get('/', verifyToken, requireRole(...ROLES_LECTURA), controller.getCasos);
router.post('/', verifyToken, requireRole(...ROLES_CREAR), controller.postCaso);

// Detalle y transiciones por id.
router.get('/:id', verifyToken, requireRole(...ROLES_LECTURA), controller.getCasoDetalle);
router.post('/:id/aprobar', verifyToken, requireRole(...ROLES_APROBAR), controller.postAprobar);
router.post('/:id/rechazar', verifyToken, requireRole(...ROLES_APROBAR), controller.postRechazar);
router.put('/:id/reenviar', verifyToken, requireRole(...ROLES_JEFE_ADMIN), controller.putReenviar);
router.post('/:id/retirar', verifyToken, requireRole(...ROLES_JEFE_ADMIN), controller.postRetirar);
router.post('/:id/comentarios', verifyToken, requireRole(...ROLES_LECTURA), controller.postComentario);

module.exports = router;
