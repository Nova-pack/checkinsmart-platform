/**
 * Checksmart — Capa de datos Firestore  FASE 2
 *
 * Flujo de datos:
 *   1. config.js detecta tenantId desde subdominio → dispara cs:config-ready
 *   2. Este script recibe el tenantId → PULL de Firestore → escribe en localStorage
 *   3. Dispara cs:db-ready → la app React monta y lee localStorage ya hidratado
 *   4. onSnapshot mantiene datos frescos durante la sesión
 *   5. localStorage.setItem interceptado → push a Firestore (fire & forget)
 */

(function () {
  'use strict';

  // ─── Config Firebase por entorno ──────────────────────────────────────────
  // PROD = checkingsmart-564a0  ·  DEV = checkingsmart-dev
  // LEGACY = area-malaga-beach (solo durante migración; se elimina después)
  var FIREBASE_CONFIGS = {
    prod: {
      apiKey:            'AIzaSyDI-kBozFUQvR3AKhe3MbVPfuVibd9S56o',
      authDomain:        'checkingsmart-564a0.firebaseapp.com',
      projectId:         'checkingsmart-564a0',
      storageBucket:     'checkingsmart-564a0.firebasestorage.app',
      messagingSenderId: '424641633126',
      appId:             '1:424641633126:web:d9db0dbd363364773cc6a7'
    },
    dev: {
      apiKey:            'AIzaSyDWIWspL6esaPOhNzuxcbjUgSzZ_I-6Yp0',
      authDomain:        'checkingsmart-dev.firebaseapp.com',
      projectId:         'checkingsmart-dev',
      storageBucket:     'checkingsmart-dev.firebasestorage.app',
      messagingSenderId: '1014452832497',
      appId:             '1:1014452832497:web:07197b232f544ea90cc150'
    },
    legacy: {
      apiKey:            'AIzaSyDP9yWuhGPmHUByb-N7Qynh7Lc1OGZHE7k',
      authDomain:        'area-malaga-beach.firebaseapp.com',
      projectId:         'area-malaga-beach',
      storageBucket:     'area-malaga-beach.firebasestorage.app',
      messagingSenderId: '559229870217',
      appId:             '1:559229870217:web:dfa860e653300ef5efa658'
    }
  };

  // Elegir entorno:
  //  - ?env=dev|prod|legacy en la URL (fuente de verdad)
  //  - localStorage 'cs_env' (persistente entre reloads)
  //  - hostname contiene 'dev' o 'checkingsmart-dev' → dev
  //  - hostname contiene 'area-malaga-beach' (firebase subdomain) → legacy
  //  - default → prod
  function detectEnv() {
    try {
      var p = new URLSearchParams(window.location.search).get('env');
      if (p && FIREBASE_CONFIGS[p]) {
        try { localStorage.setItem('cs_env', p); } catch(e) {}
        return p;
      }
    } catch(e) {}
    try {
      var saved = localStorage.getItem('cs_env');
      if (saved && FIREBASE_CONFIGS[saved]) return saved;
    } catch(e) {}
    var h = (window.location.hostname || '').toLowerCase();
    if (h.indexOf('checkingsmart-dev') !== -1 || h.indexOf('-dev.')  !== -1) return 'dev';
    if (h.indexOf('area-malaga-beach') !== -1) return 'legacy';
    return 'prod';
  }

  var CS_ENV = detectEnv();
  var FIREBASE_CONFIG = FIREBASE_CONFIGS[CS_ENV];
  try { console.info('[CS-DB] env =', CS_ENV, '· project =', FIREBASE_CONFIG.projectId); } catch(e) {}
  // Exponer por si algún consumidor (admin panel, debugging) lo necesita
  try {
    window.Checksmart = window.Checksmart || {};
    window.Checksmart.env = CS_ENV;
    window.Checksmart.firebaseProjectId = FIREBASE_CONFIG.projectId;
  } catch(e) {}

  // Capturar setItem original ANTES de parchear (para escrituras internas sin re-sync)
  var _origSetItem = localStorage.setItem.bind(localStorage);
  // Exponer para operaciones low-level (ej: borrado manual desde la app sin disparar re-sync)
  window.Checksmart = window.Checksmart || {};
  window.Checksmart._origSetItem = _origSetItem;

  // Sufijos de claves localStorage que se sincronizan
  var CS_KEYS = [
    'global_database', 'pitches', 'users', 'slog', 'notebook',
    'waitlist', 'tarifas', 'priv5', 'store_prods', 'store_sales',
    'prices', 'prov', 'sq'
  ];

  // Mapa Firestore collection → localStorage (dirección PULL: Firestore → LS)
  var PULL_MAP = [
    { col: 'guests',      lsKey: 'global_database', wrap: function(d){ return JSON.stringify({ bookings: d }); } },
    { col: 'pitches',     lsKey: 'pitches',          wrap: JSON.stringify },
    { col: 'users',       lsKey: 'users',            wrap: JSON.stringify },
    { col: 'slog',        lsKey: 'slog',             wrap: JSON.stringify },
    { col: 'notes',       lsKey: 'notebook',         wrap: JSON.stringify },
    { col: 'waitlist',    lsKey: 'waitlist',         wrap: JSON.stringify },
    { col: 'tarifas',     lsKey: 'tarifas',          wrap: JSON.stringify },
    { col: 'store_prods', lsKey: 'store_prods',      wrap: JSON.stringify },
    { col: 'store_sales', lsKey: 'store_sales',      wrap: JSON.stringify },
    { col: 'scan_queue',  lsKey: 'sq',               wrap: JSON.stringify },
    { col: 'proveedores', lsKey: 'prov',             wrap: JSON.stringify }
  ];

  var db          = null;
  var initialized = false;
  var _unsubs     = [];   // onSnapshot unsubscribers

  // ─── Helpers internos ─────────────────────────────────────────────────────

  function safeWrite(key, jsonStr) {
    try { _origSetItem(key, jsonStr); } catch (e) {
      console.warn('[CS-DB] Error escribiendo localStorage:', key, e);
    }
  }

  function cleanDoc(data) {
    var out = Object.assign({}, data);
    delete out._updatedAt;
    return out;
  }

  function parseKey(lsKey) {
    for (var i = 0; i < CS_KEYS.length; i++) {
      var suffix = '_' + CS_KEYS[i];
      if (lsKey.endsWith(suffix)) {
        var tenantId = lsKey.slice(0, lsKey.length - suffix.length);
        if (/^[a-z0-9\-]{2,50}$/.test(tenantId)) {
          return { tenantId: tenantId, key: CS_KEYS[i] };
        }
      }
    }
    return null;
  }

  // ─── Ref helpers ──────────────────────────────────────────────────────────

  function tenantCol(tenantId, colName) {
    return db.collection('tenants').doc(tenantId).collection(colName);
  }

  function configDoc(tenantId, docId) {
    return db.collection('tenants').doc(tenantId).collection('config').doc(docId);
  }

  // ─── Eliminar imágenes base64 (límite 1MB Firestore) ─────────────────────

  function stripBase64(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(stripBase64);
    var out = {};
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (typeof v === 'string' && v.startsWith('data:')) {
        out[k] = '__base64__';
      } else if (v && typeof v === 'object') {
        out[k] = stripBase64(v);
      } else {
        out[k] = v;
      }
    });
    return out;
  }

  // ─── PUSH: LS → Firestore (upsert, no borra) ─────────────────────────────
  // Usar solo para colecciones grandes donde nunca se borran registros (ej: guests).

  function syncCollection(tenantId, colName, items, idField) {
    if (!items || !items.length) return Promise.resolve();
    var colRef = tenantCol(tenantId, colName);
    var BATCH_SIZE = 400;
    var promises = [];
    for (var i = 0; i < items.length; i += BATCH_SIZE) {
      var chunk = items.slice(i, i + BATCH_SIZE);
      var batch = db.batch();
      chunk.forEach(function (item) {
        var docId = String(item[idField]);
        if (!docId || docId === 'undefined') return;
        var data = stripBase64(item);
        data._updatedAt = new Date();
        batch.set(colRef.doc(docId), data, { merge: true });
      });
      promises.push(batch.commit());
    }
    return Promise.all(promises);
  }

  // ─── PUSH completo: upsert + borrado de docs eliminados ───────────────────
  // Usar para colecciones pequeñas con operaciones CRUD completas (tarifas, users…).
  // Lee los IDs existentes en Firestore, borra los que ya no están en el array.

  function syncCollectionFull(tenantId, colName, items, idField) {
    if (!db) return Promise.resolve();
    var colRef = tenantCol(tenantId, colName);

    return colRef.get().then(function (snap) {
      var existingIds = {};
      snap.docs.forEach(function (d) { existingIds[d.id] = true; });

      var newIds = {};
      (items || []).forEach(function (item) {
        var id = String(item[idField]);
        if (id && id !== 'undefined') newIds[id] = true;
      });

      var toDelete = Object.keys(existingIds).filter(function (id) { return !newIds[id]; });

      var promises = [];
      var BATCH_SIZE = 400;

      // Borrar documentos eliminados
      if (toDelete.length) {
        for (var i = 0; i < toDelete.length; i += BATCH_SIZE) {
          var bDel = db.batch();
          toDelete.slice(i, i + BATCH_SIZE).forEach(function (id) {
            bDel.delete(colRef.doc(id));
          });
          promises.push(bDel.commit());
        }
      }

      // Upsert documentos nuevos/actualizados
      if (items && items.length) {
        for (var j = 0; j < items.length; j += BATCH_SIZE) {
          var bSet = db.batch();
          items.slice(j, j + BATCH_SIZE).forEach(function (item) {
            var docId = String(item[idField]);
            if (!docId || docId === 'undefined') return;
            var data = stripBase64(item);
            data._updatedAt = new Date();
            bSet.set(colRef.doc(docId), data, { merge: true });
          });
          promises.push(bSet.commit());
        }
      }

      return Promise.all(promises);
    }).catch(function (e) {
      console.warn('[CS-DB] syncCollectionFull error [' + colName + ']:', e.message || e);
    });
  }

  function syncKey(lsKey, rawValue) {
    if (!db) return Promise.resolve();
    var parsed = parseKey(lsKey);
    if (!parsed) return Promise.resolve();
    var tenantId = parsed.tenantId;
    var key      = parsed.key;

    var data;
    try { data = JSON.parse(rawValue); } catch (e) { return Promise.resolve(); }

    switch (key) {
      case 'global_database':
        if (data && Array.isArray(data.bookings))
          return syncCollection(tenantId, 'guests', data.bookings, 'id');
        break;
      case 'pitches':
        // Full: las parcelas pueden darse de alta/baja
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'pitches', data, 'code');
        break;
      case 'users':
        // Full: los usuarios pueden borrarse
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'users', data, 'id');
        break;
      case 'slog':
        if (Array.isArray(data)) return syncCollection(tenantId, 'slog', data, 'id');
        break;
      case 'notebook':
        // Full: las notas pueden borrarse
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'notes', data, 'id');
        break;
      case 'waitlist':
        // Full: la lista de espera tiene altas y bajas
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'waitlist', data, 'id');
        break;
      case 'tarifas':
        // Full: las tarifas se pueden crear y eliminar ← FIX PRINCIPAL
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'tarifas', data, 'id');
        break;
      case 'store_prods':
        // Full: los productos de tienda pueden borrarse
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'store_prods', data, 'id');
        break;
      case 'store_sales':
        if (Array.isArray(data)) return syncCollection(tenantId, 'store_sales', data, 'id');
        break;
      case 'sq':
        if (Array.isArray(data)) return syncCollection(tenantId, 'scan_queue', data, 'id');
        break;
      case 'prices':
        return configDoc(tenantId, 'prices').set(
          Object.assign({}, data, { _updatedAt: new Date() }), { merge: true });
      case 'prov':
        // Full: los proveedores pueden borrarse
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'proveedores', data, 'id');
        break;
      case 'priv5':
        var p1 = data && Array.isArray(data.entries)
          ? syncCollection(tenantId, 'caja_entries', data.entries, 'id')
          : Promise.resolve();
        var p2 = data && Array.isArray(data.guestRecords)
          ? syncCollection(tenantId, 'caja_records', data.guestRecords, 'id')
          : Promise.resolve();
        return Promise.all([p1, p2]);
    }
    return Promise.resolve();
  }

  // ─── PULL: Firestore → localStorage ───────────────────────────────────────

  // ─── Fecha límite para carga inicial de guests (últimos 90 días) ─────────
  function guestDateThreshold() {
    var d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().split('T')[0]; // "YYYY-MM-DD"
  }

  // Query de guests activos/recientes — la que se usa en tiempo real
  function guestsActiveQuery(tenantId) {
    return tenantCol(tenantId, 'guests')
      .where('dateIn', '>=', guestDateThreshold());
  }

  // Buscar un guest histórico por nombre o email (bajo demanda)
  function searchGuests(query) {
    if (!db || !window.Checksmart.tenantId) return Promise.resolve([]);
    var tid = window.Checksmart.tenantId;
    var q   = (query || '').trim().toLowerCase();
    if (!q || q.length < 2) return Promise.resolve([]);

    // Buscar por nombre (prefix match Firestore)
    var byName = tenantCol(tid, 'guests')
      .orderBy('name')
      .startAt(q.toUpperCase())
      .endAt(q.toUpperCase() + '\uf8ff')
      .limit(20)
      .get()
      .then(function(s){ return s.docs.map(function(d){ return cleanDoc(d.data()); }); })
      .catch(function(){ return []; });

    // Buscar por email
    var byEmail = tenantCol(tid, 'guests')
      .where('email', '==', q)
      .limit(10)
      .get()
      .then(function(s){ return s.docs.map(function(d){ return cleanDoc(d.data()); }); })
      .catch(function(){ return []; });

    return Promise.all([byName, byEmail]).then(function(results) {
      var seen = {};
      var merged = [];
      results[0].concat(results[1]).forEach(function(g) {
        var id = g.id || g.externalId || (g.name + g.dateIn);
        if (!seen[id]) { seen[id] = true; merged.push(g); }
      });
      return merged;
    });
  }

  window.Checksmart = window.Checksmart || {};
  window.Checksmart.searchGuests = searchGuests;

  function pullTenant(tenantId) {
    var tid      = tenantId;
    var promises = [];

    // Colecciones principales (excepto guests — ver abajo)
    PULL_MAP.forEach(function (entry) {
      if (entry.col === 'guests') return; // guests se carga con filtro de fecha
      var p = tenantCol(tid, entry.col).get()
        .then(function (snap) {
          if (snap.empty) return;
          var docs = snap.docs.map(function (d) { return cleanDoc(d.data()); });
          safeWrite(tid + '_' + entry.lsKey, entry.wrap(docs));
        })
        .catch(function (e) {
          console.warn('[CS-DB] Pull error [' + entry.col + ']:', e.code || e.message);
        });
      promises.push(p);
    });

    // Guests: solo últimos 90 días + activos (evita cargar miles de históricos)
    var guestsProm = guestsActiveQuery(tid).get()
      .then(function (snap) {
        var docs = snap.docs.map(function (d) { return cleanDoc(d.data()); });
        safeWrite(tid + '_global_database', JSON.stringify({ bookings: docs }));
      })
      .catch(function (e) {
        console.warn('[CS-DB] Pull error [guests]:', e.code || e.message);
      });
    promises.push(guestsProm);

    // Caja privada (priv5): dos colecciones → un objeto
    var cajaProm = Promise.all([
      tenantCol(tid, 'caja_entries').get(),
      tenantCol(tid, 'caja_records').get()
    ]).then(function (results) {
      var entries = results[0].docs.map(function (d) { return cleanDoc(d.data()); });
      var records = results[1].docs.map(function (d) { return cleanDoc(d.data()); });
      if (entries.length || records.length) {
        // Preservar el PIN local al reconstruir priv5 desde Firestore
        var existingPrv = {};
        try { existingPrv = JSON.parse(localStorage.getItem(tid + '_priv5')) || {}; } catch(e) {}
        safeWrite(tid + '_priv5', JSON.stringify({ pin: existingPrv.pin || '5555', entries: entries, guestRecords: records }));
      }
    }).catch(function (e) {
      console.warn('[CS-DB] Pull error [caja]:', e.code || e.message);
    });
    promises.push(cajaProm);

    // Precios (documento config)
    var pricesProm = configDoc(tid, 'prices').get()
      .then(function (snap) {
        if (!snap.exists) return;
        safeWrite(tid + '_prices', JSON.stringify(cleanDoc(snap.data())));
      })
      .catch(function (e) {
        console.warn('[CS-DB] Pull error [prices]:', e.code || e.message);
      });
    promises.push(pricesProm);

    return Promise.all(promises);
  }

  // ─── onSnapshot: actualizaciones en tiempo real ───────────────────────────

  function setupRealtimeListeners(tenantId) {
    var tid = tenantId;

    function notify(lsKey) {
      window.dispatchEvent(
        new CustomEvent('cs:data-updated', { detail: { key: lsKey, tenantId: tid } })
      );
    }

    // Reservas — solo últimos 90 días + activos (escala con miles de clientes)
    _unsubs.push(
      guestsActiveQuery(tid).onSnapshot(function (snap) {
        var docs = snap.docs.map(function (d) { return cleanDoc(d.data()); });
        safeWrite(tid + '_global_database', JSON.stringify({ bookings: docs }));
        notify('global_database');
      }, function (e) { console.warn('[CS-DB] snapshot guests:', e.code); })
    );

    // Parcelas (status en tiempo real)
    _unsubs.push(
      tenantCol(tid, 'pitches').onSnapshot(function (snap) {
        if (snap.empty) return;
        var docs = snap.docs.map(function (d) { return cleanDoc(d.data()); });
        safeWrite(tid + '_pitches', JSON.stringify(docs));
        notify('pitches');
      }, function (e) { console.warn('[CS-DB] snapshot pitches:', e.code); })
    );

    // Precios (cambios del admin reflejados en booking engine)
    _unsubs.push(
      configDoc(tid, 'prices').onSnapshot(function (snap) {
        if (!snap.exists) return;
        safeWrite(tid + '_prices', JSON.stringify(cleanDoc(snap.data())));
        notify('prices');
      }, function (e) { console.warn('[CS-DB] snapshot prices:', e.code); })
    );

    // Buzón IA — últimos 500 correos ordenados por recepción
    _unsubs.push(
      tenantCol(tid, 'inbox')
        .orderBy('receivedAt', 'desc')
        .limit(500)
        .onSnapshot(function (snap) {
          var docs = snap.docs.map(function (d) {
            var data = cleanDoc(d.data());
            data._id = d.id;
            // Convertir timestamps a ISO para que React pueda renderizarlos
            if (data.receivedAt && data.receivedAt.toDate)  data.receivedAt  = data.receivedAt.toDate().toISOString();
            if (data.processedAt && data.processedAt.toDate) data.processedAt = data.processedAt.toDate().toISOString();
            return data;
          });
          safeWrite(tid + '_inbox', JSON.stringify(docs));
          notify('inbox');
        }, function (e) { console.warn('[CS-DB] snapshot inbox:', e.code); })
    );
  }

  // ─── teardownListeners: libera los onSnapshot pendientes ─────────────────
  // Evita memory leak si el usuario cambia de tenant sin recargar, y libera
  // las conexiones antes de cerrar pestaña para no pagar lecturas zombie.

  function teardownListeners() {
    _unsubs.forEach(function (fn) {
      try { if (typeof fn === 'function') fn(); } catch (e) {}
    });
    _unsubs = [];
  }

  // ─── Interceptar localStorage.setItem → push a Firestore ─────────────────

  function patchLocalStorage() {
    localStorage.setItem = function (key, value) {
      _origSetItem(key, value);
      syncKey(key, value).catch(function (e) {
        console.warn('[CS-DB] Sync error [' + key + ']:', e.message || e);
      });
    };
  }

  // ─── Push inicial de datos existentes al abrir sesión ─────────────────────
  // Omite global_database (guests) — los históricos son read-only, no necesitan push.
  // Solo empuja colecciones pequeñas con operaciones CRUD activas.

  function initialPush() {
    var SKIP = ['global_database']; // guests se gestiona solo vía Firestore
    var keys = Object.keys(localStorage);
    keys.filter(function (k) {
      var parsed = parseKey(k);
      return parsed !== null && SKIP.indexOf(parsed.key) === -1;
    }).forEach(function (k) {
      syncKey(k, localStorage.getItem(k)).catch(function () {});
    });
  }

  // ─── Señal de que la app puede arrancar ───────────────────────────────────

  function dispatchReady() {
    window.Checksmart = window.Checksmart || {};
    window.Checksmart.dbReady = true;
    window.Checksmart.db     = db;
    window.dispatchEvent(new CustomEvent('cs:db-ready', { detail: { db: db } }));
  }

  // ─── Inicio después de conocer el tenantId ────────────────────────────────

  function afterConfigReady(tenantId) {
    if (!tenantId) { dispatchReady(); return; }

    console.log('[CS-DB] Iniciando FASE 2 para tenant:', tenantId);

    // 1. Pull datos desde Firestore → localStorage
    pullTenant(tenantId)
      .then(function () {
        console.log('[CS-DB] Pull completado →', tenantId);
        // 2. Activar listeners en tiempo real
        setupRealtimeListeners(tenantId);
        // 3. Señal para que la app arranque
        dispatchReady();
        // 4. Push datos locales existentes (por si hay cambios offline)
        initialPush();
      })
      .catch(function (err) {
        console.warn('[CS-DB] Error en pull inicial:', err);
        dispatchReady(); // arrancar igualmente con datos locales
      });
  }

  // ─── Inicialización principal ─────────────────────────────────────────────

  function init() {
    if (initialized) return;
    initialized = true;

    if (typeof firebase === 'undefined') {
      console.warn('[CS-DB] Firebase SDK no cargado — modo offline');
      dispatchReady();
      return;
    }

    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
      }
      db = firebase.firestore();

      db.enablePersistence({ synchronizeTabs: true }).catch(function (err) {
        if (err.code === 'failed-precondition') {
          console.warn('[CS-DB] Persistencia: múltiples pestañas abiertas');
        } else if (err.code === 'unimplemented') {
          console.warn('[CS-DB] Persistencia offline no soportada');
        }
      });

      patchLocalStorage();

      window.Checksmart = window.Checksmart || {};
      window.Checksmart.db = db;

      // ─── Auth: usar sesión existente o autenticación anónima ────────────────
      // Esto garantiza que request.auth != null en las reglas Firestore (Fase 3).
      // Si el usuario llegó desde /login (sesión Firebase activa) se usa esa sesión.
      // Si no hay sesión, se usa auth anónima como fallback temporal.
      function proceedWithTenant() {
        var tid = window.Checksmart.tenantId;
        if (tid) {
          afterConfigReady(tid);
        } else {
          window.addEventListener('cs:config-ready', function onCfg(ev) {
            window.removeEventListener('cs:config-ready', onCfg);
            afterConfigReady(ev.detail && ev.detail.tenantId);
          });
          setTimeout(function () {
            if (!window.Checksmart.dbReady) {
              console.warn('[CS-DB] Timeout esperando config — arrancando sin pull');
              dispatchReady();
            }
          }, 4000);
        }
      }

      if (firebase.auth) {
        var auth = firebase.auth();
        var _authUnsub = auth.onAuthStateChanged(function(user) {
          if (user) {
            _authUnsub(); // ya tenemos usuario
            window.Checksmart.user = user;
            proceedWithTenant();
          } else {
            // Sin sesión → auth anónima (token válido para reglas Firestore)
            auth.signInAnonymously().catch(function(e) {
              console.warn('[CS-DB] Auth anónima fallida:', e.message);
              _authUnsub();
              proceedWithTenant(); // continuar aunque falle (reglas permiten por ahora)
            });
            // onAuthStateChanged se volverá a disparar con el usuario anónimo
          }
        });
      } else {
        proceedWithTenant(); // Auth SDK no cargado, continuar sin auth
      }

    } catch (err) {
      console.warn('[CS-DB] Error inicializando Firebase:', err);
      dispatchReady();
    }
  }

  // ─── Reset total del tenant: borra todos los documentos en Firestore ─────────
  // Necesario porque syncCollection ignora arrays vacíos (no borra docs existentes).

  function deleteCollection(tenantId, colName) {
    if (!db) return Promise.resolve();
    return tenantCol(tenantId, colName).get().then(function (snap) {
      if (snap.empty) return;
      var BATCH_SIZE = 400;
      var promises = [];
      for (var i = 0; i < snap.docs.length; i += BATCH_SIZE) {
        var batch = db.batch();
        snap.docs.slice(i, i + BATCH_SIZE).forEach(function (d) { batch.delete(d.ref); });
        promises.push(batch.commit());
      }
      return Promise.all(promises);
    });
  }

  function resetTenantData(tenantId) {
    if (!db || !tenantId) return Promise.resolve();
    var COLS = [
      'guests', 'pitches', 'slog', 'notes', 'waitlist',
      'store_prods', 'store_sales', 'scan_queue', 'proveedores',
      'caja_entries', 'caja_records'
    ];
    // Borrar colecciones + doc de precios de config
    var promises = COLS.map(function (col) { return deleteCollection(tenantId, col); });
    promises.push(
      configDoc(tenantId, 'prices').delete().catch(function () {})
    );
    return Promise.all(promises);
  }

  // Exponer para uso desde app/index.html → handleReset
  window.Checksmart = window.Checksmart || {};
  window.Checksmart.resetTenant       = resetTenantData;
  window.Checksmart.teardownListeners = teardownListeners;

  // Libera listeners antes de cerrar pestaña (evita reads zombie + memory leak)
  window.addEventListener('beforeunload', teardownListeners);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
