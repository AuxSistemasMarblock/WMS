/**
 * WMS · Escáner de placas
 *
 * La pistola lectora de QR actúa como teclado HID: emite los caracteres
 * del QR seguidos de Enter. Acumulamos caracteres hasta detectar el
 * terminador y procesamos el buffer como un código.
 *
 * El listener está siempre activo. Sin botones.
 * - Pistola: keydown global (default)
 * - Cámara: fallback opcional desde un toggle
 */

var scanSource = 'pistola';          // 'pistola' | 'camara'
var scanner = null;                  // instancia Html5Qrcode (modo camara)
var cameraActive = false;
var pistolActive = false;

var lastCode = '';
var lastTime = 0;

var scanBuffer = '';
var SCAN_TERMINATOR_KEYS = ['Enter', 'Tab', '\n', '\r'];
var SCAN_MAX_LENGTH = 200;
var SCAN_BUFFER_TIMEOUT = 500;
var lastKeyTime = 0;

// Normalización de caracteres por layout de teclado (móvil/Android).
// En layout ES-LATAM, la tecla física que en US-English produce '-'
// produce "'" (apóstrofo). Como en lotes/ubicaciones nunca va a haber
// un "'", el reemplazo es seguro.
var SCAN_CHAR_FIXES = { "'": '-' };

/* ─────────────────────────────────────────────────────────
   HELPERS
   ───────────────────────────────────────────────────────── */

function _el(id) { return document.getElementById(id); }
function _setText(id, value) { var e = _el(id); if (e) e.textContent = value; }
function _setClass(id, cls) { var e = _el(id); if (e) e.className = cls; }
function _setDisplay(id, value) { var e = _el(id); if (e) e.style.display = value; }

/* ─────────────────────────────────────────────────────────
   FEEDBACK VISUAL
   ───────────────────────────────────────────────────────── */

function updateLastScanPreview(state) {
    var el = _el('lastScanText');
    if (!el) return;
    if (state && state.error) {
        el.textContent = '⚠ ' + state.error;
        _setClass('lastScanText', 'last-scan-text error');
    } else if (state && state.ok) {
        el.textContent = '✓ ' + state.ok.sku + ' · ' + state.ok.lote + ' · ' + state.ok.ubicacion;
        _setClass('lastScanText', 'last-scan-text success');
    } else {
        el.textContent = 'Acercá la pistola y dispará el QR de la placa';
        _setClass('lastScanText', 'last-scan-text idle');
    }
}

function setGunLedActive(active) {
    var led = _el('gunLed');
    if (!led) return;
    if (active) {
        led.className = 'gun-led active';
    } else {
        led.className = 'gun-led idle';
    }
    var label = _el('gunLedLabel');
    if (label) {
        label.textContent = active
            ? 'Pistola activa'
            : 'Pistola inactiva';
    }
    console.log('[WMS-SCAN] LED:', led.className);
}

/* ─────────────────────────────────────────────────────────
   ENTRADA UNIFICADA
   ───────────────────────────────────────────────────────── */

function handleScan(text) {
    console.log('[WMS-SCAN] handleScan (raw):', text);
    // Red de seguridad: normalizar caracteres de layout de teclado
    // (por si llega texto por un camino que no pasó por onPistolaKeydown,
    // por ejemplo desde la cámara o desde un futuro integrador).
    if (text && typeof text === 'string' && typeof SCAN_CHAR_FIXES === 'object') {
        for (var src in SCAN_CHAR_FIXES) {
            if (SCAN_CHAR_FIXES.hasOwnProperty(src) && text.indexOf(src) !== -1) {
                text = text.split(src).join(SCAN_CHAR_FIXES[src]);
            }
        }
    }
    console.log('[WMS-SCAN] handleScan (normalized):', text);
    var now = Date.now();
    if (text === lastCode && (now - lastTime) < 3000) {
        console.log('[WMS-SCAN] dedupe (3s)');
        return;
    }
    lastCode = text;
    lastTime = now;

    var result = null;
    try {
        result = parseQR(text, 'placa');
    } catch (e) {
        console.error('[WMS-SCAN] ERROR en parseQR:', e);
        return;
    }
    console.log('[WMS-SCAN] parseQR result:', result);

    if (!result) {
        if (typeof showToast === 'function') showToast('QR no reconocido (formato inválido)', 'error');
        updateLastScanPreview({ error: 'Formato inválido: ' + text.substring(0, 40) });
        return;
    }

    if (typeof addRecord === 'function') {
        try {
            addRecord(result);
            console.log('[WMS-SCAN] addRecord OK');
        } catch (e) {
            console.error('[WMS-SCAN] ERROR en addRecord:', e);
            if (typeof showToast === 'function') showToast('Error al agregar registro: ' + e.message, 'error');
        }
    } else {
        console.error('[WMS-SCAN] ERROR: addRecord no está definida. ¿Se cargó table.js?');
    }
    updateLastScanPreview({ ok: result });
}

