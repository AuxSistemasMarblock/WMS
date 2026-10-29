const bcryptjs = require('bcryptjs');
const supabase = require('../config/supabase');
const netsuiteRestletClient = require('../config/netsuiteRestlet');
const config = require('../config/environments');
const { esVisibleParaUbicacion } = require('../services/locationScope');
const confrontaService = require('../services/confrontaService');
const netsuiteSearchService = require('../services/netsuiteSearchService');
const netsuiteFulfillmentService = require('../services/netsuiteFulfillmentService');
const auditService = require('../services/auditService');

function extractLocation(location) {
  if (typeof location === 'string') return location;
  if (location?.text) return location.text;
  if (location?.value) return location.value;
  return null;
}

/**
 * IFs visibles para el usuario: solo su ubicación/sucursal (incluido su outlet)
 * y la whitelist compartida. NUNCA outlets de otra sucursal.
 */
function filterIFsByUserLocation(ifRecords, userLocationName) {
  return ifRecords.filter(ifRecord =>
    esVisibleParaUbicacion(extractLocation(ifRecord.location), userLocationName)
  );
}

function formatIFRecord(ifRecord) {
  return {
    internalId: ifRecord.id,
    tranid: ifRecord.tranid,
    sourceDoc: ifRecord.formulatext,
    description: ifRecord.memo || ifRecord.description || '',
    location: ifRecord.location,
    status: ifRecord.statusref,
    date: ifRecord.trandate
  };
}

/**
 * Obtener IFs disponibles para la ubicación del usuario
 * Ejecuta búsqueda guardada en NetSuite (customsearch3434)
 *
 * WMS 2.0 · R3: admin y lider pueden consultar TODAS las ubicaciones o
 * filtrar por una concreta vía ?ubicacion=<nombre> (selector del escáner).
 * El resto de roles sigue acotado a su ubicación.
 */
