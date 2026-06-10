/**
 * Cliente Token-based Auth para NetSuite
 * Usa AMBAS credenciales: Client ID/Secret + Token ID/Secret
 */

const axios = require('axios');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const config = require('./environments');

/**
 * Crear cliente HTTP autenticado
 */
const netsuiteClient = axios.create({
  baseURL: config.netsuite.baseUrl(),
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
});

/**
 * Crear instancia de OAuth 1.0a usando AMBAS credenciales
 */
const oauth = new OAuth({
  consumer: {
    // Usar Client ID como consumer key (del Integration Record)
    key: config.netsuite.clientId,
    secret: config.netsuite.clientSecret
  },
  signature_method: 'HMAC-SHA256',
  hash_function(base_string, key) {
    return crypto
      .createHmac('sha256', key)
      .update(base_string)
      .digest('base64');
  }
});

/**
 * Interceptor para agregar headers OAuth a cada request
 * Usa ambas credenciales: Client (consumer) + Token
 */
netsuiteClient.interceptors.request.use((request) => {
  // Usar Client ID + Client Secret + Token ID + Token Secret
  const authHeader = oauth.toHeader(
    oauth.authorize(
      {
        url: `${config.netsuite.baseUrl()}${request.url}`,
        method: request.method.toUpperCase()
      },
      {
        // OAuth token (Token ID + Token Secret)
        key: config.netsuite.tokenId,
        secret: config.netsuite.tokenSecret
      }
    )
  );

  request.headers['Authorization'] = authHeader.Authorization;
  return request;
});

module.exports = netsuiteClient;

