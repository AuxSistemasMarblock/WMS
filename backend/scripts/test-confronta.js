/**
 * Script de prueba: confronta datos reales (NetSuite vs Google Sheets).
 *
 * Uso:
 *   # Confronta de un día específico
 *   FECHA=2026-08-06 node backend/scripts/test-confronta.js
 *
 *   # Confronta de un rango (semana pasada, mes pasado, etc.)
 *   DESDE=2026-07-27 HASTA=2026-08-02 node backend/scripts/test-confronta.js
 *
 *   # Filtrar por sucursal
 *   SUCURSAL=GDL node backend/scripts/test-confronta.js
 *
 *   # Limitar el detalle de IFs mostradas
 *   LIMIT=10 node backend/scripts/test-confronta.js
 *
 *   # Verbose: ver payloads crudos
 *   VERBOSE=1 node backend/scripts/test-confronta.js
 *
 *   # Modo simulate: datos sintéticos para validar lógica sin NS/Sheets
 *   SIMULATE=1 node backend/scripts/test-confronta.js
 *
 * Variables de entorno:
 *   FECHA=YYYY-MM-DD      → un día específico (default: ayer)
 *   DESDE=YYYY-MM-DD      → inicio del rango (override FECHA)
 *   HASTA=YYYY-MM-DD      → fin del rango (override FECHA)
 *   SUCURSAL=MTY          → filtrar por ubicación
 *   LIMIT=5               → cuántas IFs con error detallar
 *   VERBOSE=1             → loguear payloads crudos
 *   SIMULATE=1            → usar datos sintéticos (no llama a NS ni Sheets)
 *
 * Pre-requisitos (no aplican en modo SIMULATE):
 *   - backend/secrets/gcp-service-account.json (Service Account)
 *   - GOOGLE_SHEETS_SPREADSHEET_ID configurado
 *   - NETSUITE_* configurado (cliente RESTlet con OAuth)
 *
 * Output: log formateado en consola con resumen + detalle de IFs con error.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const netsuiteSearchService = require('../services/netsuiteSearchService');
const googleSheetsService = require('../services/googleSheetsService');
const confrontaService = require('../services/confrontaService');
const loteParser = require('../services/loteParser');

const SIMULATE = process.env.SIMULATE === '1';

// Si SIMULATE, no calculamos fechas reales
let DESDE, HASTA;
if (SIMULATE) {
  DESDE = '2026-07-27';
  HASTA = '2026-08-02';
} else if ('DESDE' in process.env || 'HASTA' in process.env) {
  DESDE = process.env.DESDE || null;
  HASTA = process.env.HASTA || null;
} else {
  // Default: ayer
  const ayer = new Date();
  ayer.setDate(ayer.getDate() - 1);
  const ayerStr = ayer.toISOString().split('T')[0];
  DESDE = process.env.FECHA !== undefined ? process.env.FECHA : ayerStr;
  HASTA = DESDE;
}

const SUCURSAL = 'SUCURSAL' in process.env ? process.env.SUCURSAL : null;
const LIMIT = parseInt(process.env.LIMIT || '5', 10);
const VERBOSE = process.env.VERBOSE === '1';

function linea(char = '─', n = 60) {
  return char.repeat(n);
}

function header(titulo) {
  console.log('\n' + linea('━'));
  console.log(`  ${titulo}`);
  console.log(linea('━'));
}

function ok(msg) { console.log(`   \x1b[32m✓\x1b[0m ${msg}`); }
function warn(msg) { console.log(`   \x1b[33m⚠\x1b[0m ${msg}`); }
function err(msg) { console.log(`   \x1b[31m✗\x1b[0m ${msg}`); }
function info(msg) { console.log(`   ${msg}`); }

async function main() {
  const rangoStr = DESDE === HASTA ? DESDE : `${DESDE} → ${HASTA}`;
  header(`🧪 TEST DE CONFRONTA — ${rangoStr}${SUCURSAL ? ` (${SUCURSAL})` : ''}${SIMULATE ? ' [SIMULATE]' : ''}`);

  // 1. Test rápido del parser de lote
  console.log('\n🔧 Test del loteParser:');
  const testsLote = [
    { lote: '15760-3.14X1.96', m2: 12.3088, esperado: 2 },
    { lote: '15760-3.14x1.96', m2: 6.1544, esperado: 1 },
    { lote: '15800-2.50X1.50', m2: 3.75, esperado: 1 },
    { lote: 'L2406-A', m2: 10, esperado: null }, // sin medidas
    { lote: '15760-3,14X1,96', m2: 12.3088, esperado: 2 } // coma decimal
  ];

  let parserOK = true;
  for (const t of testsLote) {
    const r = loteParser.placasEsperadas(t.m2, t.lote);
    const pass = r === t.esperado;
    console.log(`     ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${t.lote} + ${t.m2}m² → ${r} (esperado: ${t.esperado})`);
    if (!pass) parserOK = false;
  }
  if (!parserOK) {
    warn('Parser tiene tests fallidos. Revisar antes de continuar.');
  } else {
    ok('Parser de lote OK');
  }

  let ifsEsperadas, escaneos;

  if (SIMULATE) {
    // Modo simulate: datos sintéticos
    console.log('\n🎲 Modo SIMULATE: generando datos sintéticos...');
    const sim = generarDatosSinteticos();
    ifsEsperadas = sim.ifsEsperadas;
    escaneos = sim.escaneos;
    ok(`${ifsEsperadas.length} IFs sintéticas`);
    ok(`${escaneos.length} escaneos sintéticos`);
  } else {
    // 2. Leer headers del Sheets (diagnóstico)
    console.log('\n📋 Headers del Sheet:');
    try {
      const headers = await googleSheetsService.getHeaders();
      info(`Headers crudos: ${JSON.stringify(headers)}`);
      const normalizados = headers.map(h => googleSheetsService.normalizarHeader(h));
      info(`Normalizados:   ${JSON.stringify(normalizados)}`);
    } catch (e) {
      err(`No se pudieron leer los headers: ${e.message}`);
      return;
    }

    // 3. Obtener escaneos de Google Sheets (la ventana de fechas se aplica
    //    sobre la fecha de ESCANEO; son la fuente de verdad de lo escaneado)
    console.log('\n📥 Leyendo escaneos de Google Sheets...');
    try {
      escaneos = await googleSheetsService.getEscaneos({
        desde: DESDE,
        hasta: HASTA,
        sucursal: SUCURSAL
      });
      ok(`${escaneos.length} escaneos encontrados`);

      if (VERBOSE && escaneos.length > 0) {
        info(`Primer escaneo:`);
        console.log(JSON.stringify(escaneos[0], null, 2));
      } else if (escaneos.length === 0) {
        warn('0 escaneos. Revisa que el Sheets tenga datos para el rango.');
      }
    } catch (e) {
      err(`Error leyendo escaneos: ${e.message}`);
      if (VERBOSE) console.error(e.stack);
      return;
    }

    // 4. Obtener IFs esperadas de NetSuite (mismo flujo que el dashboard):
    //    UNA sola llamada que devuelve las IFs del período (trandate en ventana)
    //    y además conserva las IFs escaneadas cuyo trandate quedó fuera de la
    //    ventana (la fecha relevante para la confronta es la del escaneo).
    console.log('\n📥 Leyendo IFs esperadas de NetSuite...');
    try {
      const tranidsEscaneados = [...new Set(
        escaneos.map(e => e.if_tranid).filter(Boolean)
      )];
      if (tranidsEscaneados.length > 0) {
        info(`Tranids escaneados (relevantes): ${tranidsEscaneados.length}`);
      }

      ifsEsperadas = await netsuiteSearchService.getIFsEsperadasAgrupadas({
        desde: DESDE,
        hasta: HASTA,
        sucursal: SUCURSAL,
        tranidsRelevantes: tranidsEscaneados
      });
      ok(`${ifsEsperadas.length} IFs totales para confrontar`);

      if (VERBOSE && ifsEsperadas.length > 0) {
        info(`Primera IF:`);
        console.log(JSON.stringify(ifsEsperadas[0], null, 2));
      }
    } catch (e) {
      err(`Error leyendo IFs: ${e.message}`);
      if (VERBOSE) console.error(e.stack);
      return;
    }
  }

  // 5. Ejecutar confronta
  console.log('\n⚙️  Ejecutando confronta...');
  const resultado = confrontaService.confrontar(ifsEsperadas, escaneos);
  ok('Confronta completada');

  // 6. Resumen
  header('📊 RESUMEN');
  console.log(`   IFs totales:            ${resultado.ifs.length}`);
  console.log(`   IFs OK:                 ${resultado.ifs_ok.length}`);
  console.log(`   IFs con errores:        ${resultado.ifs_con_errores.length}`);
  console.log(`   IFs pendientes:         ${resultado.ifs_pendientes.length}`);
  console.log(`   Líneas totales:         ${resultado.total_lineas}`);
  console.log(`   Líneas con error:       ${resultado.lineas_con_error}`);
  console.log(`   Placas esperadas:       ${resultado.total_placas_esperadas}`);
  console.log(`   Placas escaneadas:      ${resultado.total_placas_escaneadas}`);
  console.log(`   Tasa de exactitud:      ${resultado.tasa_exactitud.toFixed(1)}%`);
  console.log(`   Total discrepancias:    ${resultado.todas_las_discrepancias.length}`);

  // 7. Detalle de IFs con error
  if (resultado.ifs_con_errores.length > 0) {
    header(`🔍 DETALLE DE IFs CON ERROR (top ${LIMIT})`);

    for (const ifDoc of resultado.ifs_con_errores.slice(0, LIMIT)) {
      console.log(`\n📦 ${ifDoc.tranid}${ifDoc.so ? ` (SO: ${ifDoc.so})` : ''}`);
      console.log(`   ${ifDoc.location ? 'Ubicación: ' + ifDoc.location : ''}${ifDoc.operador ? ' | Operador: ' + ifDoc.operador : ''}`);
      console.log(`   Discrepancias: ${ifDoc.discrepancias.length}`);

      for (const disc of ifDoc.discrepancias.slice(0, 10)) {
        const detalle = formatearDiscrepancia(disc);
        console.log(`     • [${disc.tipo}] ${detalle}`);
      }
      if (ifDoc.discrepancias.length > 10) {
        info(`     ... y ${ifDoc.discrepancias.length - 10} más`);
      }
    }
  } else {
    header('✅ SIN IFs CON ERROR');
    info('Todas las IFs del periodo confrontaron sin discrepancias.');
  }

  // 8. Top errores
  header('🏆 TOP ERRORES');

  console.log('\n   Por SKU:');
  if (resultado.top_skus.length === 0) info('(sin datos)');
  resultado.top_skus.slice(0, 5).forEach((s, i) =>
    console.log(`     ${i+1}. ${s.key} — ${s.count} errores`)
  );

  console.log('\n   Por lote:');
  if (resultado.top_lotes.length === 0) info('(sin datos)');
  resultado.top_lotes.slice(0, 5).forEach((l, i) =>
    console.log(`     ${i+1}. ${l.key} — ${l.count} errores`)
  );

  console.log('\n   Por ubicación:');
  if (resultado.top_ubicaciones.length === 0) info('(sin datos)');
  resultado.top_ubicaciones.slice(0, 5).forEach((u, i) =>
    console.log(`     ${i+1}. ${u.key} — ${u.count} errores`)
  );

  console.log('\n   Por operador:');
  if (resultado.top_operadores.length === 0) info('(sin datos)');
  resultado.top_operadores.slice(0, 5).forEach((o, i) =>
    console.log(`     ${i+1}. ${o.key} — ${o.count} errores`)
  );

  console.log('\n' + linea('━'));
  console.log('  ✅ Test completado');
  console.log(linea('━') + '\n');
}

/**
 * Genera datos sintéticos para validar la lógica de confronta
 * sin depender de NS ni Sheets.
 *
 * Casos cubiertos:
 *  - IF perfecta: SKU+lote correcto, cantidad exacta
 *  - IF con faltante: escaneadas < esperadas
 *  - IF con sobrante: escaneadas > esperadas
 *  - IF con ubicación incorrecta
 *  - IF con SKU/lote no esperado (huérfano)
 *  - IF con lote sin medidas (cantidad no se valida)
 */
