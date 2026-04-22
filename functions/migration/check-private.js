const admin = require('firebase-admin');
const legacyKey = require('/sessions/vibrant-focused-brahmagupta/mnt/CHECKINSMART/_platform/functions/migration/service-account-legacy.json');
const prodKey = require('/sessions/vibrant-focused-brahmagupta/mnt/CHECKINSMART/_platform/functions/migration/service-account-prod.json');
admin.initializeApp({ credential: admin.credential.cert(legacyKey) }, 'l');
admin.initializeApp({ credential: admin.credential.cert(prodKey) }, 'p');
(async () => {
  const lDb = admin.app('l').firestore();
  const pDb = admin.app('p').firestore();
  const lColl = await lDb.listCollections();
  const pColl = await pDb.listCollections();
  console.log('LEGACY root collections:', lColl.map(c=>c.id).join(', '));
  console.log('PROD   root collections:', pColl.map(c=>c.id).join(', '));
  for (const c of lColl) {
    if (c.id !== 'tenants') {
      const snap = await c.get();
      console.log(`LEGACY /${c.id} → ${snap.size} docs:`, snap.docs.map(d=>d.id).join(', '));
    }
  }
  process.exit(0);
})();
