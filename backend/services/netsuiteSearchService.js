/**
 * Servicio de búsqueda de IFs enviadas en NetSuite.
 *
 * Usa el mismo RESTlet 2217 que el controller del scanner, cambiando
 * únicamente el searchId por el de la saved search de IFs ya enviadas.
 *
 * Devuelve cada IF con sus líneas: sku, lote, cantidad (m²), ubicación esperada.
 *
 * Estructura de cada línea (según columnas de customsearch3675):
 *   id_interno, fecha, ubicación, creado_desde, IF, SKU, número (lote),
 *   ubicación, cantidad (m²)
 */

const envConfig = require('../config/environments');
const netsuiteClient = require('../config/netsuiteRestlet');

const { scriptId, deployId, searchIdEnviadas } = envConfig.netsuite.searchRestlet;
const restletPath = `/app/site/hosting/restlet.nl?script=${scriptId}&deploy=${deployId}`;

/**
 * Llama al RESTlet y devuelve el JSON de la saved search de IFs enviadas.
 *
 * Estrategia de paginación con terminación temprana:
 *  - El saved search está configurado para devolver "más recientes primero".
 *  - Traemos de 1000 en 1000 hasta que:
 *    a) No haya más resultados, o
 *    b) La página devuelta tenga fechas anteriores al `desde` (ya cubrimos el rango), o
 *    c) Lleguemos al `maxRegistros` (tope de seguridad).
 *
 * Esto es eficiente para el caso de uso semanal: si solo quieres la semana
 * pasada, basta con 1-2 requests en vez de traer 10k+ registros.
 *
 * @param {Object} options
 * @param {string} options.desde    - Fecha desde (YYYY-MM-DD)
 * @param {string} options.hasta    - Fecha hasta (YYYY-MM-DD)
 * @param {string} options.sucursal - Filtrar por ubicación
 * @param {Array<string>} options.tranidsRelevantes - Tranids que deben conservarse
 *   aunque su trandate quede fuera de la ventana (IFs escaneadas en el período:
 *   la fecha relevante para la confronta es la del escaneo en Sheets).
 * @param {number} options.maxRegistros - Tope de seguridad (default 5000)
 * @param {number} options.maxRelevantesRows - Tope de filas a revisar cuando hay
 *   tranids relevantes pendientes (default 3000). Los escaneos son de IFs
 *   recientes (números altos, primeras páginas), así que si un tranid relevante
 *   no aparece en ese tope, casi seguro no existe en NetSuite.
 * @returns {Promise<Array<Object>>} - Filas crudas de la búsqueda
 */
async function getIFsEsperadas({
  desde, hasta, sucursal, maxRegistros = 5000, maxRelevantesRows = 3000, tranidsRelevantes
} = {}) {
  const pageSize = 1000;
  const relevantesSet = new Set(
    (tranidsRelevantes || []).map(t => String(t).trim()).filter(Boolean)
  );
  const encontradosRelevantes = new Set();
  // Si hay tranids relevantes, acotamos la búsqueda a las filas más recientes
  // (donde siempre viven los escaneos); si no, usamos el tope normal.
  const topeRows = relevantesSet.size > 0 ? maxRelevantesRows : maxRegistros;

  let todasLasFilas = [];
  let start = 0;
  let podemosParar = false;
  let pagesFetched = 0;

  while (todasLasFilas.length < topeRows && !podemosParar) {
    const payload = {
      searchId: searchIdEnviadas,
      limit: pageSize,
      start
    };
    if (desde) payload.fromDate = desde;
    if (hasta) payload.toDate = hasta;
    if (sucursal) payload.location = sucursal;

    const response = await netsuiteClient.post(restletPath, payload);

    if (!response.data || !response.data.success) {
      throw new Error(
        `Error del RESTlet de búsqueda: ${response.data?.error || 'sin detalle'}`
      );
    }

    const filas = response.data.data || [];
    if (filas.length === 0) break;

    pagesFetched++;

    if (process.env.VERBOSE === '1' && start === 0) {
      console.log(`\n[VERBOSE] RESTlet response: success=${response.data.success}, total=${filas.length}`);
      console.log(`[VERBOSE] Primera fila cruda:`);
      console.log(JSON.stringify(filas[0], null, 2));
    }

    todasLasFilas = todasLasFilas.concat(filas);

    // Normalizar trandate para poder comparar
    const filasNormalizadas = filas.map(f => ({
      ...f,
      trandate: normalizarFechaNS(f.trandate)
    }));

    // Marcar tranids relevantes encontrados en esta página
    for (const f of filas) {
      const tranid = f.tranid != null ? String(f.tranid).trim() : null;
      if (tranid && relevantesSet.has(tranid)) encontradosRelevantes.add(tranid);
    }

    // Terminación temprana: solo por fecha si no quedan tranids relevantes
    // pendientes de localizar (si faltan, seguimos paginando hasta hallarlos).
    const faltanRelevantes = relevantesSet.size > 0
      && encontradosRelevantes.size < relevantesSet.size;

    if (desde && !faltanRelevantes) {
      const ultimaFechaPagina = filasNormalizadas[filasNormalizadas.length - 1].trandate;
      if (ultimaFechaPagina && ultimaFechaPagina < desde) {
        // Reemplazar la versión no normalizada en todasLasFilas
        todasLasFilas = todasLasFilas.map((f, i) => {
          // Las primeras start filas ya están; las nuevas vienen al final
          if (i < todasLasFilas.length - filas.length) return f;
          const norm = filasNormalizadas[i - (todasLasFilas.length - filas.length)];
          return norm;
        });
        podemosParar = true;
        if (process.env.VERBOSE === '1') {
          console.log(`[VERBOSE] Terminación temprana: última fecha ${ultimaFechaPagina} < desde ${desde}`);
        }
      }
    }

    if (filas.length < pageSize) break;
    start += pageSize;
  }

  if (process.env.VERBOSE === '1') {
    console.log(`[VERBOSE] Paginación NS: ${todasLasFilas.length} filas en ${pagesFetched} páginas`
      + (relevantesSet.size ? `, relevantes ${encontradosRelevantes.size}/${relevantesSet.size}` : ''));
  }

  // Asegurar que trandate está normalizado en todas las filas
  let filas = todasLasFilas.map(f => ({
    ...f,
    trandate: normalizarFechaNS(f.trandate)
  }));

  // Ordenar desc por fecha (defensivo: si el saved search devolvió asc, lo corregimos)
  filas.sort((a, b) => (b.trandate || '').localeCompare(a.trandate || ''));

  // Filtro en memoria (sucursal, o fechas si no se aplicó terminación temprana).
  // Los tranids relevantes SIEMPRE se conservan, aunque queden fuera de la
  // ventana de fechas o la sucursal (son globales y ya vienen de escaneos
  // filtrados por sucursal del lado de Sheets).
  if (desde || hasta || sucursal) {
    filas = filas.filter(f => {
      const tranid = f.tranid != null ? String(f.tranid).trim() : null;
      if (tranid && relevantesSet.has(tranid)) return true;
      if (desde && f.trandate && f.trandate < desde) return false;
      if (hasta && f.trandate && f.trandate > hasta) return false;
      if (sucursal) {
        const loc = typeof f.location === 'string'
          ? f.location
          : (f.location?.text || f.location?.value || '');
        if (!loc.includes(sucursal)) return false;
      }
      return true;
    });
  }

  return filas;
}

