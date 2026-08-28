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
      roles: ['aux_almacen', 'cliente', 'gerente', 'jefe_almacen', 'admin'],
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
      roles: ['gerente', 'admin'],
      label: 'Dashboard',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>'
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
    const rol = user && (user.rol || user.cargo);
    if (!rol) { nav.innerHTML = ''; return; }

    // El switch de módulos aplica a jefes de almacén, gerentes y admin.
    if (rol !== 'jefe_almacen' && rol !== 'admin' && rol !== 'gerente') { nav.innerHTML = ''; return; }

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
