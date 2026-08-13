/**
 * Servicio de Google Sheets (Service Account)
 *
 * Lee la hoja donde n8n deposita los escaneos de placas.
 * Headers esperados (primera fila):
 *   Fecha | Ubicacion | Creado desde | IF | Responsable | SKU |
 *   Lote | Ubicacion lote | Hora de salida
 *
 * Ver DOCUMENTATION.md §6.14 para setup completo.
 */

const { google } = require('googleapis');
const fs = require('fs');
const config = require('../config/googleSheets');

let cachedClient = null;

/**
 * Inicializa y cachea el cliente autenticado de googleapis
 */
async function getClient() {
  if (cachedClient) return cachedClient;

  // Verificar que el archivo de credenciales existe
  if (!fs.existsSync(config.serviceAccountPath)) {
    throw new Error(
      `Service Account JSON no encontrado en: ${config.serviceAccountPath}\n` +
      'Verifica que el archivo existe y que GOOGLE_SHEETS_SA_PATH apunta correctamente.\n' +
      'Ver DOCUMENTATION.md §6.14 para el setup.'
    );
  }

  if (!config.spreadsheetId) {
    throw new Error(
      'GOOGLE_SHEETS_SPREADSHEET_ID no configurado.\n' +
      'Copia el ID del spreadsheet (segmento entre /d/ y /edit de la URL) ' +
      'y agrégalo a las variables de entorno.'
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: config.serviceAccountPath,
    scopes: config.scopes
  });

  const authClient = await auth.getClient();
  cachedClient = google.sheets({ version: 'v4', auth: authClient });
  return cachedClient;
}

/**
 * Normaliza un header a snake_case sin acentos
 * "Ubicación lote" -> "ubicacion_lote"
 * "Hora de salida" -> "hora_salida"
 */
function normalizarHeader(h) {
  if (!h) return '';
  return h.toString().toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[áàä]/g, 'a')
    .replace(/[éèë]/g, 'e')
    .replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o')
    .replace(/[úùü]/g, 'u')
    .replace(/ñ/g, 'n');
}

/**
 * Convierte filas crudas del Sheets a objetos normalizados.
 * Mapea headers normalizados a campos canónicos usados por el confrontaService.
 */
function filasAObjetos(rows) {
  if (rows.length === 0) return [];

  const headersCrudos = rows[0];
  const headersNorm = headersCrudos.map(normalizarHeader);

  // Mapa: header normalizado -> nombre canónico
  // (los headers del Sheets según DOCUMENTATION.md §6.14.4)
  const headerMap = {
    'fecha':           'fecha',
    'ubicacion':       'sucursal',
    'creado_desde':    'so',
    'if':              'if_tranid',
    'responsable':     'operador',
    'sku':             'sku',
    'lote':            'lote',
    'ubicacion_lote':  'ubicacion_escaneada',
    'hora_de_salida':  'hora_salida'
  };

  return rows.slice(1).map((fila, idx) => {
    const obj = { _row: idx + 2 }; // +2 porque la fila 1 son headers y arrays son 0-indexed
    headersNorm.forEach((hNorm, i) => {
      const canonico = headerMap[hNorm] || hNorm;
      obj[canonico] = fila[i] !== undefined ? fila[i].toString().trim() : null;
    });
    return obj;
  });
}

/**
 * Combina Fecha + Hora de salida en un ISO timestamp
 * (necesario porque Sheets los tiene en columnas separadas)
 */
function combinarTimestamp(obj) {
  if (!obj.fecha) return null;
  const hora = obj.hora_salida || '00:00:00';
  // Asumimos formato fecha: YYYY-MM-DD o similar; hora: HH:MM:SS
  try {
    const fechaLimpia = obj.fecha.split(' ')[0]; // quitar hora si viene junto
    const ts = new Date(`${fechaLimpia}T${hora}`);
    if (isNaN(ts.getTime())) return null;
    return ts.toISOString();
  } catch (e) {
    return null;
  }
}

// Caché en memoria de los escaneos normalizados (sin filtrar).
// La API de Sheets no cambia salvo que n8n escriba; con TTL (default 60s)
// evitamos releer toda la hoja en cada cambio de filtro del dashboard.
let cacheEscaneos = null; // { ts, data }
let fetchEscaneosPromise = null; // single-flight: evita doble lectura concurrente

/**
 * Lee todos los escaneos del Sheet, normaliza y los devuelve como array de objetos.
 *
 * @param {Object} options
 * @param {string} options.desde    - Fecha desde (YYYY-MM-DD) para filtrar
 * @param {string} options.hasta    - Fecha hasta (YYYY-MM-DD) para filtrar
 * @param {string} options.sucursal - Filtrar por sucursal específica (ej: "MTY")
 * @returns {Promise<Array<Object>>}
 */
