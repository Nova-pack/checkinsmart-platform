/**
 * migrate-private-config.js
 *
 * Copia la colección private_config completa de legacy → prod.
 * No está en tenants/ así que los scripts principales no la tocan.
 *
 * Uso: node migrate-private-config.js
 */

'use strict';
const admin = require('firebase-admin');
const path  = require('path');

const legacyKey = require(path.join(__dirname, 'service-account-legacy.json'));
const prodKey   = require(path.join(__dirname, 'service-account-prod.json'));

admin.initializeApp({ credential: admin.credential.cert(legacyKey) }, 'l');
admin.initializeApp({ credential: admin.credential.cert(prodKey)   }, 'p');

const lDb = admin.app('l').firestore();
const pDb = admin.app('p').firestore();

(async () => {
  const snap = await lDb.collection('private_config').get();
  console.log(`\n🔐  private_config en LEGACY: ${snap.size} docs`);
  const batch = pDb.batch();
  for (const doc of snap.docs) {
    console.log(`   → ${doc.id}`);
    batch.set(pDb.collection('private_config').doc(doc.id), doc.data(), { merge: true });
  }
  await batch.commit();

  // Verificación
  const psnap = await pDb.collection('private_config').get();
  console.log(`\n✅  private_config en PROD: ${psnap.size} docs`);
  for (const doc of psnap.docs) {
    console.log(`   · ${doc.id}:`, Object.keys(doc.data()).join(', '));
  }
  process.exit(0);
})().catch(err => { console.error('❌', err); process.exit(1); });
