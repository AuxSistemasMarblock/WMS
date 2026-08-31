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
    const parsed = parseLote(lineaEsperada.lote);
    const areaPlaca = parsed ? parsed.area : 0;
    const placasTeoricas = (areaPlaca > 0 && lineaEsperada.quantity)
      ? parseFloat(lineaEsperada.quantity) / areaPlaca
      : 1;
    const fraccion = placasTeoricas - Math.floor(placasTeoricas);
    const esFraccionEsperada = (fraccion > 0.08 && fraccion < 0.92);
    const placasEsp = esFraccionEsperada ? (Math.floor(placasTeoricas) + 0.5) : Math.round(placasTeoricas);

    discrepancias.push({
      tipo: 'linea_faltante',
      sku: lineaEsperada.sku,
      lote: lineaEsperada.lote,
      cantidad_m2_esperada: lineaEsperada.quantity,
      area_placa_m2: areaPlaca,
      placas_esperadas: placasEsp,
      placas_escaneadas: 0,
      diferencia: placasEsp,
      diff_m2: parseFloat((lineaEsperada.quantity || 0).toString()),
      mensaje: 'No se escaneó ninguna placa de este item',
      if_tranid: ifTranid,
      if_so: ifSo,
      if_location: ifLocation,
      if_fecha: ifFecha
    });
    return {
      ...lineaEsperada,
      placas_escaneadas: 0,
      evaluacion_cantidad: {
        status: 'faltante',
        tipo_discrepancia: 'linea_faltante',
        placas_esperadas: placasEsp,
        placas_escaneadas: 0,
        diferencia: placasEsp,
        m2_esperados: parseFloat((lineaEsperada.quantity || 0).toString()),
        m2_escaneados: 0,
        diff_m2: parseFloat((lineaEsperada.quantity || 0).toString()),
        area_placa_m2: areaPlaca
      },
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
  } else if (evalCantidad.tipo_discrepancia === 'media_placa') {
    discrepancias.push({
      tipo: 'media_placa',
      sku: lineaEsperada.sku,
      lote: lineaEsperada.lote,
      placas_esperadas: evalCantidad.placas_esperadas,
      placas_escaneadas: evalCantidad.placas_escaneadas,
      diferencia: evalCantidad.diferencia,
      cantidad_m2_esperada: lineaEsperada.quantity,
      area_placa_m2: evalCantidad.area_placa_m2,
      id_lote: evalCantidad.id_lote,
      es_media_placa: true,
      diff_m2: evalCantidad.diff_m2,
      if_tranid: ifTranid,
      if_so: ifSo,
      if_location: ifLocation,
      if_fecha: ifFecha
    });
  } else if (evalCantidad.tipo_discrepancia === 'cantidad_faltante') {
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
      diff_m2: evalCantidad.diff_m2,
      if_tranid: ifTranid,
      if_so: ifSo,
      if_location: ifLocation,
      if_fecha: ifFecha
    });
  } else if (evalCantidad.tipo_discrepancia === 'cantidad_sobrante') {
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
      es_media_placa: false,
      diff_m2: evalCantidad.diff_m2,
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
 *
 * Recibe SOLO los escaneos de la IF (pre-agrupados por if_tranid en confrontar),
 * para que el costo sea O(escaneos de la IF) y no O(todos los escaneos).
 */
function detectarHuerfanos(ifTranid, ifSo, ifLocation, ifFecha, lineasEsperadas, escaneosDeEstaIF) {
  const esperadosKeys = new Set(
    lineasEsperadas.map(l => `${ifTranid}|${l.sku}|${l.lote}`)
  );

  const huerfanos = [];
  for (const esc of escaneosDeEstaIF) {
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

  // Agrupar escaneos por if_tranid UNA vez. Se usa para detectar huérfanos,
  // resolver el operador y detectar IFs escaneadas sin registro en NetSuite,
  // evitando O(IFs × escaneos).
  const escaneosPorIF = new Map();
  for (const e of escaneos) {
    if (!e.if_tranid) continue;
    if (!escaneosPorIF.has(e.if_tranid)) escaneosPorIF.set(e.if_tranid, []);
    escaneosPorIF.get(e.if_tranid).push(e);
  }

  const resultado = {
    ifs: [],
    ifs_ok: [],
    ifs_con_errores: [],
    ifs_canceladas_erp: [], // Nueva categoría para IFs huérfanas/canceladas
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

  // Función interna para inyectar plan de acción a las discrepancias
  const formatM2 = (disc) => {
    if (!disc.cantidad_m2_esperada) return '';
    const expectedM2 = disc.m2_esperados ?? parseFloat(parseFloat(disc.cantidad_m2_esperada || 0).toFixed(2));
    const scannedM2 = disc.m2_escaneados ?? ((disc.area_placa_m2 && disc.placas_escaneadas) 
                      ? parseFloat((disc.placas_escaneadas * disc.area_placa_m2).toFixed(2)) 
                      : 0);
    const diffM2 = disc.diff_m2 ?? parseFloat(Math.abs(scannedM2 - expectedM2).toFixed(2));
    return `[Esperado: ${expectedM2.toFixed(2)}m² | Escaneado: ${scannedM2.toFixed(2)}m² | Diferencia: ${diffM2.toFixed(2)}m²] `;
  };

  const asignarPlanAccion = (disc) => {
    switch (disc.tipo) {
      case 'media_placa':
        disc.plan_accion = `Error de etiquetado (Media Placa). ${formatM2(disc)}Se solicitó una fracción de placa (${disc.cantidad_m2_esperada}m²) pero se escaneó placa completa. Re-etiquetar física con lote y medidas reales.`;
        break;
      case 'cantidad_faltante':
        disc.plan_accion = `Faltante físico. ${formatM2(disc)}Buscar material en andén/rack y completar tarima.`;
        break;
      case 'cantidad_sobrante':
        disc.plan_accion = `Placas de más. ${formatM2(disc)}Se escanearon más placas físicas de las requeridas. Retirar placa(s) extra de la tarima.`;
        break;
      case 'ubicacion_incorrecta':
        disc.plan_accion = `Error de ubicación física. Se escaneó en "${disc.ubicacion_escaneada}", se esperaba "${disc.ubicacion_esperada}". Mover material a ubicación correcta.`;
        break;
      case 'sku_lote_no_esperado':
        disc.plan_accion = `Artículo no esperado (Huérfano). No pertenece a esta IF. Retirar de tarima y reubicar en rack.`;
        break;
      case 'linea_faltante':
        disc.plan_accion = `Línea omitida. ${formatM2(disc)}Surtir línea completa requerida.`;
        break;
      case 'if_no_encontrada':
        disc.plan_accion = `IF Cancelada en ERP. Mercancía despachada físicamente por almacén pero no localizada/cancelada en NetSuite. Notificar a facturación / ventas para refacturación o retorno.`;
        break;
      default:
        disc.plan_accion = 'Revisar manualmente.';
    }
    return disc;
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
      if (lineaEvaluada.evaluacion_cantidad && typeof lineaEvaluada.evaluacion_cantidad.placas_esperadas === 'number') {
        resultado.total_placas_esperadas += lineaEvaluada.evaluacion_cantidad.placas_esperadas;
      }
    }

    // Detectar huérfanos (sku/lote escaneado que no estaba en la IF).
    // Solo los escaneos de ESTA IF (pre-agrupados) → O(escaneos de la IF).
    const escaneosDeLaIF = escaneosPorIF.get(ifDoc.tranid) || [];
    const huerfanos = detectarHuerfanos(
      ifDoc.tranid,
      soResuelto,
      ifDoc.location,
      ifFecha,
      ifDoc.lineas,
      escaneosDeLaIF
    );
    if (huerfanos.length > 0) {
      discrepanciasDeEstaIF.push(...huerfanos);
    }

    // Determinar operador: de TODOS los escaneos de la IF (incluidos huérfanos),
    // no solo los que matchearon alguna línea esperada.
    const operador = escaneosDeLaIF
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
      discrepancias: discrepanciasDeEstaIF.map(asignarPlanAccion),
      status: discrepanciasDeEstaIF.length > 0 ? 'con_errores' : 'ok'
    };

    resultado.ifs.push(ifResultado);
    if (ifResultado.status === 'ok') {
      resultado.ifs_ok.push(ifResultado);
    } else {
      resultado.ifs_con_errores.push(ifResultado);
    }
    resultado.todas_las_discrepancias.push(...ifResultado.discrepancias);
  }

  // ── IFs escaneadas en Sheets pero sin registro en NetSuite ─────────────────
  const tranidsProcesados = new Set(resultado.ifs.map(i => i.tranid));
  let placas_en_ifs_canceladas = 0;

  for (const [tranid, escaneosDeLaIF] of escaneosPorIF) {
    if (tranidsProcesados.has(tranid)) continue;

    const lineasMap = new Map();
    for (const e of escaneosDeLaIF) {
      if (!e.sku || !e.lote) continue;
      const key = `${e.sku}|${e.lote}`;
      if (!lineasMap.has(key)) lineasMap.set(key, []);
      lineasMap.get(key).push(e);
      placas_en_ifs_canceladas++;
    }
    const lineas = Array.from(lineasMap.entries()).map(([key, escs]) => {
      const [sku, lote] = key.split('|');
      return {
        sku,
        lote,
        placas_escaneadas: escs.length,
        escaneos: escs,
        discrepancias: [],
        status: 'ok'
      };
    });

    const operador = escaneosDeLaIF.map(e => e.operador).find(Boolean) || null;
    const primera = escaneosDeLaIF[0];
    const discCancelada = asignarPlanAccion({
      tipo: 'if_no_encontrada',
      mensaje: 'La IF fue escaneada en Google Sheets pero no se localizó en NetSuite (saved search de IFs enviadas)',
      if_tranid: tranid,
      if_so: primera.so || null,
      if_location: primera.sucursal || null,
      if_fecha: primera.fecha || null
    });

    const ifSintetica = {
      internalid: null,
      tranid,
      so: primera.so || null,
      trandate: primera.fecha || null,
      location: primera.sucursal || null,
      operador,
      lineas,
      total_lineas: lineas.length,
      lineas_con_error: 0,
      discrepancias: [discCancelada],
      status: 'cancelada_erp'
    };

    resultado.ifs.push(ifSintetica);
    resultado.ifs_canceladas_erp.push(ifSintetica);
  }

  // Top errores agregados
  const tops = agregarTopErrores(resultado.todas_las_discrepancias);
  resultado.top_skus = tops.top_skus;
  resultado.top_lotes = tops.top_lotes;
  resultado.top_ubicaciones = tops.top_ubicaciones;
  resultado.top_operadores = tops.top_operadores;

  // Total de placas escaneadas (excluyendo IFs canceladas en ERP)
  resultado.total_placas_escaneadas = escaneos.length - placas_en_ifs_canceladas;

  // Formatear placas esperadas totales
  const fracTotal = resultado.total_placas_esperadas - Math.floor(resultado.total_placas_esperadas);
  resultado.total_placas_esperadas = (fracTotal > 0.08 && fracTotal < 0.92)
    ? parseFloat(resultado.total_placas_esperadas.toFixed(1))
    : Math.round(resultado.total_placas_esperadas);

  // Top artículos con más salidas
  const masSalidas = agregarTopArticulosMasSalidas(escaneos);
  resultado.top_articulos_mas_salidas = masSalidas;

  // Tasa de exactitud (Perfect Order: IFs 100% OK / Total IFs evaluadas)
  const totalIfsEvaluadas = resultado.ifs_ok.length + resultado.ifs_con_errores.length;
  resultado.tasa_exactitud = totalIfsEvaluadas > 0
    ? (resultado.ifs_ok.length / totalIfsEvaluadas) * 100
    : 100;

  // Calcular m2 y desglose de causas raíz
  let m2Sobrante = 0;
  let m2Faltante = 0;
  let m2MediaPlaca = 0;
  let m2Canceladas = 0;

  for (const d of resultado.todas_las_discrepancias) {
    if (d.tipo === 'media_placa') {
      m2MediaPlaca += Math.abs(d.diff_m2 || 0);
    } else if (d.tipo === 'cantidad_sobrante') {
      m2Sobrante += Math.abs(d.diff_m2 || ((d.diferencia || 0) * (d.area_placa_m2 || 0)));
    } else if (d.tipo === 'cantidad_faltante') {
      m2Faltante += Math.abs(d.diff_m2 || ((d.diferencia || 0) * (d.area_placa_m2 || 0)));
    } else if (d.tipo === 'linea_faltante') {
      m2Faltante += parseFloat(d.cantidad_m2_esperada || 0);
    }
  }

  for (const ifCanc of resultado.ifs_canceladas_erp) {
    for (const l of ifCanc.lineas) {
      const parsed = parseLote(l.lote);
      if (parsed) {
        m2Canceladas += (l.placas_escaneadas * parsed.area);
      }
    }
  }

  const conteoDiscrepancias = {
    media_placa: resultado.todas_las_discrepancias.filter(d => d.tipo === 'media_placa').length,
    cantidad_sobrante: resultado.todas_las_discrepancias.filter(d => d.tipo === 'cantidad_sobrante').length,
    cantidad_faltante: resultado.todas_las_discrepancias.filter(d => d.tipo === 'cantidad_faltante').length,
    linea_faltante: resultado.todas_las_discrepancias.filter(d => d.tipo === 'linea_faltante').length,
    sku_lote_no_esperado: resultado.todas_las_discrepancias.filter(d => d.tipo === 'sku_lote_no_esperado').length,
    ubicacion_incorrecta: resultado.todas_las_discrepancias.filter(d => d.tipo === 'ubicacion_incorrecta').length,
    ifs_canceladas_erp: resultado.ifs_canceladas_erp.length
  };

  // Calcular impacto neto en placas por cada causa raíz
  let impactoPlacasMediaPlaca = 0;
  let impactoPlacasSobrantes = 0;
  let impactoPlacasFaltantes = 0;
  let impactoPlacasLineasOmitidas = 0;
  let impactoPlacasHuerfanos = 0;

  for (const d of resultado.todas_las_discrepancias) {
    if (d.tipo === 'media_placa') {
      const esc = d.placas_escaneadas || 0;
      const esp = d.placas_esperadas || 0;
      impactoPlacasMediaPlaca += (esc - esp);
    } else if (d.tipo === 'cantidad_sobrante') {
      impactoPlacasSobrantes += (d.diferencia || 0);
    } else if (d.tipo === 'cantidad_faltante') {
      impactoPlacasFaltantes += (d.diferencia || 0);
    } else if (d.tipo === 'linea_faltante') {
      impactoPlacasLineasOmitidas += (d.placas_esperadas || 0);
    } else if (d.tipo === 'sku_lote_no_esperado') {
      impactoPlacasHuerfanos += (d.placas_escaneadas || 1);
    }
  }

  const m2SobranteTotal = m2Sobrante + m2MediaPlaca;
  const m2DesviacionTotal = m2SobranteTotal + m2Faltante;

  resultado.kpis = {
    ifs_totales: resultado.ifs_ok.length + resultado.ifs_con_errores.length,
    ifs_ok: resultado.ifs_ok.length,
    ifs_con_errores: resultado.ifs_con_errores.length,
    ifs_canceladas_erp: resultado.ifs_canceladas_erp.length,
    tasa_exactitud: resultado.tasa_exactitud,
    total_lineas: resultado.total_lineas,
    lineas_con_error: resultado.lineas_con_error,
    placas_esperadas: resultado.total_placas_esperadas,
    placas_escaneadas: resultado.total_placas_escaneadas,
    placas_canceladas: placas_en_ifs_canceladas,
    total_discrepancias: resultado.todas_las_discrepancias.length,
    desglose_errores: conteoDiscrepancias,
    impacto_placas: {
      media_placa: parseFloat(impactoPlacasMediaPlaca.toFixed(1)),
      sobrantes: impactoPlacasSobrantes,
      huerfanos: impactoPlacasHuerfanos,
      faltantes: impactoPlacasFaltantes,
      lineas_omitidas: impactoPlacasLineasOmitidas,
      total_faltantes: impactoPlacasFaltantes + impactoPlacasLineasOmitidas
    },
    m2: {
      desviacion_total: parseFloat(m2DesviacionTotal.toFixed(2)),
      media_placa: parseFloat(m2MediaPlaca.toFixed(2)),
      sobrante: parseFloat(m2SobranteTotal.toFixed(2)),
      sobrante_puro: parseFloat(m2Sobrante.toFixed(2)),
      faltante: parseFloat(m2Faltante.toFixed(2)),
      canceladas_erp: parseFloat(m2Canceladas.toFixed(2))
    }
  };

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