/**
 * Convierte fecha en formato DD/MM/YYYY a YYYY-MM-DD (ISO).
 * NetSuite devuelve trandate como "01/03/2024" (DD/MM/YYYY).
 * Si ya está en formato ISO, la retorna igual.
 */
function normalizarFechaNS(fecha) {
  if (!fecha) return null;
  const s = fecha.toString().trim();

  // Ya está en formato ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);

  // DD/MM/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
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
 * Normaliza una fila cruda del RESTlet al formato que espera confrontaService.
 *
 * Mapeo de campos verificado para customsearch3675 (IFs enviadas):
 *   id                       -> internalid
 *   trandate                 -> trandate (fecha, formato DD/MM/YYYY → YYYY-MM-DD)
 *   location.text / .value   -> location (ubicación de la IF)
 *   tranid                   -> tranid (IF)
 *   formulatext              -> sku (en este saved search, formulatext = SKU)
 *   inventorynumber.text     -> lotnumber (lote con medidas, ej: "65135 3.31X1.95")
 *   quantity                 -> quantity (m²)
 *
 * NOTA: la saved search no incluye la SO origen ("Creado desde") por defecto.
 * Si se agrega la columna a la saved search, se mapea automáticamente vía
 * createdfrom/creado_desde; mientras tanto, el SO se completa en la confronta
 * a partir de los escaneos de Google Sheets (campo `so`).
 */
function normalizarLineaEsperada(fila) {
  const extract = (val) => {
    if (val === null || val === undefined) return null;
    if (typeof val === 'string') return val;
    if (typeof val === 'object') return val.text || val.value || null;
    return val.toString();
  };

  // inventorynumber puede venir como objeto {value, text} o como string
  let lotnumber = null;
  if (fila.inventorynumber) {
    if (typeof fila.inventorynumber === 'string') {
      lotnumber = fila.inventorynumber;
    } else {
      lotnumber = fila.inventorynumber.text || fila.inventorynumber.value || null;
    }
  }
  // Fallback por si el campo viene con otro nombre
  if (!lotnumber) {
    lotnumber = fila.lot || fila.lotnumber || fila.numero || fila.inventorydetail;
  }

  return {
    internalid: extract(fila.id) || extract(fila.internalid),
    tranid: extract(fila.tranid),
    trandate: normalizarFechaNS(extract(fila.trandate)),
    location: extract(fila.location),
    sourceDoc: extract(fila.createdfrom) || extract(fila.createdFrom)
      || extract(fila.creado_desde) || extract(fila.so) || null,
    sku: extract(fila.formulatext), // En este saved search, formulatext = SKU
    lote: lotnumber,  // unificado: igual que el Sheets para match directo
    expectedLocation: null, // No incluido en customsearch3675
    quantity: parseFloat((fila.quantity ?? '0').toString()) || 0
  };
}

/**
 * Devuelve IFs esperadas normalizadas y agrupadas por tranid.
 *
 * @param {Object} options - Mismas opciones que getIFsEsperadas (incluye tranidsRelevantes)
 * @returns {Promise<Array<{tranid, lineas: Array, ...}>>}
 */
async function getIFsEsperadasAgrupadas({ desde, hasta, sucursal, limit, tranidsRelevantes } = {}) {
  const filas = await getIFsEsperadas({
    desde, hasta, sucursal, maxRegistros: limit, tranidsRelevantes
  });
  const normalizadas = filas.map(normalizarLineaEsperada);

  const porIF = new Map();
  for (const linea of normalizadas) {
    if (!linea.tranid) continue;

    if (!porIF.has(linea.tranid)) {
      porIF.set(linea.tranid, {
        internalid: linea.internalid,
        tranid: linea.tranid,
        trandate: linea.trandate,
        location: linea.location,
        sourceDoc: linea.sourceDoc,
        lineas: []
      });
    }
    porIF.get(linea.tranid).lineas.push(linea);
  }

  return Array.from(porIF.values());
}

module.exports = {
  getIFsEsperadas,
  getIFsEsperadasAgrupadas,
  normalizarLineaEsperada
};
