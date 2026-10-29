/**
 * Respaldo de escaneos en Google Sheets.
 *
 * POST /webhook/scan recibe las placas de una salida (js/webhook.js) y las
 * agrega a la hoja de escaneos con la Service Account. values.append es
 * atómico: envíos simultáneos (ej. las IFs de un grupo Multi-IF) no se pisan.
 */

const googleSheetsService = require('../services/googleSheetsService');

const forwardScan = async (req, res) => {
  const { ifTranid, items } = req.body || {};
  if (!ifTranid || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'ifTranid e items (no vacío) son requeridos' });
  }

  try {
    const filas = await googleSheetsService.appendEscaneos(req.body);
    console.log(`[sheets] ${ifTranid}: ${filas} fila(s) agregadas`);
    res.json({ success: true, filas });
  } catch (e) {
    console.error(`[sheets] Error agregando ${ifTranid}:`, e.message);
    res.status(502).json({ error: 'No se pudo registrar en Google Sheets' });
  }
};

module.exports = { forwardScan };
