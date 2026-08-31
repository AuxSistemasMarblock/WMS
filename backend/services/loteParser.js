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

  // Buscamos las dimensiones en cualquier parte del string (normalmente al final)
  // Ejemplos: "15760-3.14X1.96", "24100-082-2.77x2.00", "ST027 1.40X1.79"
  const regex = /([\d]+(?:[.,]\d+)?)\s*[xX]\s*([\d]+(?:[.,]\d+)?)/;
  const match = limpio.match(regex);
  if (!match) return null;

  let id = limpio.substring(0, match.index).trim();
  if (id.endsWith('-')) {
    id = id.substring(0, id.length - 1).trim();
  }

  if (!id) return null;

  const normalizar = (s) => parseFloat(s.replace(',', '.'));
  const largo = normalizar(match[1]);
  const ancho = normalizar(match[2]);

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
      tipo_discrepancia: 'sin_medidas',
      placas_esperadas: null,
      placas_escaneadas: placasEscaneadas,
      diferencia: null,
      mensaje: 'Lote sin formato de medidas ({id}-{largo}X{ancho})'
    };
  }

  const m2Esperados = parseFloat(cantidadM2);
  const areaPlaca = parsed.area;
  const placasTeoricas = m2Esperados / areaPlaca;
  const m2Escaneados = placasEscaneadas * areaPlaca;
  const diffM2 = m2Escaneados - m2Esperados;

  const fraccion = placasTeoricas - Math.floor(placasTeoricas);
  const esFraccionEsperada = (fraccion > 0.08 && fraccion < 0.92);

  let status = 'ok';
  let es_media_placa = false;
  let tipo_discrepancia = null;
  const placasEsp = Math.round(placasTeoricas);
  const diffPlacas = placasEscaneadas - placasEsp;

  if (esFraccionEsperada) {
    // Se pidió una fracción en el ERP (ej: 0.5 placa, 2.5 placas)
    // Si se escanearon placas completas y el área escaneada excede lo pedido
    if (diffM2 > (areaPlaca * 0.15)) {
      status = 'con_errores';
      es_media_placa = true;
      tipo_discrepancia = 'media_placa';
    } else if (diffM2 < -(areaPlaca * 0.15)) {
      status = 'con_errores';
      es_media_placa = true;
      tipo_discrepancia = 'cantidad_faltante';
    }
  } else {
    // Caso de placas completas
    if (diffPlacas < 0) {
      status = 'faltante';
      tipo_discrepancia = 'cantidad_faltante';
    } else if (diffPlacas > 0) {
      status = 'sobrante';
      tipo_discrepancia = 'cantidad_sobrante';
    }
  }

  const m2EspRedondeado = parseFloat(m2Esperados.toFixed(2));
  const m2EscRedondeado = parseFloat(m2Escaneados.toFixed(2));
  const diffM2Final = parseFloat(Math.abs(m2EscRedondeado - m2EspRedondeado).toFixed(2));

  const placasEsperadasNormalizadas = esFraccionEsperada
    ? (Math.floor(placasTeoricas) + 0.5)
    : placasEsp;

  return {
    status,
    tipo_discrepancia,
    placas_esperadas: placasEsperadasNormalizadas,
    placas_escaneadas: placasEscaneadas,
    diferencia: Math.abs(diffPlacas),
    m2_esperados: m2EspRedondeado,
    m2_escaneados: m2EscRedondeado,
    diff_m2: diffM2Final,
    area_placa_m2: areaPlaca,
    id_lote: parsed.id,
    es_media_placa
  };
}

module.exports = {
  parseLote,
  placasEsperadas,
  evaluarCantidad
};
