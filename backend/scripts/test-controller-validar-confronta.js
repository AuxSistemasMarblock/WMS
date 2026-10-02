/**
 * Test directo para validarConfronta en netsuiteController
 */
const basePath = require('fs').existsSync('./controllers/netsuiteController.js') ? '.' : '..';
const { validarConfronta } = require(`${basePath}/controllers/netsuiteController`);
const netsuiteFulfillmentService = require(`${basePath}/services/netsuiteFulfillmentService`);

async function testValidarConfrontaController() {
  console.log('🧪 Probando validarConfronta controller...');

  // Mockeamos getIFEsperadaPorId para simular la respuesta de NetSuite de IF16474
  const originalGetIF = netsuiteFulfillmentService.getIFEsperadaPorId;
  const originalResolverId = netsuiteFulfillmentService.resolverInternalIdPorTranid;

  netsuiteFulfillmentService.resolverInternalIdPorTranid = async (tranid) => '16474';
  netsuiteFulfillmentService.getIFEsperadaPorId = async (id, tranid) => ({
    internalid: '16474',
    tranid: 'IF16474',
    trandate: '2026-10-02',
    location: 'GDL',
    sourceDoc: 'SO14999',
    lineas: [
      {
        sku: '087XPB',
        lote: '60033-2.46X1.64',
        quantity: 12.1032
      },
      {
        sku: '087XPB',
        lote: '60033-2.5X1.5',
        quantity: 3.75
      }
    ]
  });

  try {
    // 1. Caso limpio: 3 placas de lote 1 y 1 placa de lote 2
    let responseStatus = null;
    let responseBody = null;

    const reqLimpio = {
      body: {
        ifTranid: 'IF16474',
        ifInternalId: '16474',
        items: [
          { sku: '087XPB', lote: '60033-2.46X1.64', ubicacion: 'GDL' },
          { sku: '087XPB', lote: '60033-2.46X1.64', ubicacion: 'GDL' },
          { sku: '087XPB', lote: '60033-2.46X1.64', ubicacion: 'GDL' },
          { sku: '087XPB', lote: '60033-2.5X1.5', ubicacion: 'GDL' }
        ]
      },
      user: { id: 1, nombre: 'Kevin Mendoza', ubicacion_id: 1 }
    };

    const resLimpio = {
      status(code) { responseStatus = code; return this; },
      json(data) { responseBody = data; return this; }
    };

    await validarConfronta(reqLimpio, resLimpio);
    console.log('Resultado caso limpio:', responseBody);
    console.assert(responseBody.ok === true, 'Caso limpio debe ser ok: true');
    console.assert(responseBody.discrepancias.length === 0, 'Caso limpio no debe tener discrepancias');
    console.log('✓ Caso limpio pasó exitosamente');

    // 2. Caso con faltante: solo 2 placas de lote 1
    const reqFaltante = {
      body: {
        ifTranid: 'IF16474',
        ifInternalId: '16474',
        items: [
          { sku: '087XPB', lote: '60033-2.46X1.64', ubicacion: 'GDL' },
          { sku: '087XPB', lote: '60033-2.46X1.64', ubicacion: 'GDL' },
          { sku: '087XPB', lote: '60033-2.5X1.5', ubicacion: 'GDL' }
        ]
      },
      user: { id: 1, nombre: 'Kevin Mendoza', ubicacion_id: 1 }
    };

    let resFaltanteBody = null;
    const resFaltante = {
      status(code) { return this; },
      json(data) { resFaltanteBody = data; return this; }
    };

    await validarConfronta(reqFaltante, resFaltante);
    console.log('Resultado caso faltante:', resFaltanteBody);
    console.assert(resFaltanteBody.ok === false, 'Caso faltante debe ser ok: false');
    console.assert(resFaltanteBody.discrepancias.length === 1, 'Debe haber 1 discrepancia');
    console.assert(resFaltanteBody.discrepancias[0].tipo === 'cantidad_faltante', 'Debe ser cantidad_faltante');
    console.log('✓ Caso faltante pasó exitosamente');

    console.log('\n✅ Todas las pruebas de validarConfronta pasaron.');
  } finally {
    netsuiteFulfillmentService.getIFEsperadaPorId = originalGetIF;
    netsuiteFulfillmentService.resolverInternalIdPorTranid = originalResolverId;
  }
}

testValidarConfrontaController().catch(err => {
  console.error('Error en pruebas de controller:', err);
  process.exit(1);
});
