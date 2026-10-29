/**
 * WMS · Webhook
 * Respaldo de escaneos en Google Sheets tras el envío a NetSuite
 *
 * Flujo: Escaneo → Firmas → submitToNetSuite (netsuite-client.js)
 *        → exportJSON → backend /webhook/scan → Google Sheets (Service Account)
 *
 * Nota: BACKEND_URL ya está declarado como global en js/auth.js (se carga
 * antes que este script), por eso NO se redeclara aquí.
 */

let hasBeenSent = false; // Rastrea si ya fue enviado

/**
 * Marca que se envió correctamente (bloquea re-envíos)
 */
function lockFromResend() {
    hasBeenSent = true;
    const btnCompletar = document.getElementById('btnCompletar');
    if (btnCompletar) {
        btnCompletar.disabled = true;
        btnCompletar.style.opacity = '0.5';
        btnCompletar.title = 'Limpiar tabla para enviar nuevos registros';
    }
}

/**
 * Desbloquea para permitir nuevo envío (al limpiar tabla)
 */
function unlockForResend() {
    hasBeenSent = false;
    const btnCompletar = document.getElementById('btnCompletar');
    if (btnCompletar) {
        btnCompletar.disabled = false;
        btnCompletar.style.opacity = '1';
        btnCompletar.title = 'Completar y enviar registro';
    }
}

/**
 * Construye el payload con datos del registro
 * Versión compatible con token JWT del usuario logeado
 * @returns {Object|null} Objeto payload o null si hay error
 */
function buildPayload(IF = selectedIF, active = getActiveRecords()) {
    if (!active.length) return null;

    // En la nueva versión, usamos información de sesión del usuario
    const user = currentUser;

    if (!IF || !user) {
        showToast('Selecciona una IF e inicia sesión', 'error');
        return null;
    }

    return {
        ifTranid: IF.tranid,
        ifDocOrigen: IF.sourceDoc || '',                                              // indica desde dónde se creó la IF (ej: SO14548, TO155)
        usuarioId: user.id,
        usuario: user.nombre,
        ubicacion: user.ubicacion.nombre,
        ubicacionId: user.ubicacion.id,
        cargo: user.cargo,
        fecha: new Date().toLocaleDateString('es-MX'),
        fechaISO: new Date().toISOString(),
        totalItems: active.length,
        items: active,
    };
}

/**
 * WMS 2.0 · U3 · Multi-IF: respaldo en Sheets de UNA IF del grupo (sin IF
 * seleccionada en el escáner). La confronta del dashboard lee los escaneos de
 * Sheets, así que cada IF enviada necesita su propio respaldo.
 * @param {Object} IF    - Entrada de multiState.grupo ({ tranid, so })
 * @param {Array} items  - Registros asignados a esa IF
 * @returns {boolean} true si el respaldo llegó
 */
async function respaldarIFEnSheets(IF, items) {
    const limpios = items.map(({ ifTranid, motivoMatch, ...r }) => r);
    const payload = buildPayload({ tranid: IF.tranid, sourceDoc: IF.so || '' }, limpios);
    if (!payload) return false;
    try {
        const res = await fetch(`${BACKEND_URL}/webhook/scan`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return true;
    } catch (err) {
        console.error(`Webhook error (${IF.tranid}):`, err);
        showToast(`Error al respaldar ${IF.tranid} — descargando local`, 'error');
        downloadJSONFallback(payload);
        return false;
    }
}

/**
 * Descarga el JSON como archivo local (fallback)
 * @param {Object} payload - Datos a descargar
 */
function downloadJSONFallback(payload) {
    const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(
            new Blob([JSON.stringify(payload, null, 2)], {
                type: 'application/json',
            })
        ),
        download: (payload.ifTranid || 'salida').replace(/\s/g, '_') + '_' + Date.now() + '.json',
    });
    a.click();
}

/**
 * Registra los escaneos en Google Sheets vía el backend (/webhook/scan).
 * Esta función se mantiene para compatibilidad hacia atrás.
 * El flujo principal es submitToNetSuite()
 */
async function exportJSON() {
    // Previene re-envíos accidentales
    if (hasBeenSent) {
        showToast('Ya fue enviado. Limpia la tabla para nuevos registros.', 'error');
        return;
    }

    const payload = buildPayload();
    if (!payload) return;

    try {
        showToast('Enviando al sistema (FALLBACK)...', 'folio-ok');
        const res = await fetch(`${BACKEND_URL}/webhook/scan`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify(payload),
        });

        if (res.ok) {
            showToast(`✓ Enviado al sistema (${payload.totalItems} items)`, 'success');
            lockFromResend(); // Bloquea re-envíos
        } else {
            throw new Error(`HTTP ${res.status}`);
        }
    } catch (err) {
        console.error('Webhook error:', err);
        showToast('Error al enviar — descargando local', 'error');
        // Fallback: descarga JSON
        downloadJSONFallback(payload);
    }
}
