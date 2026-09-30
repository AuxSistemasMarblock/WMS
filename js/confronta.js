/**
 * WMS · Validación de Confronta y Autorización por PIN
 * 
 * Flujo:
 * 1. Al presionar "Completar registro", valida contra NetSuite la IF seleccionada.
 * 2. Si hay discrepancias, muestra modal con lotes erróneos y opciones: Cancelar o Solicitar autorización.
 * 3. Cancelar: resalta en rojo las filas discrepantes en la tabla para corrección.
 * 4. Solicitar autorización: solicita PIN de 4-6 dígitos al Jefe de Almacén asignado a la sucursal.
 * 5. Si el PIN es válido, se registra auditoría en Supabase y desbloquea el flujo de firmas.
 */

let ultimasDiscrepancias = [];

/**
 * Quita la clase de resalte de error a todas las filas
 */
function limpiarResaltadoErrores() {
  const tableBody = document.getElementById('tableBody');
  if (!tableBody) return;
  tableBody.querySelectorAll('tr.row-discrepancy').forEach(tr => {
    tr.classList.remove('row-discrepancy');
  });
}

/**
 * Resalta en rojo en la tabla las filas cuyo lote esté en la lista de discrepancias
 */
function resaltarLotesConError(discrepancias) {
  if (!discrepancias || !discrepancias.length) return;
  const lotesErroneos = new Set(
    discrepancias
      .map(d => String(d.lote || '').trim().toUpperCase())
      .filter(Boolean)
  );

  const tableBody = document.getElementById('tableBody');
  if (!tableBody) return;

  const rows = tableBody.querySelectorAll('tr');
  rows.forEach(tr => {
    const loteTd = tr.querySelector('.td-lote');
    if (loteTd) {
      const loteTexto = loteTd.textContent.trim().toUpperCase();
      if (lotesErroneos.has(loteTexto)) {
        tr.classList.add('row-discrepancy');
      }
    }
  });
}

/**
 * Valida confronta antes de abrir la captura de firmas
 */
