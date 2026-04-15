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

  var FIREBASE_CONFIG = {
    apiKey:            'AIzaSyDP9yWuhGPmHUByb-N7Qynh7Lc1OGZHE7k',
    authDomain:        'area-malaga-beach.firebaseapp.com',
    projectId:         'area-malaga-beach',
    storageBucket:     'area-malaga-beach.firebasestorage.app',
    messagingSenderId: '559229870217',
    appId:             '1:559229870217:web:dfa860e653300ef5efa658'
  };

  // Capturar setItem original ANTES de parchear (para escrituras internas sin re-sync)
  var _origSetItem = localStorage.setItem.bind(localStorage);

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

  // ─── PUSH: LS → Firestore (sync colección por lotes) ──────────────────────

  function syncCollection(tenantId, colName, items, idField) {
    if (!items || !items.length) return Promise.resolve();
    var BATCH_SIZE = 400;
    var promises = [];
    for (var i = 0; i < items.length; i += BATCH_SIZE) {
      var chunk = items.slice(i, i + BATCH_SIZE);
      var batch = db.batch();
      chunk.forEach(function (item) {
        var docId = String(item[idField]);
        if (!docId || docId === 'undefined') return;
        var ref  = tenantCol(tenantId, colName).doc(docId);
        var data = stripBase64(item);
        data._updatedAt = new Date();
        batch.set(ref, data, { merge: true });
      });
      promises.push(batch.commit());
    }
    return Promise.all(promises);
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
        if (Array.isArray(data)) return syncCollection(tenantId, 'pitches', data, 'code');
        break;
      case 'users':
        if (Array.isArray(data)) return syncCollection(tenantId, 'users', data, 'id');
        break;
      case 'slog':
        if (Array.isArray(data)) return syncCollection(tenantId, 'slog', data, 'id');
        break;
      case 'notebook':
        if (Array.isArray(data)) return syncCollection(tenantId, 'notes', data, 'id');
        break;
      case 'waitlist':
        if (Array.isArray(data)) return syncCollection(tenantId, 'waitlist', data, 'id');
        break;
      case 'tarifas':
        if (Array.isArray(data)) return syncCollection(tenantId, 'tarifas', data, 'id');
        break;
      case 'store_prods':
        if (Array.isArray(data)) return syncCollection(tenantId, 'store_prods', data, 'id');
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
        if (Array.isArray(data)) return syncCollection(tenantId, 'proveedores', data, 'id');
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

  function pullTenant(tenantId) {
    var tid      = tenantId;
    var promises = [];

    // Colecciones principales
    PULL_MAP.forEach(function (entry) {
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

    // Caja privada (priv5): dos colecciones → un objeto
    var cajaProm = Promise.all([
      tenantCol(tid, 'caja_entries').get(),
      tenantCol(tid, 'caja_records').get()
    ]).then(function (results) {
      var entries = results[0].docs.map(function (d) { return cleanDoc(d.data()); });
      var records = results[1].docs.map(function (d) { return cleanDoc(d.data()); });
      if (entries.length || records.length) {
        safeWrite(tid + '_priv5', JSON.stringify({ entries: entries, guestRecords: records }));
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

    // Reservas (más crítico — múltiples recepcionistas)
    _unsubs.push(
      tenantCol(tid, 'guests').onSnapshot(function (snap) {
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

  function initialPush() {
    var keys = Object.keys(localStorage);
    keys.filter(function (k) { return parseKey(k) !== null; })
        .forEach(function (k) {
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

      // Interceptar escrituras futuras
      patchLocalStorage();

      window.Checksmart = window.Checksmart || {};
      window.Checksmart.db = db;

      // Obtener tenantId: puede que config.js ya lo haya seteado, o esperar el evento
      var tid = window.Checksmart.tenantId;
      if (tid) {
        afterConfigReady(tid);
      } else {
        window.addEventListener('cs:config-ready', function onCfg(ev) {
          window.removeEventListener('cs:config-ready', onCfg);
          afterConfigReady(ev.detail && ev.detail.tenantId);
        });
        // Failsafe: si config no llega en 4s, arrancar sin pull
        setTimeout(function () {
          if (!window.Checksmart.dbReady) {
            console.warn('[CS-DB] Timeout esperando config — arrancando sin pull');
            dispatchReady();
          }
        }, 4000);
      }

    } catch (err) {
      console.warn('[CS-DB] Error inicializando Firebase:', err);
      dispatchReady();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
