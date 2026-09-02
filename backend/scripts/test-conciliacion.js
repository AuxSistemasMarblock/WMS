const confrontaService = require('../services/confrontaService');
const { parseLote } = require('../services/loteParser');

console.log('🧪 Iniciando validación de conciliación matemática...\n');

// Caso 1: Escenario del usuario (1 cruzado, 4 huérfanos puros, 0 faltantes, 0 medias placas)
const ifsEsperadas = [
  {
    internalid: '100',
    tranid: 'IF-TEST-01',
    sourceDoc: 'SO-01',
    trandate: '2026-08-31',
    location: 'GDL',
    lineas: [
      // Se pidió 1 placa del lote A (área 6.00 m²)
      { sku: 'SKU-A', lote: 'LOTA-3.00X2.00', expectedLocation: 'GDL:01', quantity: 6.00 }
    ]
  }
];

const escaneos = [
  // 1) Cruzado: en vez de LOTA, se escaneó LOTB (mismo SKU, área 6.00 m²)
  { if_tranid: 'IF-TEST-01', sku: 'SKU-A', lote: 'LOTB-3.00X2.00', ubicacion_escaneada: 'GDL:01', operador: 'pedro', fecha: '2026-08-31' },
  
  // 2) 4 Placas Huérfanas Puras: no pedidas en la IF, no sustituyen a nada
  // Cada una mide 3.00 x 2.00 = 6.00 m² (Total: 4 x 6.00 = 24.00 m²)
  { if_tranid: 'IF-TEST-01', sku: 'SKU-EXTRA', lote: 'HUR1-3.00X2.00', ubicacion_escaneada: 'GDL:01', operador: 'pedro', fecha: '2026-08-31' },
  { if_tranid: 'IF-TEST-01', sku: 'SKU-EXTRA', lote: 'HUR2-3.00X2.00', ubicacion_escaneada: 'GDL:01', operador: 'pedro', fecha: '2026-08-31' },
  { if_tranid: 'IF-TEST-01', sku: 'SKU-EXTRA', lote: 'HUR3-3.00X2.00', ubicacion_escaneada: 'GDL:01', operador: 'pedro', fecha: '2026-08-31' },
  { if_tranid: 'IF-TEST-01', sku: 'SKU-EXTRA', lote: 'HUR4-3.00X2.00', ubicacion_escaneada: 'GDL:01', operador: 'pedro', fecha: '2026-08-31' }
];

const res = confrontaService.confrontar(ifsEsperadas, escaneos);
const k = res.kpis;

console.log('=== KPIS OBTENIDOS ===');
console.log('Total discrepancias:', k.total_discrepancias);
console.log('Desglose errores:', k.desglose_errores);
console.log('Impacto placas:', k.impacto_placas);
console.log('M2 Breakdown:', k.m2);

// Verificaciones matemáticas
let fallos = 0;

function assert(cond, mensaje) {
  if (cond) {
    console.log('  ✅ ' + mensaje);
  } else {
    console.error('  ❌ ERROR: ' + mensaje);
    fallos++;
  }
}

console.log('\n=== VERIFICACIÓN MATEMÁTICA ===');
assert(k.desglose_errores.lote_cruzado === 1, 'Lote cruzado = 1 caso');
assert(k.desglose_errores.huerfanos_puros === 4, 'Huérfanos puros = 4 casos');
assert(k.impacto_placas.huerfanos_puros === 4, 'Impacto piezas huérfanos = +4 pzs');
assert(k.m2.huerfanos === 24.00, `M2 huérfanos debe ser 24.00 m² (obtenido: ${k.m2.huerfanos} m²)`);
assert(k.m2.sobrante_puro === 24.00, `M2 sobrante puro debe ser 24.00 m² (obtenido: ${k.m2.sobrante_puro} m²)`);
assert(k.m2.desviacion_total === 24.00, `M2 desviación total debe ser 24.00 m² (obtenido: ${k.m2.desviacion_total} m²)`);
assert(k.m2.balance_neto === 24.00, `M2 balance neto debe ser +24.00 m² (obtenido: ${k.m2.balance_neto} m²)`);

// Verificación de la conciliación:
// Desviación Total = Sobrante (Sobrante Puro + Media Placa) + Faltante + |Cruzados Diff|
const sumaDesviacion = (k.m2.sobrante_puro + k.m2.media_placa) + k.m2.faltante + Math.abs(k.m2.cruzados_diff);
assert(Math.abs(k.m2.desviacion_total - sumaDesviacion) < 0.001, 'Conciliación Desviación Total es exacta');

// Balance Neto = (Sobrante + Cruzados Diff) - Faltante
const sumaBalance = (k.m2.sobrante + k.m2.cruzados_diff) - k.m2.faltante;
assert(Math.abs(k.m2.balance_neto - sumaBalance) < 0.001, 'Conciliación Balance Neto es exacto');

if (fallos === 0) {
  console.log('\n🎉 ¡TODAS LAS VALIDACIONES PASARON EXITOSAMENTE!');
} else {
  console.error(`\n🚨 Fallaron ${fallos} validaciones.`);
  process.exit(1);
}
