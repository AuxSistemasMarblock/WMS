const confrontaService = require('../services/confrontaService');

function testConfrontaLogic() {
  console.log('🧪 Probando lógica de confronta para validación de escáner...');

  const ifEsperada = {
    internalid: '12345',
    tranid: 'IF12345',
    trandate: '2026-09-30',
    location: 'GDL',
    sourceDoc: 'SO9999',
    lineas: [
      {
        sku: 'GRANITO-NEGRO',
        lote: 'LOTE-OK 2.80X1.80',
        quantity: 5.04 // ~1 placa de 2.80x1.80 = 5.04m²
      }
    ]
  };

  // Caso 1: Escaneo limpio (coincide SKU y Lote)
  const escaneosLimpios = [
    {
      if_tranid: 'IF12345',
      sku: 'GRANITO-NEGRO',
      lote: 'LOTE-OK 2.80X1.80',
      ubicacion_escaneada: 'GDL'
    }
  ];

  const resLimpio = confrontaService.confrontar([ifEsperada], escaneosLimpios);
  const discLimpias = (resLimpio.todas_las_discrepancias || []).filter(d => d.if_tranid === 'IF12345');
  console.assert(discLimpias.length === 0, 'Caso limpio no debe generar discrepancias');
  console.log('  ✓ Caso limpio: sin discrepancias');

  // Caso 2: Escaneo erróneo (lote no esperado / ajeno a la IF)
  const escaneosConError = [
    {
      if_tranid: 'IF12345',
      sku: 'GRANITO-NEGRO',
      lote: 'LOTE-EQUIVOCADO 2.80X1.80',
      ubicacion_escaneada: 'GDL'
    }
  ];

  const resError = confrontaService.confrontar([ifEsperada], escaneosConError);
  const discError = (resError.todas_las_discrepancias || []).filter(d => d.if_tranid === 'IF12345');
  console.assert(discError.length > 0, 'Debe detectar discrepancias para lote erróneo');
  
  const tieneHuerfano = discError.some(d => d.lote === 'LOTE-EQUIVOCADO 2.80X1.80');
  console.assert(tieneHuerfano === true, 'Debe identificar el lote equivocado');
  console.log(`  ✓ Caso erróneo: detectó ${discError.length} discrepancia(s) para lote equivocado`);

  console.log('✅ Pruebas de lógica de confronta para escáner pasaron exitosamente.');
}

testConfrontaLogic();
