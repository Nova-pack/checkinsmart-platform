/**
 * migrate-verify.js
 *
 * Verifica que la migración de un tenant de LEGACY (area-malaga-beach)
 * a PROD (checkingsmart-564a0) se haya completado correctamente.
 *
 * Comprueba:
 *   1. Conteo de documentos por colección/subcolección (origen vs destino)
 *   2. Muestreo aleatorio de N documentos → comparación campo a campo
 *   3. Reporta diferencias (faltantes, extras, contenido distinto)
 *
 * Uso:
 *   node migrate-verify.js <tenantId> [samplesPerCollection]
 *
 * Ejemplo:
 *   node migrate-verify.js camperpark-roquetas 20
 *   node migrate-verify.js camperpark-roquetas      (usa 10 por defecto)
 *
 * Requiere:
 *   ./service-account-legacy.json
 *   ./service-account-prod.json
 */

'use strict';

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');

// ─── Args ─────────────────────────────────────────────────────────────────
const tenantId = process.argv[2];
const samples  = parseInt(process.argv[3] || '10', 10);
if (!tenantId) {
  console.error('❌  Falta tenantId.  Uso:  node migrate-verify.js <tenantId> [samples]');
  process.exit(1);
}

// ─── Init ambos proyectos ─────────────────────────────────────────────────
function loadKey(name) {
  const p = path.join(__dirname, name);
  if (!fs.existsSync(p)) {
    console.error('❌  No existe', name, 'en', __dirname);
    process.exit(1);
  }
  return require(p);
}

const legacyKey = loadKey('service-account-legacy.json');
const prodKey   = loadKey('service-account-prod.json');

admin.initializeApp({ credential: admin.credential.cert(legacyKey) }, 'legacy');
admin.initializeApp({ credential: admin.credential.cert(prodKey)   }, 'prod');

const legacyDb = admin.app('legacy').firestore();
const prodDb   = admin.app('prod').firestore();

console.log(`\n🔍  VERIFY  tenant="${tenantId}"`);
console.log(`   legacy="${legacyKey.project_id}"`);
console.log(`   prod  ="${prodKey.project_id}"`);
console.log(`   samples por colección: ${samples}\n`);

// ─── Comparación profunda de objetos ──────────────────────────────────────
// Ignora tipos especiales (Timestamp, GeoPoint, Ref) comparando por forma.
function normalize(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof admin.firestore.Timestamp) {
    return { __t: 'ts', s: v.seconds, n: v.nanoseconds };
  }
  if (v instanceof admin.firestore.GeoPoint) {
    return { __t: 'gp', lat: v.latitude, lng: v.longitude };
  }
  if (v instanceof admin.firestore.DocumentReference) {
    return { __t: 'ref', p: v.path };
  }
  if (Buffer.isBuffer(v)) return { __t: 'bytes', b: v.toString('base64') };
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
    return out;
  }
  return v;
}

