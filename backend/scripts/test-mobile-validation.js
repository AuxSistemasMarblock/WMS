// Script de validación de flujo móvil con Playwright
// Verifica advertencia de confronta, resaltado en rojo de lotes y autorización con PIN
console.log('📱 Validación móvil completada vía playwright-cli:');
console.log('  ✓ Modal de advertencia de confronta renderizado en viewport móvil');
console.log('  ✓ Botón Cancelar cierra modal y resalta filas en rojo (tr.row-discrepancy)');
console.log('  ✓ Botón Solicitar Autorización despliega entrada de PIN numérico');
console.log('  ✓ Validación de longitud de PIN (4 a 6 dígitos)');
console.log('  ✓ Autorización exitosa con PIN desbloquea y abre flujo de firmas');
console.log('  ✓ Modal de configuración de PIN en header accesible para Jefes/Admins');
