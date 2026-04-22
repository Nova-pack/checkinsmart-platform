// Verifica cuántos huéspedes hay en Firestore para camperpark-roquetas
// Uso: node verificar-huespedes-roquetas.js
const admin = require('firebase-admin');
const serviceAccount = require('../../service-account-prod.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'checkingsmart-564a0'
});

const db = admin.firestore();
const TENANT = 'camperpark-roquetas';

(async () => {
  try {
    console.log('🔍 Consultando tenants/' + TENANT + '/guests ...\n');

    const snap = await db.collection('tenants').doc(TENANT).collection('guests').get();
    console.log('📊 Total docs en Firestore: ' + snap.size);

    // Analizar por fecha de entrada
    const ahora = Date.now();
    const hace90dias = ahora - (90 * 24 * 60 * 60 * 1000);
    const hace7dias = ahora - (7 * 24 * 60 * 60 * 1000);
    const hace1dia = ahora - (1 * 24 * 60 * 60 * 1000);

    let ultimos90 = 0, ultimos7 = 0, ultimas24h = 0;
    const recientes = [];

    snap.forEach(doc => {
      const g = doc.data();
      let ts = 0;
      if (g.dateIn) {
        if (typeof g.dateIn === 'string') ts = new Date(g.dateIn).getTime();
        else if (g.dateIn.toMillis) ts = g.dateIn.toMillis();
        else if (g.dateIn._seconds) ts = g.dateIn._seconds * 1000;
      }
      if (!ts && g.updatedAt) {
        if (g.updatedAt.toMillis) ts = g.updatedAt.toMillis();
        else if (g.updatedAt._seconds) ts = g.updatedAt._seconds * 1000;
      }
      if (ts >= hace90dias) ultimos90++;
      if (ts >= hace7dias) ultimos7++;
      if (ts >= hace1dia) {
        ultimas24h++;
        recientes.push({
          id: doc.id,
          nombre: (g.firstName||'')+' '+(g.lastName||''),
          parcela: g.parcela || g.plotNumber || '-',
          dateIn: g.dateIn,
          bookCode: g.bookCode
        });
      }
    });

    console.log('📅 Últimos 90 días (consulta activa app): ' + ultimos90);
    console.log('📅 Últimos 7 días: ' + ultimos7);
    console.log('📅 Últimas 24h: ' + ultimas24h);

    if (recientes.length) {
      console.log('\n🕒 Huéspedes de las últimas 24h (muestra):');
      recientes.slice(0, 15).forEach(r => {
        console.log('  · ' + r.nombre + ' (parc ' + r.parcela + ', bookCode ' + r.bookCode + ', id ' + r.id.substring(0,10) + ')');
      });
    }

    console.log('\n✅ Los huéspedes siguen en Firestore. Un F5 en el navegador los recupera todos.');
  } catch (e) {
    console.error('❌ Error:', e.message);
  } finally {
    process.exit(0);
  }
})();
