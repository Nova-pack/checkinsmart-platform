/**
 * seed-redsys.js — Inicializa credenciales Redsys por tenant en Firestore
 *
 * Uso: node seed-redsys.js
 *
 * La colección private_config está bloqueada al navegador (Firestore rules).
 * Solo accesible desde Cloud Functions vía Admin SDK.
 */

const admin = require('firebase-admin');

// Usar service-account.json
let credential;
try {
  const sa = require('./service-account.json');
  credential = admin.credential.cert(sa);
  console.log('Usando service-account.json');
} catch (e) {
  console.error('No se encontró service-account.json en la carpeta functions/');
  console.error('Descárgalo de Firebase Console → Project Settings → Service Accounts → Generar nueva clave privada');
  process.exit(1);
}

admin.initializeApp({ credential, projectId: 'area-malaga-beach' });
const db = admin.firestore();

const configs = {

  // ── Area Málaga Beach (demo) ───────────────────────────────────────────────
  'demo': {
    redsys: {
      merchantCode: '999008881',
      terminal:     '1',
      currency:     '978',
      secretKey:    'sq7HjrUOBfKmC576ILgskD5srU870gJ7',
      live:         false,
    }
  },

  // ── Camper Park Roquetas ──────────────────────────────────────────────────
  'camperpark-roquetas': {
    redsys: {
      merchantCode: '363593336',
      terminal:     '1',
      currency:     '978',
      secretKey:    'sq7HjrUOBfKmC576ILgskD5srU870gJ7', // sandbox — reemplazar con clave real de producción
      live:         false,
    }
  },

};

async function seed() {
  for (const [tenantId, data] of Object.entries(configs)) {
    await db.collection('private_config').doc(tenantId).set(data, { merge: true });
    console.log(`✅  private_config/${tenantId} guardado`);
  }
  console.log('\nListo. Cambiar live:true y secretKey real cuando el banco confirme producción.');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
