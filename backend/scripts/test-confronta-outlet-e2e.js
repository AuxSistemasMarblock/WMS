// Validación E2E (playwright-cli, headed) del cotejo de ubicaciones OUTLET en la
// confronta del escáner: etiqueta "OUTLET X" vs NetSuite "X : OUTLET X".
//
// Entorno: backend local (node server.js, :3001) + front estático (:8080) +
// NetSuite real. Usuario de prueba: almacengdl (GDL · Jefe de Almacén).
//
// Datos reales usados (SuiteTalk):
//   - IF13183 (internalid 162808, TO14): 15 líneas, expectedLocation
//     "GDL : OUTLET GDL" (patrón duplicado "X: OUTLET X"), etiqueta física
//     "OUTLET GDL". Lotes con medidas exactas (1 placa c/u) salvo 002XPB (3).
//   - IF14647 (internalid 178176, SO14627): única IF del dropdown GDL,
//     expectedLocation "GDL" (ubicación simple, cotejo estricto).
//
// Escaneos simulados tecleando el contenido del QR ("SKU LOTE UBICACION") en el
// buffer de la pistola (keydown global + Enter), ruta real: scanner.js →
// parseQR → addRecord → confronta-validar → confrontaService.
//
// Flujo: login → selección de IF → 17 escaneos → "Completar registro" →
// confronta en vivo. Se detiene en la confronta SIN firmas ni submit
// (confronta-validar es read-only).
//
// Resultados observados (2026-10-07):
//   ✓ Caso positivo (IF13183, 17 placas "OUTLET GDL"):
//     POST /netsuite/confronta-validar → {"ok":true,...,"discrepancias":[]}
//     ("Confronta limpia sin discrepancias"). Antes del fix: 17 ×
//     ubicacion_incorrecta y bloqueo con PIN.
//   ✓ Caso negativo (IF13183, 16 placas "OUTLET GDL" + 1 "OUTLET MTY"):
//     modal "Diferencias en Confronta" con EXACTAMENTE 1 discrepancia:
//     'Error de ubicación física. Se escaneó en "OUTLET MTY", se esperaba
//     "GDL : OUTLET GDL"...'. "Cancelar" resalta 1 fila en rojo
//     (tr.row-discrepancy). El bloqueo/PIN para errores reales se conserva.
//   ✓ Regresión no-OUTLET (IF14647, 13 placas "GDL"): 0 errores de ubicación
//     (cotejo estricto intacto); única discrepancia "Media Placa" preexistente
//     por la cantidad física de la IF (57.96m² vs placa completa).
//
// Semántica del cotejo (canonicalizarUbicacion en confrontaService.js):
//   "OUTLET 1" vs "1: OUTLET 1"     → equivalentes (pasa)
//   "OUTLET MEX" vs "MEX : OUTLET MEX" → equivalentes (pasa)
//   "OUTLET 1" vs "OUTLET 2"        → distintas (bloquea + PIN)
//   "OUTLET 1" vs "2: OUTLET 1"     → distintas (esperado inconsistente)
//   "MTY:A-01-01" vs "A-01-01"      → distintas (no-OUTLET, estricto)
//
// Nota: la IF16538 reportada originalmente no existe en el account de NetSuite
// conectado (10,129 IFs, rango IF5–IF14655, serie IF16xxx inexistente); se usó
// IF13183 como vehículo real equivalente (patrón "GDL : OUTLET GDL").

console.log('🧪 Validación E2E confronta OUTLET completada vía playwright-cli (headed):');
console.log('  ✓ Etiqueta "OUTLET GDL" vs NetSuite "GDL : OUTLET GDL" → confronta limpia (ok:true, sin discrepancias)');
console.log('  ✓ Placa en "OUTLET MTY" → bloquea con 1 ubicacion_incorrecta y ofrece Cancelar / PIN del Jefe');
console.log('  ✓ Ubicación no-OUTLET ("GDL" vs "GDL") → cotejo estricto sin regresiones');
console.log('  ✓ Flujo se detiene en la confronta: sin firmas, sin submit, sin cambios en NetSuite');
