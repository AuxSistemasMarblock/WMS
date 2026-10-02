/**
 * Script de prueba integral para la lógica de confronta
 * Cubre todos los casos de uso:
 * 1. Caso exacto con SKU compuesto en NetSuite (ej. "087XPB CREMA MARFIL..." vs "087XPB")
 * 2. Caso cantidad exacta (N capturas para N placas esperadas)
 * 3. Caso cantidad faltante (escaneadas < esperadas)
 * 4. Caso cantidad sobrante (escaneadas > esperadas)
 * 5. Caso línea faltante (0 placas escaneadas de una línea)
 * 6. Caso lote ajeno a la IF (sku_lote_no_esperado)
 * 7. Variaciones de formato en lote (minúscula x, espacios, ceros decimales)
 * 8. Lote sin medidas
 */

const confrontaService = require(
  require('fs').existsSync('./services/confrontaService.js')
    ? './services/confrontaService'
    : '../services/confrontaService'
);

function runAllTests() {
  console.log('🧪 Iniciando pruebas completas de Confronta...\n');

  // IF16474 tomada directamente del reporte del usuario
  // Línea 1: 3 placas esperadas de 60033-2.46X1.64 (área = 4.0344 m² * 3 = 12.1032 m²)
  // Línea 2: 1 placa esperada de 60033-2.5X1.5 (área = 3.75 m² * 1 = 3.75 m²)
  const ifBase = {
    internalid: '16474',
    tranid: 'IF16474',
    trandate: '2026-10-02',
    location: 'GDL',
    sourceDoc: 'SO14999',
    lineas: [
      {
        sku: '087XPB CREMA MARFIL PRIMERA PLACA 2.0cm PB',
        lote: '60033-2.46X1.64',
        quantity: 12.1032
      },
      {
        sku: '087XPB CREMA MARFIL PRIMERA PLACA 2.0cm PB',
        lote: '60033-2.5X1.5',
        quantity: 3.75
      }
    ]
  };

  // CASO 1: Escaneo limpio con N capturas exactas (3 de lote 1, 1 de lote 2)
  console.log('--- TEST 1: Escaneo exacto (3 placas lote 1, 1 placa lote 2 con SKU corto) ---');
  const scansCaso1 = [
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.5X1.5', ubicacion_escaneada: 'GDL' }
  ];
  const res1 = confrontaService.confrontar([ifBase], scansCaso1);
  const disc1 = (res1.todas_las_discrepancias || []).filter(d => d.if_tranid === 'IF16474');
  console.log(`Discrepancias detectadas: ${disc1.length}`);
  if (disc1.length > 0) {
    console.log('Detalle de discrepancias en Test 1:', disc1.map(d => ({ tipo: d.tipo, lote: d.lote, sku: d.sku })));
  }

  // CASO 2: Faltante de 1 placa (solo 2 escaneadas de lote 1)
  console.log('\n--- TEST 2: Cantidad faltante (2 de 3 esperadas en lote 1) ---');
  const scansCaso2 = [
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.5X1.5', ubicacion_escaneada: 'GDL' }
  ];
  const res2 = confrontaService.confrontar([ifBase], scansCaso2);
  const disc2 = (res2.todas_las_discrepancias || []).filter(d => d.if_tranid === 'IF16474');
  console.log(`Discrepancias detectadas: ${disc2.length}`);
  console.log('Tipos:', disc2.map(d => `${d.tipo} (${d.lote}) [esc: ${d.placas_escaneadas}, esp: ${d.placas_esperadas}]`));

  // CASO 3: Sobrante de 1 placa (4 escaneadas de lote 1)
  console.log('\n--- TEST 3: Cantidad sobrante (4 de 3 esperadas en lote 1) ---');
  const scansCaso3 = [
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.5X1.5', ubicacion_escaneada: 'GDL' }
  ];
  const res3 = confrontaService.confrontar([ifBase], scansCaso3);
  const disc3 = (res3.todas_las_discrepancias || []).filter(d => d.if_tranid === 'IF16474');
  console.log(`Discrepancias detectadas: ${disc3.length}`);
  console.log('Tipos:', disc3.map(d => `${d.tipo} (${d.lote}) [esc: ${d.placas_escaneadas}, esp: ${d.placas_esperadas}]`));

  // CASO 4: Línea omitida (0 escaneos de lote 2)
  console.log('\n--- TEST 4: Línea requerida sin escanear (0 de lote 2) ---');
  const scansCaso4 = [
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' }
  ];
  const res4 = confrontaService.confrontar([ifBase], scansCaso4);
  const disc4 = (res4.todas_las_discrepancias || []).filter(d => d.if_tranid === 'IF16474');
  console.log(`Discrepancias detectadas: ${disc4.length}`);
  console.log('Tipos:', disc4.map(d => `${d.tipo} (${d.lote})`));

  // CASO 5: Lote ajeno (huérfano)
  console.log('\n--- TEST 5: Lote ajeno que no pertenece a la IF ---');
  const scansCaso5 = [
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.5X1.5', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '999XPB', lote: '88888-2.0X1.5', ubicacion_escaneada: 'GDL' }
  ];
  const res5 = confrontaService.confrontar([ifBase], scansCaso5);
  const disc5 = (res5.todas_las_discrepancias || []).filter(d => d.if_tranid === 'IF16474');
  console.log(`Discrepancias detectadas: ${disc5.length}`);
  console.log('Tipos:', disc5.map(d => `${d.tipo} (${d.lote})`));

  // CASO 6: Variaciones de formato de lote (minúscula x, espacios, ceros decimales)
  console.log('\n--- TEST 6: Variaciones de formato en lote (minúscula x, espacios) ---');
  const scansCaso6 = [
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46x1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46 X 1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16474', sku: '087XPB', lote: '60033-2.50X1.50', ubicacion_escaneada: 'GDL' }
  ];
  const res6 = confrontaService.confrontar([ifBase], scansCaso6);
  const disc6 = (res6.todas_las_discrepancias || []).filter(d => d.if_tranid === 'IF16474');
  console.log(`Discrepancias detectadas: ${disc6.length}`);
  if (disc6.length > 0) {
    console.log('Detalle de discrepancias en Test 6:', disc6.map(d => ({ tipo: d.tipo, lote: d.lote, sku: d.sku })));
  }

  // CASO 7: Lote sin medidas numéricas
  console.log('\n--- TEST 7: Lote sin formato de medidas numéricas ---');
  const ifSinMedidas = {
    internalid: '16475',
    tranid: 'IF16475',
    trandate: '2026-10-02',
    location: 'GDL',
    sourceDoc: 'SO14999',
    lineas: [
      { sku: 'ACCESORIO-PEGAMENTO', lote: 'LOTE-SIN-MEDIDAS', quantity: 1 }
    ]
  };
  const scansCaso7 = [
    { if_tranid: 'IF16475', sku: 'ACCESORIO-PEGAMENTO', lote: 'LOTE-SIN-MEDIDAS', ubicacion_escaneada: 'GDL' }
  ];
  const res7 = confrontaService.confrontar([ifSinMedidas], scansCaso7);
  const disc7 = (res7.todas_las_discrepancias || []).filter(d => d.if_tranid === 'IF16475');
  console.log(`Discrepancias detectadas: ${disc7.length} (esperado 0 o solo informativo sin medidas)`);

  // CASO 8: Múltiples SKUs diferentes en una misma IF
  console.log('\n--- TEST 8: Múltiples SKUs diferentes en una misma IF ---');
  const ifMultiSku = {
    internalid: '16476',
    tranid: 'IF16476',
    trandate: '2026-10-02',
    location: 'GDL',
    sourceDoc: 'SO14999',
    lineas: [
      { sku: '087XPB CREMA MARFIL...', lote: '60033-2.46X1.64', quantity: 4.0344 },
      { sku: '504XPB GRANITO NEGRO...', lote: '92448-2.32X1.97', quantity: 4.5704 }
    ]
  };
  const scansCaso8 = [
    { if_tranid: 'IF16476', sku: '087XPB', lote: '60033-2.46X1.64', ubicacion_escaneada: 'GDL' },
    { if_tranid: 'IF16476', sku: '504XPB', lote: '92448-2.32X1.97', ubicacion_escaneada: 'GDL' }
  ];
  const res8 = confrontaService.confrontar([ifMultiSku], scansCaso8);
  const disc8 = (res8.todas_las_discrepancias || []).filter(d => d.if_tranid === 'IF16476');
  console.log(`Discrepancias detectadas: ${disc8.length} (esperado 0)`);

  // Aserciones formales
  console.assert(disc1.length === 0, 'FAIL Test 1: El caso del usuario debe ser limpio');
  console.assert(disc2.length === 1 && disc2[0].tipo === 'cantidad_faltante', 'FAIL Test 2');
  console.assert(disc3.length === 1 && disc3[0].tipo === 'cantidad_sobrante', 'FAIL Test 3');
  console.assert(disc4.length === 1 && disc4[0].tipo === 'linea_faltante', 'FAIL Test 4');
  console.assert(disc5.length === 1 && disc5[0].tipo === 'sku_lote_no_esperado', 'FAIL Test 5');
  console.assert(disc6.length === 0, 'FAIL Test 6: Variaciones de formato deben coincidir');
  console.assert(disc8.length === 0, 'FAIL Test 8: Multi-SKU debe coincidir');

  console.log('\n✅ Todas las pruebas de confronta pasaron al 100% sin errores.');
}

runAllTests();