/* ─────────────────────────────────────────────────────────
   MODO PISTOLA
   ───────────────────────────────────────────────────────── */

function isFormField(target) {
    if (!target) return false;
    var tag = (target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return false;
}

function isFocusedButton() {
    var a = document.activeElement;
    if (!a || a === document.body) return false;
    return (a.tagName || '').toUpperCase() === 'BUTTON';
}

function isAnyModalOpen() {
    return !!document.querySelector('.confirm-modal.active, .signature-modal.active');
}

function onPistolaKeydown(e) {
    // Si hay modal abierto, descartar buffer
    if (isAnyModalOpen()) {
        scanBuffer = '';
        return;
    }

    // Solo procesar si la pistola está activa y es la fuente actual
    if (scanSource !== 'pistola') return;
    if (!pistolActive) return;

    var isTerminator = SCAN_TERMINATOR_KEYS.indexOf(e.key) !== -1;
    var now = performance.now();
    var dt = now - lastKeyTime;
    lastKeyTime = now;
    var isRapid = dt < 50; // pistola: <30ms entre teclas; humano: >100ms

    // Log de diagnóstico: primer keydown de cada escaneo (buffer vacío).
    // event.code no depende del layout; event.key sí.
    if (scanBuffer.length === 0 && !isTerminator) {
        console.log('[WMS-SCAN] first keydown:', {
            key: e.key,
            code: e.code,
            target: e.target && e.target.tagName,
            targetId: e.target && e.target.id,
            dt: Math.round(dt),
        });
    }

    // Si el target es un form field tipable (INPUT/TEXTAREA), los eventos
    // son lentos (humano tipeando) y ya hay un buffer previo, dejar pasar
    // al form field (no capturar) y resetear el buffer.
    // Importante: si el buffer está vacío NO se descarta el primer keydown,
    // porque en ese caso es casi seguro el inicio de un escaneo (un humano
    // no tipea de a un caracter en un campo). Esto evita perder el primer
    // caracter cuando hay foco residual en el <select> de IF.
    if (isFormField(e.target) && !isRapid && !isTerminator && scanBuffer.length > 0) {
        scanBuffer = '';
        return;
    }

    if (isTerminator) {
        // SIEMPRE prevenir default: evita scroll y activación de botones
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();

        // Blur del elemento con foco (button o form field) para que el Enter
        // no lo re-dispare ni queden caracteres basura en un input
        var active = document.activeElement;
        if (active && active.blur && (isFocusedButton() || isFormField(active))) {
            active.blur();
        }

        var cleanBuf = scanBuffer.replace(/[\r\n\t]+/g, '').trim();
        scanBuffer = '';

        if (cleanBuf.length > 0) {
            console.log('[WMS-SCAN] ESCANEO:', cleanBuf);
            handleScan(cleanBuf);
        }
        return;
    }

    // Acumular caracteres imprimibles
    if (e.key && e.key.length === 1) {
        // Si pasó mucho tiempo entre teclas, descartar buffer previo
        if (scanBuffer && dt > SCAN_BUFFER_TIMEOUT) {
            scanBuffer = '';
        }
        // Normalizar caracteres por layout de teclado (ej: ES-LATAM produce
        // "'" en lugar de "-").
        var ch = e.key;
        if (SCAN_CHAR_FIXES[ch] !== undefined) {
            ch = SCAN_CHAR_FIXES[ch];
        }
        scanBuffer += ch;
        if (scanBuffer.length > SCAN_MAX_LENGTH) scanBuffer = '';
    }
}

function startPistola() {
    if (pistolActive) return;
    pistolActive = true;
    document.addEventListener('keydown', onPistolaKeydown);
    setGunLedActive(true);
    if (typeof setStatus === 'function') {
        try { setStatus('Pistola activa', 'active'); } catch (e) {}
    }
    updateLastScanPreview({});
    console.log('[WMS-SCAN] pistola ACTIVADA, listener attached');
}

function stopPistola() {
    if (!pistolActive) return;
    pistolActive = false;
    document.removeEventListener('keydown', onPistolaKeydown);
    scanBuffer = '';
    setGunLedActive(false);
    console.log('[WMS-SCAN] pistola DETENIDA, listener removed');
}

/* ─────────────────────────────────────────────────────────
   MODO CÁMARA (FALLBACK OPCIONAL)
   ───────────────────────────────────────────────────────── */

function startCamera() {
    if (cameraActive) return;
    if (typeof Html5Qrcode === 'undefined') {
        if (typeof showToast === 'function') showToast('No se pudo cargar la librería de cámara', 'error');
        return;
    }
    try {
        var reader = _el('reader');
        if (reader) reader.innerHTML = '';
        scanner = new Html5Qrcode('reader');
    } catch (e) {
        console.error('[WMS-SCAN] Error creando Html5Qrcode:', e);
        return;
    }

    var config = {
        fps: 10,
        qrbox: { width: 220, height: 220 },
        aspectRatio: 1.7778,
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        videoConstraints: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920, min: 640 },
            height: { ideal: 1080, min: 480 },
        },
    };

    scanner.start({ facingMode: 'environment' }, config, handleScan, function () { })
        .then(function () {
            cameraActive = true;
            _setDisplay('scanIdle', 'none');
            _setDisplay('scanOverlay', 'flex');
            if (typeof setStatus === 'function') {
                try { setStatus('Cámara activa — apunta al QR', 'active'); } catch (e) {}
            }
            console.log('[WMS-SCAN] cámara iniciada');
        })
        .catch(function (err) {
            console.warn('[WMS-SCAN] Error cámara:', err);
            if (typeof showToast === 'function') showToast('No se pudo acceder a la cámara', 'error');
        });
}

