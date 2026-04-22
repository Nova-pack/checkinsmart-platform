/**
 * Diagnóstico demo — busca cualquier rastro _isDemo en Firestore PROD
 */
const admin = require('firebase-admin');
const sa = require('./migration/service-account-prod.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const TENANT = 'camperpark-roquetas';

(async () => {
  console.log('📡 Proyecto:', sa.project_id);
  console.log('🔍 Buscando _isDemo=true en tenants/' + TENANT + '...\n');

  const cols = ['guests', 'pitches', 'reservations', 'bookings', 'cobros', 'movements'];
  let total = 0;

  for (const colName of cols) {
    try {
      const snap = await db.collection('tenants').doc(TENANT).collection(colName)
        .where('_isDemo', '==', true).get();
      if (!snap.empty) {
        console.log('⚠️  ' + colName + ': ' + snap.size + ' docs con _isDemo=true');
        snap.docs.slice(0, 3).forEach(d => console.log('   - ' + d.id));
        if (snap.size > 3) console.log('   (... +' + (snap.size - 3) + ')');
        total += snap.size;
      } else {
        console.log('✓ ' + colName + ': limpio');
      }
    } catch (e) {
      console.log('✗ ' + colName + ': error → ' + e.message);
    }
  }

  // Chequeo extra: cualquier guest con nombre "demo" o similar
  console.log('\n🔍 Guests con nombres sospechosos...');
  const allGuests = await db.collection('tenants').doc(TENANT).collection('guests').get();
  const susp = allGuests.docs.filter(d => {
    const g = d.data();
    const name = ((g.name||'') + ' ' + (g.surname||'') + ' ' + (g.firstName||'') + ' ' + (g.lastName||'')).toLowerCase();
    return name.includes('demo') || name.includes('test') || name.includes('prueba') || name.includes('ficticio');
  });
  console.log('   Total guests: ' + allGuests.size + ' · sospechosos: ' + susp.length);
  susp.slice(0, 5).forEach(d => {
    const g = d.data();
    console.log('   - ' + d.id + ' → ' + JSON.stringify({name: g.name, surname: g.surname, _isDemo: g._isDemo}));
  });

  console.log('\n📊 Total docs _isDemo:true en Firestore: ' + total);
  process.exit(0);
})().catch(e => { console.error('❌', e); process.exit(1); });
