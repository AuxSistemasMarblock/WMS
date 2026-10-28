/**
 * Rutas del Dashboard de Supply Chain.
 * Montadas en /api/dashboard en server.js.
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/dashboardController');
const supabase = require('../config/supabase');
const { verifyToken, requireRole } = require('../middleware/auth');

// WMS 2.0 · R1: 'lider' ve todas las ubicaciones; 'gerente' solo la suya.
const allowedRoles = ['admin', 'lider', 'gerente'];

// Memo de ubicacion_id -> nombre (evita repetir la consulta por request).
const ubicacionNombreCache = new Map();

/**
 * Scope del gerente (WMS 2.0 · R1): "solo puede ver lo relacionado a su
 * ubicación". Fuerza el filtro `sucursal` al nombre de la ubicación del
 * usuario (el matcher sucursalMatch incluye sus outlets: "MEX" incluye
 * "OUTLET MEX"). Ignora cualquier `sucursal` que intente pasar el cliente.
 * admin y lider no se tocan (visión global con selector).
 */
const scopeGerenteSucursal = async (req, res, next) => {
  const rol = String(req.user?.rol ?? '').toLowerCase().trim();
  if (rol !== 'gerente') return next();

  try {
    const ubicacionId = req.user.ubicacion_id;
    if (!ubicacionId) {
      return res.status(403).json({ error: 'Usuario sin ubicación asignada' });
    }
    let nombre = ubicacionNombreCache.get(ubicacionId);
    if (!nombre) {
      const { data: ubicacion, error } = await supabase
        .from('ubicaciones')
        .select('id, nombre')
        .eq('id', ubicacionId)
        .single();
      if (error || !ubicacion?.nombre) {
        return res.status(403).json({ error: 'Ubicación del usuario no encontrada' });
      }
      nombre = ubicacion.nombre;
      ubicacionNombreCache.set(ubicacionId, nombre);
    }
    req.query.sucursal = nombre;
    next();
  } catch (e) {
    next(e);
  }
};

// Healthcheck (sin auth)
router.get('/health', controller.health);

// Endpoints protegidos (requieren JWT y rol admin, lider o gerente)
router.get('/confronta', verifyToken, requireRole(...allowedRoles), scopeGerenteSucursal, controller.getConfrontaFull);
router.get('/resumen',         verifyToken, requireRole(...allowedRoles), scopeGerenteSucursal, controller.getResumen);
router.get('/sucursales',      verifyToken, requireRole(...allowedRoles), scopeGerenteSucursal, controller.getSucursales);
router.get('/ifs-mal-sacadas', verifyToken, requireRole(...allowedRoles), scopeGerenteSucursal, controller.getIFsMalSacadas);
router.get('/ifs-canceladas',  verifyToken, requireRole(...allowedRoles), scopeGerenteSucursal, controller.getIFsCanceladas);
router.get('/if/:tranid/detalle', verifyToken, requireRole(...allowedRoles), scopeGerenteSucursal, controller.getIFDetalle);
router.get('/discrepancias',   verifyToken, requireRole(...allowedRoles), scopeGerenteSucursal, controller.getDiscrepancias);
router.get('/top-errores',     verifyToken, requireRole(...allowedRoles), scopeGerenteSucursal, controller.getTopErrores);
router.get('/ifs-ok',          verifyToken, requireRole(...allowedRoles), scopeGerenteSucursal, controller.getIFsOK);
router.get('/articulos-mas-salidas', verifyToken, requireRole(...allowedRoles), scopeGerenteSucursal, controller.getArticulosMasSalidas);

module.exports = router;
