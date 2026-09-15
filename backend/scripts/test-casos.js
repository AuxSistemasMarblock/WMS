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
// Fijar el offset de negocio para que las aserciones de fecha sean deterministas.
if (!process.env.CASOS_TZ_OFFSET) process.env.CASOS_TZ_OFFSET = '-06:00';

const casosService = require('../services/casosService');
const casosController = require('../controllers/casosController');
const dashboardController = require('../controllers/dashboardController');
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
// 4) Rango de fechas (filtros sobre columnas timestamptz)
// ============================================================

function crearMockQuery() {
  const llamadas = [];
  const q = {
    gte: (col, val) => { llamadas.push(['gte', col, val]); return q; },
    lte: (col, val) => { llamadas.push(['lte', col, val]); return q; },
    lt: (col, val) => { llamadas.push(['lt', col, val]); return q; }
  };
  return { q, llamadas };
}

function pruebasRangoFechas() {
  header('4. rangoFechas');

  check('esFechaSolo reconoce YYYY-MM-DD',
    casosService._esFechaSolo('2026-09-15') === true, 'YYYY-MM-DD');
  check('esFechaSolo rechaza fecha con hora',
    casosService._esFechaSolo('2026-09-15T10:00:00Z') === false, 'con hora');

  check('diaSiguiente 2026-09-15 -> 2026-09-16',
    casosService._diaSiguiente('2026-09-15') === '2026-09-16');
  check('diaSiguiente cruza fin de mes',
    casosService._diaSiguiente('2026-09-30') === '2026-10-01');
  check('inicioDiaUTC respeta offset -06:00 -> 06:00Z',
    casosService._inicioDiaUTC('2026-09-15') === '2026-09-15T06:00:00.000Z',
    casosService._inicioDiaUTC('2026-09-15'));

  const { q, llamadas } = crearMockQuery();
  casosService._rangoFechas(q, 'created_at', '2026-09-15', '2026-09-15');
  check('desde fecha -> gte medianoche local en UTC',
    llamadas[0][0] === 'gte' && llamadas[0][2] === '2026-09-15T06:00:00.000Z',
    JSON.stringify(llamadas[0]));
  check('hasta fecha -> lt del dia siguiente (incluye el dia completo)',
    llamadas[1][0] === 'lt' && llamadas[1][2] === '2026-09-16T06:00:00.000Z',
    JSON.stringify(llamadas[1]));

  const { q: q2, llamadas: l2 } = crearMockQuery();
  casosService._rangoFechas(q2, 'created_at', '2026-09-15T00:00:00Z', '2026-09-15T23:59:59Z');
  check('valores con hora se usan tal cual (gte/lte)',
    l2[0][0] === 'gte' && l2[0][2] === '2026-09-15T00:00:00Z' &&
    l2[1][0] === 'lte' && l2[1][2] === '2026-09-15T23:59:59Z',
    JSON.stringify(l2));
}

// ============================================================
// 5) Scope de ubicación del jefe de almacén
// ============================================================

function pruebasScopeUbicacion() {
  header('5. scope de ubicación (jefe)');

  const compartida = casosController._esUbicacionCompartida;
  check('PROYECTOS es compartida', compartida('PROYECTOS') === true);
  check('TEMPORAL es compartida', compartida('TEMPORAL') === true);
  check('"Material Transformado" es compartida', compartida('Material Transformado') === true);
  check('GDL NO es compartida', compartida('GDL') === false);
  check('OUTLET MEX NO es compartida', compartida('OUTLET MEX') === false);
  check('OUTLET GDL NO es compartida', compartida('OUTLET GDL') === false);

  const tm = casosController._tokenMatch;
  check('GDL ve GDL', tm('GDL', 'GDL') === true);
  check('GDL ve OUTLET GDL', tm('OUTLET GDL', 'GDL') === true);
  check('GDL NO ve OUTLET MEX', tm('OUTLET MEX', 'GDL') === false);
  check('GDL NO ve MEX', tm('MEX', 'GDL') === false);
  check('GDL:OUTLET ve OUTLET GDL', tm('OUTLET GDL', 'GDL:OUTLET') === true);
  check('GDL:OUTLET NO ve OUTLET MEX', tm('OUTLET MEX', 'GDL:OUTLET') === false);

  const vis = casosController._esVisibleParaUsuario;
  const jefeGDL = { user: { rol: 'jefe_almacen' } };
  check('jefe GDL ve GDL', vis(jefeGDL, 'GDL', 'GDL') === true);
  check('jefe GDL ve OUTLET GDL', vis(jefeGDL, 'OUTLET GDL', 'GDL') === true);
  check('jefe GDL NO ve OUTLET MEX', vis(jefeGDL, 'OUTLET MEX', 'GDL') === false);
  check('jefe GDL NO ve MEX', vis(jefeGDL, 'MEX', 'GDL') === false);
  check('jefe GDL ve ubicación compartida', vis(jefeGDL, 'PROYECTOS', 'GDL') === true);
  check('jefe GDL no ve sucursal nula', vis(jefeGDL, null, 'GDL') === false);

  const gerente = { user: { rol: 'gerente' } };
  check('gerente ve cualquier ubicación', vis(gerente, 'OUTLET MEX', 'GDL') === true);
  const admin = { user: { rol: 'admin' } };
  check('admin ve cualquier ubicación', vis(admin, 'OUTLET MEX', 'GDL') === true);
}

