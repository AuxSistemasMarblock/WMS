/**
 * WMS · Modo Multi-IF (WMS 2.0 · U3)
 *
 * Estado del grupo de IFs, selección por checkboxes, tabla agrupada por IF,
 * grupo "Pendientes de asignar" con selector por fila y contadores por línea.
 * El matching vive en js/match.js (funciones puras).
 *
 * Modo default: una sola IF (flujo clásico, sin cambios). El toggle
 * "Multi-IF" activa este módulo.
 */

const multiState = {
  activo: false,
  grupo: [],        // [{ tranid, internalId, so, location, lineas: [...] }] en orden de selección
  cargandoLineas: false
};

function esModoMulti() {
  return multiState.activo;
}

function grupoTranids() {
  return multiState.grupo.map(g => g.tranid);
}

// ────────────────────────────────────────────────────────────
// TOGGLE y SELECCIÓN DE IFs
// ────────────────────────────────────────────────────────────

function toggleMultiIF() {
  const activar = !multiState.activo;
  const activos = typeof getActiveRecords === 'function' ? getActiveRecords() : [];

  if (!activar && activos.length > 0) {
    const ok = confirm(
      `Tienes ${activos.length} placa(s) escaneada(s).\n\n` +
      `Al salir del modo Multi-IF se conservan los registros pero se pierde la agrupación por IF. ¿Continuar?`
    );
    if (!ok) return;
  }

  multiState.activo = activar;
  const btn = document.getElementById('btnMultiIF');
  if (btn) btn.classList.toggle('active-placa', activar);

  const wrapSelect = document.getElementById('ifSelect')?.parentElement;
  if (wrapSelect) wrapSelect.style.display = activar ? 'none' : '';
  const lista = document.getElementById('multiIFList');
  if (lista) lista.style.display = activar ? 'block' : 'none';

  if (!activar) {
    multiState.grupo = [];
    // Volver al render simple: conservar registros sin IF asignada visible
    if (typeof renderTableSimple === 'function') renderTableSimple();
    if (typeof updateRowCount === 'function') updateRowCount();
    return;
  }

  renderMultiIFList();
  // Re-render en modo multi con lo que ya esté escaneado
  renderTableMulti();
}

function renderMultiIFList() {
  const lista = document.getElementById('multiIFList');
  if (!lista) return;

  const disponibles = (typeof availableIFs !== 'undefined' ? availableIFs : []);
  if (!disponibles.length) {
    lista.innerHTML = '<div class="empty-state" style="padding:10px;">No hay IFs cargadas</div>';
    return;
  }

  lista.innerHTML = disponibles.map(f => {
    const checked = multiState.grupo.some(g => g.tranid === f.tranid) ? ' checked' : '';
    return `
      <label class="multi-if-item">
        <input type="checkbox" value="${esc(f.tranid)}"${checked} onchange="onMultiIFCheck(this)" />
        <span class="multi-if-tranid">${esc(f.tranid)}</span>
        <span class="multi-if-meta">${esc(f.sourceDoc || '')} · ${esc(f.location || '')}</span>
      </label>`;
  }).join('');
}

async function onMultiIFCheck(input) {
  const tranid = input.value;
  const IF = (typeof availableIFs !== 'undefined' ? availableIFs : []).find(f => f.tranid === tranid);
  if (!IF) return;

  if (input.checked) {
    if (multiState.grupo.some(g => g.tranid === tranid)) return;
    multiState.grupo.push({
      tranid: IF.tranid,
      internalId: IF.internalId,
      so: IF.sourceDoc || null,
      location: IF.location || '',
      lineas: []
    });
    await cargarLineasGrupo();
  } else {
    const asignadas = (typeof getActiveRecords === 'function' ? getActiveRecords() : [])
      .filter(r => r.ifTranid === tranid);
    if (asignadas.length > 0) {
      const ok = confirm(
        `Quitar ${tranid} del grupo dejará ${asignadas.length} placa(s) como "Pendientes de asignar". ¿Continuar?`
      );
      if (!ok) { input.checked = true; return; }
    }
    multiState.grupo = multiState.grupo.filter(g => g.tranid !== tranid);
    // Las placas de esa IF pasan a pendientes
    for (const r of (typeof getActiveRecords === 'function' ? getActiveRecords() : [])) {
      if (r.ifTranid === tranid) { r.ifTranid = null; r.motivoMatch = 'if_quitada'; }
    }
  }

  // Re-evaluar pendientes y repintar (asignaciones previas son estables:
  // solo las de la IF quitada cambian)
  renderTableMulti();
}

/**
 * Descarga las líneas esperadas de las IFs del grupo (para el matching).
 */
async function cargarLineasGrupo() {
  if (!multiState.grupo.length) return;
  const pendientes = multiState.grupo.filter(g => !g.lineas || g.lineas.length === 0);
  if (!pendientes.length) return;

  multiState.cargandoLineas = true;
  try {
    const response = await authenticatedFetch('/netsuite/ifs/lineas', {
      method: 'POST',
      body: JSON.stringify({
        ifs: pendientes.map(g => ({ tranid: g.tranid, internalId: g.internalId }))
      })
    });
    const data = await response.json();
    for (const info of (data.ifs || [])) {
      const g = multiState.grupo.find(x => x.tranid === info.tranid);
      if (g && info.encontrada) {
        g.lineas = info.lineas || [];
        g.internalId = info.internalId || g.internalId;
        g.so = info.so || g.so;
        g.location = info.location || g.location;
      } else if (g) {
        g.lineas = [];
      }
    }
  } catch (e) {
    console.error('cargarLineasGrupo error:', e);
    if (typeof showToast === 'function') {
      showToast('Error cargando líneas esperadas: ' + e.message, 'error');
    }
  } finally {
    multiState.cargandoLineas = false;
  }
}

