/**
 * Servicio de confronta: cruza IFs esperadas (NetSuite) contra escaneos (Sheets).
 *
 * Reglas de negocio:
 *   - Clave de match: (if_tranid, sku, lote)
 *   - m² → placas: Math.round(cantidad_m2 / (largo * ancho))
 *     Ver loteParser.js
 *   - Lote sin medidas: se omite validación de cantidad, se mantienen
 *     las validaciones de sku/lote/ubicación
 *   - Tipos de discrepancia:
 *     * cantidad_faltante: escaneadas < esperadas
 *     * cantidad_sobrante:  escaneadas > esperadas
 *     * ubicacion_incorrecta: algún escaneo tiene ubicación distinta
 *     * sku_lote_no_esperado: se escaneó sku/lote que no estaba en la IF
 *     * linea_faltante: no se escaneó nada de esa línea
 *
 * Output: estructura agregada lista para el dashboard.
 */

const { parseLote, evaluarCantidad } = require('./loteParser');

/**
 * Agrupa los escaneos por (if_tranid, sku, lote)
 */
function agruparEscaneos(escaneos) {
  const grupos = new Map();
  for (const e of escaneos) {
    if (!e.if_tranid || !e.sku || !e.lote) continue;
    const key = `${e.if_tranid}|${e.sku}|${e.lote}`;
    if (!grupos.has(key)) grupos.set(key, []);
    grupos.get(key).push(e);
  }
  return grupos;
}

/**
 * Evalúa una línea esperada contra sus escaneos.
 * Devuelve el objeto de línea con discrepancias.
 * @param {string} ifTranid - tranid de la IF dueña (para adjuntar a cada discrepancia)
 * @param {string} ifSo     - SO origen de la IF
 * @param {string} ifLocation - ubicación de la IF
 * @param {string} ifFecha  - fecha de la IF (trandate)
 */
function evaluarLinea(ifTranid, ifSo, ifLocation, ifFecha, lineaEsperada, escaneosDeEstaLinea) {
  const discrepancias = [];
  const cantEscaneada = escaneosDeEstaLinea.length;

  if (cantEscaneada === 0) {
    discrepancias.push({
      tipo: 'linea_faltante',
      sku: lineaEsperada.sku,
      lote: lineaEsperada.lote,
      mensaje: 'No se escaneó ninguna placa de este item',
      if_tranid: ifTranid,
      if_so: ifSo,
      if_location: ifLocation,
      if_fecha: ifFecha
    });
    return {
      ...lineaEsperada,
      placas_escaneadas: 0,
      escaneos: [],
      discrepancias,
      status: 'faltante'
    };
  }

  // Evaluar cantidad (usa loteParser)
  const evalCantidad = evaluarCantidad(
    lineaEsperada.quantity,
    lineaEsperada.lote,
    cantEscaneada
  );

  if (evalCantidad.status === 'sin_medidas') {
    discrepancias.push({
      tipo: 'sin_medidas',
      sku: lineaEsperada.sku,
      lote: lineaEsperada.lote,
      mensaje: evalCantidad.mensaje,
      if_tranid: ifTranid,
      if_so: ifSo,
      if_location: ifLocation,
      if_fecha: ifFecha
    });
  } else if (evalCantidad.status === 'faltante') {
    discrepancias.push({
      tipo: 'cantidad_faltante',
      sku: lineaEsperada.sku,
      lote: lineaEsperada.lote,
      placas_esperadas: evalCantidad.placas_esperadas,
      placas_escaneadas: evalCantidad.placas_escaneadas,
      diferencia: evalCantidad.diferencia,
      cantidad_m2_esperada: lineaEsperada.quantity,
      area_placa_m2: evalCantidad.area_placa_m2,
      id_lote: evalCantidad.id_lote,
      if_tranid: ifTranid,
      if_so: ifSo,
      if_location: ifLocation,
      if_fecha: ifFecha
    });
  } else if (evalCantidad.status === 'sobrante') {
    discrepancias.push({
      tipo: 'cantidad_sobrante',
      sku: lineaEsperada.sku,
      lote: lineaEsperada.lote,
      placas_esperadas: evalCantidad.placas_esperadas,
      placas_escaneadas: evalCantidad.placas_escaneadas,
      diferencia: evalCantidad.diferencia,
      cantidad_m2_esperada: lineaEsperada.quantity,
      area_placa_m2: evalCantidad.area_placa_m2,
      id_lote: evalCantidad.id_lote,
      if_tranid: ifTranid,
      if_so: ifSo,
      if_location: ifLocation,
      if_fecha: ifFecha
    });
  }

  // Validar ubicación de cada escaneo
  const ubicacionEsperada = lineaEsperada.expectedLocation;
  for (const esc of escaneosDeEstaLinea) {
    if (ubicacionEsperada && esc.ubicacion_escaneada
        && esc.ubicacion_escaneada !== ubicacionEsperada) {
      discrepancias.push({
        tipo: 'ubicacion_incorrecta',
        sku: esc.sku,
        lote: esc.lote,
        ubicacion_esperada: ubicacionEsperada,
        ubicacion_escaneada: esc.ubicacion_escaneada,
        escaneo_timestamp: esc.timestamp,
        escaneo_operador: esc.operador,
        if_tranid: ifTranid,
        if_so: ifSo,
        if_location: ifLocation,
        if_fecha: ifFecha
      });
    }
  }

  return {
    ...lineaEsperada,
    placas_escaneadas: cantEscaneada,
    escaneos: escaneosDeEstaLinea,
    discrepancias,
    status: discrepancias.some(d => d.tipo !== 'sin_medidas') ? 'con_errores' : 'ok',
    evaluacion_cantidad: evalCantidad
  };
}