function stopCamera() {
    if (!scanner || !cameraActive) return;
    scanner.stop().then(function () {
        cameraActive = false;
        _setDisplay('scanIdle', 'flex');
        _setDisplay('scanOverlay', 'none');
        var reader = _el('reader');
        if (reader) reader.innerHTML = '';
        console.log('[WMS-SCAN] cámara detenida');
    });
}

/* ─────────────────────────────────────────────────────────
   ORQUESTADOR
   ───────────────────────────────────────────────────────── */

function setScanSource(src) {
    console.log('[WMS-SCAN] setScanSource:', src);
    if (src !== 'pistola' && src !== 'camara') return;
    if (src === scanSource) return;

    if (scanSource === 'pistola' && pistolActive) stopPistola();
    if (scanSource === 'camara' && cameraActive) stopCamera();

    scanSource = src;
    applyScanSourceUI();

    if (src === 'pistola') startPistola();
    else startCamera();
}

function applyScanSourceUI() {
    var btnP = _el('sourcePistola');
    var btnC = _el('sourceCamara');
    if (btnP) {
        btnP.classList.toggle('active', scanSource === 'pistola');
        btnP.setAttribute('aria-selected', scanSource === 'pistola');
    }
    if (btnC) {
        btnC.classList.toggle('active', scanSource === 'camara');
        btnC.setAttribute('aria-selected', scanSource === 'camara');
    }

    _setText('scanCardTitle', scanSource === 'pistola'
        ? 'Lector de placas (pistola)'
        : 'Lector de placas (cámara)');

    _setDisplay('gunPanel', scanSource === 'pistola' ? 'flex' : 'none');
    _setDisplay('cameraPanel', scanSource === 'camara' ? 'block' : 'none');
    _setDisplay('cameraWarning', scanSource === 'camara' ? 'flex' : 'none');

    if (scanSource === 'pistola') {
        updateLastScanPreview({});
    }
}

/* ─────────────────────────────────────────────────────────
   API GLOBAL
   ───────────────────────────────────────────────────────── */

window.setScanSource = setScanSource;
window.startScanner = function () { if (scanSource === 'pistola') startPistola(); else startCamera(); };
window.stopScanner = function () { if (scanSource === 'pistola') stopPistola(); else stopCamera(); };
window.clearScanBuffer = function () { scanBuffer = ''; };
window.getScannerState = function () {
    return {
        scanSource: scanSource,
        pistolActive: pistolActive,
        cameraActive: cameraActive,
        bufferLen: scanBuffer.length,
        buffer: scanBuffer,
    };
};

/* ─────────────────────────────────────────────────────────
   INIT — arranca la pistola inmediatamente
   ───────────────────────────────────────────────────────── */

(function initScanner() {
    console.log('[WMS-SCAN] initScanner ejecutándose, readyState:', document.readyState);

    // Si el DOM ya está listo, arrancar ahora
    applyScanSourceUI();
    if (scanSource === 'pistola' && !pistolActive) {
        startPistola();
    }

    // Si el DOM aún no está listo, esperar
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            console.log('[WMS-SCAN] DOMContentLoaded');
            applyScanSourceUI();
            if (scanSource === 'pistola' && !pistolActive) {
                startPistola();
            }
        });
    }

    console.log('[WMS-SCAN] initScanner completo. pistolActive:', pistolActive);
})();