function generarDatosSinteticos() {
  const ifsEsperadas = [
    {
      internalid: '1', tranid: 'IF1001', sourceDoc: 'SO50001',
      trandate: '2026-07-27', location: 'MTY',
      lineas: [
        { sku: '030LTH', lote: '26865-3.02X1.99', expectedLocation: 'MTY:A-01-01', quantity: 12.08 }, // 2 placas de 6.04 m²
        { sku: '134LTH', lote: '31090-3.26X1.8', expectedLocation: 'MTY:A-01-02', quantity: 11.74 }   // 2 placas
      ]
    },
    {
      internalid: '2', tranid: 'IF1002', sourceDoc: 'SO50002',
      trandate: '2026-07-28', location: 'GDL',
      lineas: [
        { sku: '016XPB', lote: '10150-3.23X1.92', expectedLocation: 'GDL:B-02-01', quantity: 12.40 }  // 2 placas
      ]
    },
    {
      internalid: '3', tranid: 'IF1003', sourceDoc: 'SO50003',
      trandate: '2026-07-29', location: 'MEX',
      lineas: [
        { sku: '030XPB', lote: '14362-3.00X1.94', expectedLocation: 'MEX:C-03-01', quantity: 11.64 }  // 2 placas
      ]
    },
    {
      internalid: '4', tranid: 'IF1004', sourceDoc: 'SO50004',
      trandate: '2026-07-30', location: 'MTY',
      lineas: [
        { sku: '019XPB', lote: '65135-3.31X1.95', expectedLocation: 'MTY:A-02-01', quantity: 6.45 }   // 1 placa
      ]
    }
  ];

  const escaneos = [
    // IF1001: PERFECTA (2 placas de cada SKU/lote, ubicación correcta)
    { if_tranid: 'IF1001', sku: '030LTH', lote: '26865-3.02X1.99', ubicacion_escaneada: 'MTY:A-01-01', operador: 'jperez', timestamp: '2026-07-27T10:00:00Z', fecha: '2026-07-27' },
    { if_tranid: 'IF1001', sku: '030LTH', lote: '26865-3.02X1.99', ubicacion_escaneada: 'MTY:A-01-01', operador: 'jperez', timestamp: '2026-07-27T10:00:30Z', fecha: '2026-07-27' },
    { if_tranid: 'IF1001', sku: '134LTH', lote: '31090-3.26X1.8', ubicacion_escaneada: 'MTY:A-01-02', operador: 'jperez', timestamp: '2026-07-27T10:01:00Z', fecha: '2026-07-27' },
    { if_tranid: 'IF1001', sku: '134LTH', lote: '31090-3.26X1.8', ubicacion_escaneada: 'MTY:A-01-02', operador: 'jperez', timestamp: '2026-07-27T10:01:30Z', fecha: '2026-07-27' },

    // IF1002: CON FALTANTE (1 de 2 esperadas) + UBICACIÓN INCORRECTA
    { if_tranid: 'IF1002', sku: '016XPB', lote: '10150-3.23X1.92', ubicacion_escaneada: 'GDL:B-99-99', operador: 'mgarcia', timestamp: '2026-07-28T11:00:00Z', fecha: '2026-07-28' },

    // IF1003: CON SOBRANTE (3 de 2 esperadas) + HUÉRFANO
    { if_tranid: 'IF1003', sku: '030XPB', lote: '14362-3.00X1.94', ubicacion_escaneada: 'MEX:C-03-01', operador: 'jlopez', timestamp: '2026-07-29T12:00:00Z', fecha: '2026-07-29' },
    { if_tranid: 'IF1003', sku: '030XPB', lote: '14362-3.00X1.94', ubicacion_escaneada: 'MEX:C-03-01', operador: 'jlopez', timestamp: '2026-07-29T12:00:30Z', fecha: '2026-07-29' },
    { if_tranid: 'IF1003', sku: '030XPB', lote: '14362-3.00X1.94', ubicacion_escaneada: 'MEX:C-03-01', operador: 'jlopez', timestamp: '2026-07-29T12:01:00Z', fecha: '2026-07-29' },
    { if_tranid: 'IF1003', sku: '999HUR', lote: '99999-1.00X1.00', ubicacion_escaneada: 'MEX:Z-99-99', operador: 'jlopez', timestamp: '2026-07-29T12:02:00Z', fecha: '2026-07-29' }, // huérfano

    // IF1004: LINEA_FALTANTE (ningún escaneo)

    // IF1005: NO EXISTE EN ESPERADAS → todos sus escaneos son huérfanos
    { if_tranid: 'IF1005', sku: '000ZZZ', lote: '00000-1.00X1.00', ubicacion_escaneada: 'MTY:Z-99-99', operador: 'extraño', timestamp: '2026-07-30T15:00:00Z', fecha: '2026-07-30' }
  ];

  return { ifsEsperadas, escaneos };
}

