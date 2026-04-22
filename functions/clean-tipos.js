const admin=require('firebase-admin');
admin.initializeApp({credential:admin.credential.cert(require('/sessions/vibrant-focused-brahmagupta/mnt/CHECKINSMART/service-account-prod.json'))});
const db=admin.firestore();
(async()=>{
  const ref=db.doc('tenants/camperpark-roquetas/config/prices');
  const snap=await ref.get();
  const d=snap.data()||{};
  console.log('tiposPlazaList ANTES:',JSON.stringify(d.tiposPlazaList,null,2));
  const cleanList=(d.tiposPlazaList||[]).filter(t=>!String(t.value).startsWith('tipo_'));
  const cleanMat=Object.assign({},d.tiposAMB||{});
  Object.keys(cleanMat).forEach(k=>{ if(k.startsWith('tipo_')) delete cleanMat[k]; });
  await ref.set({tiposPlazaList:cleanList,tiposAMB:cleanMat,_updatedAt:new Date()},{merge:true});
  const snap2=await ref.get();
  console.log('tiposPlazaList DESPUES:',JSON.stringify(snap2.data().tiposPlazaList,null,2));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
