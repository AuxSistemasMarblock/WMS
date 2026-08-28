const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token', details: error.message });
  }
};

/**
 * Requiere que el usuario autenticado tenga uno de los roles indicados.
 * Debe usarse DESPUÉS de verifyToken (necesita req.user).
 * Lee req.user.rol (nueva clave) con fallback a req.user.cargo (tokens viejos).
 *
 * @param {...string} roles - Claves de rol permitidas (ej. 'admin', 'jefe_almacen')
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const rol = req.user.rol ?? req.user.cargo;
  if (!roles.includes(rol)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

/**
 * Requiere que el usuario autenticado tenga rol admin.
 * Debe usarse DESPUÉS de verifyToken (necesita req.user).
 */
const requireAdmin = requireRole('admin');

/**
 * Solo disponible fuera de producción (debug/diagnóstico).
 * En producción responde 404 para ocultar la existencia del endpoint.
 */
const devOnly = (req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
};

module.exports = { verifyToken, requireAdmin, requireRole, devOnly };
