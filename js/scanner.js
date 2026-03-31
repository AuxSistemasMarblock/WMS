/**
 * WMS · Escáner QR
 * Inicialización, captura y procesamiento de códigos QR
 */

let scanner = null;
let scanning = false;
let lastCode = '';
let lastTime = 0;

/**
 * Maneja el escaneo de un código QR
 * @param {string} text - Texto del QR
 */
function handleScan(text) {
    const now = Date.now();
    // Evita duplicados dentro de 2 segundos
    if (text === lastCode && now - lastTime < 2000) return;
    lastCode = text;
    lastTime = now;

    const result = parseQR(text, scanMode);
    if (!result) {
        showToast('QR no reconocido (formato inválido)', 'error');
        return;
    }

    if (result.tipo === 'folio') {
        setFolio(result.valor);
        setMode('placa'); // Vuelve a modo placa automáticamente
    } else {
        addRecord(result);
    }
}

/**
 * Inicia el escáner de cámara
 */
async function startScanner() {
    if (scanning) return;
    document.getElementById('reader').innerHTML = '';
    scanner = new Html5Qrcode('reader');

    const config = {
        fps: 10,
        qrbox: (w, h) => {
            const size = Math.min(Math.min(w, h) * 0.8, 280);
            return { width: size, height: size };
        },
        aspectRatio: 1.7778,
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        videoConstraints: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 3840, min: 1280 },
            height: { ideal: 2160, min: 720 },
        },
    };

    scanner
        .start({ facingMode: 'environment' }, config, handleScan, () => { })
        .then(() => {
            scanning = true;
            document.getElementById('scanIdle').style.display = 'none';
            document.getElementById('scanOverlay').style.display = 'flex';
            document.getElementById('btnStart').disabled = true;
            document.getElementById('btnStop').disabled = false;

            const statusMsg =
                scanMode === 'folio' ? 'Esperando QR de folio...' : 'Cámara activa — apunta al QR';
            const statusType = scanMode === 'folio' ? 'folio' : 'active';
            setStatus(statusMsg, statusType);

            // Activar autoenfoque continuo
            setTimeout(applyFocus, 900);
        })
        .catch((err) => {
            console.warn('Error cámara:', err);
            setStatus('Sin acceso a cámara — usa el Simulador', 'error');
            showToast('No se pudo acceder a la cámara', 'error');
        });
}

/**
 * Aplica autoenfoque continuo a la cámara
 */
async function applyFocus() {
    try {
        const video = document.querySelector('#reader video');
        if (!video?.srcObject) return;

        const track = video.srcObject.getVideoTracks()[0];
        if (!track) return;

        const caps = track.getCapabilities?.() || {};
        const constraints = {};

        if (caps.focusMode?.includes('continuous')) {
            constraints.focusMode = 'continuous';
        }
        if (caps.focusDistance) {
            constraints.focusDistance = caps.focusDistance.min;
        }

        if (Object.keys(constraints).length) {
            await track.applyConstraints({ advanced: [constraints] });
        }
    } catch (e) {
        // Silencioso — el dispositivo no soporta estas constraints
    }
}

/**
 * Detiene el escáner de cámara
 */
function stopScanner() {
    if (!scanner || !scanning) return;

    scanner.stop().then(() => {
        scanning = false;
        document.getElementById('scanIdle').style.display = 'flex';
        document.getElementById('scanOverlay').style.display = 'none';
        document.getElementById('btnStart').disabled = false;
        document.getElementById('btnStop').disabled = true;
        document.getElementById('reader').innerHTML = '';
        setStatus('Escáner detenido', '');
    });
}
