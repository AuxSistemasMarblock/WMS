/**
 * Cliente OAuth 1.0a para NetSuite RESTlet
 * Usa AMBAS credenciales: Client (Consumer) + Token
 * Configurable desde .env para sandbox/producción
 */

const axios = require('axios');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const config = require('./environments');

/**
 * Extraer base URL del RESTlet URL completo
 */
function getRestletBaseUrl() {
  const fullUrl = process.env.NETSUITE_RESTLET_URL || config.netsuite.getRestletUrl();
  // Extract domain from URL (sin query params)
  const url = new URL(fullUrl);
  return `${url.protocol}//${url.hostname}`;
}

/**
 * Crear cliente HTTP autenticado para RESTlet
 */
const netsuiteRestletClient = axios.create({
  baseURL: getRestletBaseUrl(),
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
});

/**
 * Crear instancia de OAuth 1.0a
 * Configurado con HMAC-SHA256 como en Postman
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
 * Agrega Authorization header con firma OAuth
 */
netsuiteRestletClient.interceptors.request.use((request) => {
  // Construir URL completa para firmar (dinámicu desde .env)
  const baseUrl = getRestletBaseUrl();
  const fullUrl = `${baseUrl}${request.url}`;

  const authHeader = oauth.toHeader(
    oauth.authorize(
      {
        url: fullUrl,
        method: request.method.toUpperCase()
      },
      {
        // Token credentials (segundo par de credenciales)
        key: config.netsuite.tokenId,
        secret: config.netsuite.tokenSecret
      }
    )
  );

  // Agregar Authorization header (como en Postman, no en query params)
  request.headers['Authorization'] = authHeader.Authorization;

  return request;
});

module.exports = netsuiteRestletClient;
