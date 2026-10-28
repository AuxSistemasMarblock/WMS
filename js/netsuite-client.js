/**
 * Cliente para NetSuite
 * Maneja obtención de IFs dinámicas y envío de datos
 */

let availableIFs = [];
let selectedIF = null;

/**
 * Cargar IFs disponibles desde NetSuite
 */
async function loadIFs() {
  if (!currentUser) return;

  try {
    showToast('Cargando Instrucciones de Fabricación...', 'info');

    // WMS 2.0 · R3: admin/lider pueden filtrar por ubicación desde el selector
    const selUbicacion = document.getElementById('filtroUbicacionEscaneo');
    const ubicacionParam = (selUbicacion && selUbicacion.value)
      ? `&ubicacion=${encodeURIComponent(selUbicacion.value)}`
      : '';

    const response = await authenticatedFetch(
      `/netsuite/ifs?ubicacion_id=${currentUser.ubicacion.id}${ubicacionParam}`
    );

    if (!response.ok) {
      throw new Error('Failed to load IFs');
    }

    const data = await response.json();
    availableIFs = data.ifs || [];

    // Actualizar dropdown
    updateIFSelect();
    showToast(`✓ Se cargaron ${availableIFs.length} IFs disponibles`, 'success');

  } catch (error) {
    console.error('Load IFs error:', error);
    showToast('Error al cargar IFs: ' + error.message, 'error');
  }
}

/**
 * WMS 2.0 · R3: inicializa el selector de ubicación del escáner.
 * Solo se muestra para admin y lider (default: Todas las ubicaciones).
 */
async function initUbicacionEscaneo() {
  const grupo = document.getElementById('grupoUbicacionEscaneo');
  const sel = document.getElementById('filtroUbicacionEscaneo');
  if (!grupo || !sel) return;

  const rol = String(currentUser?.rol || '').toLowerCase().trim();
  if (rol !== 'admin' && rol !== 'lider') return;

  try {
    const response = await authenticatedFetch('/api/dashboard/sucursales');
    if (!response.ok) throw new Error('No se pudieron cargar las ubicaciones');
    const data = await response.json();
    (data.sucursales || []).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.nombre;
      opt.textContent = s.nombre;
      sel.appendChild(opt);
    });
    grupo.style.display = 'block';
  } catch (e) {
    console.error('initUbicacionEscaneo error:', e);
  }
}

/**
 * WMS 2.0 · R3: al cambiar la ubicación se recargan las IFs (con confirmación
 * si ya hay placas escaneadas para la IF actual).
 */
function onCambiarUbicacionEscaneo() {
  const activeRecords = typeof getActiveRecords === 'function' ? getActiveRecords() : [];
  if (activeRecords.length > 0) {
    const ok = confirm(
      `Tienes ${activeRecords.length} placa(s) escaneada(s)${selectedIF ? ' para ' + selectedIF.tranid : ''}.\n\n` +
      `Si cambias de ubicación, esas placas NO se enviarán con la nueva selección. ¿Continuar?`
    );
    if (!ok) {
      // Revertir al valor anterior no es trivial sin estado previo: se mantiene
      // la selección y simplemente no se recarga.
      return;
    }
  }
  selectedIF = null;
  const badge = document.getElementById('ifBadge');
  if (badge) badge.style.display = 'none';
  loadIFs();
}

/**
 * Actualizar opciones del select de IFs
 */
function updateIFSelect() {
  const select = document.getElementById('ifSelect');
  select.innerHTML = '<option value="">-- Selecciona una IF --</option>';

  availableIFs.forEach(IF => {
    const option = document.createElement('option');
    option.value = IF.tranid;
    option.textContent = `${IF.tranid} (${IF.sourceDoc})`;
    select.appendChild(option);
  });
}

/**
 * Manejar selección de IF
 */
function handleIFSelect(event) {
  const tranid = event.target.value;
  const activeRecords = typeof getActiveRecords === 'function' ? getActiveRecords() : [];

  // Si hay placas escaneadas para la IF actual, pedir confirmación antes de cambiar
  if (tranid && selectedIF && tranid !== selectedIF.tranid && activeRecords.length > 0) {
    const ok = confirm(
      `Tienes ${activeRecords.length} placa(s) escaneada(s) para ${selectedIF.tranid}.\n\n` +
      `Si cambias de IF, esas placas NO se enviarán con la nueva IF. ¿Continuar?`
    );
    if (!ok) {
      event.target.value = selectedIF.tranid;
      return;
    }
  }

  if (!tranid) {
    selectedIF = null;
    document.getElementById('ifBadge').style.display = 'none';
    return;
  }

  selectedIF = availableIFs.find(IF => IF.tranid === tranid);

  if (selectedIF) {
    document.getElementById('ifBadgeText').textContent = selectedIF.tranid;
    document.getElementById('ifBadge').style.display = 'flex';
    if (event && event.target && typeof event.target.blur === 'function') {
      event.target.blur();
    }
  }
}

/**
 * Botón para recargar IFs
 */
async function reloadIFs() {
  const activeRecords = typeof getActiveRecords === 'function' ? getActiveRecords() : [];
  if (selectedIF && activeRecords.length > 0) {
    const ok = confirm(
      `Tienes ${activeRecords.length} placa(s) escaneada(s) para ${selectedIF.tranid}.\n\n` +
      `Recargar IFs NO borra los registros, pero perderás la selección actual. ¿Continuar?`
    );
    if (!ok) return;
  }
  document.getElementById('ifSelect').value = '';
  selectedIF = null;
  document.getElementById('ifBadge').style.display = 'none';
  await loadIFs();
}

/**
 * Limpiar selección de IF
 */
function clearIF() {
  document.getElementById('ifSelect').value = '';
  selectedIF = null;
  document.getElementById('ifBadge').style.display = 'none';
}

/**
 * Enviar datos a NetSuite (incluyendo firmas)
 */
async function submitToNetSuite(signatures) {
  if (!selectedIF || records.length === 0) {
    showToast('Selecciona una IF y escanea al menos una placa', 'error');
    return false;
  }

  try {
    showToast('Enviando datos a NetSuite...', 'info');

const payload = {
      ifTranid: selectedIF.tranid,
      ifInternalId: selectedIF.internalId,
      ubicacion_id: currentUser.ubicacion.id,
      items: records,
      signatures: signatures
    };

    const response = await authenticatedFetch(
      '/netsuite/submit',
      {
        method: 'POST',
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      throw new Error('Failed to submit data');
    }

    const data = await response.json();
    showToast(`✓ Se guardaron ${records.length} registros en NetSuite`, 'success');

    return true;

  } catch (error) {
    console.error('Submit error:', error);
    showToast('Error al enviar: ' + error.message, 'error');
    return false;
  }
}
