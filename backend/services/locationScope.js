/**
 * Alcance de ubicaciones por usuario (compartido por escáner, casos y afines).
 *
 * Reglas:
 *  - La whitelist (SHARED_LOCATIONS) es visible para todos.
 *  - Una ubicación de sucursal/outlet (MEX, GDL, MTY, "OUTLET GDL",
 *    "MEX:OUTLET", "MEX : OUTLET MEX") solo es visible para usuarios cuya
 *    sucursal coincide. Así un jefe de GDL ve "GDL" y "OUTLET GDL", pero nunca
 *    "OUTLET MEX".
 *  - Sin sucursal detectable: coincidencia exacta o por tokens (todos los
 *    tokens de la ubicación del usuario deben aparecer en la de la fila).
 */

const config = require('../config/environments');

const RESTRICTED_LOCATION_PREFIXES = config.netsuite.RESTRICTED_LOCATION_PREFIXES || ['MEX', 'MTY', 'GDL'];
const SHARED_LOCATIONS = config.netsuite.SHARED_LOCATIONS || ['TEMPORAL', 'PROYECTOS', 'Material Transformado', 'MATRIZ'];

/**
 * Sucursal (MEX/MTY/GDL) de una ubicación, o null si no es de una sucursal
 * restringida. Reconoce "MEX", "MEX:OUTLET", "MEX : OUTLET MEX", "OUTLET MEX".
 */
function branchOf(loc) {
  const s = String(loc || '').trim().toUpperCase();
  if (!s) return null;
  return RESTRICTED_LOCATION_PREFIXES.find(p => {
    const P = String(p).toUpperCase();
    return s === P
      || s.startsWith(P + ':')
      || s.startsWith(P + ' ')
      || s.startsWith('OUTLET ' + P);
  }) || null;
}

/**
 * Verdadero si la ubicación pertenece a la lista blanca compartida (visible
 * para todos). SOLO estas ubicaciones se comparten.
 */
function esUbicacionCompartida(loc) {
  if (!loc) return false;
  return SHARED_LOCATIONS.includes(loc);
}

/**
 * Verdadero si `loc` es visible para un usuario de ubicación `userLocationName`.
 */
function esVisibleParaUbicacion(loc, userLocationName) {
  if (!loc || !userLocationName) return false;
  if (esUbicacionCompartida(loc)) return true;

  const userBranch = branchOf(userLocationName);
  const locBranch = branchOf(loc);
  if (userBranch && locBranch) return userBranch === locBranch;

  if (loc === userLocationName) return true;
  const tokens = String(loc).split(/[\s:]+/).filter(Boolean);
  const userTokens = String(userLocationName).split(/[\s:]+/).filter(Boolean);
  return userTokens.length > 0 && userTokens.every(t => tokens.includes(t));
}

module.exports = {
  RESTRICTED_LOCATION_PREFIXES,
  SHARED_LOCATIONS,
  branchOf,
  esUbicacionCompartida,
  esVisibleParaUbicacion
};
