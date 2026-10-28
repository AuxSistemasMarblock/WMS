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

// WMS 2.0 · U3: cola del flujo Multi-IF (IFs con discrepancias por autorizar)
let multiFlujo = { cola: [], idx: 0, itemsPorIF: {}, resultados: [] };

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
 * Resalta en rojo en la tabla las filas cuyo lote esté en la lista de discrepancias.
 * En modo Multi-IF se puede acotar a las filas de una IF concreta (data-if).
 */
function resaltarLotesConError(discrepancias, tranidScope) {
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
    if (tranidScope && tr.dataset.if !== tranidScope) return;
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
 * (en modo Multi-IF valida IF por IF — WMS 2.0 · U3)
 */
async function validarYCompletarEnvio() {
  if (typeof esModoMulti === 'function' && esModoMulti()) {
    return validarYCompletarEnvioMulti();
  }

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
 * WMS 2.0 · U3 · Multi-IF: valida la confronta IF por IF.
 * Cada IF limpia avanza; las que tengan discrepancias entran a una cola que
 * se resuelve con PIN por IF (autorización registra la IF que corresponde).
 */
async function validarYCompletarEnvioMulti() {
  const activos = typeof getActiveRecords === 'function' ? getActiveRecords() : records.filter(r => r);
  if (!activos || activos.length === 0) {
    showToast('Escanea al menos una placa antes de completar el registro', 'error');
    return;
  }

  const grupo = (typeof multiState !== 'undefined' ? multiState.grupo : []);
  if (!grupo.length) {
    showToast('Selecciona al menos una IF del grupo', 'error');
    return;
  }

  const pendientes = activos.filter(r => !r.ifTranid);
  if (pendientes.length > 0) {
    showToast(`Hay ${pendientes.length} placa(s) pendientes de asignar a una IF`, 'error');
    return;
  }

  limpiarResaltadoErrores();

  const btn = document.getElementById('btnCompletar');
  const originalHTML = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> Validando confronta (${grupo.length} IFs)...`;
  }

  multiFlujo = { cola: [], idx: 0, itemsPorIF: {}, resultados: [] };

  try {
    for (const g of grupo) {
      const items = activos.filter(r => r.ifTranid === g.tranid);
      if (!items.length) {
        multiFlujo.resultados.push({ tranid: g.tranid, estado: 'sin_placas' });
        continue;
      }
      multiFlujo.itemsPorIF[g.tranid] = items;

      showToast(`Validando confronta de ${g.tranid}...`, 'info');
      const response = await authenticatedFetch('/netsuite/confronta-validar', {
        method: 'POST',
        body: JSON.stringify({
          ifTranid: g.tranid,
          ifInternalId: g.internalId,
          items
        })
      });
      const data = await response.json();

      if (response.ok && data.ok) {
        multiFlujo.resultados.push({ tranid: g.tranid, estado: 'ok' });
      } else if (data.discrepancias && data.discrepancias.length > 0) {
        multiFlujo.cola.push({ tranid: g.tranid, internalId: g.internalId, discrepancias: data.discrepancias });
      } else {
        // Error NetSuite (IF no encontrada, red): abortar el flujo
        if (btn) { btn.innerHTML = originalHTML; btn.disabled = false; }
        showToast('⚠️ ' + (data.message || data.error || `Error validando ${g.tranid}`), 'error');
        return;
      }
    }

    if (btn) { btn.innerHTML = originalHTML; btn.disabled = false; }

    if (multiFlujo.cola.length === 0) {
      showToast('✓ Confronta validada en todas las IFs', 'success');
      if (typeof startSignatureCapture === 'function') {
        await startSignatureCapture();
      }
      return;
    }

    // Mostrar el modal para la primera IF con discrepancias
    multiFlujo.idx = 0;
    mostrarSiguienteDiscrepanciaMulti();

  } catch (error) {
    console.error('Error al validar confronta multi:', error);
    if (btn) { btn.innerHTML = originalHTML; btn.disabled = false; }
    showToast('Error de conexión al validar confronta. Verifica tu red e intenta de nuevo.', 'error');
  }
}

/**
 * Abre (o repuebla) el modal de advertencia para la IF actual de la cola.
 */
function mostrarSiguienteDiscrepanciaMulti() {
  const actual = multiFlujo.cola[multiFlujo.idx];
  if (!actual) return;
  ultimasDiscrepancias = actual.discrepancias;
  mostrarModalAdvertenciaConfronta(actual.discrepancias, actual.tranid);
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
 * Abre el modal de advertencia mostrando el detalle de cada lote erróneo.
 * En Multi-IF recibe el tranid de la IF actual de la cola (WMS 2.0 · U3).
 */
function mostrarModalAdvertenciaConfronta(discrepancias, tranidOverride) {
  const modal = document.getElementById('confrontaWarningModal');
  if (!modal) return;

  const ifText = document.getElementById('confrontaWarnIF');
  if (ifText) {
    const tranid = tranidOverride || (selectedIF ? selectedIF.tranid : '—');
    const enMulti = tranidOverride && multiFlujo.cola.length > 1;
    ifText.textContent = enMulti
      ? `${tranid} (IF ${multiFlujo.idx + 1} de ${multiFlujo.cola.length})`
      : tranid;
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
 * (en Multi-IF solo las filas de la IF actual — WMS 2.0 · U3)
 */
function cancelarConfrontaModal() {
  const enMulti = typeof esModoMulti === 'function' && esModoMulti() && multiFlujo.cola.length > 0;
  const tranidScope = enMulti ? multiFlujo.cola[multiFlujo.idx]?.tranid : undefined;
  cerrarConfrontaModal();
  resaltarLotesConError(ultimasDiscrepancias, tranidScope);
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

    // WMS 2.0 · U3: en Multi-IF el PIN autoriza la IF ACTUAL de la cola
    const enMulti = typeof esModoMulti === 'function' && esModoMulti() && multiFlujo.cola.length > 0;
    const actual = enMulti ? multiFlujo.cola[multiFlujo.idx] : null;
    const ifTranid = enMulti ? actual.tranid : selectedIF.tranid;
    const items = enMulti ? multiFlujo.itemsPorIF[actual.tranid] : activeRecords;
    const discrepancias = enMulti ? actual.discrepancias : ultimasDiscrepancias;

    const response = await authenticatedFetch('/netsuite/confronta-autorizar-pin', {
      method: 'POST',
      skipAutoLogout: true,
      body: JSON.stringify({
        pin: pin,
        ifTranid,
        items,
        discrepancias
      })
    });

    const data = await response.json();

    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Autorizar y continuar';
    }

    if (response.ok && data.success) {
      if (typeof showToast === 'function') {
        showToast(`✓ ${ifTranid} autorizado por ${data.authorizedBy}`, 'success');
      }

      if (enMulti) {
        // Avanzar a la siguiente IF con discrepancias de la cola
        multiFlujo.idx++;
        const siguiente = multiFlujo.cola[multiFlujo.idx];
        if (siguiente) {
          mostrarSiguienteDiscrepanciaMulti();
          volverAAccionesConfronta();
          if (typeof clearScanBuffer === 'function') clearScanBuffer();
        } else {
          cerrarConfrontaModal();
          // Todas las IFs del grupo resueltas (ok o autorizadas) → firmas
          if (typeof startSignatureCapture === 'function') {
            await startSignatureCapture();
          }
        }
        return;
      }

      cerrarConfrontaModal();
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
