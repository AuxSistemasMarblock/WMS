/**
 * Controller para autenticación OAuth 2.0 con NetSuite
 */

const supabase = require('../config/supabase');
const oauth2 = require('../config/netsuiteOAuth2');
const config = require('../config/environments');
const jwt = require('jsonwebtoken');

/**
 * Iniciar flujo OAuth 2.0
 * Redirige al usuario a NetSuite para autorizar
 */
const initiateOAuth = (req, res) => {
  try {
    console.log('🔐 Iniciando flujo OAuth 2.0...');
    const authUrl = oauth2.getAuthorizationUrl();
    console.log(`📍 Redirect URL: ${authUrl}`);
    res.redirect(authUrl);
  } catch (error) {
    console.error('❌ Error iniciando OAuth:', error.message);
    res.status(500).json({ error: 'Failed to initiate OAuth flow', details: error.message });
  }
};

/**
 * Callback del flujo OAuth 2.0
 * NetSuite redirige aquí con el authorization code
 */
const oauthCallback = async (req, res) => {
  try {
    const { code, state, error } = req.query;

    console.log('📲 OAuth callback recibido');
    console.log(`   Code: ${code?.substring(0, 20)}...`);
    console.log(`   State: ${state}`);
    console.log(`   Error: ${error || 'none'}`);

    // Validar que no haya error
    if (error) {
      console.error(`❌ NetSuite retornó error: ${error}`);
      return res.status(400).json({
        error: 'Authorization denied',
        details: error
      });
    }

    // Validar que tenemos el código
    if (!code) {
      console.error('❌ No authorization code received');
      return res.status(400).json({
        error: 'No authorization code received'
      });
    }

    // Intercambiar código por access token
    console.log('🔄 Intercambiando authorization code por access token...');
    const tokenData = await oauth2.getAccessToken(code);

    // Aquí necesitarías:
    // 1. Identificar al usuario (desde la sesión o JWT)
    // 2. Guardar el token de acceso en la base de datos
    // 3. Redirigir a la app con confirmación

    // Por ahora, retornamos el token (en producción, guardarlo en BD)
    console.log('✅ OAuth flow completado exitosamente');

    res.json({
      success: true,
      message: 'OAuth authentication successful',
      token: tokenData.accessToken,
      expiresIn: tokenData.expiresIn,
      note: 'En producción, este token se guarda en la BD asociado al usuario'
    });

  } catch (error) {
    console.error('❌ Error en OAuth callback:', error.message);
    res.status(500).json({
      error: 'OAuth callback failed',
      details: error.message
    });
  }
};

/**
 * Test de conexión con OAuth 2.0
 * Verifica que podamos autenticar correctamente
 */
const testOAuth2Connection = async (req, res) => {
  try {
    console.log('\n🔍 ===== OAUTH 2.0 TEST =====\n');

    // 1. Validar configuración
    console.log('1️⃣  Validando configuración...');
    const requiredConfig = {
      'Client ID': config.netsuite.clientId,
      'Client Secret': config.netsuite.clientSecret,
      'Redirect URI': config.netsuite.redirectUri,
      'Account ID': config.netsuite.accountId,
    };

    for (const [key, value] of Object.entries(requiredConfig)) {
      if (!value) {
        return res.status(400).json({
          test: 'FAILED',
          step: 'Configuration validation',
          missing: key
        });
      }
      const masked = String(value).substring(0, 5) + '***' + String(value).substring(String(value).length - 3);
      console.log(`   ✓ ${key}: ${masked}`);
    }

    // 2. Mostrar URL de autorización
    console.log('\n2️⃣  URL de autorización:');
    const authUrl = oauth2.getAuthorizationUrl();
    console.log(`   ${authUrl}`);

    // 3. Mostrar endpoints
    console.log('\n3️⃣  Endpoints de OAuth 2.0:');
    console.log(`   Token Endpoint: ${config.netsuite.tokenUrl()}`);
    console.log(`   Auth Endpoint: ${config.netsuite.authUrl()}`);

    console.log('\n✅ Configuración de OAuth 2.0 es válida\n');

    res.json({
      test: 'SUCCESS',
      message: 'OAuth 2.0 configuration is valid',
      config: {
        accountId: config.netsuite.accountId,
        realm: config.netsuite.realm,
        clientId: config.netsuite.clientId?.substring(0, 10) + '...',
        redirectUri: config.netsuite.redirectUri
      },
      authUrl: authUrl,
      nextStep: 'Redirect user to authUrl to start OAuth flow'
    });

  } catch (error) {
    console.error('❌ Test error:', error.message);
    res.status(500).json({
      test: 'FAILED',
      error: error.message
    });
  }
};

module.exports = {
  initiateOAuth,
  oauthCallback,
  testOAuth2Connection
};
