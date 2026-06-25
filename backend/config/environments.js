/**
 * Configuración centralizada por ambiente (Sandbox/Producción)
 * Valida variables de entorno y expone configuración normalizada
 */

const requiredVars = [
  'NETSUITE_ACCOUNT_ID',
  'NETSUITE_REALM',
  'NETSUITE_CLIENT_ID',
  'NETSUITE_CLIENT_SECRET',
  'NETSUITE_TOKEN_ID',
  'NETSUITE_TOKEN_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET'
];

// Validar variables requeridas al cargar
const missing = requiredVars.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error('❌ Variables de entorno faltantes:', missing);
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Variables requeridas faltantes: ${missing.join(', ')}`);
  }
}

// ===== MAPEO PLANO DE TIPOS DE FIRMA A IDs DE CARPETA =====
// Estructura física del File Cabinet: /Firmas/{tipoFirma} con 4 subcarpetas
// La ubicación del usuario NO determina el folder físico; solo filtra IFs visibles.
// IDs leídos desde variables de entorno para facilitar cambios entre sandbox/producción.
const FIRMAS_CARPETAS = {
  'auxAlmacen':  parseInt(process.env.NETSUITE_FOLDER_AUXALMACEN || '0'),
  'cliente':     parseInt(process.env.NETSUITE_FOLDER_CLIENTE    || '0'),
  'jefeAlmacen': parseInt(process.env.NETSUITE_FOLDER_JEFE       || '0'),
  'gerente':     parseInt(process.env.NETSUITE_FOLDER_GERENTE    || '0')
};

// ===== MAPA DE UBICACIONES (solo para filtrado de IFs por usuario) =====
// No se usa para resolver folders; se conserva para que el controller pueda
// referenciar nombres/IDs al filtrar resultados del RESTlet 2217.
const UBICACIONES = {
  'MEX':         { id: 1, nombre: 'MEX' },
  'MEX:OUTLET':  { id: 2, nombre: 'MEX:OUTLET' },
  'GDL':         { id: 5, nombre: 'GDL' },
  'GDL:OUTLET':  { id: 6, nombre: 'GDL:OUTLET' },
  'MTY':         { id: 3, nombre: 'MTY' },
  'MTY:OUTLET':  { id: 4, nombre: 'MTY:OUTLET' },
  'TEMPORAL':    { id: 7, nombre: 'TEMPORAL' },
  'PROYECTOS':   { id: 8, nombre: 'PROYECTOS' }
};

/**
 * Obtener ID de carpeta para un tipo de firma
 * La ubicación no participa: el folder físico es el mismo para todas las ubicaciones.
 *
 * @param {string} tipoFirma - Tipo (auxAlmacen, cliente, jefeAlmacen, gerente)
 * @returns {number} ID de carpeta en NetSuite
 */
function getFolderId(tipoFirma) {
  const folderId = FIRMAS_CARPETAS[tipoFirma];
  if (!folderId) {
    throw new Error(`Tipo de firma no soportado: ${tipoFirma}`);
  }
  return folderId;
}

/**
 * Exportar configuración normalizada
 */
module.exports = {
  // ===== NETSUITE Token-based Auth (con ambas credenciales) =====
  netsuite: {
    accountId: process.env.NETSUITE_ACCOUNT_ID,
    realm: process.env.NETSUITE_REALM,
    environment: process.env.NETSUITE_ENVIRONMENT || 'sandbox',
    apiVersion: process.env.NETSUITE_API_VERSION || '2022.1',

    // Client Credentials (Integration Record)
    clientId: process.env.NETSUITE_CLIENT_ID,
    clientSecret: process.env.NETSUITE_CLIENT_SECRET,

    // Token Credentials (Access Token)
    tokenId: process.env.NETSUITE_TOKEN_ID,
    tokenSecret: process.env.NETSUITE_TOKEN_SECRET,

    // Base URL para API calls
    baseUrl: () => {
      return `https://${process.env.NETSUITE_ACCOUNT_ID}.app.netsuite.com/services/rest/record/v1`;
    },

    // RESTlet configuration
    restlet: {
      url: process.env.NETSUITE_RESTLET_URL || 'https://9080139-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl',
      scriptId: process.env.NETSUITE_RESTLET_SCRIPT_ID || '2860',
      deployId: process.env.NETSUITE_RESTLET_DEPLOY_ID || '1'
    },

    // Search RESTlet configuration (2217)
    searchRestlet: {
      url: process.env.NETSUITE_SEARCH_RESTLET_URL || 'https://9080139-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=2217&deploy=1',
      scriptId: process.env.NETSUITE_SEARCH_RESTLET_SCRIPT_ID || '2217',
      deployId: process.env.NETSUITE_SEARCH_RESTLET_DEPLOY_ID || '1',
      searchId: process.env.NETSUITE_SEARCH_ID || 'customsearch3678'
    },

    // Función helper para obtener URL del RESTlet
    getRestletUrl: () => {
      return process.env.NETSUITE_RESTLET_URL || 'https://9080139-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=2860&deploy=1';
    },

    // Función helper para obtener URL del Search RESTlet
    getSearchRestletUrl: () => {
      return process.env.NETSUITE_SEARCH_RESTLET_URL || 'https://9080139-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=2217&deploy=1';
    },
    fileCabinet: {
      pathPrefix: process.env.NETSUITE_FILECABINET_PATH_PREFIX || '/Firmas',
      signatureFolderPattern: process.env.NETSUITE_FILECABINET_SIGNATURE_FOLDER_PATTERN || '{LOCATION}/{TYPE}',
      filePattern: process.env.NETSUITE_FILECABINET_FILE_PATTERN || '{IF}_{TYPE}.png'
    },

    // Mapeo plano de carpetas de firma (4 tipos)
    firmasCarpetas: FIRMAS_CARPETAS,
    // Mapa de ubicaciones (solo para filtrado de IFs por usuario, no para folders)
    ubicaciones: UBICACIONES,
    getFolderId
  },

  // ===== SUPABASE =====
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  },

  // ===== JWT =====
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: '24h'
  },

  // ===== SERVER =====
  server: {
    port: process.env.PORT || 3001,
    nodeEnv: process.env.NODE_ENV || 'development',
    allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost').split(','),
    logLevel: process.env.LOG_LEVEL || 'info'
  },

  // ===== HELPERS =====
  isProduction: () => process.env.NODE_ENV === 'production',
  isSandbox: () => process.env.NETSUITE_REALM === 'sandbox'
};
