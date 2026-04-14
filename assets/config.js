/**
 * CheckinSmart — Sistema de configuración multi-tenant
 * Este archivo carga la configuración del tenant activo y aplica
 * colores corporativos, logo y nombre de forma dinámica.
 */

(function () {
  'use strict';

  // ─── Detectar tenant desde subdominio o parámetro URL ───────────────────────
  function detectTenantId() {
    // ?tenant=demo (para desarrollo local)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('tenant')) return urlParams.get('tenant');

    // subdominio: demo.checkinsmart.com → "demo"
    const host = window.location.hostname;
    const parts = host.split('.');
    if (parts.length >= 3) return parts[0];

    // fallback
    return 'demo';
  }

  // ─── Aplicar CSS variables corporativas ─────────────────────────────────────
  function applyColors(colores) {
    const root = document.documentElement;
    root.style.setProperty('--cs-primario',       colores.primario      || '#0066CC');
    root.style.setProperty('--cs-primario-dark',  colores.primarioDark  || '#004fa3');
    root.style.setProperty('--cs-secundario',     colores.secundario    || '#FF6B35');
    root.style.setProperty('--cs-acento',         colores.acento        || '#00C851');
    root.style.setProperty('--cs-fondo',          colores.fondo         || '#f8f9fa');
    root.style.setProperty('--cs-sidebar',        colores.sidebar       || '#1a1a2e');
    root.style.setProperty('--cs-sidebar-texto',  colores.sidebarTexto  || '#ffffff');
    root.style.setProperty('--cs-texto',          colores.texto         || '#333333');
  }

  // ─── Aplicar logo y nombre de empresa ───────────────────────────────────────
  function applyBranding(config) {
    // Título de la página
    document.title = config.nombre + ' — CheckinSmart';

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
    window.CheckinSmart = window.CheckinSmart || {};
    window.CheckinSmart.config = config;
    window.CheckinSmart.tenantId = config.tenantId;
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
      console.warn('[CheckinSmart] No se pudo cargar tenant:', tenantId, err);
      // Cargar demo como fallback
      if (tenantId !== 'demo') {
        window.location.search = '?tenant=demo';
      }
    }
  }

  // Arrancar inmediatamente (antes del DOMContentLoaded para que los colores
  // se apliquen antes del primer render)
  loadTenant();

})();
