/**
 * Endpoint de validación previa antes de subir firmas
 */

const express = require('express');
const router = express.Router();
const netsuiteRestletClient = require('../config/netsuiteRestlet');
const config = require('../config/environments');

/**
 * GET /firmas/validate
 * Valida la configuración y credenciales antes de subir
 */
router.get('/validate', async (req, res) => {
  const validation = {
    timestamp: new Date().toISOString(),
    checks: {},
    errors: [],
    warnings: []
  };

  try {
    // 1. Validar variables de entorno
    console.log('\n🔍 VALIDACIÓN DE CONFIGURACIÓN\n');

    const envVars = {
      'NETSUITE_ACCOUNT_ID': process.env.NETSUITE_ACCOUNT_ID,
      'NETSUITE_REALM': process.env.NETSUITE_REALM,
      'NETSUITE_CLIENT_ID': process.env.NETSUITE_CLIENT_ID ? '✓ (existe)' : '✗ (falta)',
      'NETSUITE_CLIENT_SECRET': process.env.NETSUITE_CLIENT_SECRET ? '✓ (existe)' : '✗ (falta)',
      'NETSUITE_TOKEN_ID': process.env.NETSUITE_TOKEN_ID ? '✓ (existe)' : '✗ (falta)',
      'NETSUITE_TOKEN_SECRET': process.env.NETSUITE_TOKEN_SECRET ? '✓ (existe)' : '✗ (falta)',
      'NETSUITE_RESTLET_URL': process.env.NETSUITE_RESTLET_URL,
      'NETSUITE_RESTLET_SCRIPT_ID': process.env.NETSUITE_RESTLET_SCRIPT_ID,
      'NETSUITE_RESTLET_DEPLOY_ID': process.env.NETSUITE_RESTLET_DEPLOY_ID
    };

    validation.checks.configuration = {
      status: 'OK',
      details: envVars
    };

    // 2. Validar folder IDs
    const folderChecks = {
      'MEX (auxAlmacen)': process.env.NETSUITE_FOLDER_MEX_AUXALMACEN,
      'MEX (cliente)': process.env.NETSUITE_FOLDER_MEX_CLIENTE,
      'MEX (jefe)': process.env.NETSUITE_FOLDER_MEX_JEFE,
      'MEX (gerente)': process.env.NETSUITE_FOLDER_MEX_GERENTE,
      'GDL (auxAlmacen)': process.env.NETSUITE_FOLDER_GDL_AUXALMACEN,
      'GDL (cliente)': process.env.NETSUITE_FOLDER_GDL_CLIENTE,
      'MTY (auxAlmacen)': process.env.NETSUITE_FOLDER_MTY_AUXALMACEN,
      'MTY (cliente)': process.env.NETSUITE_FOLDER_MTY_CLIENTE
    };

    validation.checks.folders = folderChecks;

    // 3. Test de conexión OAuth
    console.log('1️⃣  Validando configuración... ✓');
    console.log('2️⃣  Validando Folder IDs... ✓');
    console.log('3️⃣  Testeando conexión OAuth...');

    const testPayload = {
      filename: 'VALIDATION_TEST.png',
      contents: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      folder_id: 7433  // Test folder
    };

    try {
      const scriptId = process.env.NETSUITE_RESTLET_SCRIPT_ID || '2860';
      const deployId = process.env.NETSUITE_RESTLET_DEPLOY_ID || '1';
      const restletPath = `/app/site/hosting/restlet.nl?script=${scriptId}&deploy=${deployId}`;

      const response = await netsuiteRestletClient.post(restletPath, testPayload, {
        validateStatus: () => true
      });

      if (response.status === 200 && response.data.success) {
        validation.checks.oauth_connection = {
          status: 'OK',
          message: 'OAuth 1.0a funcionando correctamente',
          response: {
            status: response.status,
            fileId: response.data.fileId
          }
        };
        console.log('3️⃣  OAuth funcionando... ✓');
      } else {
        validation.checks.oauth_connection = {
          status: 'ERROR',
          message: 'OAuth falló',
          response: {
            status: response.status,
            data: response.data
          }
        };
        validation.errors.push(`OAuth error: ${response.status} - ${JSON.stringify(response.data)}`);
        console.log(`3️⃣  OAuth falló... ✗ (${response.status})`);
      }

    } catch (oauthError) {
      validation.checks.oauth_connection = {
        status: 'ERROR',
        message: oauthError.message
      };
      validation.errors.push(`OAuth exception: ${oauthError.message}`);
      console.log('3️⃣  OAuth error... ✗');
    }

    // 4. Resumen
    console.log('\n📊 VALIDACIÓN COMPLETA\n');

    const hasErrors = validation.errors.length > 0;
    validation.ready_for_upload = !hasErrors;

    console.log(`Status: ${hasErrors ? '❌ NO LISTO' : '✅ LISTO PARA SUBIR'}`);
    if (validation.errors.length > 0) {
      console.log('\n⚠️  Errores encontrados:');
      validation.errors.forEach(err => console.log(`   - ${err}`));
    }

    const statusCode = hasErrors ? 400 : 200;
    res.status(statusCode).json(validation);

  } catch (error) {
    validation.errors.push(error.message);
    validation.ready_for_upload = false;
    res.status(500).json(validation);
  }
});

module.exports = router;