/**
 * Detecta escaneos huérfanos (sku/lote que se escaneó pero no estaba en la IF).
 */
function detectarHuerfanos(ifTranid, ifSo, ifLocation, ifFecha, lineasEsperadas, todosLosEscaneos) {
  const esperadosKeys = new Set(
    lineasEsperadas.map(l => `${ifTranid}|${l.sku}|${l.lote}`)
  );

  const huerfanos = [];
  for (const esc of todosLosEscaneos) {
    if (esc.if_tranid !== ifTranid) continue;
    const key = `${ifTranid}|${esc.sku}|${esc.lote}`;
    if (!esperadosKeys.has(key)) {
      huerfanos.push({
        tipo: 'sku_lote_no_esperado',
        sku: esc.sku,
        lote: esc.lote,
        ubicacion_escaneada: esc.ubicacion_escaneada,
        escaneo_timestamp: esc.timestamp,
        escaneo_operador: esc.operador,
        if_tranid: ifTranid,
        if_so: ifSo,
        if_location: ifLocation,
        if_fecha: ifFecha
      });
    }
  }
  return huerfanos;
}

/**
 * Agrega contadores por dimensión (sku, lote, ubicación, operador)
 * a partir de las discrepancias.
 */
function agregarTopErrores(todasLasDiscrepancias) {
  const porSku = new Map();
  const porLote = new Map();
  const porUbicacion = new Map();
  const porOperador = new Map();

  for (const d of todasLasDiscrepancias) {
    if (d.sku) {
      porSku.set(d.sku, (porSku.get(d.sku) || 0) + 1);
    }
    if (d.lote) {
      porLote.set(d.lote, (porLote.get(d.lote) || 0) + 1);
    }
    const ub = d.ubicacion_escaneada || d.ubicacion_esperada;
    if (ub) {
      porUbicacion.set(ub, (porUbicacion.get(ub) || 0) + 1);
    }
    const op = d.escaneo_operador;
    if (op) {
      porOperador.set(op, (porOperador.get(op) || 0) + 1);
    }
  }

  const toArray = (m) => Array.from(m.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);

  return {
    top_skus: toArray(porSku),
    top_lotes: toArray(porLote),
    top_ubicaciones: toArray(porUbicacion),
    top_operadores: toArray(porOperador)
  };
}

/**
 * Cuenta los escaneos por SKU (artículos con más salidas).
 * Diferente de top_skus (errores): este cuenta volumen, no problemas.
 */
function agregarTopArticulosMasSalidas(todosLosEscaneos) {
  const porSku = new Map();
  const porLote = new Map();
  const porOperador = new Map();

  for (const esc of todosLosEscaneos) {
    if (esc.sku) {
      porSku.set(esc.sku, (porSku.get(esc.sku) || 0) + 1);
    }
    if (esc.lote) {
      porLote.set(esc.lote, (porLote.get(esc.lote) || 0) + 1);
    }
    if (esc.operador) {
      porOperador.set(esc.operador, (porOperador.get(esc.operador) || 0) + 1);
    }
  }

  const toArray = (m) => Array.from(m.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);

  return {
    top_skus: toArray(porSku),
    top_lotes: toArray(porLote),
    top_operadores: toArray(porOperador)
  };
}

/**
 * Función principal: ejecuta la confronta completa.
 *
 * @param {Array} ifsEsperadas - IFs agrupadas (output de netsuiteSearchService.getIFsEsperadasAgrupadas)
 * @param {Array} escaneos      - Escaneos (output de googleSheetsService.getEscaneos)
 * @returns {Object} Resultado agregado
 */
