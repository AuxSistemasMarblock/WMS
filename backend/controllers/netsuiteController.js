const supabase = require('../config/supabase');
const netsuiteRestletClient = require('../config/netsuiteRestlet');
const config = require('../config/environments');

const RESTRICTED_LOCATION_PREFIXES = ['MEX', 'MTY', 'GDL'];
const SHARED_LOCATIONS = ['TEMPORAL', 'PROYECTOS', 'Material Transformado', 'MATRIZ'];

function extractLocation(location) {
  if (typeof location === 'string') return location;
  if (location?.text) return location.text;
  if (location?.value) return location.value;
  return null;
}

function startsWithRestrictedPrefix(ifLocation) {
  return RESTRICTED_LOCATION_PREFIXES.some(prefix => {
    return ifLocation === prefix || ifLocation.startsWith(prefix + ':') || ifLocation.startsWith(prefix + ' ');
  });
}

function isSharedLocation(ifLocation) {
  if (!ifLocation) return false;
  if (SHARED_LOCATIONS.includes(ifLocation)) return true;
  return !startsWithRestrictedPrefix(ifLocation);
}

function filterIFsByUserLocation(ifRecords, userLocationName) {
  return ifRecords.filter(ifRecord => {
    const ifLocation = extractLocation(ifRecord.location);
    if (!ifLocation) return false;
    if (isSharedLocation(ifLocation)) return true;
    if (ifLocation === userLocationName) return true;
    const ifLocationTokens = ifLocation.split(/[\s:]+/).filter(Boolean);
    return ifLocationTokens.includes(userLocationName);
  });
}

function formatIFRecord(ifRecord) {
  return {
    internalId: ifRecord.id,
    tranid: ifRecord.tranid,
    description: ifRecord.memo || ifRecord.description || '',
    location: ifRecord.location,
    status: ifRecord.shipstatus,
    date: ifRecord.trandate
  };
}

/**
 * Obtener IFs disponibles para la ubicación del usuario
 * Ejecuta búsqueda guardada en NetSuite (customsearch3434)
 */
const getIFs = async (req, res) => {
  try {
    const userUbicacionId = req.user.ubicacion_id;

    const { data: ubicacion, error: ubError } = await supabase
      .from('ubicaciones')
      .select('id, nombre')
      .eq('id', userUbicacionId)
      .single();

    if (ubError || !ubicacion) {
      return res.status(404).json({ error: 'Ubicación no encontrada' });
    }

    const searchPayload = {
      searchId: config.netsuite.searchRestlet.searchId,
      limit: 1000,
      start: 0
    };

    const searchUrl = `/app/site/hosting/restlet.nl?script=${config.netsuite.searchRestlet.scriptId}&deploy=${config.netsuite.searchRestlet.deployId}`;

    const searchResponse = await netsuiteRestletClient.post(searchUrl, searchPayload);

    if (!searchResponse.data || !searchResponse.data.success) {
      console.error('❌ Error del RESTlet:', searchResponse.data);
      throw new Error(searchResponse.data?.error || searchResponse.data?.message || 'Error en búsqueda de NetSuite');
    }

    const allIFs = searchResponse.data.data || [];
    const filteredIFs = filterIFsByUserLocation(allIFs, ubicacion.nombre);
    const formattedIFs = filteredIFs.map(formatIFRecord);

    res.json({
      ifs: formattedIFs,
      ubicacion: ubicacion.nombre,
      total: formattedIFs.length
    });

  } catch (error) {
    console.error('Get IFs error:', error);
    res.status(500).json({ error: 'Error al obtener IFs', details: error.message });
  }
};

/**
 * Convertir base64 a Buffer
 */
