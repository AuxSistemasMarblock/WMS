/**
 * WMS · Webhook
 * Envío de datos a n8n (fallback) o NetSuite (principal)
 *
 * Nota: El flujo principal ahora es:
 * Escaneo → Firmas → submitToNetSuite (netsuite-client.js)
 * Fallback: exportJSON → n8n webhook
 */

const WEBHOOK_URL = 'https://n8nmrb.marblock.shop/webhook/5f3d84df-0d66-4ea8-a9dd-285f7e6f7dc0';
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
function buildPayload() {
    const active = getActiveRecords();
    if (!active.length) return null;

    // En la nueva versión, usamos información de sesión del usuario
    const user = currentUser;
    const IF = selectedIF;

    if (!IF || !user) {
        showToast('Selecciona una IF e inicia sesión', 'error');
        return null;
    }

    return {
        ifTranid: IF.tranid,
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
 * Envía los datos al webhook de n8n (FALLBACK LEGACY)
 * Esta función se mantiene para compatibilidad hacia atrás
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
        const res = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
