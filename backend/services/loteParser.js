/**
 * Parser del campo lote y cálculo de placas esperadas.
 *
 * Formato esperado del lote: {id}-{largo}X{ancho}
 * Ejemplo: "15760-3.14X1.96"
 *   id    = "15760"
 *   largo = 3.14  (metros)
 *   ancho = 1.96  (metros)
 *
 * Cálculo de placas esperadas:
 *   placas = Math.round(cantidad_m2 / (largo * ancho))
 *
 * Casos manejados:
 *   - Lotes con formato válido → {id, largo, ancho}
 *   - Lotes sin formato de medidas → null (se omite validación de cantidad)
 *   - "x" minúscula o "X" mayúscula → case-insensitive
 *   - Decimales con punto o coma
 *   - Espacios alrededor de la "X"
 *
 * Ver DOCUMENTATION.md §6.14 para la estructura del Sheet.
 */

/**
 * Parsea un lote con formato {id}-{largo}X{ancho}
 *
 * @param {string} lote
 * @returns {{id: string, largo: number, ancho: number, area: number} | null}
 */
function parseLote(lote) {
  if (!lote || typeof lote !== 'string') return null;

  const limpio = lote.trim();
  if (!limpio) return null;

  // Primer "-" separa id de medidas
  const dashIdx = limpio.indexOf('-');
  if (dashIdx === -1) return null;

  const id = limpio.substring(0, dashIdx).trim();
  const medidasStr = limpio.substring(dashIdx + 1).trim();

  if (!id) return null;

  // Regex: acepta "3.14X1.96", "3.14x1.96", "3,14X1,96", con/sin espacios
  // Solo capturamos las primeras 2 dimensiones (largo x ancho)
  const m = medidasStr.match(/^([\d]+(?:[.,]\d+)?)\s*[xX]\s*([\d]+(?:[.,]\d+)?)/);
  if (!m) return null;

  const normalizar = (s) => parseFloat(s.replace(',', '.'));
  const largo = normalizar(m[1]);
  const ancho = normalizar(m[2]);

  if (isNaN(largo) || isNaN(ancho) || largo <= 0 || ancho <= 0) return null;

  return {
    id,
    largo,
    ancho,
    area: largo * ancho
  };
}

/**
 * Calcula placas esperadas a partir de m² y dimensiones del lote.
 *
 * @param {number|string} cantidadM2
 * @param {string} lote
 * @returns {number | null} - null si el lote no tiene medidas reconocibles
 */
function placasEsperadas(cantidadM2, lote) {
  const parsed = parseLote(lote);
  if (!parsed) return null;

  const m2 = parseFloat(cantidadM2);
  if (isNaN(m2) || m2 <= 0) return null;

  return Math.round(m2 / parsed.area);
}

/**
 * Evalúa una línea completa: calcula esperadas vs escaneadas y devuelve el status.
 *
 * @param {number} cantidadM2
 * @param {string} lote
 * @param {number} placasEscaneadas
 * @returns {Object}
 */
function evaluarCantidad(cantidadM2, lote, placasEscaneadas) {
  const parsed = parseLote(lote);

  if (!parsed) {
    return {
      status: 'sin_medidas',
      placas_esperadas: null,
      placas_escaneadas,
      diferencia: null,
      mensaje: 'Lote sin formato de medidas ({id}-{largo}X{ancho})'
    };
  }

  const placasEsp = Math.round(parseFloat(cantidadM2) / parsed.area);
  const diferencia = placasEscaneadas - placasEsp;

  let status = 'ok';
  if (diferencia < 0) status = 'faltante';
  else if (diferencia > 0) status = 'sobrante';

  return {
    status,
    placas_esperadas: placasEsp,
    placas_escaneadas: placasEscaneadas,
    diferencia: Math.abs(diferencia),
    area_placa_m2: parsed.area,
    id_lote: parsed.id
  };
}

module.exports = {
  parseLote,
  placasEsperadas,
  evaluarCantidad
};
