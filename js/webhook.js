/**
 * WMS · Webhook
 * Envío de datos a n8n y Google Sheets
 */

const WEBHOOK_URL = 'https://n8nmrb.marblock.shop/webhook/5f3d84df-0d66-4ea8-a9dd-285f7e6f7dc0';

/**
 * Construye el payload con datos del registro
 * @returns {Object|null} Objeto payload o null si hay error
 */
function buildPayload() {
    const active = getActiveRecords();
    if (!active.length) return null;

    const folio = document.getElementById('folioInput').value.trim();
    const responsable = document.getElementById('respInput').value.trim();

    if (!folio || !responsable) {
        showToast('Folio SO y Responsable son obligatorios', 'error');
        return null;
    }

    return {
        folio: folio,
        responsable: responsable,
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
        download: payload.folio.replace(/\s/g, '_') + '_salida.json',
    });
    a.click();
}

/**
 * Envía los datos al webhook de n8n
 */
async function exportJSON() {
    const payload = buildPayload();
    if (!payload) return;

    try {
        showToast('Enviando a n8n...', 'folio-ok');
        const res = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (res.ok) {
            showToast(`✓ Enviado a Sheets (${payload.totalItems} items)`, 'success');
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