async function getEscaneos({ desde, hasta, sucursal } = {}) {
  const objetos = await getEscaneosNormalizados();

  // Filtrar. Se devuelven COPIES de los objetos cacheados para que ningún
  // consumidor pueda mutar el caché y corromper otras combinaciones de filtros.
  return objetos
    .filter(o => {
      if (desde && o.fecha && o.fecha < desde) return false;
      if (hasta && o.fecha && o.fecha > hasta) return false;
      if (sucursal && !sucursalMatch(o.sucursal, sucursal)) return false;
      return true;
    })
    .map(o => ({ ...o }));
}

/**
 * Lee la hoja UNA vez dentro del TTL configurado y devuelve los escaneos
 * normalizados SIN filtrar (todas las filas). El filtrado por fechas/sucursal
 * se hace en getEscaneos, después de este caché, así todas las combinaciones
 * de filtros comparten la misma lectura de la hoja.
 *
 * @returns {Promise<Array<Object>>}
 */
async function getEscaneosNormalizados() {
  const ttlMs = (config.cacheTTL || 60) * 1000;

  if (cacheEscaneos && Date.now() - cacheEscaneos.ts < ttlMs) {
    return cacheEscaneos.data;
  }

  // Si ya hay una lectura en curso (caché expirado justo con varias llamadas
  // concurrentes), todas comparten la misma; evita doble lectura de la hoja.
  if (fetchEscaneosPromise) return fetchEscaneosPromise;

  fetchEscaneosPromise = (async () => {
    const sheets = await getClient();

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: config.range
    });

    const rows = res.data.values || [];

    if (process.env.VERBOSE === '1') {
      console.log(`[VERBOSE] Sheets response: ${rows.length} filas (incluyendo header)`);
      if (rows.length > 1) {
        console.log(`[VERBOSE] Primera fila de datos:`);
        console.log(JSON.stringify(rows[1], null, 2));
      }
    }

    const objetos = filasAObjetos(rows);

    // Agregar timestamp combinado
    objetos.forEach(o => {
      o.timestamp = combinarTimestamp(o);
    });

    // Normalizar fechas antes de filtrar
    objetos.forEach(o => {
      o.fecha = normalizarFechaSheets(o.fecha);
    });

    cacheEscaneos = { ts: Date.now(), data: objetos };
    return objetos;
  })().finally(() => {
    fetchEscaneosPromise = null;
  });

  return fetchEscaneosPromise;
}

/**
 * Match de sucursal estilo filterIFsByUserLocation del scanner:
 *  - "MEX" matchea "MEX", "MEX:OUTLET", "MEX : OUTLET MEX", etc.
 *  - Cualquier otra: match exacto.
 */
function sucursalMatch(sucursalEscaneo, sucursalFiltro) {
  if (!sucursalFiltro) return true;
  if (!sucursalEscaneo) return false;
  if (sucursalEscaneo === sucursalFiltro) return true;
  const tokens = sucursalEscaneo.split(/[\s:]+/).filter(Boolean);
  return tokens.includes(sucursalFiltro);
}

/**
 * Convierte fecha en formato Sheets (M/D/YYYY, D/M/YYYY, o DD/MM/YYYY) a YYYY-MM-DD.
 * Sheets puede entregar fechas en cualquiera de estos formatos dependiendo de
 * la configuración regional de la hoja.
 *
 * Heurística: si el primer número es > 12, es día (DD/MM/YYYY).
 *              si el segundo número es > 12, es mes (M/D/YYYY → DD/MM/YYYY ambiguo).
 *              Para distinguir, verificamos si la hora del Sheets es AM/PM o 24h.
 *              En la práctica, "11/6/2026" con "12:23:33 p.m." sugiere M/D/YYYY
 *              (6 de noviembre), o D/M/YYYY (11 de junio) dependiendo del locale.
 *
 * Para México, lo más probable es DD/MM/YYYY. Si el primer número es > 12, es DD/MM.
 */
function normalizarFechaSheets(fecha) {
  if (!fecha) return null;
  const s = fecha.toString().trim();

  // Ya está en formato ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);

  // M/D/YYYY o D/M/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, a, b, yyyy] = m;
    const aNum = parseInt(a, 10);
    const bNum = parseInt(b, 10);

    // Si el primer número es > 12, definitivamente es día → DD/MM/YYYY
    if (aNum > 12) {
      return `${yyyy}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    }
    // Si el segundo número es > 12, es mes → M/D/YYYY
    if (bNum > 12) {
      return `${yyyy}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
    }
    // Ambos <= 12: ambiguo. Asumir DD/MM/YYYY (convención México/Latam)
    return `${yyyy}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
  }

  // DD-MM-YYYY
  const m2 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m2) {
    const [, dd, mm, yyyy] = m2;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }

  return s;
}

/**
 * Lee solo los headers del Sheet (útil para diagnóstico)
 */
async function getHeaders() {
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: config.range.split('!')[0] + '!1:1' // solo primera fila
  });
  return (res.data.values && res.data.values[0]) || [];
}

module.exports = {
  getEscaneos,
  getHeaders,
  normalizarHeader,
  // exportados para tests
  _filasAObjetos: filasAObjetos,
  _combinarTimestamp: combinarTimestamp
};
