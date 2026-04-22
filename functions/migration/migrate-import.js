/**
 * migrate-import.js
 *
 * Importa un JSON generado por migrate-export.js al proyecto PROD
 * (checkingsmart-564a0).  Recorre recursivamente y escribe en batches
 * de 500 operaciones (límite de Firestore).
 *
 * Rehidrata tipos especiales (Timestamp, GeoPoint, DocumentReference, Bytes).
 *
 * Uso:
 *   node migrate-import.js <archivo.json>
 *
 * Ejemplo:
 *   node migrate-import.js backup/camperpark-roquetas-1745000000000.json
 *
 * Requiere:
 *   ./service-account-prod.json  (del proyecto checkingsmart-564a0)
 *
 * IMPORTANTE: este script ESCRIBE en producción. Úsalo solo sobre
 * un tenant recién creado o tras confirmar que el destino está vacío.
 */

'use strict';

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');

// ─── Args ─────────────────────────────────────────────────────────────────
const jsonFile = process.argv[2];
if (!jsonFile) {
  console.error('❌  Falta archivo JSON.  Uso:  node migrate-import.js <archivo.json>');
  process.exit(1);
}

const jsonPath = path.resolve(jsonFile);
if (!fs.existsSync(jsonPath)) {
  console.error('❌  No existe:', jsonPath);
  process.exit(1);
}

// ─── Init ─────────────────────────────────────────────────────────────────
const keyPath = path.join(__dirname, 'service-account-prod.json');
if (!fs.existsSync(keyPath)) {
  console.error('❌  No existe service-account-prod.json en', __dirname);
  console.error('    Descárgalo desde Firebase Console del proyecto');
  console.error('    checkingsmart-564a0 → Configuración → Cuentas de servicio');
  process.exit(1);
}

const serviceAccount = require(keyPath);
const projectId = serviceAccount.project_id;

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }, 'prod');
const db = admin.app('prod').firestore();

const dump = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
console.log(`\n📥  IMPORT  tenant="${dump.tenantId}"  into="${projectId}"`);
console.log(`   origen="${dump.projectId}"  exportedAt=${dump.exportedAt}\n`);

// ─── Rehidratación ─────────────────────────────────────────────────────
function decode(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value === 'object') {
    if (value.__type === 'timestamp') {
      return new admin.firestore.Timestamp(value.seconds, value.nanoseconds);
    }
    if (value.__type === 'geopoint') {
      return new admin.firestore.GeoPoint(value.latitude, value.longitude);
    }
    if (value.__type === 'ref') {
      return db.doc(value.path);
    }
    if (value.__type === 'bytes') {
      return Buffer.from(value.base64, 'base64');
    }
    const out = {};
    for (const k of Object.keys(value)) out[k] = decode(value[k]);
    return out;
  }
  return value;
}

// ─── Batch writer ──────────────────────────────────────────────────────
// Firestore acepta 500 operaciones por batch. Si pasamos, hacemos flush.
class BatchWriter {
  constructor(db) {
    this.db = db;
    this.batch = db.batch();
    this.count = 0;
    this.total = 0;
  }
  async set(ref, data) {
    this.batch.set(ref, data);
    this.count++;
    this.total++;
    if (this.count >= 400) await this.flush();
  }
  async flush() {
    if (this.count === 0) return;
    await this.batch.commit();
    this.batch = this.db.batch();
    this.count = 0;
  }
}

// ─── Escritura recursiva ───────────────────────────────────────────────
async function importCollection(collRef, docs, writer, indent = '  ') {
  for (const entry of docs) {
    const docRef = collRef.doc(entry.id);
    await writer.set(docRef, decode(entry.data));

    for (const [subName, subDocs] of Object.entries(entry.subcollections || {})) {
      if (subDocs.length > 0) {
        console.log(`${indent}↳ ${collRef.id}/${entry.id}/${subName}  (${subDocs.length})`);
      }
      await importCollection(docRef.collection(subName), subDocs, writer, indent + '  ');
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const writer = new BatchWriter(db);
  const tenantRef = db.collection('tenants').doc(dump.tenantId);

  // Doc raíz del tenant (si existía en origen)
  if (dump.rootDoc) {
    await writer.set(tenantRef, decode(dump.rootDoc));
  }

  console.log(`→ tenants/${dump.tenantId}`);
  for (const [collName, docs] of Object.entries(dump.collections)) {
    console.log(`  📂 ${collName}  (${docs.length} docs de primer nivel)`);
    await importCollection(tenantRef.collection(collName), docs, writer);
  }

  await writer.flush();
  console.log(`\n✅  Importados ${writer.total} documentos a ${projectId}/tenants/${dump.tenantId}\n`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('❌  Error:', err); process.exit(1); });
