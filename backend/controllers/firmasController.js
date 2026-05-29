/**
 * Controlador para manejar requests de firmas
 */

const netsuiteFileService = require('../services/netsuiteFileService');
const supabase = require('../config/supabase');

/**
 * POST /firmas/upload
 * Subir una o múltiples firmas
 *
 * Body:
 * {
 *   ifNumber: "IF-2026-001",
 *   location: "MEX",
 *   signatures: {
 *     cliente: "base64_string",
 *     almacen: "base64_string",
 *     jefe_almacen: "base64_string" (opcional)
 *   }
 * }
 */
const uploadSignatures = async (req, res) => {
  try {
    const { ifNumber, location, signatures } = req.body;
    const userId = req.user?.id;

    // Validar campos requeridos
    if (!ifNumber) return res.status(400).json({ error: 'ifNumber is required' });
    if (!location) return res.status(400).json({ error: 'location is required' });
    if (!signatures || Object.keys(signatures).length === 0) {
      return res.status(400).json({ error: 'At least one signature is required' });
    }

    console.log(`\n📋 Uploading signatures for IF: ${ifNumber} (${location})`);

    // Procesar uploads
    const { uploaded, failed } = await netsuiteFileService.uploadSignatures(
      signatures,
      ifNumber,
      location
    );

    // Determinar estado
    const allSuccess = failed.length === 0;
    const statusCode = allSuccess ? 200 : 207; // 207 Multi-Status para éxito parcial

    const result = {
      status: allSuccess ? 'success' : 'partial_success',
      ifNumber,
      location,
      uploaded: uploaded.length > 0 ? uploaded : undefined,
      failed: failed.length > 0 ? failed : undefined,
      summary: {
        total: uploaded.length + failed.length,
        success: uploaded.length,
        failures: failed.length
      },
      timestamp: new Date().toISOString()
    };

    console.log(`✅ Upload complete: ${uploaded.length}/${uploaded.length + failed.length} success\n`);

    res.status(statusCode).json(result);

  } catch (error) {
    console.error('Upload signatures error:', error);
    res.status(500).json({
      error: 'Failed to upload signatures',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

/**
 * POST /firmas/upload/single
 * Subir una firma individual
 *
 * Body:
 * {
 *   filename: "IF-2026-001_cliente.png",
 *   fileContent: "base64_string",
 *   folderId: 12345
 * }
 */
const uploadSingleFile = async (req, res) => {
  try {
    const { filename, fileContent, folderId } = req.body;

    if (!filename) return res.status(400).json({ error: 'filename is required' });
    if (!fileContent) return res.status(400).json({ error: 'fileContent is required' });
    if (!folderId) return res.status(400).json({ error: 'folderId is required' });

    const result = await netsuiteFileService.uploadFile(filename, fileContent, folderId);

    res.status(200).json(result);

  } catch (error) {
    console.error('Upload single file error:', error);
    res.status(500).json({
      error: 'Failed to upload file',
      message: error.message
    });
  }
};

module.exports = {
  uploadSignatures,
  uploadSingleFile
};
