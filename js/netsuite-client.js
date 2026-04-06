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

    const response = await authenticatedFetch(
      `/netsuite/ifs?ubicacion_id=${currentUser.ubicacion.id}`
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
 * Actualizar opciones del select de IFs
 */
function updateIFSelect() {
  const select = document.getElementById('ifSelect');
  select.innerHTML = '<option value="">-- Selecciona una IF --</option>';

  availableIFs.forEach(IF => {
    const option = document.createElement('option');
    option.value = IF.tranid;
    option.textContent = `${IF.tranid} - ${IF.description}`;
    select.appendChild(option);
  });
}

/**
 * Manejar selección de IF
 */
function handleIFSelect(event) {
  const tranid = event.target.value;

  if (!tranid) {
    selectedIF = null;
    document.getElementById('ifBadge').style.display = 'none';
    return;
  }

  selectedIF = availableIFs.find(IF => IF.tranid === tranid);

  if (selectedIF) {
    document.getElementById('ifBadgeText').textContent = selectedIF.tranid;
    document.getElementById('ifBadge').style.display = 'flex';
  }
}

/**
 * Botón para recargar IFs
 */
async function reloadIFs() {
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
      ubicacion_id: currentUser.ubicacion.id,
      items: records,
      signatures: signatures // Base64 PNGs
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
