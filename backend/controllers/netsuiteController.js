const supabase = require('../config/supabase');
const netsuiteClient = require('../config/netsuiteAuth');
const config = require('../config/environments');
const axios = require('axios');

/**
 * Obtener IFs disponibles para una ubicación
 * Ejecuta búsqueda guardada en NetSuite
 */
const getIFs = async (req, res) => {
  try {
    const { ubicacion_id } = req.query;

    if (!ubicacion_id) {
      return res.status(400).json({ error: 'ubicacion_id is required' });
    }

    // Obtener datos de ubicación
    const { data: ubicacion, error: ubError } = await supabase
      .from('ubicaciones')
      .select('*')
      .eq('id', ubicacion_id)
      .single();

    if (ubError || !ubicacion) {
      return res.status(404).json({ error: 'Location not found' });
    }

    // IMPORTANTE: Implementar búsqueda en NetSuite
    // Por ahora retornamos estructura de ejemplo
    // En producción, llamar makeNetsuiteRequest para ejecutar búsqueda guardada

    const mockIFs = [
      {
        tranid: 'IF-2024-001',
        description: 'Descripción del producto 1',
        ubicacion: ubicacion.nombre
      },
      {
        tranid: 'IF-2024-002',
        description: 'Descripción del producto 2',
        ubicacion: ubicacion.nombre
      }
    ];

    res.json({
      ifs: mockIFs,
      ubicacion: ubicacion.nombre
    });
  } catch (error) {
    console.error('Get IFs error:', error);
    res.status(500).json({ error: 'Failed to get IFs', details: error.message });
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

    // POST al RESTlet con OAuth 1.0a
    const restletUrl = 'https://9080139-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=2860&deploy=1';

    const response = await netsuiteClient.post(restletUrl, payload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

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
    const { ifTranid, ubicacion_id, items, signatures } = req.body;
    const userId = req.user.id;

    if (!ifTranid || !ubicacion_id || !items || !signatures) {
      return res.status(400).json({ error: 'Missing required fields' });
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
        // Obtener ID de carpeta para esta firma en esta ubicación
        const folderId = config.netsuite.getFolderId(ubicacion.nombre, sigType);

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
    // Respuesta de resultado
    // ──────────────────────────────────────────────────────

    const allUploaded = failedFiles.length === 0;
    const response = {
      status: allUploaded ? 'success' : 'partial_success',
      message: allUploaded
        ? 'All signatures uploaded successfully to NetSuite'
        : `${uploadedFiles.length} of ${uploadedFiles.length + failedFiles.length} signatures uploaded`,
      ifTranid,
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
      'NETSUITE_CONSUMER_KEY': config.netsuite.consumerKey,
      'NETSUITE_CONSUMER_SECRET': config.netsuite.consumerSecret,
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

    // 3. Hacer un request simple a NetSuite (sin autenticación aún, solo para debug)
    console.log('\n3️⃣  Intentando conexión simple a NetSuite (sin OAuth)...');
    try {
      const simpleTest = await axios.get(`${baseUrl}/record/salesorder/1`, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 5000,
        validateStatus: () => true // Aceptar cualquier status para debug
      });

      console.log(`   Status: ${simpleTest.status}`);
      console.log(`   Headers recibidos:`, Object.keys(simpleTest.headers));
    } catch (simpleError) {
      console.log(`   ⚠️  Error esperado (sin OAuth): ${simpleError.message}`);
    }

    // 4. Ahora hacer request con cliente autenticado
    console.log('\n4️⃣  Intentando conexión CON OAuth 1.0a...');
    try {
      const response = await netsuiteClient.get(`/record/salesorder/1`, {
        timeout: 10000,
        validateStatus: () => true
      });

      console.log(`   ✓ Status: ${response.status}`);
      console.log(`   ✓ Respuesta headers:`, {
        contentType: response.headers['content-type'],
        server: response.headers['server']
      });

      if (response.status === 401 || response.status === 403) {
        console.log(`   ⚠️  Autenticación fallida. Status: ${response.status}`);
        console.log(`   Error details:`, response.data);
      } else if (response.status === 200) {
        console.log(`   ✓ Autenticación exitosa`);
      } else if (response.status === 404) {
        console.log(`   ✓ Autenticación funciona (404 es OK - recurso no existe)`);
      }

      return res.status(200).json({
        test: 'COMPLETED',
        environment_vars: 'OK',
        netsuite_connection: {
          status: response.status,
          statusText: response.statusText,
          authenticated: response.status !== 401 && response.status !== 403,
          baseUrl: baseUrl,
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
