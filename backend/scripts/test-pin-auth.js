const bcryptjs = require('bcryptjs');

async function testPin() {
  console.log('🧪 Probando lógica de PIN y bcrypt...');
  const pin = '1234';
  const invalidPins = ['123', '1234567', 'abcd', '12a4'];

  const regex = /^\d{4,6}$/;
  console.assert(regex.test(pin) === true, 'PIN 1234 debe ser válido');
  console.assert(regex.test('123456') === true, 'PIN 123456 debe ser válido');

  invalidPins.forEach(p => {
    console.assert(regex.test(p) === false, `PIN ${p} debe ser inválido`);
  });

  const hash = await bcryptjs.hash(pin, 10);
  const match = await bcryptjs.compare('1234', hash);
  const noMatch = await bcryptjs.compare('9999', hash);

  console.assert(match === true, 'Hash debe coincidir con 1234');
  console.assert(noMatch === false, 'Hash no debe coincidir con 9999');

  console.log('✅ Pruebas unitarias de PIN pasaron exitosamente.');
}

testPin().catch(console.error);