const getIFs = async (req, res) => {
  try {
    const userUbicacionId = req.user.ubicacion_id;
    const rol = String(req.user.rol ?? '').toLowerCase().trim();
    const esGlobal = rol === 'admin' || rol === 'lider';
    const ubicacionFiltro = req.query.ubicacion ? String(req.query.ubicacion) : '';

    let nombreUbicacion = null;
    if (userUbicacionId) {
      const { data: ubicacion } = await supabase
        .from('ubicaciones')
        .select('id, nombre')
        .eq('id', userUbicacionId)
        .single();
      nombreUbicacion = ubicacion?.nombre || null;
    }

    if (!esGlobal && !nombreUbicacion) {
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
    let filteredIFs;
    if (esGlobal) {
      // Sin selector o "Todas": todas las IFs; con ubicación elegida: su alcance
      filteredIFs = ubicacionFiltro
        ? filterIFsByUserLocation(allIFs, ubicacionFiltro)
        : allIFs;
    } else {
      filteredIFs = filterIFsByUserLocation(allIFs, nombreUbicacion);
    }
    const formattedIFs = filteredIFs.map(formatIFRecord);

    res.json({
      ifs: formattedIFs,
      ubicacion: ubicacionFiltro || nombreUbicacion || 'Todas',
      total: formattedIFs.length
    });

  } catch (error) {
    console.error('Get IFs error:', error);
    res.status(500).json({ error: 'Error al obtener IFs', details: error.message });
  }
};

/**
 * Líneas esperadas de un grupo de IFs (WMS 2.0 · U3 · MultiIfs).
 * POST /netsuite/ifs/lineas
 * Body: { ifs: [{ tranid, internalId? }] } (1..20)
 *
 * Devuelve por IF sus líneas con `placas_esperadas` y `area_placa_m2`
 * calculadas con la MISMA matemática de la confronta (evaluarLinea con
 * escaneos vacíos). El frontend las usa para el matching en tiempo real.
 */
const getIFsLineas = async (req, res) => {
  try {
    const { ifs } = req.body || {};
    if (!Array.isArray(ifs) || ifs.length === 0 || ifs.length > 20) {
      return res.status(400).json({ error: 'ifs debe ser un arreglo de 1 a 20 elementos' });
    }

    const resultado = [];
    for (const entrada of ifs) {
      const tranid = String(entrada?.tranid || '').trim();
      if (!tranid) continue;

      let internalId = entrada.internalId || null;
      let ifEncontrada = null;

      // 1) SuiteTalk REST (mismo criterio que validarConfronta)
      try {
        if (!internalId) {
          internalId = await netsuiteFulfillmentService.resolverInternalIdPorTranid(tranid);
        }
        if (internalId) {
          ifEncontrada = await netsuiteFulfillmentService.getIFEsperadaPorId(internalId, tranid);
        }
      } catch (stErr) {
        console.warn(`[ifs/lineas] SuiteTalk falló para ${tranid}:`, stErr.message);
      }

      // 2) Respaldo a Saved Search
      if (!ifEncontrada || !ifEncontrada.lineas || ifEncontrada.lineas.length === 0) {
        try {
          const ifsEsperadas = await netsuiteSearchService.getIFsEsperadasAgrupadas({
            tranidsRelevantes: [tranid],
            limit: 2000
          });
          ifEncontrada = ifsEsperadas.find(i => String(i.tranid).trim() === tranid) || null;
        } catch (nsErr) {
          console.warn(`[ifs/lineas] Saved Search falló para ${tranid}:`, nsErr.message);
        }
      }

      if (!ifEncontrada || !ifEncontrada.lineas || ifEncontrada.lineas.length === 0) {
        resultado.push({ tranid, encontrada: false, lineas: [] });
        continue;
      }

      const lineas = ifEncontrada.lineas.map(l => {
        const ev = confrontaService._evaluarLinea(
          ifEncontrada.tranid, ifEncontrada.so, ifEncontrada.location, ifEncontrada.fecha, l, []
        );
        return {
          sku: l.sku,
          lote: l.lote,
          ubicacion: l.expectedLocation || l.location || ifEncontrada.location || '',
          quantity_m2: l.quantity != null ? Number(l.quantity) : null,
          area_placa_m2: ev.evaluacion_cantidad?.area_placa_m2 ?? 0,
          placas_esperadas: ev.evaluacion_cantidad?.placas_esperadas ?? 1
        };
      });

      resultado.push({
        tranid: ifEncontrada.tranid || tranid,
        internalId,
        so: ifEncontrada.so || null,
        location: ifEncontrada.location || '',
        fecha: ifEncontrada.fecha || null,
        encontrada: true,
        lineas
      });
    }

    res.json({ ifs: resultado });
  } catch (error) {
    console.error('getIFsLineas error:', error);
    res.status(500).json({ error: 'Error al obtener líneas de las IFs', details: error.message });
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

    // WMS 2.0 · A2: bitácora de envíos (resultado por IF a NetSuite)
    auditService.registrarDesdeReq(req, {
      usuarioId: userId,
      tipoEvento: auditService.TIPOS.ENVIO,
      accion: 'submit_netsuite',
      entidad: 'netsuite',
      detalle: {
        if_tranid: ifTranid,
        if_internal_id: ifInternalId,
        ubicacion: ubicacion.nombre,
        items: items.length,
        firmas_subidas: uploadedFiles.map(f => f.type),
        firmas_fallidas: failedFiles.map(f => ({ type: f.type, error: f.error })),
        resultado: allUploaded ? 'success' : 'partial_success',
        if_status_updated: response.ifStatusUpdated ?? null
      }
    });

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

/**
 * Validar confronta de escaneos de una IF contra líneas de NetSuite
 * POST /netsuite/confronta-validar
 */
const validarConfronta = async (req, res) => {
  try {
    const { ifTranid, ifInternalId, items } = req.body;
    if (!ifTranid || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'ifTranid e items (no vacío) son requeridos' });
    }

    const userUbicacionId = req.user.ubicacion_id;
    let locationName = '';
    if (userUbicacionId) {
      const { data: ubicacion } = await supabase
        .from('ubicaciones')
        .select('id, nombre')
        .eq('id', userUbicacionId)
        .single();
      locationName = ubicacion?.nombre || '';
    }

    // Obtener líneas esperadas de la IF en NetSuite:
    // 1. Intentar por SuiteTalk REST API (ideal para IFs empaquetadas/pendientes)
    let ifEncontrada = null;
    let resolvedInternalId = ifInternalId;

    if (!resolvedInternalId && ifTranid) {
      resolvedInternalId = await netsuiteFulfillmentService.resolverInternalIdPorTranid(ifTranid);
    }

    if (resolvedInternalId) {
      try {
        ifEncontrada = await netsuiteFulfillmentService.getIFEsperadaPorId(resolvedInternalId, ifTranid);
        console.log(`[validarConfronta] IF ${ifTranid} (id: ${resolvedInternalId}) obtenida vía SuiteTalk (${ifEncontrada.lineas.length} líneas)`);
      } catch (stErr) {
        console.warn(`[validarConfronta] Falló consulta SuiteTalk para IF ${ifTranid}:`, stErr.message);
      }
    }

    // 2. Respaldo a Saved Search (customsearch3675) para IFs ya enviadas o si SuiteTalk no retornó líneas
    if (!ifEncontrada || !ifEncontrada.lineas || ifEncontrada.lineas.length === 0) {
      try {
        const ifsEsperadas = await netsuiteSearchService.getIFsEsperadasAgrupadas({
          tranidsRelevantes: [ifTranid],
          limit: 2000
        });
        const matchSearch = ifsEsperadas.find(i => String(i.tranid).trim() === String(ifTranid).trim());
        if (matchSearch) {
          ifEncontrada = matchSearch;
          console.log(`[validarConfronta] IF ${ifTranid} obtenida vía Saved Search (${ifEncontrada.lineas.length} líneas)`);
        }
      } catch (nsErr) {
        console.warn('Error consultando saved search en validarConfronta:', nsErr.message);
      }
    }

    if (!ifEncontrada) {
      return res.status(404).json({
        ok: false,
        error: 'IF_NOT_FOUND',
        message: `No se encontraron líneas esperadas para la IF ${ifTranid} en NetSuite`
      });
    }

    // Normalizar escaneos para el confrontaService
    const escaneos = items.map(item => ({
      if_tranid: ifTranid,
      sku: item.sku,
      lote: item.lote,
      ubicacion_escaneada: item.ubicacion || locationName,
      timestamp: item.timestamp || new Date().toISOString(),
      operador: req.user.nombre || 'Auxiliar'
    }));

    // Ejecutar confronta
    const resultado = confrontaService.confrontar([ifEncontrada], escaneos);

    // Filtrar discrepancias correspondientes a esta IF (excluyendo 'sin_medidas' que es solo informativo)
    const discrepancias = (resultado.todas_las_discrepancias || [])
      .filter(d => String(d.if_tranid).trim() === String(ifTranid).trim() && d.tipo !== 'sin_medidas')
      .map(d => ({
        tipo: d.tipo,
        sku: d.sku,
        lote: d.lote,
        placas_esperadas: d.placas_esperadas ?? 0,
        placas_escaneadas: d.placas_escaneadas ?? 0,
        diferencia: d.diferencia ?? 0,
        mensaje: d.mensaje || d.plan_accion || 'Discrepancia detectada',
        es_cruzado: Boolean(d.es_cruzado)
      }));

    if (discrepancias.length === 0) {
      return res.json({
        ok: true,
        ifTranid,
        message: 'Confronta limpia sin discrepancias',
        discrepancias: []
      });
    }

    return res.json({
      ok: false,
      ifTranid,
      message: 'Se detectaron discrepancias en la confronta',
      discrepancias
    });

  } catch (error) {
    console.error('Error en validarConfronta:', error);
    res.status(500).json({ error: 'Error al validar la confronta', details: error.message });
  }
};

/**
 * Autorizar discrepancias de confronta con PIN de autorización
 * (jefe de la sucursal, líder o admin — WMS 2.0 · R1).
 * POST /netsuite/confronta-autorizar-pin
 */
const autorizarConfrontaPin = async (req, res) => {
  try {
    const { pin, ifTranid, items, discrepancias } = req.body;
    if (!pin || !ifTranid) {
      return res.status(400).json({ error: 'PIN e ifTranid son requeridos' });
    }

    const pinStr = String(pin).trim();
    if (!/^\d{4,6}$/.test(pinStr)) {
      return res.status(400).json({ error: 'El PIN debe ser numérico de 4 a 6 dígitos' });
    }

    const userUbicacionId = req.user.ubicacion_id;
    let auxLocationName = '';
    if (userUbicacionId) {
      const { data: ubicacionAux } = await supabase
        .from('ubicaciones')
        .select('id, nombre')
        .eq('id', userUbicacionId)
        .single();
      auxLocationName = ubicacionAux?.nombre || '';
    }

    // Buscar usuarios activos con pin_hash
    const { data: usuariosConPin, error: qError } = await supabase
      .from('usuarios')
      .select('id, nombre_completo, cargo, pin_hash, ubicacion_id, roles(clave), ubicaciones(id, nombre)')
      .eq('activo', true)
      .not('pin_hash', 'is', null);

    if (qError || !usuariosConPin || usuariosConPin.length === 0) {
      return res.status(403).json({ error: 'No hay autorizadores (jefe, líder o admin) con PIN configurado en el sistema' });
    }

    // WMS 2.0 · R1: autorizan jefe (de la sucursal del auxiliar), líder y admin
    // (globales). El gerente queda fuera del PIN: su única intervención es la
    // firma >10 placas dentro del flujo del escáner.
    const jefesCandidatos = usuariosConPin.filter(u => {
      const rol = String(u.roles?.clave ?? '').toLowerCase().trim();
      if (rol === 'admin' || rol === 'lider') return true; // autoridad global
      if (rol !== 'jefe_almacen') return false;

      const jefeLocName = u.ubicaciones?.nombre || '';
      return esVisibleParaUbicacion(jefeLocName, auxLocationName);
    });

    if (jefesCandidatos.length === 0) {
      return res.status(403).json({ error: 'No se encontraron autorizadores (jefe de esta sucursal, líder o admin) con PIN' });
    }

    let jefeAutorizador = null;
    for (const jefe of jefesCandidatos) {
      const match = await bcryptjs.compare(pinStr, jefe.pin_hash);
      if (match) {
        jefeAutorizador = jefe;
        break;
      }
    }

    if (!jefeAutorizador) {
      return res.status(403).json({ error: 'PIN incorrecto o no pertenece a un autorizador válido (jefe de esta sucursal, líder o admin)' });
    }

    // Registrar en auditoría en Supabase
    let auditRecord = null;
    try {
      const { data, error: auditError } = await supabase
        .from('autorizaciones_confronta')
        .insert({
          if_tranid: ifTranid,
          usuario_auxiliar_id: req.user.id,
          usuario_jefe_id: jefeAutorizador.id,
          ubicacion_id: req.user.ubicacion_id,
          discrepancias: discrepancias || []
        })
        .select()
        .single();

      if (auditError) {
        console.error('Error insertando autorizaciones_confronta:', auditError);
      } else {
        auditRecord = data;
      }
    } catch (e) {
      console.error('Excepción guardando autorizaciones_confronta:', e);
    }

    // WMS 2.0 · A2: bitácora de cambios (autorización de discrepancias por PIN)
    auditService.registrarDesdeReq(req, {
      usuarioId: req.user.id,
      tipoEvento: auditService.TIPOS.CAMBIO,
      accion: 'confronta_autorizada_pin',
      entidad: 'autorizaciones_confronta',
      entidadId: auditRecord?.id,
      detalle: {
        if_tranid: ifTranid,
        autorizado_por_id: jefeAutorizador.id,
        autorizado_por: jefeAutorizador.nombre_completo
      }
    });

    return res.json({
      success: true,
      authorizedBy: jefeAutorizador.nombre_completo,
      jefeId: jefeAutorizador.id,
      authorizationId: auditRecord?.id || null,
      message: `Autorizado por ${jefeAutorizador.nombre_completo}`
    });

  } catch (error) {
    console.error('Error en autorizarConfrontaPin:', error);
    res.status(500).json({ error: 'Error al autorizar por PIN', details: error.message });
  }
};

module.exports = {
  getIFs,
  getIFsLineas,
  submitData,
  diagnosticTest,
  validarConfronta,
  autorizarConfrontaPin,
  // Exportado para tests
  _filterIFsByUserLocation: filterIFsByUserLocation
};
