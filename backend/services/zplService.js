/**
 * Servicio ZPL: arma el código .zpl de la etiqueta Zebra.
 *
 * Layout fiel al Suitelet previo de NetSuite, pero construido en backend:
 *  - Línea 1 (izq): descripción
 *  - Línea 2 (izq): lote + m² + índice
 *  - Línea 3 (izq): ubicación/embarque
 *  - QR (der): SKU LOTE UBICACION
 *  - Pedimento (debajo del QR), solo si existe
 */

const config = require('../config/environments');

/**
 * Sanea un texto para ZPL: elimina caracteres de control ^ y ~ (reservados).
 */
function sanitize(value) {
  return String(value ?? '').replace(/[\^~]/g, '');
}

/**
 * Máximo de etiquetas imprimibles para un lote.
 * Tope = floor(físico / totalM2), mínimo 1.
 *
 * @param {number} fisico - Cantidad física (m²)
 * @param {number} totalM2 - m² por pieza
 * @returns {number}
 */
function maxLabels(fisico, totalM2) {
  if (!totalM2 || totalM2 <= 0) return 1;
  return Math.max(1, Math.floor(fisico / totalM2));
}

/**
 * Construye el ZPL de `cantidad` etiquetas para un lote.
 *
 * @param {Object} params
 * @param {string} params.sku
 * @param {string} params.lote
 * @param {string} params.ubicacion
 * @param {string} params.descripcion
 * @param {number|string} params.totalM2
 * @param {string|null} params.pedimento
 * @param {number} params.cantidad - Número de etiquetas a generar
 * @returns {string} Código ZPL
 */
function buildZpl({ sku, lote, ubicacion, descripcion, totalM2, pedimento, cantidad }) {
  const { zpl } = config;
  const qrData = `${sku} ${lote} ${ubicacion}`;

  let out = `~SD${zpl.densidad}\n`;

  for (let i = 0; i < cantidad; i++) {
    out += `^XA\n`;
    out += `^PW${zpl.ancho}\n`;
    out += `^LL${zpl.alto}\n`;
    out += `^PR${zpl.velocidad}\n`;

    // Línea 1: descripción
    out += `^FO20,20^A0N,28,28^FD${sanitize(descripcion)}^FS\n`;
    // Línea 2: lote + totalM2 + índice
    out += `^FO20,65^A0N,28,28^FD${sanitize(lote)}      ${sanitize(totalM2)} ${i + 1}^FS\n`;
    // Línea 3: ubicación
    out += `^FO20,110^A0N,28,28^FD${sanitize(ubicacion)}^FS\n`;

    // QR: SKU LOTE UBICACION
    out += `^FO${zpl.qrX},${zpl.qrY}^BQN,2,4^FDQA,${sanitize(qrData)}^FS\n`;

    // Pedimento debajo del QR (solo si existe)
    if (pedimento) {
      out += `^FO${zpl.qrX},${zpl.pedimentoY}^A0N,24,24^FD${sanitize(pedimento)}^FS\n`;
    }

    out += `^XZ\n`;
  }

  return out;
}

module.exports = { buildZpl, maxLabels, sanitize };
