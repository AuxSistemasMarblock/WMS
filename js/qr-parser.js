/**
 * WMS · Parseo de QR
 * Extrae información de códigos QR según el modo
 */

/**
 * Parsea un código QR según el modo activo
 * @param {string} raw - Texto crudo del QR
 * @param {string} mode - Modo actual: 'placa' | 'folio'
 * @returns {Object|null} Objeto con datos parseados o null si inválido
 */
function parseQR(raw, mode) {
    if (!raw) return null;

    const clean = raw.trim();
    const parts = clean.split(/\s+/);

    if (mode === 'folio') {
        return { tipo: 'folio', valor: clean };
    }

    if (mode === 'placa') {
        if (parts.length < 3) return null;
        return {
            tipo: 'placa',
            sku: parts[0],
            lote: parts[1],
            ubicacion: parts.slice(2).join(' '),
        };
    }

    // Fallback automático
    if (parts.length >= 3) {
        return {
            tipo: 'placa',
            sku: parts[0],
            lote: parts[1],
            ubicacion: parts.slice(2).join(' '),
        };
    }
    if (parts.length === 1) {
        return { tipo: 'folio', valor: clean };
    }

    return null;
}
