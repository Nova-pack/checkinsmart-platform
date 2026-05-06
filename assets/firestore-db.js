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
    }
  };

  // Elegir entorno:
  //  - ?env=dev|prod en la URL (fuente de verdad)
  //  - localStorage 'cs_env' (persistente entre reloads)
  //  - hostname contiene 'dev' o 'checkingsmart-dev' → dev
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
    'prices', 'prov', 'sq', 'cargos_tipos', 'invoices'
  ];

  // Mapa Firestore collection → localStorage (dirección PULL: Firestore → LS)
  var PULL_MAP = [
    { col: 'guests',       lsKey: 'global_database', wrap: function(d){ return JSON.stringify({ bookings: d }); } },
    { col: 'pitches',      lsKey: 'pitches',          wrap: JSON.stringify },
    { col: 'users',        lsKey: 'users',            wrap: JSON.stringify },
    { col: 'slog',         lsKey: 'slog',             wrap: JSON.stringify },
    { col: 'notes',        lsKey: 'notebook',         wrap: JSON.stringify },
    { col: 'waitlist',     lsKey: 'waitlist',         wrap: JSON.stringify },
    { col: 'tarifas',      lsKey: 'tarifas',          wrap: JSON.stringify },
    { col: 'store_prods',  lsKey: 'store_prods',      wrap: JSON.stringify },
    { col: 'store_sales',  lsKey: 'store_sales',      wrap: JSON.stringify },
    { col: 'scan_queue',   lsKey: 'sq',               wrap: JSON.stringify },
    { col: 'proveedores',  lsKey: 'prov',             wrap: JSON.stringify },
    { col: 'cargos_tipos', lsKey: 'cargos_tipos',     wrap: JSON.stringify },
    { col: 'invoices',     lsKey: 'invoices',         wrap: JSON.stringify }
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

  // Variante: solo escribe si el contenido difiere del actual. Devuelve true si
  // hubo escritura real. Usado por los listeners onSnapshot para evitar disparar
  // cs:data-updated cuando Firestore re-emite el mismo doc.
  //
  // TRUCO ANTI-PARPADEO: _changedBy lo añade stampActor en la ruta de escritura
  // a Firestore, pero el localStorage del cliente NO lo tiene cuando escribe.
  // Cuando onSnapshot devuelve la confirmación del servidor, el doc trae _changedBy
  // → safeWriteIfChanged ve diferencia → notify() → re-render → parpadeo.
  // Solución: siempre escribir el valor completo (para que el badge de auditoría
  // funcione), pero comparar versiones sin campos de auditoría (_changedBy,
  // _updatedAt) para determinar si hace falta disparar notify.
  var _AUDIT_FIELDS = ['_changedBy', '_updatedAt'];
  function _stripAudit(jsonStr) {
    if (!jsonStr) return jsonStr;
    try {
      var parsed = JSON.parse(jsonStr);
      function _s(v) {
        if (!v || typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(_s);
        var o = {};
        Object.keys(v).forEach(function(k) {
          if (_AUDIT_FIELDS.indexOf(k) === -1) o[k] = _s(v[k]);
        });
        return o;
      }
      return JSON.stringify(_s(parsed));
    } catch(e) { return jsonStr; }
  }
  function safeWriteIfChanged(key, jsonStr) {
    try {
      var cur = localStorage.getItem(key);
      // Siempre escribir el valor completo (preserva _changedBy para badge auditoría)
      _origSetItem(key, jsonStr);
      // Pero notificar solo si cambiaron datos reales (ignorar cambios solo de auditoría)
      return _stripAudit(cur) !== _stripAudit(jsonStr);
    } catch (e) {
      console.warn('[CS-DB] Error escribiendo localStorage:', key, e);
      return false;
    }
  }

  // Notificador de cambios en localStorage hidratados desde Firestore.
  // Disponible a nivel de módulo (tanto pullTenant como setupRealtimeListeners
  // deben poder disparar este evento).
  function notifyData(lsKey, tenantId) {
    window.dispatchEvent(
      new CustomEvent('cs:data-updated', { detail: { key: lsKey, tenantId: tenantId } })
    );
  }

  // ─── lastKnown IDs (anti-pisada en clientes con vista stale) ──────────────
  // Cuando un cliente guarda una colección "full" (tarifas, users, pitches…),
  // NO puede borrar arbitrariamente los IDs que faltan en su array local: quizá
  // otro cliente acaba de añadir un doc que este aún no ha sincronizado. Solo
  // es seguro borrar los IDs que ESTE cliente vio por última vez en Firestore.
  //
  // lastKnown guarda, por tenant+colección, el conjunto de IDs que el cliente
  // ha visto tras el pull inicial o tras cada snapshot. El diff entre lastKnown
  // y el array local indica los borrados intencionales reales.

  function _lkKey(tenantId, colName) {
    return '__cs_lastKnown_' + tenantId + '_' + colName;
  }
  function getLastKnown(tenantId, colName) {
    try {
      var raw = _origSetItem && localStorage.getItem(_lkKey(tenantId, colName));
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function setLastKnown(tenantId, colName, idsMap) {
    try { _origSetItem(_lkKey(tenantId, colName), JSON.stringify(idsMap)); }
    catch (e) { /* noop */ }
  }
  // Para uso desde onSnapshot/pull: marca exactamente los IDs que hay ahora.
  function rememberIds(tenantId, colName, docs) {
    var m = {};
    (docs || []).forEach(function (d) {
      var id = d && (d.id != null ? d.id : d._id);
      if (id != null) m[String(id)] = true;
    });
    setLastKnown(tenantId, colName, m);
  }

  // ─── Audit: _changedBy (quién hizo el cambio) ────────────────────────────
  // La app expone window.Checksmart.currentUser = { name, pin, role } tras
  // el login por PIN. Lo leemos justo antes de cada write para que Firestore
  // registre la autoría aunque el login Firebase Auth sea compartido.
  function actorName() {
    try {
      var u = window.Checksmart && window.Checksmart.currentUser;
      if (u && u.name) return String(u.name).slice(0, 60);
    } catch (e) {}
    return null;
  }
  function stampActor(data) {
    var who = actorName();
    if (who) data._changedBy = who;
    return data;
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

  function syncCollection(tenantId, colName, items, idField, opts) {
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
        stampActor(data);
        batch.set(colRef.doc(docId), data, { merge: true });
      });
      promises.push(batch.commit());
    }
    return Promise.all(promises);
  }

  // ─── PUSH completo: upsert + borrado SEGURO de docs eliminados ────────────
  // Usar para colecciones pequeñas con operaciones CRUD completas (tarifas, users…).
  // SOLO borra los IDs que este cliente VIO por última vez en Firestore y han
  // desaparecido del array local — así, si otro cliente ha añadido un doc que
  // este aún no ha sincronizado, NO lo borramos por error.
  //
  // Antes: se borraba cualquier ID en Firestore que no estuviera en items → un
  // PC con vista stale podía pisar creaciones recientes de otro PC.

  function syncCollectionFull(tenantId, colName, items, idField, opts) {
    if (!db) return Promise.resolve();
    var isInitial = !!(opts && opts.isInitial);
    var colRef = tenantCol(tenantId, colName);

    return colRef.get().then(function (snap) {
      var existingIds = {};
      snap.docs.forEach(function (d) { existingIds[d.id] = true; });

      var newIds = {};
      (items || []).forEach(function (item) {
        var id = String(item[idField]);
        if (id && id !== 'undefined') newIds[id] = true;
      });

      // Solo son candidatos a borrado los IDs que estaban en el último
      // snapshot conocido por ESTE cliente (intersección con lastKnown).
      // Si el lastKnown está vacío (primer uso) no borramos nada — es la
      // primera vez que guardamos, el estado remoto es soberano.
      var lastKnown = getLastKnown(tenantId, colName);
      var hasLastKnown = Object.keys(lastKnown).length > 0;

      // ── GUARD anti-zombificación (24/04/26) ───────────────────────────
      // SOLO en initialPush al arranque: si el remoto está vacío y el local
      // tiene items, es cache stale → NO pushear (sería zombificar).
      // Para writes runtime (creación/edición explícita del usuario), NO se
      // aplica el guard: permitimos que se suban normalmente.
      if (isInitial && !hasLastKnown && Object.keys(existingIds).length === 0 && (items || []).length > 0) {
        console.warn('[CS-DB] skip initialPush ' + colName + ' — cache stale (local=' + items.length + ', remoto=0). Evita zombificación.');
        setLastKnown(tenantId, colName, {});
        return Promise.resolve();
      }

      var toDelete = Object.keys(existingIds).filter(function (id) {
        if (newIds[id]) return false;              // sigue en el array → no borrar
        if (!hasLastKnown) return false;            // primer sync → no borrar nada
        return !!lastKnown[id];                     // solo borrar si yo lo conocía
      });

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

      // Upsert documentos nuevos/actualizados — con autoría (_changedBy)
      if (items && items.length) {
        for (var j = 0; j < items.length; j += BATCH_SIZE) {
          var bSet = db.batch();
          items.slice(j, j + BATCH_SIZE).forEach(function (item) {
            var docId = String(item[idField]);
            if (!docId || docId === 'undefined') return;
            var data = stripBase64(item);
            data._updatedAt = new Date();
            stampActor(data);
            bSet.set(colRef.doc(docId), data, { merge: true });
          });
          promises.push(bSet.commit());
        }
      }

      // Actualizar lastKnown al nuevo estado (existingIds − toDelete ∪ newIds).
      // Esto cierra la ventana de carrera: en el próximo save, ya sabemos los
      // IDs que hay realmente en Firestore tras este write.
      var newLk = {};
      Object.keys(existingIds).forEach(function (id) {
        if (toDelete.indexOf(id) === -1) newLk[id] = true;
      });
      Object.keys(newIds).forEach(function (id) { newLk[id] = true; });
      setLastKnown(tenantId, colName, newLk);

      return Promise.all(promises);
    }).catch(function (e) {
      console.warn('[CS-DB] syncCollectionFull error [' + colName + ']:', e.message || e);
    });
  }

  function syncKey(lsKey, rawValue, opts) {
    if (!db) return Promise.resolve();
    var parsed = parseKey(lsKey);
    if (!parsed) return Promise.resolve();
    var tenantId = parsed.tenantId;
    var key      = parsed.key;
    opts = opts || {};

    var data;
    try { data = JSON.parse(rawValue); } catch (e) { return Promise.resolve(); }

    switch (key) {
      case 'global_database':
        if (data && Array.isArray(data.bookings))
          return syncCollection(tenantId, 'guests', data.bookings, 'id', opts);
        break;
      case 'pitches':
        // Full: las parcelas pueden darse de alta/baja
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'pitches', data, 'code', opts);
        break;
      case 'users':
        // Full: los usuarios pueden borrarse
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'users', data, 'id', opts);
        break;
      case 'slog':
        if (Array.isArray(data)) return syncCollection(tenantId, 'slog', data, 'id');
        break;
      case 'notebook':
        // Full: las notas pueden borrarse
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'notes', data, 'id', opts);
        break;
      case 'waitlist':
        // Full: la lista de espera tiene altas y bajas
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'waitlist', data, 'id', opts);
        break;
      case 'tarifas':
        // Full: las tarifas se pueden crear y eliminar ← FIX PRINCIPAL
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'tarifas', data, 'id', opts);
        break;
      case 'store_prods':
        // Full: los productos de tienda pueden borrarse
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'store_prods', data, 'id', opts);
        break;
      case 'store_sales':
        if (Array.isArray(data)) return syncCollection(tenantId, 'store_sales', data, 'id');
        break;
      case 'sq':
        if (Array.isArray(data)) return syncCollection(tenantId, 'scan_queue', data, 'id');
        break;
      case 'prices':
        // Sin merge: el documento 'prices' es el estado COMPLETO de la configuración
        // de tarifas. Si usamos merge:true, al borrar un tipo de plaza (ej. tiposAMB["Premium"])
        // la clave no se elimina del documento en Firestore (merge solo añade/actualiza).
        // onSnapshot luego re-trae el tipo borrado y sobrescribe localStorage.
        // Escribiendo el doc completo, las eliminaciones se propagan correctamente.
        return configDoc(tenantId, 'prices').set(
          stampActor(Object.assign({}, data, { _updatedAt: new Date() })));
      case 'prov':
        // Full: los proveedores pueden borrarse
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'proveedores', data, 'id', opts);
        break;
      case 'cargos_tipos':
        // Full: los tipos de cargos extra (persona extra, fianza, etc.) pueden
        // crearse, editarse y eliminarse desde Cobro o Configuración.
        if (Array.isArray(data)) return syncCollectionFull(tenantId, 'cargos_tipos', data, 'id', opts);
        break;
      case 'priv5':
        var p1 = data && Array.isArray(data.entries)
          ? syncCollection(tenantId, 'caja_entries', data.entries, 'id')
          : Promise.resolve();
        var p2 = data && Array.isArray(data.guestRecords)
          ? syncCollection(tenantId, 'caja_records', data.guestRecords, 'id')
          : Promise.resolve();
        return Promise.all([p1, p2]);
      case 'invoices':
        // Facturas y abonos — UPSERT puro (sync, no syncCollectionFull).
        // CRITICO 06/05/2026: una factura emitida JAMAS se borra (RD 1619/2012).
        // Si necesitas anular, se emite una nota de abono (creditNote) que va
        // como nuevo doc tipo 'credit'. Cambiar de syncCollectionFull → syncCollection
        // evita que un bug del frontend (filter mal hecho, race con onSnapshot)
        // pueda borrar docs Firestore. Las reglas Firestore bloquean tambien delete.
        if (Array.isArray(data)) return syncCollection(tenantId, 'invoices', data, 'id');
        break;
    }
    return Promise.resolve();
  }

  // ─── PULL: Firestore → localStorage ───────────────────────────────────────

  // ─── Fecha límite para carga inicial de guests (últimos 30 días) ─────────
  // Cambiado de 90→30 días para aliviar sync (antes ~519 docs, ahora ~150-200).
  // Reservas más antiguas siguen buscables con searchGuests (bajo demanda).
  function guestDateThreshold() {
    var d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0]; // "YYYY-MM-DD"
  }

  // Query de guests activos/recientes — la que se usa en tiempo real.
  //
  // CRITICO 2026-05-06: filtramos por dateOut, NO por dateIn.
  // Bug previo: una reserva con dateIn:2026-04-01 dateOut:2026-05-30 (long stay
  // activa, cliente fisicamente en el camping) DESAPARECIA del listado en cuanto
  // dateIn caia fuera de la ventana de 30d. Resultado: "las reservas desaparecen"
  // mientras el cliente seguia alojado. Ahora se incluye cualquier reserva cuyo
  // dateOut sea hoy o futuro (rango -30d → infinito), cubriendo long stays.
  function guestsActiveQuery(tenantId) {
    return tenantCol(tenantId, 'guests')
      .where('dateOut', '>=', guestDateThreshold());
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
          // Registrar IDs conocidos (para borrado seguro) incluso si está vacío.
          // Para pitches forzamos siempre x.id = d.id (= docId = code) para
          // alinear lastKnown con syncCollectionFull(idField='code'). Ver el
          // listener pitches mas abajo para el contexto del bug.
          var snapDocs = snap.docs.map(function (d) {
            var x = cleanDoc(d.data());
            if (entry.col === 'pitches') {
              x.id = d.id;
            } else if (x.id == null && d.id != null) {
              x.id = d.id;
            }
            return x;
          });
          rememberIds(tid, entry.col, snapDocs);
          if (snap.empty) return;
          safeWrite(tid + '_' + entry.lsKey, entry.wrap(snapDocs));
          // Notificar a la UI que los datos recién descargados están disponibles.
          // Sin esto, componentes que usen useState(_loadX) con los defaults
          // del módulo no se refrescan cuando Firestore termina de hidratar.
          notifyData(entry.lsKey, tid);
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
        // CRÍTICO: notificar a React que los guests ya están cargados.
        // Sin esto, en sesión nueva el componente no re-renderiza hasta el primer onSnapshot.
        notifyData('global_database', tid);
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
        var _nStr = JSON.stringify({ bookings: docs });
        if (snap.metadata.hasPendingWrites) {
          safeWriteIfChanged(tid + '_global_database', _nStr); // sin notify → sin parpadeo
        } else {
          if (safeWriteIfChanged(tid + '_global_database', _nStr)) notify('global_database');
        }
      }, function (e) { console.warn('[CS-DB] snapshot guests:', e.code); })
    );

    // Parcelas (status en tiempo real)
    //
    // CRITICO 2026-05-06: forzar `x.id = d.id` (docId Firestore = code). Antes,
    // si el doc tenia un campo data.id legado numerico (1, 2, 3...), x.id se
    // quedaba con ese numero y rememberIds usaba String(1) = "1". Pero
    // syncCollectionFull para pitches usa idField="code" → existingIds tiene
    // ids tipo "P-01", "P-02". Resultado: lastKnown["P-01"] = undefined, el
    // delete-diff devolvia toDelete=[] y NUNCA se borraba ningun doc Firestore.
    // Sintoma: "borro plaza, vuelve a aparecer".
    _unsubs.push(
      tenantCol(tid, 'pitches').onSnapshot(function (snap) {
        var docs = snap.docs.map(function (d) {
          var x = cleanDoc(d.data());
          x.id = d.id; // siempre = code (= docId), no numerico legado
          return x;
        });
        rememberIds(tid, 'pitches', docs);
        if (snap.empty) return;
        var _nStr = JSON.stringify(docs);
        if (snap.metadata.hasPendingWrites) {
          safeWriteIfChanged(tid + '_pitches', _nStr);
        } else {
          if (safeWriteIfChanged(tid + '_pitches', _nStr)) notify('pitches');
        }
      }, function (e) { console.warn('[CS-DB] snapshot pitches:', e.code); })
    );

    // Usuarios autorizados (altas/bajas en tiempo real entre pestañas/dispositivos).
    // Antes faltaba este listener — al crear un usuario en el PC A no aparecía
    // en el PC B hasta recargar, y si los defaults hardcoded sobrescribían el
    // localStorage con los 3 iniciales, los reales nunca se refrescaban.
    _unsubs.push(
      tenantCol(tid, 'users').onSnapshot(function (snap) {
        var docs = snap.docs.map(function (d) {
          var x = cleanDoc(d.data()); if (x.id == null) x.id = d.id; return x;
        });
        rememberIds(tid, 'users', docs);
        var _nStr = JSON.stringify(docs);
        if (snap.metadata.hasPendingWrites) {
          safeWriteIfChanged(tid + '_users', _nStr);
        } else {
          if (safeWriteIfChanged(tid + '_users', _nStr)) notify('users');
        }
      }, function (e) { console.warn('[CS-DB] snapshot users:', e.code); })
    );

    // Precios (cambios del admin reflejados en booking engine)
    _unsubs.push(
      configDoc(tid, 'prices').onSnapshot(function (snap) {
        if (!snap.exists) return;
        var _nStr = JSON.stringify(cleanDoc(snap.data()));
        if (snap.metadata.hasPendingWrites) {
          safeWriteIfChanged(tid + '_prices', _nStr);
        } else {
          if (safeWriteIfChanged(tid + '_prices', _nStr)) notify('prices');
        }
      }, function (e) { console.warn('[CS-DB] snapshot prices:', e.code); })
    );

    // Tarifas extras (recargos/descuentos definidos por el admin)
    _unsubs.push(
      tenantCol(tid, 'tarifas').onSnapshot(function (snap) {
        var docs = snap.docs.map(function (d) {
          var x = cleanDoc(d.data()); if (x.id == null) x.id = d.id; return x;
        });
        rememberIds(tid, 'tarifas', docs);
        var _nStr = JSON.stringify(docs);
        if (snap.metadata.hasPendingWrites) {
          safeWriteIfChanged(tid + '_tarifas', _nStr);
        } else {
          if (safeWriteIfChanged(tid + '_tarifas', _nStr)) notify('tarifas');
        }
      }, function (e) { console.warn('[CS-DB] snapshot tarifas:', e.code); })
    );

    // Notas / Notebook (comunicación interna entre puestos)
    _unsubs.push(
      tenantCol(tid, 'notes').onSnapshot(function (snap) {
        var docs = snap.docs.map(function (d) {
          var x = cleanDoc(d.data()); if (x.id == null) x.id = d.id; return x;
        });
        rememberIds(tid, 'notes', docs);
        var _nStr = JSON.stringify(docs);
        if (snap.metadata.hasPendingWrites) {
          safeWriteIfChanged(tid + '_notebook', _nStr);
        } else {
          if (safeWriteIfChanged(tid + '_notebook', _nStr)) notify('notebook');
        }
      }, function (e) { console.warn('[CS-DB] snapshot notes:', e.code); })
    );

    // Lista de espera (varios puestos pueden añadir/quitar clientes en paralelo)
    _unsubs.push(
      tenantCol(tid, 'waitlist').onSnapshot(function (snap) {
        var docs = snap.docs.map(function (d) {
          var x = cleanDoc(d.data()); if (x.id == null) x.id = d.id; return x;
        });
        rememberIds(tid, 'waitlist', docs);
        var _nStr = JSON.stringify(docs);
        if (snap.metadata.hasPendingWrites) {
          safeWriteIfChanged(tid + '_waitlist', _nStr);
        } else {
          if (safeWriteIfChanged(tid + '_waitlist', _nStr)) notify('waitlist');
        }
      }, function (e) { console.warn('[CS-DB] snapshot waitlist:', e.code); })
    );

    // Productos de la tienda interna (stock compartido entre puestos)
    _unsubs.push(
      tenantCol(tid, 'store_prods').onSnapshot(function (snap) {
        var docs = snap.docs.map(function (d) {
          var x = cleanDoc(d.data()); if (x.id == null) x.id = d.id; return x;
        });
        rememberIds(tid, 'store_prods', docs);
        var _nStr = JSON.stringify(docs);
        if (snap.metadata.hasPendingWrites) {
          safeWriteIfChanged(tid + '_store_prods', _nStr);
        } else {
          if (safeWriteIfChanged(tid + '_store_prods', _nStr)) notify('store_prods');
        }
      }, function (e) { console.warn('[CS-DB] snapshot store_prods:', e.code); })
    );

    // Proveedores (alta/baja realizable desde cualquier puesto)
    _unsubs.push(
      tenantCol(tid, 'proveedores').onSnapshot(function (snap) {
        var docs = snap.docs.map(function (d) {
          var x = cleanDoc(d.data()); if (x.id == null) x.id = d.id; return x;
        });
        rememberIds(tid, 'proveedores', docs);
        var _nStr = JSON.stringify(docs);
        if (snap.metadata.hasPendingWrites) {
          safeWriteIfChanged(tid + '_prov', _nStr);
        } else {
          if (safeWriteIfChanged(tid + '_prov', _nStr)) notify('prov');
        }
      }, function (e) { console.warn('[CS-DB] snapshot proveedores:', e.code); })
    );

    // Tipos de cargos extra (persona extra, fianza, etc.) — sincronizado entre
    // puestos para que cualquier cambio en Configuración o creación ad-hoc desde
    // Cobro propague en tiempo real.
    _unsubs.push(
      tenantCol(tid, 'cargos_tipos').onSnapshot(function (snap) {
        var docs = snap.docs.map(function (d) {
          var x = cleanDoc(d.data()); if (x.id == null) x.id = d.id; return x;
        });
        rememberIds(tid, 'cargos_tipos', docs);
        var _nStr = JSON.stringify(docs);
        if (snap.metadata.hasPendingWrites) {
          safeWriteIfChanged(tid + '_cargos_tipos', _nStr);
        } else {
          if (safeWriteIfChanged(tid + '_cargos_tipos', _nStr)) notify('cargos_tipos');
        }
      }, function (e) { console.warn('[CS-DB] snapshot cargos_tipos:', e.code); })
    );

    // Facturas y abonos — sincronización en tiempo real
    _unsubs.push(
      tenantCol(tid, 'invoices').onSnapshot(function (snap) {
        var docs = snap.docs.map(function (d) {
          var x = cleanDoc(d.data()); if (x.id == null) x.id = d.id; return x;
        });
        rememberIds(tid, 'invoices', docs);
        var _nStr = JSON.stringify(docs);
        if (snap.metadata.hasPendingWrites) {
          safeWriteIfChanged(tid + '_invoices', _nStr);
        } else {
          if (safeWriteIfChanged(tid + '_invoices', _nStr)) notify('invoices');
        }
      }, function (e) { console.warn('[CS-DB] snapshot invoices:', e.code); })
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
      // Capturar valor previo ANTES de sobreescribir, para que syncCollection
      // pueda calcular el diff exacto y NO subir items que no han cambiado.
      var oldValue = null;
      try { oldValue = localStorage.getItem(key); } catch(_e) {}
      _origSetItem(key, value);
      // GUARD anti cruce de tenants (29/04/2026): si la key parsea a otro
      // tenant distinto al actual, escribir en localStorage pero NO pushear.
      // Eso evita que un superadmin con cache de varios tenants suba data del
      // tenant equivocado a Firestore (sobreescribiendo edits recientes).
      var parsed = parseKey(key);
      if (parsed) {
        var currentTenant = window.Checksmart && window.Checksmart.tenantId;
        if (currentTenant && parsed.tenantId !== currentTenant) {
          console.warn('[CS-DB] write a otro tenant ignorado:',
            parsed.tenantId, '(actual:', currentTenant + ') — key:', key);
          return; // No syncKey
        }
      }
      syncKey(key, value, { oldValue: oldValue }).catch(function (e) {
        console.warn('[CS-DB] Sync error [' + key + ']:', e.message || e);
        // Propagar a la UI — App escucha cs:write-error y muestra toast rojo.
        // Sin esto el usuario veia "Plaza guardada" en verde aunque Firestore
        // hubiera rechazado el write (permission-denied, network down, etc).
        try {
          window.dispatchEvent(new CustomEvent('cs:write-error', {
            detail: {
              key: key,
              code: e && e.code,
              message: (e && e.message) || String(e)
            }
          }));
        } catch (_) {}
      });
    };
  }

  // ─── Push inicial de datos existentes al abrir sesión ─────────────────────
  // Omite global_database (guests) — los históricos son read-only, no necesitan push.
  // Solo empuja colecciones pequeñas con operaciones CRUD activas.

  function initialPush() {
    // Guard: si el token no tiene claim de tenant, los writes van a fallar con
    // permission-denied, lo que dispara onSnapshot de rollback → notify → parpadeo.
    // En ese caso omitimos el push (los datos ya están en Firestore del pull).
    var claims = window._csTokenClaims || {};
    if (!claims.tenantId) {
      console.log('[CS-DB] initialPush omitido — token sin claim tenantId (primer login o anónimo)');
      return;
    }

    // BUG CRÍTICO ARREGLADO 29/04/2026: antes iteraba TODAS las keys de
    // localStorage. Si el navegador tenía cache de OTRO tenant (caso típico:
    // superadmin que visita varios tenants), initialPush subía cache vieja del
    // otro tenant a su path Firestore → SOBREESCRITURA DE DATOS REALES con
    // cache stale. Resultado: cruce de datos AMB↔Roquetas y pérdida de edits
    // recientes hechos por la otra recepción.
    //
    // Fix: filtrar solo keys cuyo prefix coincide con el tenant actual.
    var currentTenant = window.Checksmart && window.Checksmart.tenantId;
    if (!currentTenant) {
      console.warn('[CS-DB] initialPush omitido — sin tenantId actual');
      return;
    }
    var SKIP = ['global_database']; // guests se gestiona solo vía Firestore
    var keys = Object.keys(localStorage);
    keys.filter(function (k) {
      var parsed = parseKey(k);
      if (!parsed) return false;
      if (SKIP.indexOf(parsed.key) !== -1) return false;
      // GUARD anti cruce de tenants: solo procesar keys del tenant actual
      if (parsed.tenantId !== currentTenant) return false;
      return true;
    }).forEach(function (k) {
      // isInitial:true activa el guard anti-zombificación en syncCollectionFull
      syncKey(k, localStorage.getItem(k), { isInitial: true }).catch(function () {});
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

    // GUARD ANTI CRUCE DE DATOS (29/04/2026): si en localStorage hay claves de
    // OTROS tenants (caso superadmin que abrió antes Roquetas y ahora AMB),
    // las purgamos de la SESIÓN ACTUAL — siguen vivas en Firestore, sólo se
    // borra el cache local stale para que esta sesión solo opere con datos de
    // ESTE tenant. Sin esto, initialPush+pollers podían "rebotar" cache vieja
    // del otro tenant a su Firestore (data loss).
    try {
      var purged = 0;
      Object.keys(localStorage).forEach(function (k) {
        var parsed = parseKey(k);
        if (parsed && parsed.tenantId !== tenantId) {
          _origSetItem(k, ''); // overwrite a string vacío usando setItem original
          try { localStorage.removeItem(k); } catch(_) {}
          purged++;
        }
      });
      if (purged) console.log('[CS-DB] Purgadas', purged, 'keys de otros tenants para evitar cruce');
    } catch (e) { console.warn('[CS-DB] purge keys otro tenant error:', e.message); }

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

      // Solo habilitar persistencia en la ventana principal, no en iframes.
      // Si mapa (iframe) y app (padre) llaman ambos enablePersistence sobre el mismo
      // origen → INTERNAL ASSERTION FAILED en IndexedDB. Detectamos iframe con window!==parent.
      if (window === window.parent) {
        db.enablePersistence({ synchronizeTabs: true }).catch(function (err) {
          if (err.code === 'failed-precondition') {
            console.warn('[CS-DB] Persistencia: múltiples pestañas abiertas');
          } else if (err.code === 'unimplemented') {
            console.warn('[CS-DB] Persistencia offline no soportada');
          }
        });
      } else {
        console.log('[CS-DB] iframe detectado — persistencia offline omitida');
      }

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

        // CRÍTICO: esperar a que la sesión persistente (IndexedDB) esté lista
        // ANTES de decidir si hacer signInAnonymously. Si no esperamos,
        // onAuthStateChanged se dispara con null demasiado pronto, hacemos
        // signInAnonymously, los listeners se abren con un token sin claims y
        // todas las lecturas Firestore fallan con permission-denied —
        // aunque el user logueado en /login/ acabe de llegar a /app/.
        function _waitForSessionThen(cb){
          // Firebase 10 ofrece authStateReady() — promesa que resuelve cuando
          // la sesión persistente ya está cargada (o se ha determinado que no hay).
          if (typeof auth.authStateReady === 'function') {
            return auth.authStateReady().then(function(){ cb(auth.currentUser); });
          }
          // Fallback: dar 1.5s de gracia para que IndexedDB cargue la sesión
          // antes de asumir que no hay user.
          var settled = false;
          var unsub = auth.onAuthStateChanged(function(u){
            if (u && !settled) { settled = true; unsub(); cb(u); }
          });
          setTimeout(function(){
            if (!settled) { settled = true; try{unsub();}catch(e){} cb(auth.currentUser); }
          }, 1500);
        }

        _waitForSessionThen(function(user){
          if (user) {
            window.Checksmart.user = user;
            // Force-refresh del idToken para asegurar que contiene los custom
            // claims actuales (tenantId, role).
            user.getIdTokenResult(true).then(function(tokenResult){
              // Guardar claims para que initialPush pueda verificar si hay tenantId
              window._csTokenClaims = (tokenResult && tokenResult.claims) || {};
              proceedWithTenant();
            }).catch(function(e){
              console.warn('[CS-DB] No se pudo refrescar idToken:', e.message);
              proceedWithTenant();
            });
          } else {
            // Sin sesión real → auth anónima (motor público de reservas).
            // CRÍTICO: si estamos en /app/, los usuarios anónimos no tienen claim
            // tenantId → escrituras fallan silenciosamente. Redirigir a /login/.
            var _isAppPage = typeof window !== 'undefined' &&
              window.location && window.location.pathname &&
              (window.location.pathname.indexOf('/app') !== -1 ||
               window.location.pathname.indexOf('/app/') !== -1);
            if (_isAppPage) {
              console.warn('[CS-DB] /app/ requiere login real — redirigiendo a /login/');
              var _next = encodeURIComponent(window.location.pathname + (window.location.search || ''));
              window.location.href = '/login/?next=' + _next;
              return; // no continuar
            }
            // ──────────────────────────────────────────────────────────────────
            // BUG CRÍTICO ARREGLADO 29/04/2026: si estamos dentro de un iframe
            // (ej. mapa embebido en /app/), NO firmar anónimo. Firebase Auth
            // comparte IndexedDB entre iframes mismo origen, y signInAnonymously
            // PISA al user del parent → todos los listeners del parent fallan
            // con permission-denied (incluso aunque el parent esté logueado
            // correctamente). Síntoma: el plano abre, hace pull OK, y 30-60s
            // después todos los snapshots explotan con permission-denied
            // porque el iframe se firmó como anónimo y borró la sesión real.
            //
            // Fix: en iframe, esperar hasta 3s a que IndexedDB propague el user
            // del parent. Si tras 3s sigue sin user, abortar SIN firmar anónimo
            // (que el iframe quede sin auth — el padre sigue funcionando).
            // ──────────────────────────────────────────────────────────────────
            var _inIframe = (window.parent !== window);
            if (_inIframe) {
              console.log('[CS-DB] iframe sin auth — esperando propagación del parent (no anónimo)…');
              var _attempts = 0;
              var _iframePoll = setInterval(function(){
                _attempts++;
                var u = auth.currentUser;
                if (u && !u.isAnonymous) {
                  clearInterval(_iframePoll);
                  console.log('[CS-DB] iframe: auth del parent recibida tras', _attempts*200, 'ms');
                  window.Checksmart.user = u;
                  u.getIdTokenResult(true).then(function(tr){
                    window._csTokenClaims = (tr && tr.claims) || {};
                    proceedWithTenant();
                  }).catch(function(){ proceedWithTenant(); });
                } else if (_attempts >= 15) { // 15 * 200ms = 3s
                  clearInterval(_iframePoll);
                  console.warn('[CS-DB] iframe: sin auth tras 3s — arrancando SIN auth (no se firmará anónimo para no pisar al parent)');
                  proceedWithTenant();
                }
              }, 200);
              return;
            }
            auth.signInAnonymously().then(function(cred){
              window.Checksmart.user = cred && cred.user;
              proceedWithTenant();
            }).catch(function(e){
              console.warn('[CS-DB] Auth anónima fallida:', e.message);
              proceedWithTenant();
            });
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
