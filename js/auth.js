/**
 * Sistema de Autenticación
 * Maneja login, logout y gestión de sesión con JWT
 */

const BACKEND_URL = 'http://localhost:3001'; // Cambiar según ambiente
let currentUser = null;
let authToken = null;

/**
 * Realizar login
 */
async function handleLogin(event) {
  event?.preventDefault();

  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value.trim();

  if (!email || !password) {
    showToast('Email y contraseña son requeridos', 'error');
    return;
  }

  try {
    showToast('Autenticando...', 'info');

    const response = await fetch(`${BACKEND_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Login failed');
    }

    const data = await response.json();

    // Guardar token y usuario
    authToken = data.token;
    currentUser = data.user;

    // Guardar en sessionStorage (se limpia al cerrar pestaña)
    sessionStorage.setItem('authToken', authToken);
    sessionStorage.setItem('currentUser', JSON.stringify(currentUser));

    showToast(`¡Bienvenido ${currentUser.nombre}!`, 'success');

    // Cambiar a vista principal
    showMainView();

    // Cargar IFs disponibles
    await loadIFs();

  } catch (error) {
    console.error('Login error:', error);
    showToast(error.message || 'Error en login', 'error');
  }
}

/**
 * Realizar logout
 */
function handleLogout() {
  authToken = null;
  currentUser = null;
  sessionStorage.removeItem('authToken');
  sessionStorage.removeItem('currentUser');

  // Limpiar UI
  records = [];
  document.getElementById('tableBody').innerHTML = '<tr id="emptyRow"><td colspan="6"><div class="empty-state"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>Sin registros. Escanea un QR de placa para comenzar.</div></td></tr>';

  showToast('Sesión cerrada', 'info');
  showLoginView();
}

/**
 * Restaurar sesión si existe token
 */
function restoreSession() {
  const token = sessionStorage.getItem('authToken');
  const userStr = sessionStorage.getItem('currentUser');

  if (token && userStr) {
    try {
      authToken = token;
      currentUser = JSON.parse(userStr);
      showMainView();
      loadIFs(); // Cargar IFs al restaurar sesión
    } catch (error) {
      console.error('Error restoring session:', error);
      handleLogout();
    }
  }
}

/**
 * Mostrar vista de login
 */
function showLoginView() {
  document.getElementById('loginContainer').style.display = 'flex';
  document.getElementById('mainApp').style.display = 'none';
}

/**
 * Mostrar vista principal
 */
function showMainView() {
  document.getElementById('loginContainer').style.display = 'none';
  document.getElementById('mainApp').style.display = 'block';
  document.getElementById('currentUserName').textContent = currentUser.nombre;
  document.getElementById('currentUserLocation').textContent = currentUser.ubicacion.nombre;
  document.getElementById('currentUserRole').textContent = getRoleLabel(currentUser.cargo);
}

/**
 * Traducir cargo a etiqueta
 */
function getRoleLabel(cargo) {
  const roles = {
    'aux_almacen': 'Aux. Almacén',
    'jefe_almacen': 'Jefe de Almacén',
    'gerente': 'Gerente',
    'cliente': 'Cliente'
  };
  return roles[cargo] || cargo;
}

/**
 * Hacer request con autenticación
 */
async function authenticatedFetch(endpoint, options = {}) {
  if (!authToken) {
    throw new Error('Not authenticated');
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${authToken}`,
    ...options.headers
  };

  const response = await fetch(`${BACKEND_URL}${endpoint}`, {
    ...options,
    headers
  });

  if (response.status === 401) {
    // Token expirado
    handleLogout();
    throw new Error('Sesión expirada. Por favor inicia sesión nuevamente.');
  }

  return response;
}

// Inicializar sesión al cargar página
document.addEventListener('DOMContentLoaded', restoreSession);
