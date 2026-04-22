/**
 * migrate-export.js
 *
 * Exporta todos los datos del tenant especificado desde el proyecto
 * LEGACY (area-malaga-beach) a un JSON local en ./backup/.
 *
 * Recorre recursivamente subcolecciones bajo tenants/{tenantId}/*.
 * Preserva tipos nativos de Firestore (Timestamp, GeoPoint, DocumentReference).
 *
 * Uso:
 *   node migrate-export.js <tenantId>
 *
 * Ejemplos:
 *   node migrate-export.js camperpark-roquetas
 *   node migrate-export.js area-malaga-beach
 *
 * Requiere:
 *   ./service-account-legacy.json  (del proyecto area-malaga-beach)
 */

'use strict';

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');

// ─── Args ─────────────────────────────────────────────────────────────────
const tenantId = process.argv[2];
if (!tenantId) {
  console.error('❌  Falta tenantId.  Uso:  node migrate-export.js <tenantId>');
  process.exit(1);
}

// ─── Init ─────────────────────────────────────────────────────────────────
const keyPath = path.join(__dirname, 'service-account-legacy.json');
if (!fs.existsSync(keyPath)) {
  console.error('❌  No existe service-account-legacy.json en', __dirname);
  console.error('    Descárgalo desde Firebase Console del proyecto');
  console.error('    area-malaga-beach → Configuración → Cuentas de servicio');
  process.exit(1);
}

const serviceAccount = require(keyPath);
const projectId = serviceAccount.project_id;

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }, 'legacy');
const db = admin.app('legacy').firestore();

console.log(`\n📦  EXPORT  tenant="${tenantId}"  from="${projectId}"\n`);

// ─── Serialización de tipos especiales ──────────────────────────────────
// Firestore tiene tipos que JSON no puede representar. Los codificamos
// con un campo __type para poder rehidratar en import.
function encode(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof admin.firestore.Timestamp) {
    return { __type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  if (value instanceof admin.firestore.GeoPoint) {
    return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  }
  if (value instanceof admin.firestore.DocumentReference) {
    return { __type: 'ref', path: value.path };
  }
  if (Buffer.isBuffer(value)) {
    return { __type: 'bytes', base64: value.toString('base64') };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = encode(value[k]);
    return out;
  }
  return value;
}

// ─── Recorrido recursivo de colecciones ────────────────────────────────
// Paralelizamos listCollections() en bloques para no secuenciar 5000+ docs.
const PAR = 50;

async function exportCollection(collRef, indent = '  ') {
  const snapshot = await collRef.get();
  const rawDocs  = snapshot.docs;

  // Primer pase: data + listCollections en paralelo (bloques de PAR)
  const entries = new Array(rawDocs.length);
  for (let i = 0; i < rawDocs.length; i += PAR) {
    const block = rawDocs.slice(i, i + PAR);
    await Promise.all(block.map(async (doc, idx) => {
      const subColls = await doc.ref.listCollections();
      entries[i + idx] = {
        id:    doc.id,
        data:  encode(doc.data()),
        subcollections: {},
        _subColls: subColls,
      };
    }));
    if (rawDocs.length > 200 && (i + PAR) % 500 < PAR) {
      console.log(`${indent}  [${Math.min(i + PAR, rawDocs.length)}/${rawDocs.length}]`);
    }
  }

  // Segundo pase: recursivo sólo si el doc tiene subcolecciones
  for (const entry of entries) {
    for (const sub of entry._subColls) {
      console.log(`${indent}↳ ${collRef.id}/${entry.id}/${sub.id}`);
      entry.subcollections[sub.id] = await exportCollection(sub, indent + '  ');
    }
    delete entry._subColls;
  }

  return entries;
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const tenantRef = db.collection('tenants').doc(tenantId);
  const tenantSnap = await tenantRef.get();

  if (!tenantSnap.exists) {
    console.warn(`⚠️   El documento tenants/${tenantId} no existe en origen.`);
    console.warn(`    Comprobando si hay subcolecciones igualmente...`);
  }

  // Raíz: tenants/{tenantId} + subcolecciones
  const rootData = tenantSnap.exists ? encode(tenantSnap.data()) : null;
  const subColls = await tenantRef.listCollections();

  const dump = {
    exportedAt: new Date().toISOString(),
    projectId,
    tenantId,
    rootDoc: rootData,
    collections: {},
  };

  console.log(`→ tenants/${tenantId} (${subColls.length} subcolecciones)`);
  for (const coll of subColls) {
    console.log(`  📂 ${coll.id}`);
    dump.collections[coll.id] = await exportCollection(coll);
  }

  // Contadores para el resumen
  const counts = {};
  function countDocs(colls, prefix = '') {
    for (const [name, docs] of Object.entries(colls)) {
      const key = prefix + name;
      counts[key] = (counts[key] || 0) + docs.length;
      for (const d of docs) {
        countDocs(d.subcollections || {}, key + '/' + d.id + '/');
      }
    }
  }
  countDocs(dump.collections);

  // Escribir JSON
  const outPath = path.join(__dirname, 'backup', `${tenantId}-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(dump, null, 2));

  console.log('\n─── RESUMEN ────────────────────────────────────');
  for (const [k, v] of Object.entries(counts).sort()) {
    console.log(`  ${k.padEnd(50)} ${v} docs`);
  }
  console.log('─────────────────────────────────────────────────');
  console.log(`✅  Exportado a: ${outPath}`);
  console.log(`   Tamaño: ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB\n`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('❌  Error:', err); process.exit(1); });