// ============================================================
// 6) Filtro por tipo de discrepancia (lote cruzado)
// ============================================================

function crearMockQueryEq() {
  const llamadas = [];
  const q = {
    eq: (col, val) => { llamadas.push(['eq', col, val]); return q; },
    gte: () => q, lte: () => q, lt: () => q
  };
  return { q, llamadas };
}

function pruebasFiltroTipo() {
  header('6. aplicarFiltroTipo');

  const { q, llamadas } = crearMockQueryEq();
  casosService._aplicarFiltroTipo(q, '');
  check('sin tipo no aplica filtros', llamadas.length === 0, JSON.stringify(llamadas));

  const { q: q2, llamadas: l2 } = crearMockQueryEq();
  casosService._aplicarFiltroTipo(q2, 'lote_cruzado');
  check('lote_cruzado -> es_cruzado = true',
    l2.length === 1 && l2[0][1] === 'es_cruzado' && l2[0][2] === true, JSON.stringify(l2));

  const { q: q3, llamadas: l3 } = crearMockQueryEq();
  casosService._aplicarFiltroTipo(q3, 'linea_faltante');
  check('linea_faltante -> tipo = X y es_cruzado = false',
    l3.length === 2 && l3[0][1] === 'tipo' && l3[0][2] === 'linea_faltante' &&
    l3[1][1] === 'es_cruzado' && l3[1][2] === false, JSON.stringify(l3));
}

// ============================================================
// 7) KPIs: discrepancias justificadas cuentan como OK
// ============================================================

function discTest(justificada, tipo = 'linea_faltante') {
  return {
    tipo,
    es_cruzado: false,
    placas_esperadas: 2,
    placas_escaneadas: 0,
    diferencia: 2,
    cantidad_m2_esperada: 6,
    diff_m2: 6,
    justificacion: { estado: justificada ? 'justificada' : 'abierta' }
  };
}

function casoTestConDiscs(discs) {
  const ifDoc = { lineas_con_error: 1, discrepancias: discs };
  return {
    ifs_ok: [],
    ifs_con_errores: [ifDoc],
    ifs_canceladas_erp: [],
    placas_en_ifs_canceladas: 0,
    total_lineas: 3,
    lineas_con_error: 1,
    total_placas_esperadas: 10,
    total_placas_escaneadas: 10,
    todas_las_discrepancias: discs
  };
}

function pruebasKPIsJustificadas() {
  header('7. KPIs: justificadas como OK');

  const r1 = casoTestConDiscs([discTest(true)]);
  dashboardController._calcularKPIsConJustificadas(r1);
  check('justificada => 0 discrepancias de error', r1.kpis.total_discrepancias === 0, String(r1.kpis.total_discrepancias));
  check('justificada => desviacion m2 = 0', r1.kpis.m2.desviacion_total === 0, String(r1.kpis.m2.desviacion_total));
  check('IF totalmente justificado => ifs_ok 1',
    r1.kpis.ifs_ok === 1 && r1.kpis.ifs_con_errores === 0,
    JSON.stringify({ ok: r1.kpis.ifs_ok, err: r1.kpis.ifs_con_errores }));
  check('tasa de exactitud 100', r1.kpis.tasa_exactitud === 100, String(r1.kpis.tasa_exactitud));

  dashboardController._calcularKPIsConJustificadas(r1);
  check('recalculo idempotente', r1.kpis.ifs_ok === 1 && r1.kpis.total_discrepancias === 0,
    JSON.stringify({ ok: r1.kpis.ifs_ok, disc: r1.kpis.total_discrepancias }));

  const r2 = casoTestConDiscs([discTest(true), discTest(false)]);
  dashboardController._calcularKPIsConJustificadas(r2);
  check('mezcla => 1 error vigente', r2.kpis.total_discrepancias === 1, String(r2.kpis.total_discrepancias));
  check('mezcla => IF sigue con error',
    r2.kpis.ifs_con_errores === 1 && r2.kpis.ifs_ok === 0,
    JSON.stringify({ ok: r2.kpis.ifs_ok, err: r2.kpis.ifs_con_errores }));
  check('mezcla => desviacion m2 solo del error vigente',
    r2.kpis.m2.faltante === 6, String(r2.kpis.m2.faltante));
}

// ============================================================
// 8) Prueba en vivo (opcional)
// ============================================================

async function pruebaEnVivo() {
  header('8. PRUEBA EN VIVO (crear_caso + limpieza)');

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

    check('folio con formato YYYY-NNNN',
      /^\d{4}-\d{4}$/.test(caso.folio || ''), String(caso.folio));
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
  pruebasRangoFechas();
  pruebasScopeUbicacion();
  pruebasFiltroTipo();
  pruebasKPIsJustificadas();

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
