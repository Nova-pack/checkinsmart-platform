/**
 * reclasificar-inbox.js
 *
 * Busca en tenants/camperpark-roquetas/inbox todos los correos cuyo
 * summary empieza por "(error IA:" o cuya categoría es "unclassified",
 * y los vuelve a clasificar con Claude Haiku.
 *
 * Uso:
 *   node reclasificar-inbox.js <ANTHROPIC_API_KEY>
 *
 * Ejemplo (BAT lo hace automáticamente):
 *   node reclasificar-inbox.js sk-ant-api03-xxx...
 */

const admin = require('firebase-admin');
const path = require('path');
const { classifyEmail } = require('./inbox/classify');

const TENANT_ID = 'camperpark-roquetas';
const TENANT_NAME = 'Camper Park Roquetas';

async function main() {
  const apiKey = process.argv[2];
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    console.error('[ERROR] Falta la API key de Anthropic (sk-ant-...).');
    console.error('Uso: node reclasificar-inbox.js <ANTHROPIC_API_KEY>');
    process.exit(2);
  }

  // Init admin con service-account-prod
  const saPath = path.join(__dirname, 'service-account.json');
  const sa = require(saPath);
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id
  });
  const db = admin.firestore();

  console.log('[INFO] Proyecto:', sa.project_id);
  console.log('[INFO] Tenant:', TENANT_ID);

  // Cargar FAQ
  let faq = '';
  try {
    const faqSnap = await db.collection('tenants').doc(TENANT_ID)
      .collection('config').doc('faq').get();
    if (faqSnap.exists) faq = faqSnap.data().content || '';
    console.log('[INFO] FAQ cargada:', faq.length, 'chars');
  } catch (e) { console.log('[WARN] No se pudo cargar FAQ:', e.message); }

  // Buscar correos con error
  const snap = await db.collection('tenants').doc(TENANT_ID)
    .collection('inbox').get();

  const toFix = [];
  snap.forEach(doc => {
    const d = doc.data();
    const hasError = (d.summary || '').startsWith('(error IA:') ||
                     (d.summary || '').startsWith('(IA no devolvió') ||
                     (d.summary || '').startsWith('(JSON parse') ||
                     d.category === 'unclassified';
    if (hasError) toFix.push({ id: doc.id, data: d });
  });

  console.log('[INFO] Correos a reclasificar:', toFix.length);
  if (toFix.length === 0) {
    console.log('[OK] Nada que hacer. Salgo.');
    process.exit(0);
  }

  let ok = 0, fail = 0;
  for (const item of toFix) {
    const d = item.data;
    try {
      console.log('  → [' + item.id.slice(0, 50) + '...] asunto:', (d.subject || '').slice(0, 60));
      const cls = await classifyEmail({
        apiKey: apiKey,
        faqMarkdown: faq,
        tenantName: TENANT_NAME,
        subject: d.subject || '',
        bodyText: d.bodyText || '',
        fromEmail: d.from || ''
      });
      await db.collection('tenants').doc(TENANT_ID)
        .collection('inbox').doc(item.id).update({
          category: cls.category,
          confidence: cls.confidence,
          language: cls.language,
          priority: cls.priority,
          summary: cls.summary || '',
          extracted: cls.extracted || {},
          tags: cls.tags || [],
          reclassifiedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      console.log('     ✓', cls.category, '·', cls.priority, '·', (cls.summary || '').slice(0, 80));
      ok++;
    } catch (e) {
      console.log('     ✗ Error:', e.message);
      fail++;
    }
  }

  console.log('');
  console.log('==========================================');
  console.log(' RECLASIFICACIÓN TERMINADA');
  console.log('  OK:     ' + ok);
  console.log('  FALLOS: ' + fail);
  console.log('==========================================');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('[FATAL]', e);
  process.exit(1);
});
