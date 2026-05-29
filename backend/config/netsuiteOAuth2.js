/**
 * Cliente OAuth 2.0 para NetSuite
 * Implementa flujo Authorization Code Flow
 */

const axios = require('axios');
const config = require('./environments');

/**
 * Cliente HTTP para OAuth 2.0 requests
 */
const netsuiteOAuth2Client = axios.create({
  baseURL: `https://${config.netsuite.accountId}.suiteapis.com/auth/oauth2`,
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded'
  }
});

/**
 * Obtener URL de autorización
 * Redirigir al usuario a esta URL para que autorice
 * @returns {string} URL de autorización
 */
const getAuthorizationUrl = () => {
  const params = new URLSearchParams({
    client_id: config.netsuite.clientId,
    response_type: 'code',
    scope: 'restlets',
    redirect_uri: config.netsuite.redirectUri,
    state: 'security_token_' + Date.now() // Para validar en callback
  });

  // NetSuite OAuth 2.0 endpoint
  // Usa el Account ID directamente (que incluye -SB1 para sandbox)
  return `https://${config.netsuite.accountId}.app.netsuite.com/app/login/oauth.nl?${params.toString()}`;
};

/**
 * Intercambiar authorization code por access token
 * @param {string} authorizationCode - Código recibido en el callback
 * @returns {Promise<Object>} Token object con accessToken, expiresIn, etc
 */
const getAccessToken = async (authorizationCode) => {
  try {
    console.log('🔐 Intercambiando authorization code por access token...');

    const data = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: config.netsuite.redirectUri,
      client_id: config.netsuite.clientId,
      client_secret: config.netsuite.clientSecret
    });

    const response = await netsuiteOAuth2Client.post('/token', data);

    console.log('✅ Access token obtenido exitosamente');

    return {
      accessToken: response.data.access_token,
      expiresIn: response.data.expires_in,
      tokenType: response.data.token_type,
      refreshToken: response.data.refresh_token,
      issuedAt: Date.now()
    };
  } catch (error) {
    console.error('❌ Error obteniendo access token:', error.response?.data || error.message);
    throw new Error(`Failed to get access token: ${error.response?.data?.error_description || error.message}`);
  }
};

/**
 * Refrescar access token usando refresh token
 * @param {string} refreshToken - Token de refresco
 * @returns {Promise<Object>} Nuevo token object
 */
const refreshAccessToken = async (refreshToken) => {
  try {
    console.log('🔄 Refrescando access token...');

    const data = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.netsuite.clientId,
      client_secret: config.netsuite.clientSecret
    });

    const response = await netsuiteOAuth2Client.post('/token', data);

    console.log('✅ Access token refrescado exitosamente');

    return {
      accessToken: response.data.access_token,
      expiresIn: response.data.expires_in,
      tokenType: response.data.token_type,
      refreshToken: response.data.refresh_token,
      issuedAt: Date.now()
    };
  } catch (error) {
    console.error('❌ Error refrescando access token:', error.response?.data || error.message);
    throw new Error(`Failed to refresh access token: ${error.message}`);
  }
};

/**
 * Crear cliente HTTP autenticado con access token
 * @param {string} accessToken - Token de acceso
 * @returns {AxiosInstance} Cliente HTTP autenticado
 */
const createAuthenticatedClient = (accessToken) => {
  return axios.create({
    baseURL: `https://${config.netsuite.accountId}.suiteapis.com/services/rest/record/v1`,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });
};

module.exports = {
  getAuthorizationUrl,
  getAccessToken,
  refreshAccessToken,
  createAuthenticatedClient
};