function formatearDiscrepancia(disc) {
  switch (disc.tipo) {
    case 'cantidad_faltante':
      return `${disc.sku} / ${disc.lote} → esperaba ${disc.placas_esperadas} placas, se escanearon ${disc.placas_escaneadas} (diff: -${disc.diferencia}, área por placa: ${disc.area_placa_m2}m²)`;
    case 'cantidad_sobrante':
      return `${disc.sku} / ${disc.lote} → esperaba ${disc.placas_esperadas} placas, se escanearon ${disc.placas_escaneadas} (diff: +${disc.diferencia}, área por placa: ${disc.area_placa_m2}m²)`;
    case 'ubicacion_incorrecta':
      return `${disc.sku} / ${disc.lote} → esperaba "${disc.ubicacion_esperada}", se escaneó "${disc.ubicacion_escaneada}" (${disc.escaneo_operador || 's/operador'})`;
    case 'sku_lote_no_esperado':
      return `${disc.sku} / ${disc.lote} → SKU/lote no estaba en la IF (operador: ${disc.escaneo_operador || 's/d'})`;
    case 'linea_faltante':
      return `${disc.sku} / ${disc.lote} → no se escaneó ninguna placa`;
    case 'if_no_encontrada':
      return `${disc.mensaje || 'IF escaneada pero no localizada en NetSuite'}`;
    case 'sin_medidas':
      return `${disc.sku} / ${disc.lote} → ${disc.mensaje}`;
    default:
      return JSON.stringify(disc);
  }
}

main().catch(e => {
  console.error('\n❌ Error fatal:', e.message);
  if (process.env.VERBOSE === '1') console.error(e.stack);
  process.exit(1);
});
