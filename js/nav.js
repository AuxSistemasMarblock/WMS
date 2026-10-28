/**
 * WMS · Navegación entre módulos (header)
 *
 * Renderiza en #appNav las secciones a las que el rol del usuario tiene acceso
 * y marca como activa la página actual. Se carga en index.html, dashboard.html
 * y etiquetas.html.
 */
(function () {
  const ITEMS = [
    {
      url: 'index.html',
      roles: ['aux_almacen', 'cliente', 'jefe_almacen', 'admin'],
      label: 'Escáner',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/></svg>'
    },
    {
      url: 'etiquetas.html',
      roles: ['jefe_almacen', 'admin'],
      label: 'Etiquetas',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>'
    },
    {
      url: 'dashboard.html',
      roles: ['gerente', 'lider', 'admin'],
      label: 'Confronta',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>'
    },
    {
      url: 'casos.html',
      roles: ['jefe_almacen', 'lider', 'admin'],
      label: 'Casos',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12l2 2 4-4"/></svg>'
    },
    {
      url: 'auditoria.html',
      roles: ['admin'],
      label: 'Auditoría',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>'
    }
  ];

  function currentFile() {
    const p = window.location.pathname.split('/').pop();
    return p || 'index.html';
  }

  function renderAppNav() {
    const nav = document.getElementById('appNav');
    if (!nav) return;

    let user = null;
    try { user = JSON.parse(sessionStorage.getItem('currentUser') || 'null'); } catch (e) { user = null; }
    // Clave exacta del rol (sin substrings ni fallback `cargo` — WMS 2.0 · R1)
    const CLAVES_ROL = ['admin', 'jefe_almacen', 'aux_almacen', 'gerente', 'lider', 'cliente'];
    const rawRol = (user && (user.rol || '')) || '';
    const rol = CLAVES_ROL.includes(rawRol.toLowerCase().trim()) ? rawRol.toLowerCase().trim() : '';

    if (!rol) { nav.innerHTML = ''; return; }

    const allowed = ITEMS.filter(i => i.roles.includes(rol));
    const current = currentFile();

    nav.innerHTML = allowed.map(i => {
      const active = i.url === current ? ' active' : '';
      return `<a href="${i.url}" class="app-nav-item${active}">${i.icon}<span>${i.label}</span></a>`;
    }).join('');
  }

  window.renderAppNav = renderAppNav;

  document.addEventListener('DOMContentLoaded', renderAppNav);
})();
