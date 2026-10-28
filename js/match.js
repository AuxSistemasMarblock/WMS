/**
 * WMS · Motor de matching Multi-IF (WMS 2.0 · U3)
 *
 * Funciones PURAS (sin DOM) que asignan placas escaneadas a las IFs de un
 * grupo. Reglas del diseño cerrado:
 *
 *  1. Llave de matching: SKU + Lote (normalizados).
 *  2. Desempate por ubicación: el 3er token del QR contra la ubicación
 *     esperada de la línea — coincidencia exacta primero, contención después;
 *     si deja UNA sola candidata, esa gana.
 *  3. Auto-fill por cantidad: entre las candidatas restantes, la que aún tenga
 *     cantidad pendiente de esa línea, EN ORDEN DE SELECCIÓN del grupo.
 *  4. Sin candidatas o sin pendientes → null (Pendientes de asignar).
 *  5. Asignaciones ESTABLES: nunca se reacomodan solas; solo cambian por
 *     override manual del auxiliar.
 */

function normalizarTexto(s) {
  return String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function claveMatch(sku, lote) {
  return normalizarTexto(sku) + '|' + normalizarTexto(lote);
}

/**
 * Compatibilidad de ubicación placa↔línea (mismo criterio de tokens que el
 * resto del sistema: "OUTLET MEX" contiene a "MEX").
 */
function ubicacionCompatible(placaLoc, lineaLoc) {
  const p = normalizarTexto(placaLoc);
  const l = normalizarTexto(lineaLoc);
  if (!p || !l) return true; // sin dato: no desempata, pero no excluye
  if (p === l) return true;
  const tokensP = p.split(/[\s:]+/).filter(Boolean);
  const tokensL = l.split(/[\s:]+/).filter(Boolean);
  return tokensP.every(t => tokensL.includes(t)) || tokensL.every(t => tokensP.includes(t));
}

/**
 * Calcula las cantidades pendientes por IF y línea.
 * @param {Array} grupoIFs - [{ tranid, lineas: [{sku, lote, placas_esperadas}] }] en orden de selección
 * @param {Array} registros - registros con ifTranid asignado (null = pendiente)
 * @returns {Object} { [tranid]: { [clave]: { esperado, escaneado, pendiente } } }
 */
function pendientesPorLinea(grupoIFs, registros) {
  const mapa = {};
  for (const ifGrupo of grupoIFs) {
    mapa[ifGrupo.tranid] = {};
    for (const linea of ifGrupo.lineas || []) {
      const clave = claveMatch(linea.sku, linea.lote);
      mapa[ifGrupo.tranid][clave] = {
        esperado: Number(linea.placas_esperadas) || 0,
        escaneado: 0,
        pendiente: Number(linea.placas_esperadas) || 0
      };
    }
  }
  for (const r of registros) {
    if (!r || !r.ifTranid) continue;
    const porLinea = mapa[r.ifTranid];
    if (!porLinea) continue;
    const clave = claveMatch(r.sku, r.lote);
    if (!porLinea[clave]) continue;
    porLinea[clave].escaneado += 1;
    porLinea[clave].pendiente = Math.max(0, porLinea[clave].pendiente - 1);
  }
  return mapa;
}

/**
 * Asigna una placa al grupo según el algoritmo de resolución.
 * @param {Object} registro - { sku, lote, ubicacion }
 * @param {Array} grupoIFs  - IFs del grupo en orden de selección
 * @param {Array} registros - registros ya asignados (para cómputo de pendientes)
 * @returns {Object} { tranid: string|null, motivo: 'sku_lote'|'ubicacion'|'cantidad'|'sin_candidatas'|'sin_pendientes' }
 */
function asignarPlacaMulti(registro, grupoIFs, registros) {
  const clave = claveMatch(registro.sku, registro.lote);

  // 1) Candidatas: IFs con línea (SKU + Lote)
  let candidatas = grupoIFs.filter(g =>
    (g.lineas || []).some(l => claveMatch(l.sku, l.lote) === clave)
  );
  if (candidatas.length === 0) {
    return { tranid: null, motivo: 'sin_candidatas' };
  }
  if (candidatas.length === 1) {
    return { tranid: candidatas[0].tranid, motivo: 'sku_lote' };
  }

  // 2) Desempate por ubicación (exacta primero, contención después)
  const conUbicacionExacta = candidatas.filter(g =>
    (g.lineas || []).some(l =>
      claveMatch(l.sku, l.lote) === clave &&
      normalizarTexto(l.ubicacion) === normalizarTexto(registro.ubicacion)
    )
  );
  if (conUbicacionExacta.length === 1) {
    return { tranid: conUbicacionExacta[0].tranid, motivo: 'ubicacion' };
  }
  const conUbicacionCompatible = candidatas.filter(g =>
    (g.lineas || []).some(l =>
      claveMatch(l.sku, l.lote) === clave &&
      ubicacionCompatible(registro.ubicacion, l.ubicacion)
    )
  );
  if (conUbicacionCompatible.length === 1) {
    return { tranid: conUbicacionCompatible[0].tranid, motivo: 'ubicacion' };
  }

  // 3) Auto-fill por cantidad pendiente, en orden de selección
  const pendientes = pendientesPorLinea(grupoIFs, registros);
  for (const g of (conUbicacionCompatible.length ? conUbicacionCompatible : candidatas)) {
    const estado = pendientes[g.tranid]?.[clave];
    if (estado && estado.pendiente > 0) {
      return { tranid: g.tranid, motivo: 'cantidad' };
    }
  }

  // 4) Todas las cantidades cubiertas → Pendientes de asignar (excedente)
  return { tranid: null, motivo: 'sin_pendientes' };
}

/**
 * Resumen de contadores por IF/línea para la UI (chips escaneado/esperado).
 * @returns {Object} { [tranid]: { total: {escaneado, esperado}, lineas: [{clave, sku, lote, escaneado, esperado}] } }
 */
function contadoresDeGrupo(grupoIFs, registros) {
  const mapa = pendientesPorLinea(grupoIFs, registros);
  const resumen = {};
  for (const g of grupoIFs) {
    const porLinea = mapa[g.tranid] || {};
    const lineas = Object.entries(porLinea).map(([clave, e]) => {
      const [sku, lote] = clave.split('|');
      return { clave, sku, lote, escaneado: e.escaneado, esperado: e.esperado };
    });
    resumen[g.tranid] = {
      total: {
        escaneado: lineas.reduce((s, l) => s + l.escaneado, 0),
        esperado: lineas.reduce((s, l) => s + l.esperado, 0)
      },
      lineas
    };
  }
  return resumen;
}

// Exportar para navegador (globals) y CommonJS (tests unitarios)
const matchMultiIF = {
  normalizarTexto,
  claveMatch,
  ubicacionCompatible,
  pendientesPorLinea,
  asignarPlacaMulti,
  contadoresDeGrupo
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = matchMultiIF;
}
if (typeof window !== 'undefined') {
  window.matchMultiIF = matchMultiIF;
}
