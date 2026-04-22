/**
 * CheckingSmart — Sistema de configuración multi-tenant
 * Este archivo carga la configuración del tenant activo y aplica
 * colores corporativos, logo y nombre de forma dinámica.
 */

(function () {
  'use strict';

  // ─── Detectar tenant desde subdominio ───────────────────────────────────────

  // Mapeo de dominios propios de clientes → tenantId
  const CUSTOM_DOMAIN_MAP = {
    'camperparkroquetas.com':     'camperpark-roquetas',
    'www.camperparkroquetas.com': 'camperpark-roquetas',
    'areamalagabeach.com':        'area-malaga-beach',
    'www.areamalagabeach.com':    'area-malaga-beach',
  };

  function detectTenantId() {
    const host = window.location.hostname;

    // 1. ?tenant=X en URL — fuente de verdad explícita, siempre gana
    try {
      const paramTenant = new URLSearchParams(window.location.search).get('tenant');
      if (paramTenant && /^[a-z0-9-]{2,50}$/.test(paramTenant)) {
        // Sincronizar storage con la URL para que F5 siga funcionando
        try { sessionStorage.setItem('cs_tenant', paramTenant); } catch(e) {}
        try { localStorage.setItem('cs_active_tenant', paramTenant); } catch(e) {}
        return paramTenant;
      }
    } catch(e) {}

    // 2. Dominio propio del cliente (camperparkroquetas.com, etc.)
    if (CUSTOM_DOMAIN_MAP[host]) return CUSTOM_DOMAIN_MAP[host];

    // 3. Subdominio: camperpark-roquetas.checkingsmart.com → "camperpark-roquetas"
    const parts = host.split('.');
    if (parts.length >= 3 && !['web', 'firebaseapp'].includes(parts[1])) return parts[0];

    // 4. sessionStorage — set by login portal just before redirecting
    try {
      const ssTenant = sessionStorage.getItem('cs_tenant');
      if (ssTenant && /^[a-z0-9-]{2,50}$/.test(ssTenant)) return ssTenant;
    } catch(e) {}

    // 5. localStorage — remembers last active tenant (for F5/reloads)
    try {
      const lsTenant = localStorage.getItem('cs_active_tenant');
      if (lsTenant && /^[a-z0-9-]{2,50}$/.test(lsTenant)) return lsTenant;
    } catch(e) {}

    // 6. Fallback (dominio raíz sin subdominio)
    return 'demo';
  }

  // ─── Aplicar CSS variables corporativas ─────────────────────────────────────
  function applyColors(colores) {
    const root = document.documentElement;

    // Variables de marca (usadas por admin panel y legacy)
    root.style.setProperty('--cs-primario',       colores.primario        || '#0066CC');
    root.style.setProperty('--cs-primario-dark',  colores.primarioDark    || '#004fa3');
    root.style.setProperty('--cs-secundario',     colores.secundario      || '#FF6B35');
    root.style.setProperty('--cs-acento',         colores.acento          || '#00C851');
    root.style.setProperty('--cs-fondo',          colores.fondo           || '#f8f9fa');
    root.style.setProperty('--cs-sidebar',        colores.sidebar         || '#1a1a2e');
    root.style.setProperty('--cs-sidebar-texto',  colores.sidebarTexto    || '#ffffff');
    root.style.setProperty('--cs-texto',          colores.texto           || '#333333');

    // Variables de UI completas (motor de reservas + panel de check-in)
    // Solo se aplican si el tenant las define explícitamente
    if (colores.fondo)            root.style.setProperty('--bg',          colores.fondo);
    if (colores.superficie)       root.style.setProperty('--surface',      colores.superficie);
    if (colores.superficieAlt)    root.style.setProperty('--surface-alt',  colores.superficieAlt);
    if (colores.texto)            root.style.setProperty('--text',         colores.texto);
    if (colores.textoSecundario)  root.style.setProperty('--text-sec',     colores.textoSecundario);
    if (colores.textoTerciario)   root.style.setProperty('--text-ter',     colores.textoTerciario);
    if (colores.borde)            root.style.setProperty('--border',       colores.borde);
    if (colores.primarioLight)    root.style.setProperty('--primary-l',    colores.primarioLight);
    if (colores.sombra)           root.style.setProperty('--shadow',       colores.sombra);
    if (colores.sombraGrande)     root.style.setProperty('--shadow-lg',    colores.sombraGrande);
    if (colores.heroBg)           root.style.setProperty('--hero-bg',      colores.heroBg);
  }

  // ─── Aplicar logo y nombre de empresa ───────────────────────────────────────
  function applyBranding(config) {
    // Título de la página
    document.title = config.nombre + ' — CheckingSmart';

    // Logo: cualquier elemento con data-cs-logo
    document.querySelectorAll('[data-cs-logo]').forEach(el => {
      if (el.tagName === 'IMG') {
        el.src = config.logo;
        el.alt = config.nombre;
      } else {
        el.style.backgroundImage = `url(${config.logo})`;
      }
    });

    // Nombre empresa: cualquier elemento con data-cs-nombre
    document.querySelectorAll('[data-cs-nombre]').forEach(el => {
      el.textContent = config.nombre;
    });

    // Nombre corto
    document.querySelectorAll('[data-cs-nombre-corto]').forEach(el => {
      el.textContent = config.nombreCorto || config.nombre;
    });

    // Slogan
    document.querySelectorAll('[data-cs-slogan]').forEach(el => {
      el.textContent = config.slogan || '';
    });
  }

  // ─── Guardar config globalmente ──────────────────────────────────────────────
  function storeConfig(config) {
    window.Checksmart = window.Checksmart || {};
    window.Checksmart.config = config;
    window.Checksmart.tenantId = config.tenantId;
  }

  // ─── Cargar configuración del tenant ────────────────────────────────────────
  async function loadTenant() {
    const tenantId = detectTenantId();

    try {
      const res = await fetch(`/tenants/${tenantId}.json`);
      if (!res.ok) throw new Error('Tenant no encontrado');
      const config = await res.json();

      applyColors(config.colores);
      storeConfig(config);

      // Esperar DOM si aún no está listo
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => applyBranding(config));
      } else {
        applyBranding(config);
      }

      // Disparar evento para que la app sepa que config está lista
      window.dispatchEvent(new CustomEvent('cs:config-ready', { detail: config }));

    } catch (err) {
      console.warn('[Checksmart] No se pudo cargar tenant:', tenantId, err);
      // Cargar demo como fallback (solo en localhost)
      if (tenantId !== 'demo' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
        window.location.search = '?tenant=demo';
      }
    }
  }

  // Arrancar inmediatamente (antes del DOMContentLoaded para que los colores
  // se apliquen antes del primer render)
  loadTenant();

})();