async function validarYCompletarEnvio() {
  const activeRecords = typeof getActiveRecords === 'function' ? getActiveRecords() : records.filter(r => r);
  if (!activeRecords || activeRecords.length === 0) {
    if (typeof showToast === 'function') {
      showToast('Escanea al menos una placa antes de completar el registro', 'error');
    }
    return;
  }

  if (!selectedIF) {
    if (typeof showToast === 'function') {
      showToast('Selecciona una IF antes de completar el registro', 'error');
    }
    return;
  }

  limpiarResaltadoErrores();

  const btn = document.getElementById('btnCompletar');
  const originalHTML = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> Validando confronta...`;
  }

  try {
    if (typeof showToast === 'function') {
      showToast('Validando confronta con NetSuite...', 'info');
    }

    const response = await authenticatedFetch('/netsuite/confronta-validar', {
      method: 'POST',
      body: JSON.stringify({
        ifTranid: selectedIF.tranid,
        ifInternalId: selectedIF.internalId,
        items: activeRecords
      })
    });

    const data = await response.json();

    if (btn) {
      btn.innerHTML = originalHTML;
      btn.disabled = false;
    }

    if (response.ok && data.ok) {
      if (typeof showToast === 'function') {
        showToast('✓ Confronta validada correctamente', 'success');
      }
      // Proceder al flujo normal de firmas
      if (typeof startSignatureCapture === 'function') {
        await startSignatureCapture();
      }
      return;
    }

    if (data.discrepancias && data.discrepancias.length > 0) {
      ultimasDiscrepancias = data.discrepancias;
      mostrarModalAdvertenciaConfronta(data.discrepancias);
      return;
    }

    // Caso de error en NetSuite (ej. IF no encontrada o error de red)
    const errorMsg = data.message || data.error || 'Error al validar la confronta en NetSuite';
    if (typeof showToast === 'function') {
      showToast('⚠️ ' + errorMsg, 'error');
    }

  } catch (error) {
    console.error('Error al validar confronta:', error);
    if (btn) {
      btn.innerHTML = originalHTML;
      btn.disabled = false;
    }
    if (typeof showToast === 'function') {
      showToast('Error de conexión al validar confronta. Verifica tu red e intenta de nuevo.', 'error');
    }
  }
}

/**
 * Traduce el tipo de discrepancia a un texto legible para el auxiliar y jefe
 */
function formatoTextoDiscrepancia(d) {
  switch (d.tipo) {
    case 'sku_lote_no_esperado':
      return 'Lote NO pertenece a esta IF';
    case 'cantidad_sobrante':
      return `Placas sobrantes: escaneadas ${d.placas_escaneadas}, esperadas ${d.placas_esperadas} (+${d.diferencia})`;
    case 'cantidad_faltante':
      return `Placas faltantes: escaneadas ${d.placas_escaneadas}, esperadas ${d.placas_esperadas} (-${d.diferencia})`;
    case 'linea_faltante':
      return `Línea requerida sin escanear (esperadas: ${d.placas_esperadas})`;
    default:
      return d.mensaje || 'Discrepancia en lote o cantidad';
  }
}

/**
 * Abre el modal de advertencia mostrando el detalle de cada lote erróneo
 */
function mostrarModalAdvertenciaConfronta(discrepancias) {
  const modal = document.getElementById('confrontaWarningModal');
  if (!modal) return;

  const ifText = document.getElementById('confrontaWarnIF');
  if (ifText) {
    ifText.textContent = selectedIF ? selectedIF.tranid : '—';
  }

  const listContainer = document.getElementById('confrontaList');
  if (listContainer) {
    listContainer.innerHTML = '';
    discrepancias.forEach(d => {
      const itemEl = document.createElement('div');
      itemEl.className = 'confronta-disc-card';
      itemEl.innerHTML = `
        <div class="confronta-disc-header">
          <span class="confronta-disc-lote">${esc(d.lote || 'Sin lote')}</span>
          <span class="confronta-disc-sku">${esc(d.sku || 'SKU')}</span>
        </div>
        <div class="confronta-disc-error">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>${formatoTextoDiscrepancia(d)}</span>
        </div>
      `;
      listContainer.appendChild(itemEl);
    });
  }

  // Restablecer vistas del modal
  volverAAccionesConfronta();

  // Limpiar buffer de pistola
  if (typeof clearScanBuffer === 'function') clearScanBuffer();

  modal.classList.add('active');
}

/**
 * Cierra el modal de advertencia
 */
function cerrarConfrontaModal() {
  const modal = document.getElementById('confrontaWarningModal');
  if (modal) {
    modal.classList.remove('active');
  }
  const pinInput = document.getElementById('inputPinJefe');
  if (pinInput) pinInput.value = '';
  const errorMsg = document.getElementById('confrontaPinMsg');
  if (errorMsg) errorMsg.style.display = 'none';
}

/**
 * Opción 1: Cancelar
 * Cierra modal y resalta las filas erróneas en rojo
 */
function cancelarConfrontaModal() {
  cerrarConfrontaModal();
  resaltarLotesConError(ultimasDiscrepancias);
  if (typeof showToast === 'function') {
    showToast('Placas con error resaltadas en rojo. Corrige o elimina antes de reintentar.', 'warning');
  }
}

/**
 * Opción 2: Solicitar autorización
 * Muestra el campo de ingreso de PIN
 */
function mostrarSeccionPinConfronta() {
  const initial = document.getElementById('confrontaInitialActions');
  const pinSection = document.getElementById('confrontaPinSection');
  if (initial) initial.style.display = 'none';
  if (pinSection) pinSection.style.display = 'block';

  const pinInput = document.getElementById('inputPinJefe');
  if (pinInput) {
    pinInput.value = '';
    setTimeout(() => pinInput.focus(), 100);
  }
  const errorMsg = document.getElementById('confrontaPinMsg');
  if (errorMsg) errorMsg.style.display = 'none';
}

/**
 * Vuelve de la pantalla de PIN a las acciones iniciales (Cancelar / Solicitar)
 */
function volverAAccionesConfronta() {
  const initial = document.getElementById('confrontaInitialActions');
  const pinSection = document.getElementById('confrontaPinSection');
  if (initial) initial.style.display = 'flex';
  if (pinSection) pinSection.style.display = 'none';

  const pinInput = document.getElementById('inputPinJefe');
  if (pinInput) pinInput.value = '';
  const errorMsg = document.getElementById('confrontaPinMsg');
  if (errorMsg) errorMsg.style.display = 'none';
}

/**
 * Valida el PIN del Jefe de Almacén contra el backend
 */
async function validarPinJefe() {
  const pinInput = document.getElementById('inputPinJefe');
  const errorMsg = document.getElementById('confrontaPinMsg');
  const btn = document.getElementById('btnValidarPin');
  const pin = (pinInput ? pinInput.value : '').trim();

  if (!pin || pin.length < 4 || pin.length > 6) {
    if (errorMsg) {
      errorMsg.textContent = 'Ingresa un PIN numérico de 4 a 6 dígitos';
      errorMsg.style.display = 'block';
    }
    if (pinInput) pinInput.focus();
    return;
  }

  if (errorMsg) errorMsg.style.display = 'none';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Verificando...';
  }

  try {
    const activeRecords = typeof getActiveRecords === 'function' ? getActiveRecords() : records.filter(r => r);

    const response = await authenticatedFetch('/netsuite/confronta-autorizar-pin', {
      method: 'POST',
      skipAutoLogout: true,
      body: JSON.stringify({
        pin: pin,
        ifTranid: selectedIF.tranid,
        items: activeRecords,
        discrepancias: ultimasDiscrepancias
      })
    });

    const data = await response.json();

    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Autorizar y continuar';
    }

    if (response.ok && data.success) {
      cerrarConfrontaModal();
      if (typeof showToast === 'function') {
        showToast(`✓ Autorizado por ${data.authorizedBy}`, 'success');
      }
      // Pasar a captura de firmas
      if (typeof startSignatureCapture === 'function') {
        await startSignatureCapture();
      }
    } else {
      if (errorMsg) {
        errorMsg.textContent = data.error || 'PIN incorrecto o no autorizado para esta sucursal';
        errorMsg.style.display = 'block';
      }
      if (pinInput) {
        pinInput.value = '';
        pinInput.focus();
      }
    }
  } catch (err) {
    console.error('Error al autorizar PIN:', err);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Autorizar y continuar';
    }
    if (errorMsg) {
      errorMsg.textContent = 'Error de conexión al validar PIN';
      errorMsg.style.display = 'block';
    }
  }
}

/**
 * ─────────────────────────────────────────────────────────────
 * GESTIÓN DE PIN PARA JEFES DE ALMACÉN Y ADMINS
 * ─────────────────────────────────────────────────────────────
 */

function abrirModalConfigurarPin() {
  const modal = document.getElementById('modalConfigurarPin');
  if (!modal) return;
  const form = document.getElementById('formConfigurarPin');
  if (form) form.reset();
  const errorEl = document.getElementById('pinConfigError');
  if (errorEl) errorEl.style.display = 'none';
  if (typeof clearScanBuffer === 'function') clearScanBuffer();
  modal.classList.add('active');
}

function cerrarModalConfigurarPin() {
  const modal = document.getElementById('modalConfigurarPin');
  if (modal) modal.classList.remove('active');
}

async function guardarPinJefe(event) {
  if (event) event.preventDefault();
  const pass = (document.getElementById('pinCurrentPassword')?.value || '').trim();
  const pin1 = (document.getElementById('pinNuevo')?.value || '').trim();
  const pin2 = (document.getElementById('pinConfirmar')?.value || '').trim();
  const errorEl = document.getElementById('pinConfigError');
  const btn = document.getElementById('btnGuardarPin');

  if (!pass) {
    if (errorEl) { errorEl.textContent = 'Ingresa tu contraseña actual'; errorEl.style.display = 'block'; }
    return;
  }
  if (!/^\d{4,6}$/.test(pin1)) {
    if (errorEl) { errorEl.textContent = 'El PIN debe ser numérico de 4 a 6 dígitos'; errorEl.style.display = 'block'; }
    return;
  }
  if (pin1 !== pin2) {
    if (errorEl) { errorEl.textContent = 'Los PINs no coinciden'; errorEl.style.display = 'block'; }
    return;
  }

  if (errorEl) errorEl.style.display = 'none';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Guardando...';
  }

  try {
    const response = await authenticatedFetch('/auth/set-pin', {
      method: 'POST',
      body: JSON.stringify({ password: pass, pin: pin1 })
    });

    const data = await response.json();
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Guardar PIN';
    }

    if (response.ok && data.success) {
      cerrarModalConfigurarPin();
      if (typeof showToast === 'function') {
        showToast('✓ PIN configurado correctamente', 'success');
      }
    } else {
      if (errorEl) {
        errorEl.textContent = data.error || 'Error al configurar el PIN';
        errorEl.style.display = 'block';
      }
    }
  } catch (err) {
    console.error('Error al guardar PIN:', err);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Guardar PIN';
    }
    if (errorEl) {
      errorEl.textContent = 'Error de red al guardar PIN';
      errorEl.style.display = 'block';
    }
  }
}

// Asignar al objeto window para acceso global
window.validarYCompletarEnvio = validarYCompletarEnvio;
window.mostrarModalAdvertenciaConfronta = mostrarModalAdvertenciaConfronta;
window.cerrarConfrontaModal = cerrarConfrontaModal;
window.cancelarConfrontaModal = cancelarConfrontaModal;
window.mostrarSeccionPinConfronta = mostrarSeccionPinConfronta;
window.volverAAccionesConfronta = volverAAccionesConfronta;
window.validarPinJefe = validarPinJefe;
window.limpiarResaltadoErrores = limpiarResaltadoErrores;
window.resaltarLotesConError = resaltarLotesConError;
window.abrirModalConfigurarPin = abrirModalConfigurarPin;
window.cerrarModalConfigurarPin = cerrarModalConfigurarPin;
window.guardarPinJefe = guardarPinJefe;
