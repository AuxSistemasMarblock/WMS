/**
 * Prueba del gestor de casos (backend/services/casosService.js).
 *
 * Uso:
 *   # Solo pruebas unitarias (no toca la BD)
 *   node backend/scripts/test-casos.js
 *
 *   # Unitarias + flujo en vivo contra Supabase (requiere credenciales)
 *   LIVE=1 node backend/scripts/test-casos.js
 *
 * Variables de entorno:
 *   LIVE=1                       → habilita la prueba en vivo
 *   SUPABASE_URL                 → URL del proyecto Supabase
 *   SUPABASE_SERVICE_ROLE_KEY    → service role key (bypassa RLS)
 *
 * La prueba en vivo crea una discrepancia temporal, ejecuta la RPC
 * public.crear_caso(...) y valida el flujo completo; SIEMPRE limpia los datos
 * de prueba en un bloque finally. Si faltan credenciales o LIVE != 1, se omite
 * sin fallar (imprime "SKIP live test").
 *
 * Exit code != 0 si alguna verificación falla.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const LIVE = process.env.LIVE === '1';
// Detectar credenciales reales ANTES de inyectar placeholders para el modo unit.
const HAS_ENV = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

// backend/config/supabase.js construye el cliente al cargarse y exige URL + key.
// El modo unit no toca la BD: si no hay credenciales, se usan placeholders para
// permitir el require; las pruebas unitarias mockean `supabase`.
if (!process.env.SUPABASE_URL) process.env.SUPABASE_URL = 'http://localhost:54321';
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-placeholder';

const casosService = require('../services/casosService');
const supabase = require('../config/supabase');

// ============================================================
// Mini framework de asserts
// ============================================================

let passed = 0;
let failed = 0;
const fallos = [];

function check(nombre, cond, detalle) {
  if (cond) {
    console.log(`   \x1b[32mPASS\x1b[0m  ${nombre}`);
    passed++;
  } else {
    console.log(`   \x1b[31mFAIL\x1b[0m  ${nombre}${detalle ? `  →  ${detalle}` : ''}`);
    failed++;
    fallos.push(nombre);
  }
}

function linea(char = '─', n = 62) {
  return char.repeat(n);
}

function header(titulo) {
  console.log('\n' + linea('━'));
  console.log(`  ${titulo}`);
  console.log(linea('━'));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ============================================================
// 1) Pruebas unitarias (siempre)
// ============================================================

function pruebasFingerprint() {
  header('1. calcularFingerprint');

  const base = {
    tipo: 'cantidad_faltante',
    if_tranid: 'IF1001',
    sku: 'SKU-A',
    lote: 'LOTE-1',
    sucursal: 'MTY'
  };

  const h = casosService.calcularFingerprint(base);

  check('mismo input produce el mismo hash',
    h === casosService.calcularFingerprint({ ...base }));

  check('hash es 64 hex',
    /^[0-9a-f]{64}$/.test(h), String(h));

  for (const campo of ['tipo', 'if_tranid', 'sku', 'lote', 'sucursal']) {
    const otro = casosService.calcularFingerprint({ ...base, [campo]: `${base[campo]}-X` });
    check(`cambia si cambia "${campo}"`, otro !== h);
  }

  check('null devuelve null', casosService.calcularFingerprint(null) === null);
  check('undefined devuelve null', casosService.calcularFingerprint(undefined) === null);
  check('no-objeto devuelve null', casosService.calcularFingerprint('nope') === null);

  const conNulos = casosService.calcularFingerprint({
    tipo: 'linea_faltante', if_tranid: null, sku: undefined, lote: '', sucursal: null
  });
  check('campos null/undefined no revientan', /^[0-9a-f]{64}$/.test(conNulos), String(conNulos));

  check('null y "" normalizan igual (no "null"/"undefined")',
    casosService.calcularFingerprint({ tipo: 'x', if_tranid: null, sku: '', lote: null, sucursal: '' }) ===
    casosService.calcularFingerprint({ tipo: 'x', if_tranid: undefined, sku: '', lote: '', sucursal: null }));
}

function pruebasConstruirFila() {
  header('2. _construirFila');

  const disc = {
    tipo: 'cantidad_faltante',
    if_tranid: 'IF1001',
    if_id: '123',
    if_so: 'SO-1',
    sku: 'SKU-A',
    lote: 'LOTE-1',
    sucursal: 'MTY',
    if_fecha: '2026-08-01',
    placas_esperadas: 2,
    placas_escaneadas: 1,
    area_placa_m2: 3.14,
    diferencia: -1
  };
  const ahora = new Date().toISOString();
  const fila = casosService._construirFila(disc, ahora);

  check('fila NO incluye estado', !('estado' in fila));
  check('fila NO incluye caso_id', !('caso_id' in fila));
  check('fila NO incluye primera_vista', !('primera_vista' in fila));
  check('fila NO incluye created_at', !('created_at' in fila));

  check('fingerprint coincide con calcularFingerprint(discrepancia+sucursal)',
    fila.fingerprint === casosService.calcularFingerprint({ ...disc, sucursal: disc.sucursal }),
    fila.fingerprint);

  check('ultima_vista == ahora', fila.ultima_vista === ahora);
  check('m2_escaneados calculado desde placas * área',
    Number(fila.m2_escaneados) === Number((1 * 3.14).toFixed(2)), String(fila.m2_escaneados));

  const conLocation = { ...disc, sucursal: undefined, if_location: 'GDL' };
  const filaLocation = casosService._construirFila(conLocation, ahora);
  check('usa if_location como sucursal cuando falta sucursal',
    filaLocation.fingerprint === casosService.calcularFingerprint({ ...disc, sucursal: 'GDL' }),
    filaLocation.fingerprint);

  // Medias placas: la confronta produce fracciones (p. ej. 2.5) que NO deben
  // redondearse; el sync fallaba al insertarlas en columnas int.
  const filaMedia = casosService._construirFila(
    { ...disc, placas_esperadas: 2.5, placas_escaneadas: 3, diferencia: 0.5 }, ahora);
  check('preserva placas fraccionarias (medias placas)',
    Number(filaMedia.placas_esperadas) === 2.5 && Number(filaMedia.diferencia) === 0.5,
    `${filaMedia.placas_esperadas} / ${filaMedia.diferencia}`);

  check('_construirFila(null) devuelve null', casosService._construirFila(null, ahora) === null);
}

// Mock mínimo del query builder de supabase:
//   supabase.from(tabla).select(cols).in(col, vals) -> Promise<{data, error}>
function crearMock(respuestas, registro) {
  return {
    from(tabla) {
      return {
        select(columnas) {
          registro.push({ tabla, op: 'select', columnas });
          return {
            in(columna, valores) {
              registro.push({ tabla, op: 'in', columna, valores });
              return Promise.resolve(respuestas[tabla] || { data: [], error: null });
            }
          };
        }
      };
    }
  };
}

async function pruebasAnotarDiscrepancias() {
  header('3. anotarDiscrepancias (mock supabase)');

  const discA = { tipo: 'cantidad_faltante', if_tranid: 'IF-A', sku: 'A', lote: 'LA', sucursal: 'MTY' };
  const discB = { tipo: 'cantidad_sobrante', if_tranid: 'IF-B', sku: 'B', lote: 'LB', sucursal: 'GDL' };
  const discC = { tipo: 'linea_faltante', if_tranid: 'IF-C', sku: 'C', lote: 'LC', sucursal: 'MEX' };
  const discD = { ...discA }; // mismo fingerprint que discA → debe deduplicar

  const fpA = casosService.calcularFingerprint(discA);
  const fpB = casosService.calcularFingerprint(discB);
  const fpC = casosService.calcularFingerprint(discC);

  const respuestas = {
    discrepancias: {
      data: [
        { fingerprint: fpA, estado: 'en_revision', caso_id: 10 },
        { fingerprint: fpB, estado: 'justificada', caso_id: 11 }
      ],
      error: null
    },
    casos: {
      data: [
        { id: 10, folio: 'CASO-2026-0001', tipo_justificacion_id: 7 },
        { id: 11, folio: 'CASO-2026-0002', tipo_justificacion_id: 3 }
      ],
      error: null
    }
  };

  const registro = [];
  const mock = crearMock(respuestas, registro);
  const originalFrom = supabase.from;
  const items = [discA, discB, discC, discD];

  try {
    supabase.from = mock.from;
    await casosService.anotarDiscrepancias(items);
  } finally {
    supabase.from = originalFrom;
  }

  const esperadoA = { estado: 'en_revision', caso_id: 10, folio: 'CASO-2026-0001', tipo: 7 };
  const esperadoB = { estado: 'justificada', caso_id: 11, folio: 'CASO-2026-0002', tipo: 3 };

  check('mapea {estado, caso_id, folio, tipo} de discA',
    deepEqual(items[0].justificacion, esperadoA), JSON.stringify(items[0].justificacion));
  check('mapea {estado, caso_id, folio, tipo} de discB',
    deepEqual(items[1].justificacion, esperadoB), JSON.stringify(items[1].justificacion));
  check('sin fila en BD → justificacion null', items[2].justificacion === null);
  check('fingerprint duplicado comparte justificación (dedupe)',
    deepEqual(items[3].justificacion, esperadoA), JSON.stringify(items[3].justificacion));

  const inDisc = registro.filter(r => r.tabla === 'discrepancias' && r.op === 'in');
  const inCasos = registro.filter(r => r.tabla === 'casos' && r.op === 'in');
  const selects = registro.filter(r => r.op === 'select');

  check('una sola query a discrepancias (sin N+1)', inDisc.length === 1, `queries=${inDisc.length}`);
  check('una sola query a casos (sin N+1)', inCasos.length === 1, `queries=${inCasos.length}`);
  check('total 2 queries en lote', selects.length === 2, `selects=${selects.length}`);
  check('fingerprints deduplicados en el IN (3 únicos, no 4)',
    inDisc.length === 1 && inDisc[0].valores.length === 3, String(inDisc[0] && inDisc[0].valores.length));
  check('el IN incluye los fingerprints correctos',
    inDisc.length === 1 && [fpA, fpB, fpC].every(fp => inDisc[0].valores.includes(fp)));

  // Lista vacía: no debe consultar la BD.
  const registroVacio = [];
  const mockVacio = crearMock({}, registroVacio);
  const originalFrom2 = supabase.from;
  let resultadoVacio;
  try {
    supabase.from = mockVacio.from;
    resultadoVacio = await casosService.anotarDiscrepancias([]);
  } finally {
    supabase.from = originalFrom2;
  }
  check('lista vacía no consulta la BD', registroVacio.length === 0 && Array.isArray(resultadoVacio));
}

// ============================================================
// 2) Prueba en vivo (opcional)
// ============================================================

async function pruebaEnVivo() {
  header('4. PRUEBA EN VIVO (crear_caso + limpieza)');

  const marca = `test-casos-${Date.now()}`;
  let discId = null;
  let casoId = null;

  try {
    // Tipo de justificación activo 'otro'.
    const { data: tipo, error: tipoError } = await supabase
      .from('tipos_justificacion')
      .select('id, clave, nombre')
      .eq('clave', 'otro')
      .eq('activo', true)
      .maybeSingle();

    check('tipo de justificación activo "otro" disponible',
      !tipoError && !!tipo, tipoError && tipoError.message);
    if (!tipo) throw new Error('no se encontró el tipo de justificación "otro" activo');

    // 1) Discrepancia temporal (fingerprint único, estado 'abierta').
    const { data: disc, error: discError } = await supabase
      .from('discrepancias')
      .insert({
        fingerprint: marca,
        tipo: 'cantidad_faltante',
        if_tranid: marca,
        sku: 'TEST-SKU',
        lote: 'TEST-LOTE',
        sucursal: 'TEST',
        if_fecha: new Date().toISOString().split('T')[0],
        estado: 'abierta'
      })
      .select('*')
      .single();

    check('discrepancia temporal insertada', !discError && !!disc, discError && discError.message);
    if (!disc) throw new Error('no se pudo insertar la discrepancia temporal');
    discId = disc.id;

    // 2) RPC transaccional crear_caso.
    const { data: caso, error: rpcError } = await supabase.rpc('crear_caso', {
      p_discrepancia_ids: [discId],
      p_tipo_justificacion_id: tipo.id,
      p_justificacion: `Prueba automatizada ${marca}`,
      p_ubicacion_id: null,
      p_sucursal: null,
      p_creado_por: null
    });

    check('rpc crear_caso sin error', !rpcError && !!caso, rpcError && rpcError.message);
    if (!caso) throw new Error('la RPC crear_caso no devolvió caso');
    casoId = caso.id;

    check('folio con formato CASO-YYYY-NNNN',
      /^CASO-\d{4}-\d{4}$/.test(caso.folio || ''), String(caso.folio));
    check('estado del caso es "pendiente_aprobacion"',
      caso.estado === 'pendiente_aprobacion', String(caso.estado));

    // 3) Discrepancia marcada en_revision y asociada al caso.
    const { data: discFinal, error: discFinalError } = await supabase
      .from('discrepancias')
      .select('estado, caso_id')
      .eq('id', discId)
      .single();

    check('discrepancia quedó "en_revision"',
      !discFinalError && discFinal && discFinal.estado === 'en_revision',
      (discFinalError && discFinalError.message) || String(discFinal && discFinal.estado));
    check('discrepancia tiene caso_id asignado',
      !!discFinal && discFinal.caso_id === casoId, String(discFinal && discFinal.caso_id));

    // 4) Bitácora: exactamente 2 eventos.
    const { data: eventos, error: eventosError } = await supabase
      .from('caso_eventos')
      .select('evento')
      .eq('caso_id', casoId);

    const nombres = new Set((eventos || []).map(e => e.evento));
    check('existen 2 eventos para el caso',
      !eventosError && (eventos || []).length === 2,
      (eventosError && eventosError.message) || String((eventos || []).length));
    check('evento "caso_creado" presente', nombres.has('caso_creado'));
    check('evento "justificacion_enviada" presente', nombres.has('justificacion_enviada'));
  } finally {
    // LIMPIEZA OBLIGATORIA: nunca dejar data de prueba.
    try {
      if (casoId != null) {
        const { error } = await supabase.from('caso_eventos').delete().eq('caso_id', casoId);
        if (error) console.error('   limpieza caso_eventos error:', error.message);
      }
    } catch (e) { console.error('   limpieza caso_eventos excepción:', e.message); }

    try {
      if (discId != null) {
        const { error } = await supabase.from('discrepancias').delete().eq('id', discId);
        if (error) console.error('   limpieza discrepancias error:', error.message);
      } else {
        const { error } = await supabase.from('discrepancias').delete().eq('fingerprint', marca);
        if (error) console.error('   limpieza discrepancias error:', error.message);
      }
    } catch (e) { console.error('   limpieza discrepancias excepción:', e.message); }

    try {
      if (casoId != null) {
        const { error } = await supabase.from('casos').delete().eq('id', casoId);
        if (error) console.error('   limpieza casos error:', error.message);
      }
    } catch (e) { console.error('   limpieza casos excepción:', e.message); }

    // Verificación de limpieza: 0 filas de prueba.
    const { count: residuoDisc } = await supabase
      .from('discrepancias')
      .select('id', { count: 'exact', head: true })
      .eq('fingerprint', marca);

    let residuoCaso = 0;
    let residuoEventos = 0;
    if (casoId != null) {
      const { count: c } = await supabase
        .from('casos')
        .select('id', { count: 'exact', head: true })
        .eq('id', casoId);
      residuoCaso = c || 0;

      const { count: ev } = await supabase
        .from('caso_eventos')
        .select('id', { count: 'exact', head: true })
        .eq('caso_id', casoId);
      residuoEventos = ev || 0;
    }

    check('limpieza: 0 discrepancias de prueba', (residuoDisc || 0) === 0, String(residuoDisc));
    check('limpieza: 0 eventos de prueba', residuoEventos === 0, String(residuoEventos));
    check('limpieza: 0 casos de prueba', residuoCaso === 0, String(residuoCaso));

    console.log(`   Filas de prueba restantes → discrepancias=${residuoDisc || 0}, eventos=${residuoEventos}, casos=${residuoCaso}`);
  }
}

// ============================================================
// Runner
// ============================================================

async function main() {
  console.log('🧪 TEST DEL GESTOR DE CASOS');
  console.log(`   Modo: unitarias${LIVE ? ' + en vivo' : ''}`);
  console.log(`   LIVE=${LIVE}  credenciales=${HAS_ENV ? 'sí' : 'no'}`);

  pruebasFingerprint();
  pruebasConstruirFila();
  await pruebasAnotarDiscrepancias();

  if (LIVE && HAS_ENV) {
    await pruebaEnVivo();
  } else if (LIVE && !HAS_ENV) {
    console.log('\nSKIP live test (LIVE=1 pero faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  } else {
    console.log('\nSKIP live test (LIVE!=1)');
  }

  header('RESUMEN');
  console.log(`   PASS: ${passed}`);
  console.log(`   FAIL: ${failed}`);
  if (failed > 0) {
    console.log('   Fallos:');
    for (const f of fallos) console.log(`     - ${f}`);
  }

  if (failed === 0) {
    console.log('\n✅ Todas las verificaciones pasaron.');
    process.exit(0);
  } else {
    console.log('\n❌ Hubo verificaciones fallidas.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\n❌ Error fatal:', e.message);
  if (process.env.VERBOSE === '1') console.error(e.stack);
  process.exit(1);
});