function confrontar(ifsEsperadas, escaneos) {
  const escaneosAgrupados = agruparEscaneos(escaneos);

  // Backfill de SO origen: la saved search de NS no incluye "Creado desde",
  // pero los escaneos de Google Sheets sí (campo `so`). Si la IF no trae
  // sourceDoc de NetSuite, lo completamos con el SO de sus escaneos.
  const soPorIF = new Map();
  for (const e of escaneos) {
    if (e.if_tranid && e.so && !soPorIF.has(e.if_tranid)) {
      soPorIF.set(e.if_tranid, e.so);
    }
  }

  const resultado = {
    ifs: [],
    ifs_ok: [],
    ifs_con_errores: [],
    ifs_pendientes: [],
    total_lineas: 0,
    lineas_con_error: 0,
    total_placas_esperadas: 0,
    total_placas_escaneadas: 0,
    todas_las_discrepancias: [],
    top_skus: [],
    top_lotes: [],
    top_ubicaciones: [],
    top_operadores: [],
    top_articulos_mas_salidas: { top_skus: [], top_lotes: [], top_operadores: [] }
  };

  for (const ifDoc of ifsEsperadas) {
    const lineasEvaluadas = [];
    const discrepanciasDeEstaIF = [];

    // SO resuelto: prioridad al de NetSuite (si algún día la saved search lo trae),
    // fallback al SO de los escaneos (Sheets).
    const soResuelto = ifDoc.sourceDoc || soPorIF.get(ifDoc.tranid) || null;
    const ifFecha = ifDoc.trandate || null;

    for (const lineaEsperada of ifDoc.lineas) {
      const key = `${ifDoc.tranid}|${lineaEsperada.sku}|${lineaEsperada.lote}`;
      const escaneosDeEstaLinea = escaneosAgrupados.get(key) || [];
      const lineaEvaluada = evaluarLinea(
        ifDoc.tranid,
        soResuelto,
        ifDoc.location,
        ifFecha,
        lineaEsperada,
        escaneosDeEstaLinea
      );
      lineasEvaluadas.push(lineaEvaluada);

      if (lineaEvaluada.discrepancias.length > 0) {
        discrepanciasDeEstaIF.push(...lineaEvaluada.discrepancias);
      }

      // Acumular contadores
      resultado.total_lineas++;
      if (lineaEvaluada.status === 'con_errores') resultado.lineas_con_error++;
      if (lineaEvaluada.evaluacion_cantidad?.placas_esperadas) {
        resultado.total_placas_esperadas += lineaEvaluada.evaluacion_cantidad.placas_esperadas;
      }
    }

    // Detectar huérfanos (sku/lote escaneado que no estaba en la IF)
    const huerfanos = detectarHuerfanos(
      ifDoc.tranid,
      soResuelto,
      ifDoc.location,
      ifFecha,
      ifDoc.lineas,
      escaneos
    );
    if (huerfanos.length > 0) {
      discrepanciasDeEstaIF.push(...huerfanos);
    }

    // Determinar operador: de TODOS los escaneos de la IF (incluidos huérfanos),
    // no solo los que matchearon alguna línea esperada.
    const operador = escaneos
      .filter(e => e.if_tranid === ifDoc.tranid)
      .map(e => e.operador)
      .find(Boolean) || null;

    const ifResultado = {
      internalid: ifDoc.internalid,
      tranid: ifDoc.tranid,
      so: soResuelto,
      trandate: ifDoc.trandate,
      location: ifDoc.location,
      operador,
      lineas: lineasEvaluadas,
      total_lineas: lineasEvaluadas.length,
      lineas_con_error: lineasEvaluadas.filter(l => l.status === 'con_errores').length,
      discrepancias: discrepanciasDeEstaIF,
      status: discrepanciasDeEstaIF.length > 0 ? 'con_errores' : 'ok'
    };

    resultado.ifs.push(ifResultado);
    if (ifResultado.status === 'ok') {
      resultado.ifs_ok.push(ifResultado);
    } else {
      resultado.ifs_con_errores.push(ifResultado);
    }
    resultado.todas_las_discrepancias.push(...discrepanciasDeEstaIF);
  }

  // Top errores agregados
  const tops = agregarTopErrores(resultado.todas_las_discrepancias);
  resultado.top_skus = tops.top_skus;
  resultado.top_lotes = tops.top_lotes;
  resultado.top_ubicaciones = tops.top_ubicaciones;
  resultado.top_operadores = tops.top_operadores;

  // Total de placas escaneadas: viene directo de Google Sheets
  // (independiente del match con NetSuite, refleja lo que realmente se escaneó)
  resultado.total_placas_escaneadas = escaneos.length;

  // Conteo adicional: cuántas matchearon con IFs vs cuántas son huérfanas
  let placasMatcheadas = 0;
  for (const l of resultado.ifs) {
    for (const ln of l.lineas) {
      placasMatcheadas += ln.placas_escaneadas || 0;
    }
  }
  resultado.placas_escaneadas_matcheadas = placasMatcheadas;
  resultado.placas_escaneadas_huerfanas = escaneos.length - placasMatcheadas;

  // Top artículos con más salidas (volumen de escaneos)
  const masSalidas = agregarTopArticulosMasSalidas(escaneos);
  resultado.top_articulos_mas_salidas = masSalidas;

  // Tasa de exactitud
  resultado.tasa_exactitud = resultado.total_lineas > 0
    ? ((resultado.total_lineas - resultado.lineas_con_error) / resultado.total_lineas) * 100
    : 100;

  return resultado;
}

module.exports = {
  confrontar,
  // exports para tests unitarios
  _evaluarLinea: evaluarLinea,
  _agruparEscaneos: agruparEscaneos,
  _detectarHuerfanos: detectarHuerfanos,
  _agregarTopErrores: agregarTopErrores
};
