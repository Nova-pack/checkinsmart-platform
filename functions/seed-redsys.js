/**
 * seed-redsys.js — Inicializa credenciales Redsys por tenant en Firestore
 *
 * Uso: node seed-redsys.js
 *
 * La colección private_config está bloqueada al navegador (Firestore rules).
 * Solo accesible desde Cloud Functions vía Admin SDK.
 */

const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json'); // descargar de Firebase Console

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'area-malaga-beach',
});

const db = admin.firestore();

const configs = {

  // ── Area Málaga Beach (demo) ───────────────────────────────────────────────
  'demo': {
    redsys: {
      merchantCode: '999008881',          // Código de comercio real de Area Málaga Beach
      terminal:     '1',
      currency:     '978',               // EUR
      secretKey:    'sq7HjrUOBfKmC576ILgskD5srU870gJ7', // Clave SHA-256 del banco
      live:         false,               // ⚠️  cambiar a true cuando sea producción
    }
  },

  // ── Camper Park Roquetas ──────────────────────────────────────────────────
  'camperpark-roquetas': {
    redsys: {
      merchantCode: 'PENDIENTE',         // ← Rellenar con código del banco
      terminal:     '1',
      currency:     '978',              // EUR
      secretKey:    'PENDIENTE',         // ← Rellenar con clave SHA-256 del banco
      live:         false,              // ⚠️  cambiar a true cuando sea producción
    }
  },

};

async function seed() {
  for (const [tenantId, data] of Object.entries(configs)) {
    await db.collection('private_config').doc(tenantId).set(data, { merge: true });
    console.log(`✅  private_config/${tenantId} guardado`);
  }
  console.log('\nListo. Recuerda actualizar los valores PENDIENTE con los datos reales del banco.');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
