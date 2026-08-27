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
  'JWT_SECRET',
  'GOOGLE_SHEETS_SPREADSHEET_ID'
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

// ===== UBICACIONES PRINCIPALES (para el dashboard) =====
// Cuando el dashboard filtra por "MEX", también incluye "MEX:OUTLET", "MEX : OUTLET MEX", etc.
// (mismo patrón que netsuiteController.js:filterIFsByUserLocation)
const RESTRICTED_LOCATION_PREFIXES = ['MEX', 'MTY', 'GDL'];
const SHARED_LOCATIONS = ['TEMPORAL', 'PROYECTOS', 'Material Transformado', 'MATRIZ'];

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
      // Saved search de IFs pendientes a sacar (la que usa el controller del scanner)
      searchId: process.env.NETSUITE_SEARCH_ID || 'customsearch3678',
      // Saved search de IFs ya enviadas (la que usa el dashboard para confronta)
      searchIdEnviadas: process.env.NETSUITE_SEARCH_IFS_ENVIADAS_ID || 'customsearch3675',
      // Saved search de existencias (artículos/lotes con cantidad a mano)
      searchIdExistencias: process.env.NETSUITE_SEARCH_EXISTENCIAS_ID || 'customsearch_imr_items',
      // Saved search IR -> pedimento (sub-búsqueda por ubicación + lote)
      searchIdIRPedimento: process.env.NETSUITE_SEARCH_IR_PEDIMENTO_ID || 'customsearch3677'
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
    // Prefijos restringidos (sucursales principales: MEX, MTY, GDL)
    RESTRICTED_LOCATION_PREFIXES,
    // Ubicaciones compartidas (visibles para todos)
    SHARED_LOCATIONS,
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

  // ===== N8N (proxy de webhook) =====
  n8n: {
    webhookUrl: process.env.N8N_WEBHOOK_URL
  },

  // ===== HELPERS =====
  isProduction: () => process.env.NODE_ENV === 'production',
  isSandbox: () => process.env.NETSUITE_REALM === 'sandbox',

  // ===== ZPL (impresión de etiquetas) =====
  // Dimensiones y settings de la impresora Zebra, ajustables por ambiente.
  zpl: {
    ancho: parseInt(process.env.ZPL_PW || '807', 10),     // ^PW ancho de impresión (101mm / 807 dots @ 203dpi)
    alto: parseInt(process.env.ZPL_LL || '152', 10),      // ^LL largo de etiqueta (19mm / 152 dots @ 203dpi)
    velocidad: parseInt(process.env.ZPL_PR || '2', 10),   // ^PR velocidad (lenta = más nitidez)
    densidad: parseInt(process.env.ZPL_SD || '25', 10),   // ~SD máxima oscuridad
    qrMagnification: parseInt(process.env.ZPL_QR_MAGNIFICATION || process.env.ZPL_QR_SIZE || '4', 10), // Factor de tamaño (4 = ~1.45 cm, 3 = ~1.08 cm)
    qrEcc: process.env.ZPL_QR_ECC || 'L',                 // Corrección de error (L permite hasta 53 bytes en V3 sin crecer)
    qrFixedLen: parseInt(process.env.ZPL_QR_FIXED_LEN || '45', 10), // largo fijo del dato QR para bloquear Versión 3 fija (29x29)
    textoX: parseInt(process.env.ZPL_TEXTO_X || '20', 10),          // X de la columna de texto (margen izquierdo)
    qrX: process.env.ZPL_QR_X ? parseInt(process.env.ZPL_QR_X, 10) : undefined, // Opcional: si se omite, se calcula automáticamente para márgenes idénticos
    qrY: process.env.ZPL_QR_Y ? parseInt(process.env.ZPL_QR_Y, 10) : undefined  // Opcional: si se omite, se calcula automáticamente para márgenes idénticos
  }
};