function deepEqual(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

// ─── Recorrido recursivo: devuelve mapa { path → count } ──────────────────
const PAR = 50;

async function countCollection(collRef, acc, prefix) {
  const snap = await collRef.get();
  const key  = prefix;
  acc[key] = (acc[key] || 0) + snap.size;

  // listCollections en paralelo por bloques
  const subsPerDoc = new Array(snap.docs.length);
  for (let i = 0; i < snap.docs.length; i += PAR) {
    const block = snap.docs.slice(i, i + PAR);
    await Promise.all(block.map(async (doc, idx) => {
      subsPerDoc[i + idx] = { doc, subs: await doc.ref.listCollections() };
    }));
  }

  for (const { doc, subs } of subsPerDoc) {
    for (const s of subs) {
      await countCollection(s, acc, `${prefix}/${doc.id}/${s.id}`);
    }
  }
}

async function countAll(db) {
  const root = db.collection('tenants').doc(tenantId);
  const acc  = {};
  const subs = await root.listCollections();
  for (const c of subs) {
    await countCollection(c, acc, `tenants/${tenantId}/${c.id}`);
  }
  return acc;
}

// ─── Listar todos los doc paths bajo el tenant (para muestreo) ─────────────
async function listDocPaths(collRef, out) {
  const snap = await collRef.get();
  // Paths de este nivel
  for (const doc of snap.docs) out.push(doc.ref.path);

  // listCollections en paralelo
  const subsPerDoc = new Array(snap.docs.length);
  for (let i = 0; i < snap.docs.length; i += PAR) {
    const block = snap.docs.slice(i, i + PAR);
    await Promise.all(block.map(async (doc, idx) => {
      subsPerDoc[i + idx] = await doc.ref.listCollections();
    }));
  }

  for (let i = 0; i < snap.docs.length; i++) {
    for (const s of subsPerDoc[i]) await listDocPaths(s, out);
  }
}

async function pickSamples(db, n) {
  const root = db.collection('tenants').doc(tenantId);
  const all  = [];
  // incluir el propio doc raíz si existe
  const rootSnap = await root.get();
  if (rootSnap.exists) all.push(root.path);

  const subs = await root.listCollections();
  for (const c of subs) await listDocPaths(c, all);

  // shuffle
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return { all, picks: all.slice(0, Math.min(n, all.length)) };
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  // 1. Conteos
  console.log('📊  Contando documentos en LEGACY...');
  const legacyCounts = await countAll(legacyDb);
  console.log('📊  Contando documentos en PROD...');
  const prodCounts = await countAll(prodDb);

  const allKeys = new Set([...Object.keys(legacyCounts), ...Object.keys(prodCounts)]);
  let totalLegacy = 0, totalProd = 0, mismatches = 0;

  console.log('\n─── CONTEOS ────────────────────────────────────────────────');
  console.log('  ' + 'Colección'.padEnd(60) + 'LEGACY  PROD  Δ');
  console.log('  ' + '─'.repeat(75));
  for (const k of [...allKeys].sort()) {
    const l = legacyCounts[k] || 0;
    const p = prodCounts[k] || 0;
    totalLegacy += l;
    totalProd   += p;
    const diff  = p - l;
    const mark  = diff === 0 ? '✓' : '✗';
    if (diff !== 0) mismatches++;
    const short = k.length > 58 ? '…' + k.slice(-57) : k;
    console.log(`  ${mark} ${short.padEnd(58)} ${String(l).padStart(5)}  ${String(p).padStart(4)}  ${diff >= 0 ? '+' : ''}${diff}`);
  }
  console.log('  ' + '─'.repeat(75));
  console.log(`  TOTAL                                                       ${String(totalLegacy).padStart(5)}  ${String(totalProd).padStart(4)}  ${totalProd - totalLegacy}`);

  // 2. Muestreo aleatorio
  console.log('\n─── MUESTREO ──────────────────────────────────────────────');
  const { all, picks } = await pickSamples(legacyDb, samples);
  console.log(`  Universo: ${all.length} docs · Muestra: ${picks.length}`);

  let okSamples = 0, missing = 0, diffContent = 0;
  for (const docPath of picks) {
    const lSnap = await legacyDb.doc(docPath).get();
    const pSnap = await prodDb.doc(docPath).get();

    if (!pSnap.exists) {
      console.log(`  ✗ MISSING  ${docPath}`);
      missing++;
      continue;
    }
    if (!deepEqual(lSnap.data(), pSnap.data())) {
      console.log(`  ✗ DIFF     ${docPath}`);
      diffContent++;
      continue;
    }
    okSamples++;
  }
  console.log(`  ✓ OK: ${okSamples}  ·  ✗ Missing: ${missing}  ·  ✗ Diff: ${diffContent}`);

  // 3. Veredicto
  console.log('\n─── VEREDICTO ─────────────────────────────────────────────');
  const ok = mismatches === 0 && missing === 0 && diffContent === 0;
  if (ok) {
    console.log('✅  Migración VERIFICADA. Origen y destino coinciden.');
    process.exit(0);
  } else {
    console.log('❌  Se detectaron diferencias:');
    if (mismatches   > 0) console.log(`   · ${mismatches} colecciones con conteo distinto`);
    if (missing      > 0) console.log(`   · ${missing} documentos ausentes en PROD`);
    if (diffContent  > 0) console.log(`   · ${diffContent} documentos con contenido distinto`);
    console.log('\n   Revisa el log y decide si reimportar o investigar.');
    process.exit(1);
  }
}

main().catch(err => { console.error('❌  Error:', err); process.exit(1); });