function base64ToBuffer(base64String) {
  // Eliminar prefijo data:image/png;base64, si existe
  const base64Data = base64String.replace(/^data:image\/png;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}

/**
 * Subir archivo PNG a NetSuite File Cabinet vía RESTlet
 * Usa OAuth 1.0a para autenticar
 *
 * @param {Buffer} fileBuffer - Contenido del archivo
 * @param {string} fileName - Nombre del archivo (ej: firma_auxAlmacen.png)
 * @param {number} parentFolderId - ID de la carpeta padre en NetSuite
 * @returns {Promise<Object>} Resultado de upload con id de archivo, URL, etc.
 */
async function uploadFileToNetSuite(fileBuffer, fileName, parentFolderId) {
  try {
    console.log(`📤 Uploading to NetSuite: ${fileName}`);
    console.log(`   Folder ID: ${parentFolderId}`);
    console.log(`   File size: ${fileBuffer.length} bytes`);

    // Convertir buffer a base64
    const base64Contents = fileBuffer.toString('base64');

    // Payload para el RESTlet
    const payload = {
      filename: fileName,
      contents: base64Contents,
      folder_id: parentFolderId
    };

    // Construir ruta relativa del RESTlet
    const scriptId = process.env.NETSUITE_RESTLET_SCRIPT_ID || '2860';
    const deployId = process.env.NETSUITE_RESTLET_DEPLOY_ID || '1';
    const restletPath = `/app/site/hosting/restlet.nl?script=${scriptId}&deploy=${deployId}`;

    // POST al RESTlet con OAuth 1.0a (usando cliente con interceptor)
    const response = await netsuiteRestletClient.post(restletPath, payload);

    if (!response.data.success) {
      throw new Error(response.data.error || 'RESTlet returned error');
    }

    console.log(`✓ Archivo subido exitosamente`);

    return {
      success: true,
      fileName: fileName,
      fileId: response.data.fileId,
      folderId: parentFolderId,
      url: response.data.url,
      size: fileBuffer.length,
      uploaded: new Date().toISOString()
    };

  } catch (error) {
    console.error(`❌ Error uploading ${fileName}:`, error.response?.data || error.message);
    throw new Error(`Failed to upload ${fileName}: ${error.message}`);
  }
}

/**
 * Enviar datos de escaneo y firmas a NetSuite File Cabinet
 */
const submitData = async (req, res) => {
  try {
    const { ifTranid, ifInternalId, ubicacion_id, items, signatures } = req.body;
    const userId = req.user.id;

    if (!ifTranid || !ubicacion_id || !items || !signatures) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!ifInternalId) {
      return res.status(400).json({ error: 'ifInternalId es requerido para actualizar el estado' });
    }

    // Obtener info de ubicación
    const { data: ubicacion } = await supabase
      .from('ubicaciones')
      .select('*')
      .eq('id', ubicacion_id)
      .single();

    if (!ubicacion) {
      return res.status(404).json({ error: 'Location not found' });
    }

    // ──────────────────────────────────────────────────────
    // Procesamiento de firmas
    // ──────────────────────────────────────────────────────

    const uploadedFiles = [];
    const failedFiles = [];

    console.log(`\n📋 Processing submission for IF: ${ifTranid}`);
    console.log(`   Location: ${ubicacion.nombre}`);
    console.log(`   Items: ${items.length}`);
    console.log(`   Signatures: ${Object.keys(signatures).length}\n`);

    // Mapeo de tipos de firma
    const signatureMap = {
      auxAlmacen: { label: 'Auxiliar', displayName: 'Aux. de Almacén' },
      jefeAlmacen: { label: 'Jefe', displayName: 'Jefe de Almacén' },
      gerente: { label: 'Gerente', displayName: 'Gerente de Sucursal' },
      cliente: { label: 'Cliente', displayName: 'Cliente' }
    };

    // Procesar cada firma
    for (const [sigType, sigData] of Object.entries(signatures)) {
      if (!sigData || !signatureMap[sigType]) {
        console.warn(`⚠️  Tipo de firma no reconocido: ${sigType}`);
        continue;
      }

      try {
        // Obtener ID de carpeta para esta firma (la ubicación no afecta el folder físico)
        const folderId = config.netsuite.getFolderId(sigType);

        const fileBuffer = base64ToBuffer(sigData);
        const fileName = `${ifTranid}_${sigType}.png`; // Patrón: {IF}_{TYPE}.png

        console.log(`🔐 Uploading ${signatureMap[sigType].displayName} (${sigType})`);
        console.log(`   Destination folder ID: ${folderId}`);

        const uploadResult = await uploadFileToNetSuite(
          fileBuffer,
          fileName,
          folderId
        );

        uploadedFiles.push({
          type: sigType,
          label: signatureMap[sigType].displayName,
          filename: fileName,
          size: fileBuffer.length,
          ...uploadResult
        });

        console.log(`✓ ${signatureMap[sigType].displayName} uploaded successfully\n`);

      } catch (error) {
        console.error(`✗ Error uploading ${sigType}:`, error.message);
        failedFiles.push({
          type: sigType,
          label: signatureMap[sigType].displayName,
          error: error.message
        });
      }
    }

    // ──────────────────────────────────────────────────────
    // Actualizar status del IF si todas las firmas se subieron
    // ──────────────────────────────────────────────────────

    const allUploaded = failedFiles.length === 0;
    const response = {
      status: allUploaded ? 'success' : 'partial_success',
      message: allUploaded
        ? 'All signatures uploaded successfully to NetSuite'
        : `${uploadedFiles.length} of ${uploadedFiles.length + failedFiles.length} signatures uploaded`,
      ifTranid,
      ifInternalId,
      location: ubicacion.nombre,
      itemsCount: items.length,
      uploadedFiles: uploadedFiles,
      failedFiles: failedFiles.length > 0 ? failedFiles : undefined,
      timestamp: new Date().toISOString(),
      summary: {
        totalSignatures: uploadedFiles.length + failedFiles.length,
        successCount: uploadedFiles.length,
        failureCount: failedFiles.length
      }
    };

    if (allUploaded && ifInternalId) {
      try {
        console.log(`🔄 Intentando actualizar status del IF ${ifTranid} (ID: ${ifInternalId}) via RESTlet`);

        const restletPath = `/app/site/hosting/restlet.nl?script=${config.netsuite.restlet.scriptId}&deploy=${config.netsuite.restlet.deployId}`;

        const statusUpdateResponse = await netsuiteRestletClient.post(restletPath, {
          action: 'updateIFStatus',
          internalId: ifInternalId
        });

        console.log(`✅ Status update response:`, statusUpdateResponse.data);

        if (statusUpdateResponse.data.success) {
          console.log(`✓ Status del IF ${ifTranid} (ID: ${ifInternalId}) actualizado a "C"`);
          response.ifStatusUpdated = true;
        } else {
          throw new Error(statusUpdateResponse.data.error || 'Error desconocido');
        }
      } catch (statusError) {
        console.error(`❌ Error completo al actualizar status:`, {
          message: statusError.message,
          response: statusError.response?.data
        });
        response.ifStatusUpdated = false;
        response.ifStatusError = statusError.message;
      }
    }

    console.log(`\n✓ Submission complete:`);
    console.log(`  - IF: ${ifTranid}`);
    console.log(`  - Location: ${ubicacion.nombre}`);
    console.log(`  - Items: ${items.length}`);
    console.log(`  - Signatures uploaded: ${uploadedFiles.length}/${uploadedFiles.length + failedFiles.length}\n`);

    const statusCode = allUploaded ? 200 : 207; // 207 Multi-Status para éxito parcial
    res.status(statusCode).json(response);

  } catch (error) {
    console.error('Submit data error:', error);
    res.status(500).json({
      status: 'error',
      error: 'Failed to submit data',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

/**
 * Test de diagnóstico para conexión a NetSuite
 * Verifica:
 * 1. Variables de entorno cargadas
 * 2. OAuth headers generados correctamente
 * 3. Conexión a API de NetSuite
 */
const diagnosticTest = async (req, res) => {
  try {
    console.log('\n🔍 ===== NETSUITE DIAGNOSTIC TEST =====\n');

    // 1. Validar variables de entorno
    console.log('1️⃣  Validando variables de entorno...');
    const requiredVars = {
      'NETSUITE_ACCOUNT_ID': config.netsuite.accountId,
      'NETSUITE_REALM': config.netsuite.realm,
      'NETSUITE_CLIENT_ID': config.netsuite.clientId,
      'NETSUITE_CLIENT_SECRET': config.netsuite.clientSecret,
      'NETSUITE_TOKEN_ID': config.netsuite.tokenId,
      'NETSUITE_TOKEN_SECRET': config.netsuite.tokenSecret
    };

    const missingVars = [];
    Object.entries(requiredVars).forEach(([key, value]) => {
      if (!value) {
        missingVars.push(key);
        console.log(`   ❌ ${key}: MISSING`);
      } else {
        const masked = String(value).substring(0, 5) + '***' + String(value).substring(String(value).length - 3);
        console.log(`   ✓ ${key}: ${masked}`);
      }
    });

    if (missingVars.length > 0) {
      return res.status(400).json({
        test: 'FAILED',
        step: 'Environment validation',
        missing_vars: missingVars,
        timestamp: new Date().toISOString()
      });
    }

    // 2. Obtener URL base
    console.log('\n2️⃣  Base URL de NetSuite:');
    const baseUrl = config.netsuite.baseUrl();
    console.log(`   ${baseUrl}`);

    // 3. Hacer un test dummy de upload al RESTlet 2860 (mismo path que el flujo principal)
    console.log('\n3️⃣  Testeando RESTlet 2860 (dummy upload a folder de validación)...');
    try {
      const scriptId = process.env.NETSUITE_RESTLET_SCRIPT_ID || '2860';
      const deployId = process.env.NETSUITE_RESTLET_DEPLOY_ID || '1';
      const restletPath = `/app/site/hosting/restlet.nl?script=${scriptId}&deploy=${deployId}`;

      const testPayload = {
        filename: 'VALIDATION_TEST.png',
        contents: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        folder_id: config.netsuite.getFolderId('auxAlmacen')
      };

      const response = await netsuiteRestletClient.post(restletPath, testPayload, {
        validateStatus: () => true
      });

      console.log(`   ✓ Status: ${response.status}`);
      const authenticated = response.status !== 401 && response.status !== 403;
      console.log(`   ${authenticated ? '✓' : '⚠️'} Autenticación ${authenticated ? 'exitosa' : 'fallida'}`);

      return res.status(200).json({
        test: 'COMPLETED',
        environment_vars: 'OK',
        netsuite_connection: {
          status: response.status,
          statusText: response.statusText,
          authenticated,
          baseUrl: baseUrl,
          restlet_tested: `${scriptId}/${deployId}`,
          headers_sent: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': 'OAuth 1.0a (signed)'
          }
        },
        timestamp: new Date().toISOString()
      });

    } catch (authError) {
      console.error(`   ❌ Error con OAuth:`, authError.message);
      return res.status(500).json({
        test: 'FAILED',
        step: 'OAuth authentication',
        error: authError.message,
        suggestions: [
          'Verificar que las credenciales de OAuth 1.0a sean correctas',
          'Confirmar que el Token creado en NetSuite esté activo',
          'Revisar que el Realm sea correcto (sandbox vs production)',
          'Validar Account ID con formato correcto'
        ],
        timestamp: new Date().toISOString()
      });
    }

  } catch (error) {
    console.error('Diagnostic error:', error);
    res.status(500).json({
      test: 'ERROR',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

module.exports = {
  getIFs,
  submitData,
  diagnosticTest
};