// ────────────────────────────────────────────────────────────
// ESCANEO + TABLA AGRUPADA
// ────────────────────────────────────────────────────────────

/**
 * Alta de registro en modo multi: match automático + repaint completo.
 */
function addRecordMulti(item) {
  const registros = typeof getActiveRecords === 'function' ? getActiveRecords() : [];
  const resultado = window.matchMultiIF.asignarPlacaMulti(item, multiState.grupo, registros);
  item.ifTranid = resultado.tranid;
  item.motivoMatch = resultado.motivo;
  renderTableMulti();
}

/**
 * Override manual: mover una placa a otra IF (o a Pendientes).
 */
function moverPlaca(idx, tranid) {
  const r = records[idx];
  if (!r) return;
  r.ifTranid = tranid || null;
  r.motivoMatch = tranid ? 'manual' : 'manual_pendiente';
  renderTableMulti();
}

// Chip de línea: verde si está completa, rojo si se escanearon placas de más
function lineChipClase(l) {
  if (l.esperado > 0 && l.escaneado > l.esperado) return ' line-over';
  if (l.esperado > 0 && l.escaneado === l.esperado) return ' line-ok';
  return '';
}

/**
 * Render completo de la tabla agrupada por IF + "Pendientes de asignar".
 */
function renderTableMulti() {
  const tbody = document.getElementById('tableBody');
  if (!tbody) return;

  const registros = typeof getActiveRecords === 'function' ? getActiveRecords() : [];
  const conIdx = records.map((r, i) => r ? { ...r, _idx: i } : null).filter(Boolean);

  if (!conIdx.length) {
    if (typeof renderEmpty === 'function') renderEmpty();
    if (typeof updateRowCount === 'function') updateRowCount();
    return;
  }

  const contadores = window.matchMultiIF.contadoresDeGrupo(multiState.grupo, registros);
  const opcionesIF = (g) => `
    <select class="multi-move-select" onchange="moverPlaca(${g._idx}, this.value)" title="Cambiar de IF">
      ${multiState.grupo.map(x => `<option value="${esc(x.tranid)}"${x.tranid === g.ifTranid ? ' selected' : ''}>${esc(x.tranid)}</option>`).join('')}
      <option value=""${!g.ifTranid ? ' selected' : ''}>Pendiente</option>
    </select>`;

  const fila = (g) => `
    <tr data-if="${esc(g.ifTranid || '')}">
      <td class="td-idx">${g._idx + 1}</td>
      <td class="td-sku">${esc(g.sku)}</td>
      <td class="td-lote">${esc(g.lote)}</td>
      <td>${esc(g.ubicacion || '')}</td>
      <td class="td-time">${esc(g.hora || '')}</td>
      <td class="td-del multi-move">${opcionesIF(g)}
        <button onclick="deleteRow(this,${g._idx})">✕</button></td>
    </tr>`;

  let html = '';
  for (const ifGrupo of multiState.grupo) {
    const placas = conIdx.filter(r => r.ifTranid === ifGrupo.tranid);
    const cont = contadores[ifGrupo.tranid] || { total: { escaneado: 0, esperado: 0 }, lineas: [] };
    const chips = cont.lineas.map(l =>
      `<span class="line-chip${lineChipClase(l)}" title="${esc(l.sku)} · ${esc(l.lote)}">${esc(l.sku)}/${esc(l.lote)} ${l.escaneado}/${l.esperado}</span>`
    ).join('');
    html += `
      <tr class="multi-group-row">
        <td colspan="6">
          <div class="multi-group-head">
            <strong>📦 ${esc(ifGrupo.tranid)}</strong>
            <span class="multi-group-loc">${esc(ifGrupo.location || '')}</span>
            <span class="multi-group-count">${cont.total.escaneado}/${cont.total.esperado} placas</span>
            <span class="multi-line-chips">${chips}</span>
          </div>
        </td>
      </tr>`;
    if (!placas.length) {
      html += `<tr><td colspan="6"><div class="empty-state" style="padding:10px;">Sin placas escaneadas para esta IF</div></td></tr>`;
    } else {
      html += placas.map(fila).join('');
    }
  }

  const pendientes = conIdx.filter(r => !r.ifTranid);
  html += `
    <tr class="multi-group-row multi-pendientes-row">
      <td colspan="6">
        <div class="multi-group-head">
          <strong>⚠️ Pendientes de asignar</strong>
          <span class="multi-group-count">${pendientes.length} placa(s)</span>
          <span class="multi-group-loc">Asígnalas a una IF o elimínalas antes de completar</span>
        </div>
      </td>
    </tr>`;
  if (!pendientes.length) {
    html += `<tr><td colspan="6"><div class="empty-state" style="padding:10px;">Sin pendientes 👍</div></td></tr>`;
  } else {
    html += pendientes.map(fila).join('');
  }

  tbody.innerHTML = html;
  if (typeof updateRowCount === 'function') updateRowCount();
}

/**
 * Resetea el modo multi tras envío o limpieza.
 */
function resetearMulti() {
  multiState.grupo = [];
  renderMultiIFList();
}

window.esModoMulti = esModoMulti;
window.toggleMultiIF = toggleMultiIF;
window.renderMultiIFList = renderMultiIFList;
window.onMultiIFCheck = onMultiIFCheck;
window.addRecordMulti = addRecordMulti;
window.moverPlaca = moverPlaca;
window.renderTableMulti = renderTableMulti;
window.resetearMulti = resetearMulti;
window.grupoTranids = grupoTranids;
window.cargarLineasGrupo = cargarLineasGrupo;
window.multiState = multiState;
