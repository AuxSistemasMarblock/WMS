/**
 * Configuración del cliente de Google Sheets (Service Account)
 *
 * Lee la hoja donde n8n (vía webhook) deposita los escaneos de placas
 * y la expone al dashboard para la confronta contra NetSuite.
 *
 * Ver DOCUMENTATION.md §6.14 para el setup completo de la SA.
 */

const path = require('path');

module.exports = {
  // Ruta absoluta al JSON de la Service Account dentro del contenedor.
  // En local: backend/secrets/gcp-service-account.json
  // En Dokploy: montado por volumen en /app/backend/secrets/gcp-service-account.json
  serviceAccountPath: process.env.GOOGLE_SHEETS_SA_PATH
    || path.join(__dirname, '..', 'secrets', 'gcp-service-account.json'),

  // ID del spreadsheet (segmento de la URL entre /d/ y /edit)
  spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,

  // Rango A1 notation. A1:I = todas las filas con datos, columnas A a I.
  // La API de Sheets devuelve hasta la última fila con contenido,
  // no hace falta poner un número de fila explícito.
  range: process.env.GOOGLE_SHEETS_RANGE || 'Hoja 1!A1:I',

  // Scope de OAuth: solo lectura. No se puede modificar el Sheet.
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],

  // TTL de caché en memoria (segundos)
  cacheTTL: parseInt(process.env.GOOGLE_SHEETS_CACHE_TTL || '60', 10)
};
