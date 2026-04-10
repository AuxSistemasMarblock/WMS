/**
 * Cliente OAuth 1.0a para NetSuite RESTlet
 * Usa AMBAS credenciales: Client (Consumer) + Token
 */

const axios = require('axios');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const config = require('./environments');

/**
 * Crear cliente HTTP autenticado para RESTlet
 */
const netsuiteRestletClient = axios.create({
  baseURL: 'https://9080139-sb1.restlets.api.netsuite.com',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
});

/**
 * Crear instancia de OAuth 1.0a
 */
const oauth = new OAuth({
  consumer: {
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
 * Interceptor para firmar requests con OAuth 1.0a
 */
netsuiteRestletClient.interceptors.request.use((request) => {
  // Construir URL completa para firmar
  const fullUrl = `https://9080139-sb1.restlets.api.netsuite.com${request.url}`;

  const authHeader = oauth.toHeader(
    oauth.authorize(
      {
        url: fullUrl,
        method: request.method.toUpperCase()
      },
      {
        // Token credentials
        key: config.netsuite.tokenId,
        secret: config.netsuite.tokenSecret
      }
    )
  );

  request.headers['Authorization'] = authHeader.Authorization;
  return request;
});

module.exports = netsuiteRestletClient;
