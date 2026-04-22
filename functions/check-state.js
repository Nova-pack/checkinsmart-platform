const admin=require('firebase-admin');
admin.initializeApp({credential:admin.credential.cert(require('/sessions/vibrant-focused-brahmagupta/mnt/CHECKINSMART/service-account-prod.json'))});
const db=admin.firestore();
(async()=>{
  const snap=await db.doc('tenants/camperpark-roquetas/config/prices').get();
  const d=snap.data()||{};
  console.log('_updatedAt:', d._updatedAt && d._updatedAt.toDate ? d._updatedAt.toDate().toISOString() : d._updatedAt);
  console.log('tiposPlazaList:', JSON.stringify(d.tiposPlazaList,null,2));
  const extras=Object.keys(d.tiposAMB||{}).filter(k=>k.startsWith('tipo_'));
  console.log('Claves huérfanas tipo_ en tiposAMB:', extras);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
