/**
 * Servicio ZPL: arma el código .zpl de la etiqueta Zebra.
 *
 * Layout con posiciones fijas (el QR y el pedimento NO se mueven) y texto
 * auto-adaptable: cada campo reduce su tamaño de fuente para caber en la
 * columna reservada a la izquierda del QR.
 *  - Línea 1 (izq): descripción
 *  - Línea 2 (izq): lote + m² + índice
 *  - Línea 3 (izq): EMBARQUE | UBICACION
 *  - QR (der): SKU LOTE UBICACION
 *  - Pedimento (izquierda del QR, abajo), solo si existe
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
 * Calcula el tamaño de fuente que hace caber `texto` en una sola línea dentro
 * del ancho de la columna reservada. Aproxima ancho de carácter ≈ 0.5 × font.
 *
 * @param {string} texto
 * @param {number} ancho - Ancho disponible en dots
 * @param {number} maxSize - Tamaño máximo de fuente
 * @param {number} minSize - Tamaño mínimo de fuente
 * @returns {number}
 */
function fitFont(texto, ancho = 630, maxSize = 26, minSize = 12) {
  const largo = String(texto ?? '').length;
  if (!largo) return maxSize;
  const size = Math.floor(ancho / (largo * 0.5));
  return Math.max(minSize, Math.min(maxSize, size));
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
 * @param {string|null} params.embarque
 * @param {number} params.cantidad - Número de etiquetas a generar
 * @returns {string} Código ZPL
 */
function buildZpl({ sku, lote, ubicacion, descripcion, totalM2, pedimento, embarque, cantidad }) {
  const { zpl } = config;
  const ancho = zpl.ancho || 807;
  const alto = zpl.alto || 152;
  const qrMagnification = zpl.qrMagnification || zpl.qrSize || 4;
  const qrEcc = zpl.qrEcc || 'L';
  const qrFixedLen = zpl.qrFixedLen || 45;

  // Dimensión física del QR (Versión 3 = 29 módulos)
  const qrDim = 29 * qrMagnification;

  // Margen uniforme exacto: arriba, abajo y a la derecha son 100% idénticos
  const margenUniforme = Math.max(0, Math.floor((alto - qrDim) / 2));
  const qrY = Number.isFinite(zpl.qrY) ? zpl.qrY : margenUniforme;
  const qrX = Number.isFinite(zpl.qrX) ? zpl.qrX : (ancho - qrDim - margenUniforme);

  // Columna de texto: margen izquierdo limpio y zona de separación con el QR
  const textoX = zpl.textoX || 20;
  const quietZone = 20;
  const textoAncho = Math.max(200, qrX - textoX - quietZone);

  // QR con largo fijo para que la versión (29x29) y el tamaño físico sean invariantes
  const qrDataRaw = `${sku} ${lote} ${ubicacion}`.trim();
  const qrData = qrDataRaw.length >= qrFixedLen ? qrDataRaw : qrDataRaw.padEnd(qrFixedLen, ' ');

  // Línea 3 integrada: EMBARQUE | UBICACION | PED: ... (alineado y armonizado)
  const line3Parts = [
    embarque,
    ubicacion,
    pedimento ? `PED: ${pedimento}` : null
  ].filter(Boolean);
  const line3 = line3Parts.join(' | ');

  // Distribución vertical uniforme de las 3 líneas alineadas con el QR
  const linea1Y = Math.max(18, qrY);
  const linea2Y = linea1Y + 40;
  const linea3Y = linea2Y + 40;

  let out = `~SD${zpl.densidad}\n`;

  for (let i = 0; i < cantidad; i++) {
    const loteLine = `${lote}  ${totalM2}  ${i + 1}`;
    const descLine = `${sku} ${descripcion}`.trim();

    out += `^XA\n`;
    out += `^PW${ancho}\n`;
    out += `^LL${alto}\n`;
    out += `^PR${zpl.velocidad}\n`;

    // Línea 1: SKU + descripción (font auto-adaptable)
    const f1 = fitFont(descLine, textoAncho, 26, 12);
    out += `^FO${textoX},${linea1Y}^A0N,${f1},${f1}^FD${sanitize(descLine)}^FS\n`;

    // Línea 2: lote + totalM2 + índice (font auto-adaptable)
    const f2 = fitFont(loteLine, textoAncho, 26, 12);
    out += `^FO${textoX},${linea2Y}^A0N,${f2},${f2}^FD${sanitize(loteLine)}^FS\n`;

    // Línea 3: EMBARQUE | UBICACION | PEDIMENTO (font auto-adaptable)
    const f3 = fitFont(line3, textoAncho, 24, 12);
    out += `^FO${textoX},${linea3Y}^A0N,${f3},${f3}^FD${sanitize(line3)}^FS\n`;

    // QR: SKU LOTE UBICACION (márgenes exactamente iguales arriba, abajo y derecha)
    out += `^FO${qrX},${qrY}^BQN,2,${qrMagnification}^FD${qrEcc}A,${sanitize(qrData)}^FS\n`;

    out += `^XZ\n`;
  }

  return out;
}

module.exports = { buildZpl, maxLabels, sanitize, fitFont };