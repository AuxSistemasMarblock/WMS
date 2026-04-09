/**
 * WMS · Gestión de Tabla
 * Agregar, eliminar y gestionar registros
 */

let records = [];

/**
 * Valida que los campos obligatorios estén completos
 * @returns {boolean} True si son válidos
 */
function validateRequiredFields() {
    return true; // Sin validaciones, agregar directo
}

/**
 * Agrega un nuevo registro a la tabla
 * @param {Object} item - Objeto con datos del registro
 */
function addRecord(item) {
    if (!validateRequiredFields()) return;

    item.hora = new Date().toLocaleTimeString('es-MX', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
    item.timestamp = new Date().toISOString();
    records.push(item);
    const idx = records.length;

    document.getElementById('emptyRow')?.remove();
    const tr = document.createElement('tr');
    tr.className = 'new-row';
    tr.innerHTML = `
    <td class="td-idx">${idx}</td>
    <td class="td-sku">${esc(item.sku)}</td>
    <td class="td-lote">${esc(item.lote)}</td>
    <td>${esc(item.ubicacion)}</td>
    <td class="td-time">${item.hora}</td>
    <td class="td-del"><button onclick="deleteRow(this,${idx - 1})">✕</button></td>
  `;
    document.getElementById('tableBody').insertBefore(tr, document.getElementById('tableBody').firstChild);
    updateRowCount();

    showToast('✓ ' + item.sku + ' · ' + item.lote, 'success');
    setStatus('placa registrada: ' + item.sku, 'active');
}

/**
 * Elimina un registro de la tabla
 * @param {HTMLElement} btn - Botón que se clickeó
 * @param {number} idx - Índice del registro
 */
function deleteRow(btn, idx) {
    records[idx] = null;
    btn.closest('tr').remove();
    updateRowCount();

    const n = records.filter((r) => r).length;
    if (n === 0) renderEmpty();
}

/**
 * Limpia todos los registros
 */
function clearTable() {
    if (!records.some((r) => r)) return;
    if (!confirm('¿Limpiar todos los registros?')) return;

    records = [];
    updateRowCount();
    renderEmpty();
    
    // Desbloquea el botón para permitir nuevos envíos
    unlockForResend();
}

/**
 * Actualiza el contador de registros
 */
function updateRowCount() {
    const n = records.filter((r) => r).length;
    document.getElementById('rowCount').textContent = n;
}

/**
 * Renderiza el estado vacío de la tabla
 */
function renderEmpty() {
    document.getElementById('tableBody').innerHTML = `
    <tr id="emptyRow"><td colspan="6"><div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>
      </svg>
      Sin registros.
    </div></td></tr>`;
}

/**
 * Obtiene los registros activos (no eliminados)
 * @returns {Array} Array de registros activos
 */
function getActiveRecords() {
    return records.filter((r) => r);
}
