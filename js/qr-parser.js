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
    const parts = clean.split(/\s+/).filter(Boolean);

    if (mode === 'folio') {
        return { tipo: 'folio', valor: clean };
    }

    if (mode === 'placa' || parts.length >= 3) {
        if (parts.length < 3) return null;
        const sku = parts[0];
        let loteEndIdx = parts.length;
        for (let i = 1; i < parts.length; i++) {
            if (!/\d/.test(parts[i])) { loteEndIdx = i; break; }
        }
        return {
            tipo: 'placa',
            sku,
            lote: parts.slice(1, loteEndIdx).join('-'),
            ubicacion: parts.slice(loteEndIdx).join(' '),
        };
    }

    if (parts.length === 1) {
        return { tipo: 'folio', valor: clean };
    }

    return null;
}
