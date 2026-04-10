/**
 * Servicio para manejar uploads de archivos a NetSuite File Cabinet
 * Usa RESTlet con OAuth 1.0a para autenticar
 */

const netsuiteRestletClient = require('../config/netsuiteRestlet');
const config = require('../config/environments');

/**
 * Convertir base64 a Buffer
 * Maneja prefijos data:image/png;base64,
 */
function base64ToBuffer(base64String) {
  const base64Data = base64String.replace(/^data:image\/[^;]+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}

/**
 * Obtener URL del RESTlet dinámicamente desde config
 */
function getRestletPath() {
  const scriptId = process.env.NETSUITE_RESTLET_SCRIPT_ID || '2860';
  const deployId = process.env.NETSUITE_RESTLET_DEPLOY_ID || '1';
  return `/app/site/hosting/restlet.nl?script=${scriptId}&deploy=${deployId}`;
}

/**
 * Subir archivo a NetSuite File Cabinet vía RESTlet
 *
 * @param {string} filename - Nombre del archivo (ej: IF-2026-001_cliente.png)
 * @param {string|Buffer} fileContent - Contenido en base64 o Buffer
 * @param {number} folderId - ID de carpeta destino en NetSuite
 * @returns {Promise<Object>} {success, fileId, url, filename, folderId}
 */
async function uploadFile(filename, fileContent, folderId) {
  try {
    // Convertir a base64 si es Buffer
    const base64Content = Buffer.isBuffer(fileContent)
      ? fileContent.toString('base64')
      : fileContent;

    const payload = {
      filename,
      contents: base64Content,
      folder_id: folderId
    };

    console.log(`📤 Uploading: ${filename} to folder ${folderId}`);

    // POST al RESTlet usando ruta relativa (interceptor maneja OAuth)
    const response = await netsuiteRestletClient.post(
      getRestletPath(),
      payload
    );

    if (!response.data.success) {
      throw new Error(response.data.error || 'RESTlet error');
    }

    console.log(`✅ Upload successful: ${filename} (ID: ${response.data.fileId})`);

    return {
      success: true,
      filename,
      fileId: response.data.fileId,
      folderId,
      url: response.data.url,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error(`❌ Upload failed: ${filename}`, error.message);
    throw new Error(`Failed to upload ${filename}: ${error.message}`);
  }
}

/**
 * Subir múltiples firmas
 *
 * @param {Object} signatures - {tipo: base64String, ...}
 * @param {string} ifNumber - Número de IF (ej: IF-2026-001)
 * @param {string} location - Ubicación (ej: MEX, MTY)
 * @returns {Promise<Object>} {uploaded: [...], failed: [...]}
 */
async function uploadSignatures(signatures, ifNumber, location) {
  const uploaded = [];
  const failed = [];

  for (const [signatureType, base64Content] of Object.entries(signatures)) {
    if (!base64Content) continue;

    try {
      // Obtener folder ID según ubicación y tipo
      const folderId = config.netsuite.getFolderId(location, signatureType);
      const filename = `${ifNumber}_${signatureType}.png`;

      const result = await uploadFile(filename, base64Content, folderId);
      uploaded.push({ type: signatureType, ...result });

    } catch (error) {
      failed.push({
        type: signatureType,
        error: error.message
      });
    }
  }

  return { uploaded, failed };
}

module.exports = {
  uploadFile,
  uploadSignatures,
  base64ToBuffer
};
