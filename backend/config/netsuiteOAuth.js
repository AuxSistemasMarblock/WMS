/**
 * Cliente OAuth 1.0a para NetSuite
 * Genera firmas y headers de autenticación para llamadas a la API REST
 */

const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const axios = require('axios');
const config = require('./environments');

/**
 * Crear instancia de OAuth 1.0a
 */
const oauth = new OAuth({
  consumer: {
    key: config.netsuite.consumerKey,
    secret: config.netsuite.consumerSecret
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
 * Crear cliente HTTP autenticado con OAuth 1.0a
 */
const netsuiteClient = axios.create({
  baseURL: config.netsuite.baseUrl(),
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
});

/**
 * Interceptor para agregar headers OAuth a cada request
 */
netsuiteClient.interceptors.request.use((request) => {
  const authHeader = oauth.toHeader(
    oauth.authorize(
      {
        url: `${config.netsuite.baseUrl()}${request.url}`,
        method: request.method.toUpperCase()
      },
      {
        key: config.netsuite.tokenId,
        secret: config.netsuite.tokenSecret
      }
    )
  );

  request.headers['Authorization'] = authHeader.Authorization;
  return request;
});

module.exports = netsuiteClient;
