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

// ===== MAPEO DE UBICACIONES A IDs DE CARPETA =====
// Estructura: ubicacion => { id: folder_id, nombre: nombre_ubicacion, firmas: {tipo => folder_id} }
// IDs leídos desde variables de entorno para facilitar cambios entre sandbox/producción
const UBICACIONES_CARPETAS = {
  'MEX': {
    id: 1,
    nombre: 'MEX',
    firmas: {
      'auxAlmacen': parseInt(process.env.NETSUITE_FOLDER_MEX_AUXALMACEN || '0'),
      'cliente': parseInt(process.env.NETSUITE_FOLDER_MEX_CLIENTE || '0'),
      'jefeAlmacen': parseInt(process.env.NETSUITE_FOLDER_MEX_JEFE || '0'),
      'gerente': parseInt(process.env.NETSUITE_FOLDER_MEX_GERENTE || '0')
    }
  },
  'MEX:OUTLET': {
    id: 2,
    nombre: 'MEX:OUTLET',
    firmas: {
      'auxAlmacen': parseInt(process.env.NETSUITE_FOLDER_MEX_AUXALMACEN || '0'),
      'cliente': parseInt(process.env.NETSUITE_FOLDER_MEX_CLIENTE || '0'),
      'jefeAlmacen': parseInt(process.env.NETSUITE_FOLDER_MEX_JEFE || '0'),
      'gerente': parseInt(process.env.NETSUITE_FOLDER_MEX_GERENTE || '0')
    }
  },

  'GDL': {
    id: 5,
    nombre: 'GDL',
    firmas: {
      'auxAlmacen': parseInt(process.env.NETSUITE_FOLDER_GDL_AUXALMACEN || '0'),
      'cliente': parseInt(process.env.NETSUITE_FOLDER_GDL_CLIENTE || '0'),
      'jefeAlmacen': parseInt(process.env.NETSUITE_FOLDER_GDL_JEFE || '0'),
      'gerente': parseInt(process.env.NETSUITE_FOLDER_GDL_GERENTE || '0')
    }
  },
  'GDL:OUTLET': {
    id: 6,
    nombre: 'GDL:OUTLET',
    firmas: {
      'auxAlmacen': parseInt(process.env.NETSUITE_FOLDER_GDL_AUXALMACEN || '0'),
      'cliente': parseInt(process.env.NETSUITE_FOLDER_GDL_CLIENTE || '0'),
      'jefeAlmacen': parseInt(process.env.NETSUITE_FOLDER_GDL_JEFE || '0'),
      'gerente': parseInt(process.env.NETSUITE_FOLDER_GDL_GERENTE || '0')
    }
  },

  'MTY': {
    id: 3,
    nombre: 'MTY',
    firmas: {
      'auxAlmacen': parseInt(process.env.NETSUITE_FOLDER_MTY_AUXALMACEN || '0'),
      'cliente': parseInt(process.env.NETSUITE_FOLDER_MTY_CLIENTE || '0'),
      'jefeAlmacen': parseInt(process.env.NETSUITE_FOLDER_MTY_JEFE || '0'),
      'gerente': parseInt(process.env.NETSUITE_FOLDER_MTY_GERENTE || '0')
    }
  },
  'MTY:OUTLET': {
    id: 4,
    nombre: 'MTY:OUTLET',
    firmas: {
      'auxAlmacen': parseInt(process.env.NETSUITE_FOLDER_MTY_AUXALMACEN || '0'),
      'cliente': parseInt(process.env.NETSUITE_FOLDER_MTY_CLIENTE || '0'),
      'jefeAlmacen': parseInt(process.env.NETSUITE_FOLDER_MTY_JEFE || '0'),
      'gerente': parseInt(process.env.NETSUITE_FOLDER_MTY_GERENTE || '0')
    }
  },

  'TEMPORAL': {
    id: 7,
    nombre: 'TEMPORAL',
    firmas: {
      'auxAlmacen': parseInt(process.env.NETSUITE_FOLDER_TEMPORAL_AUXALMACEN || '0'),
      'cliente': parseInt(process.env.NETSUITE_FOLDER_TEMPORAL_CLIENTE || '0'),
      'jefeAlmacen': parseInt(process.env.NETSUITE_FOLDER_TEMPORAL_JEFE || '0'),
      'gerente': parseInt(process.env.NETSUITE_FOLDER_TEMPORAL_GERENTE || '0')
    }
  },
  'PROYECTOS': {
    id: 8,
    nombre: 'PROYECTOS',
    firmas: {
      'auxAlmacen': parseInt(process.env.NETSUITE_FOLDER_PROYECTOS_AUXALMACEN || '0'),
      'cliente': parseInt(process.env.NETSUITE_FOLDER_PROYECTOS_CLIENTE || '0'),
      'jefeAlmacen': parseInt(process.env.NETSUITE_FOLDER_PROYECTOS_JEFE || '0'),
      'gerente': parseInt(process.env.NETSUITE_FOLDER_PROYECTOS_GERENTE || '0')
    }
  }
};

/**
 * Obtener ID de carpeta para una firma específica
 * @param {string} ubicacion - Cod ubicación (MEX, MEX:OUTLET, GDL, etc.)
 * @param {string} tipoFirma - Tipo (auxAlmacen, cliente, jefeAlmacen, gerente)
 * @returns {number} ID de carpeta en NetSuite
 */
function getFolderId(ubicacion, tipoFirma) {
  const ub = UBICACIONES_CARPETAS[ubicacion];
  if (!ub) {
    throw new Error(`Ubicación no soportada: ${ubicacion}`);
  }
  const folderId = ub.firmas[tipoFirma];
  if (!folderId) {
    throw new Error(`Tipo de firma no soportado: ${tipoFirma} en ${ubicacion}`);
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

    // Función helper para obtener URL del RESTlet
    getRestletUrl: () => {
      return process.env.NETSUITE_RESTLET_URL || 'https://9080139-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=2860&deploy=1';
    },
    fileCabinet: {
      pathPrefix: process.env.NETSUITE_FILECABINET_PATH_PREFIX || '/Firmas',
      signatureFolderPattern: process.env.NETSUITE_FILECABINET_SIGNATURE_FOLDER_PATTERN || '{LOCATION}/{TYPE}',
      filePattern: process.env.NETSUITE_FILECABINET_FILE_PATTERN || '{IF}_{TYPE}.png'
    },

    // Mapeo de carpetas
    ubicacionesCarpetas: UBICACIONES_CARPETAS,
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
