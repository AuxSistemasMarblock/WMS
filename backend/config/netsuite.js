const axios = require('axios');

// Configuración base para NetSuite REST API
const netsuiteConfig = {
  accountId: process.env.NETSUITE_ACCOUNT_ID,
  clientId: process.env.NETSUITE_CLIENT_ID,
  clientSecret: process.env.NETSUITE_CLIENT_SECRET,
  baseUrl: `https://${process.env.NETSUITE_ACCOUNT_ID}.suiteapis.com`
};

// Helper para hacer requests autenticados a NetSuite
const makeNetsuiteRequest = async (method, endpoint, data = null) => {
  try {
    // Nota: En producción, necesitarás implementar OAuth 2.0 o token-based auth
    // Esta es una estructura base que requiere configuración adicional

    const config = {
      method,
      url: `${netsuiteConfig.baseUrl}${endpoint}`,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        // Aquí iría el token de autenticación
      }
    };

    if (data) {
      config.data = data;
    }

    return await axios(config);
  } catch (error) {
    console.error('NetSuite API error:', error.response?.data || error.message);
    throw error;
  }
};

module.exports = {
  netsuiteConfig,
  makeNetsuiteRequest
};
