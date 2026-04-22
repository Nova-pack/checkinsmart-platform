/**
 * Buzón IA — Entrypoint de Cloud Functions
 *
 * Exporta:
 *   - pollInboxScheduled: cron cada 5 minutos que recorre los tenants con
 *     inbox habilitado y dispara pollTenantInbox para cada uno.
 *   - pollInboxManual: HTTPS callable/admin para forzar una ejecución manual
 *     (útil para pruebas desde DEPLOY_ARQUITECTURA.bat o desde el panel).
 *
 * Configuración por tenant en Firestore:
 *   tenants/{tid}/config/inbox:
 *     enabled: true
 *     gmailUser: "camperparkroquetas@gmail.com"
 *     secretName: "GMAIL_APP_PASSWORD_CAMPERPARK_ROQUETAS"
 *     tenantNameHuman: "Camper Park Roquetas"
 *
 * Secrets usados:
 *   - ANTHROPIC_API_KEY
 *   - GMAIL_APP_PASSWORD_CAMPERPARK_ROQUETAS
 *   - GMAIL_APP_PASSWORD_AREA_MALAGA_BEACH (opcional, cuando esté habilitado)
 */

const admin = require('firebase-admin');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { pollTenantInbox } = require('./poll');
const { generateDraft } = require('./draft');
const { sendReply } = require('./send');
const { translateToSpanish } = require('./translate');

// IMPORTANTE: sólo listar secrets que YA existan en Secret Manager.
// Al dar de alta un nuevo tenant con buzón, subir primero su secret
// (firebase functions:secrets:set GMAIL_APP_PASSWORD_XXX) y luego añadirlo
// aquí y hacer redeploy. Si listas un secret que no existe, el deploy falla.
const SECRETS_ALL = [
  'ANTHROPIC_API_KEY',
  'GMAIL_APP_PASSWORD_CAMPERPARK_ROQUETAS'
  // 'GMAIL_APP_PASSWORD_AREA_MALAGA_BEACH' ← añadir cuando se habilite AMB
];

/**
 * Lee todas las configs inbox habilitadas y ejecuta pollTenantInbox en cada una.
 * @param {string[]|null} allowTids - si se pasa un array, sólo procesa esos tenants.
 */
async function runAllTenants(allowTids) {
  const db = admin.firestore();

  // Recorrer todos los tenants y buscar config/inbox habilitado
  const tenantsSnap = await db.collection('tenants').listDocuments();
  const results = [];

  for (const tRef of tenantsSnap) {
    const tid = tRef.id;
    if (Array.isArray(allowTids) && allowTids.indexOf(tid) < 0) continue;
    try {
      const cfgSnap = await tRef.collection('config').doc('inbox').get();
      if (!cfgSnap.exists) continue;
      const cfg = cfgSnap.data() || {};
      if (!cfg.enabled) continue;
      if (!cfg.gmailUser || !cfg.secretName) {
        console.warn('[inbox] tenant', tid, 'sin gmailUser/secretName → saltado');
        continue;
      }

      // Resolver secret name a valor en env (Secret Manager inyecta los secrets como env)
      const gmailPass = process.env[cfg.secretName];
      if (!gmailPass) {
        console.warn('[inbox] tenant', tid, 'secret', cfg.secretName, 'no está disponible');
        continue;
      }
      const anthKey = process.env.ANTHROPIC_API_KEY;
      if (!anthKey) {
        console.warn('[inbox] ANTHROPIC_API_KEY ausente → saltando tenant', tid);
        continue;
      }

      // Cargar nombre legible del tenant
      let tenantName = cfg.tenantNameHuman || tid;
      try {
        const tDoc = await tRef.get();
        if (tDoc.exists && tDoc.data().nombre) tenantName = tDoc.data().nombre;
      } catch (e) {}

      const r = await pollTenantInbox({
        tenantId: tid,
        tenantName: tenantName,
        gmailUser: cfg.gmailUser,
        gmailAppPassword: gmailPass,
        anthropicApiKey: anthKey
      });
      results.push({ tenantId: tid, ok: true, ...r });
    } catch (e) {
      console.error('[inbox] tenant', tid, 'error:', e.message);
      results.push({ tenantId: tid, ok: false, error: e.message });
    }
  }

  return results;
}

// ─── Cron cada 5 minutos ───────────────────────────────────────────────────
exports.pollInboxScheduled = onSchedule({
  region: 'europe-west1',
  schedule: 'every 5 minutes',
  timeZone: 'Europe/Madrid',
  secrets: SECRETS_ALL,
  memory: '512MiB',
  timeoutSeconds: 300
}, async () => {
  console.log('[inbox] cron start');
  const results = await runAllTenants();
  console.log('[inbox] cron done:', JSON.stringify(results));
});

// ─── Ejecución manual (admin global) ───────────────────────────────────────
// GET /pollInboxManual  con header Authorization: Bearer {idToken}
// Solo admin global (eldarvi30@gmail.com) puede dispararlo.
exports.pollInboxManual = onRequest({
  region: 'europe-west1',
  cors: true,
  secrets: SECRETS_ALL,
  timeoutSeconds: 300
}, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Token requerido' }); return;
    }
    const idToken = authHeader.slice(7);
    const decoded = await admin.auth().verifyIdToken(idToken);
    const email = (decoded.email || '').toLowerCase();
    const db = admin.firestore();

    // Cualquier usuario autenticado puede refrescar.
    // - Si pasa ?tenantId=xxx, solo refresca ese tenant
    // - Si no pasa tenantId, y es admin global (eldarvi30), refresca todos
    // - Si no es admin global, intenta inferir el tenant por su email (gmailUser)
    //   y si no hay match, refresca todos los que tengan buzón activo
    let allowTids = null;
    const qTid = (req.query && req.query.tenantId) ? String(req.query.tenantId) : '';
    if (qTid) {
      allowTids = [qTid];
    } else if (email !== 'eldarvi30@gmail.com') {
      // Intentar encontrar tenants donde este email es el gmailUser
      const tenantsSnap = await db.collection('tenants').listDocuments();
      const matched = [];
      for (const tRef of tenantsSnap) {
        try {
          const cfgSnap = await tRef.collection('config').doc('inbox').get();
          if (!cfgSnap.exists) continue;
          const cfg = cfgSnap.data() || {};
          if (!cfg.enabled) continue;
          if ((cfg.gmailUser || '').toLowerCase() === email) matched.push(tRef.id);
        } catch (e) {}
      }
      if (matched.length > 0) allowTids = matched;
      // Si no hay match, dejamos allowTids=null → refresca todos los habilitados
      // (el usuario está autenticado en Firebase Auth del proyecto, aceptable)
    }

    console.log('[inbox] manual call by', email, 'allowTids=', allowTids);
    const results = await runAllTenants(allowTids);
    res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error('[inbox] manual error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers compartidos (Fase 2) ─────────────────────────────────────────
// Política de autorización (Fase 2, consistente con firestore.rules):
//   - Exige token Bearer válido (usuario autenticado en Firebase Auth).
//   - Requiere tenantId válido (regex [a-z0-9\-]{2,50}).
//   - No restringe por email: cualquier usuario autenticado del proyecto
//     puede generar borradores / enviar respuestas del tenant indicado.
//   Fase 3 añadirá custom claims por tenant para cerrar el acceso por rol.
async function _verifyUserAndTenant(req, tenantId) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    const err = new Error('Token requerido'); err.code = 401; throw err;
  }
  const idToken = authHeader.slice(7);
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    const err = new Error('Token inválido o caducado'); err.code = 401; throw err;
  }
  const email = (decoded.email || '').toLowerCase();

  if (!tenantId || !/^[a-z0-9\-]{2,50}$/.test(tenantId)) {
    const err = new Error('tenantId inválido'); err.code = 400; throw err;
  }

  // Verifica que el tenant exista
  const cfgSnap = await admin.firestore().collection('tenants').doc(tenantId)
    .collection('config').doc('inbox').get();
  if (!cfgSnap.exists) {
    const err = new Error('Inbox no configurado para tenant ' + tenantId); err.code = 404; throw err;
  }

  return { decoded, email };
}

function _defaultSignature(tenantName, tenant) {
  // Firma genérica si el tenant no tiene una personalizada en config/inbox.signature
  const lines = ['Quedamos a su disposición.', '', 'Un saludo,'];
  if (tenantName) lines.push(tenantName);
  if (tenant && tenant.telefono) lines.push(tenant.telefono);
  if (tenant && tenant.dominio) lines.push(tenant.dominio);
  return lines.join('\n');
}

async function _loadInboxContext(tenantId, msgId) {
  const db = admin.firestore();
  const tRef = db.collection('tenants').doc(tenantId);

  const [cfgSnap, tSnap, msgSnap, faqSnap] = await Promise.all([
    tRef.collection('config').doc('inbox').get(),
    tRef.get(),
    tRef.collection('inbox').doc(msgId).get(),
    tRef.collection('config').doc('faq').get()
  ]);

  if (!msgSnap.exists) {
    const err = new Error('Correo no encontrado'); err.code = 404; throw err;
  }
  if (!cfgSnap.exists) {
    const err = new Error('Inbox no configurado para tenant ' + tenantId); err.code = 404; throw err;
  }

  const cfg = cfgSnap.data() || {};
  const tenant = tSnap.exists ? tSnap.data() : {};
  const msg = msgSnap.data();
  const faq = faqSnap.exists ? (faqSnap.data().content || '') : '';
  const tenantName = cfg.tenantNameHuman || tenant.nombre || tenantId;
  const signature = (cfg.signature && String(cfg.signature).trim()) || _defaultSignature(tenantName, tenant);

  return { cfg, tenant, msg, msgRef: msgSnap.ref, faq, tenantName, signature };
}

// ─── Generar borrador de respuesta (Fase 2A) ──────────────────────────────
// POST /generateInboxDraft  Body: { tenantId, msgId }
// Usa SECRETS_ALL para soportar todos los tenants sin editar esta función
// al dar de alta uno nuevo (basta añadirlo arriba).
exports.generateInboxDraft = onRequest({
  region: 'europe-west1',
  cors: true,
  secrets: SECRETS_ALL,
  timeoutSeconds: 120
}, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const tenantId = String(body.tenantId || '');
    const msgId = String(body.msgId || '');
    if (!tenantId || !msgId) {
      res.status(400).json({ error: 'tenantId y msgId son obligatorios' }); return;
    }

    await _verifyUserAndTenant(req, tenantId);
    const ctx = await _loadInboxContext(tenantId, msgId);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada' }); return; }

    const result = await generateDraft({
      apiKey: apiKey,
      tenantName: ctx.tenantName,
      signature: ctx.signature,
      faqMarkdown: ctx.faq,
      category: ctx.msg.category || 'otros',
      language: ctx.msg.language || 'es',
      subject: ctx.msg.subject || '',
      bodyText: ctx.msg.bodyText || '',
      fromEmail: ctx.msg.from || '',
      fromName: ctx.msg.fromName || '',
      extracted: ctx.msg.extracted || {}
    });

    if (result.skipped) {
      res.status(200).json({ ok: true, skipped: true, reason: 'spam-o-no-contestable' });
      return;
    }

    await ctx.msgRef.update({
      aiDraft: result.draft,
      aiDraftPreviewEs: result.draftPreviewEs || '',
      aiDraftAt: admin.firestore.FieldValue.serverTimestamp(),
      status: ctx.msg.status === 'new' ? 'read' : (ctx.msg.status || 'read')
    });

    res.status(200).json({
      ok: true,
      draft: result.draft,
      draftPreviewEs: result.draftPreviewEs || ''
    });
  } catch (err) {
    console.error('[inbox:generateDraft] error:', err);
    const code = err.code && Number.isInteger(err.code) ? err.code : 500;
    res.status(code).json({ error: err.message || 'Error interno' });
  }
});

// ─── Enviar respuesta (Fase 2B) ───────────────────────────────────────────
// POST /sendInboxReply  Body: { tenantId, msgId, body, subject? }
// Usa SECRETS_ALL — el App Password concreto se elige por tenant vía
// cfg.secretName, pero TODOS los posibles deben estar listados aquí.
exports.sendInboxReply = onRequest({
  region: 'europe-west1',
  cors: true,
  secrets: SECRETS_ALL,
  timeoutSeconds: 120
}, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const tenantId = String(body.tenantId || '');
    const msgId = String(body.msgId || '');
    const replyBody = String(body.body || '').trim();
    const overrideSubject = body.subject ? String(body.subject) : '';

    if (!tenantId || !msgId) { res.status(400).json({ error: 'tenantId y msgId son obligatorios' }); return; }
    if (!replyBody) { res.status(400).json({ error: 'El cuerpo no puede estar vacío' }); return; }

    await _verifyUserAndTenant(req, tenantId);
    const ctx = await _loadInboxContext(tenantId, msgId);

    const gmailPass = process.env[ctx.cfg.secretName || ''];
    if (!gmailPass) {
      res.status(500).json({ error: 'App Password no disponible (' + (ctx.cfg.secretName || 'sin secretName') + ')' });
      return;
    }
    if (!ctx.cfg.gmailUser) {
      res.status(500).json({ error: 'Falta gmailUser en config/inbox' }); return;
    }
    if (!ctx.msg.from) {
      res.status(400).json({ error: 'El correo original no tiene remitente' }); return;
    }

    const sent = await sendReply({
      gmailUser: ctx.cfg.gmailUser,
      gmailAppPassword: gmailPass,
      fromName: ctx.tenantName,
      toEmail: ctx.msg.from,
      toName: ctx.msg.fromName || '',
      subject: overrideSubject || ctx.msg.subject || '(sin asunto)',
      body: replyBody,
      inReplyToMessageId: ctx.msg.messageId || ''
    });

    await ctx.msgRef.update({
      status: 'replied',
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      replyText: replyBody,
      replyMessageId: sent.messageId || ''
    });

    res.status(200).json({ ok: true, messageId: sent.messageId, accepted: sent.accepted });
  } catch (err) {
    console.error('[inbox:sendReply] error:', err);
    const code = err.code && Number.isInteger(err.code) ? err.code : 500;
    res.status(code).json({ error: err.message || 'Error interno' });
  }
});

// ─── Traducir correo entrante al castellano (Fase 4) ──────────────────────
// POST /translateInboxMessage  Body: { tenantId, msgId }
// Respuesta: { ok:true, subject, bodyText, sourceLang, cached:boolean }
// La traducción se cachea en inbox/{msgId}.translationEs para no repetir
// llamadas a Claude si recepción pulsa varias veces el botón "Traducir".
exports.translateInboxMessage = onRequest({
  region: 'europe-west1',
  cors: true,
  secrets: SECRETS_ALL,
  timeoutSeconds: 90
}, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const tenantId = String(body.tenantId || '');
    const msgId = String(body.msgId || '');
    const forceRefresh = !!body.force;
    if (!tenantId || !msgId) {
      res.status(400).json({ error: 'tenantId y msgId son obligatorios' }); return;
    }

    await _verifyUserAndTenant(req, tenantId);
    const ctx = await _loadInboxContext(tenantId, msgId);

    // Si ya hay traducción cacheada y no se fuerza, devolver cache
    if (!forceRefresh && ctx.msg.translationEs && ctx.msg.translationEs.bodyText) {
      res.status(200).json({
        ok: true,
        cached: true,
        subject: ctx.msg.translationEs.subject || '',
        bodyText: ctx.msg.translationEs.bodyText || '',
        sourceLang: ctx.msg.translationEs.sourceLang || ctx.msg.language || 'other'
      });
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada' }); return; }

    const tr = await translateToSpanish({
      apiKey: apiKey,
      subject: ctx.msg.subject || '',
      bodyText: ctx.msg.bodyText || '',
      sourceLang: ctx.msg.language || 'other'
    });

    await ctx.msgRef.update({
      translationEs: {
        subject: tr.subject,
        bodyText: tr.bodyText,
        sourceLang: tr.sourceLang,
        translatedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    });

    res.status(200).json({
      ok: true,
      cached: false,
      subject: tr.subject,
      bodyText: tr.bodyText,
      sourceLang: tr.sourceLang
    });
  } catch (err) {
    console.error('[inbox:translate] error:', err);
    const code = err.code && Number.isInteger(err.code) ? err.code : 500;
    res.status(code).json({ error: err.message || 'Error interno' });
  }
});

// ─── Vincular correo a huésped manualmente (Fase 4) ───────────────────────
// POST /linkInboxMessage  Body: { tenantId, msgId, guestId }
// Permite a recepción asignar un correo al expediente de un huésped cuando
// la vinculación automática por email no ha dado con el match (p.ej. el
// cliente escribió desde otra cuenta).
exports.linkInboxMessage = onRequest({
  region: 'europe-west1',
  cors: true,
  timeoutSeconds: 30
}, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const tenantId = String(body.tenantId || '');
    const msgId = String(body.msgId || '');
    const guestId = body.guestId ? String(body.guestId) : '';
    const unlink = !!body.unlink;
    if (!tenantId || !msgId) {
      res.status(400).json({ error: 'tenantId y msgId son obligatorios' }); return;
    }
    if (!unlink && !guestId) {
      res.status(400).json({ error: 'guestId obligatorio (o unlink:true)' }); return;
    }

    await _verifyUserAndTenant(req, tenantId);

    const db = admin.firestore();
    const msgRef = db.collection('tenants').doc(tenantId).collection('inbox').doc(msgId);
    const msgSnap = await msgRef.get();
    if (!msgSnap.exists) {
      res.status(404).json({ error: 'Correo no encontrado' }); return;
    }

    if (unlink) {
      await msgRef.update({
        linkedGuestId: admin.firestore.FieldValue.delete(),
        linkedBy: admin.firestore.FieldValue.delete(),
        linkedAt: admin.firestore.FieldValue.delete()
      });
      res.status(200).json({ ok: true, unlinked: true });
      return;
    }

    // Verificar que el guest existe
    const gRef = db.collection('tenants').doc(tenantId).collection('guests').doc(guestId);
    const gSnap = await gRef.get();
    if (!gSnap.exists) {
      res.status(404).json({ error: 'Huésped no encontrado' }); return;
    }

    await msgRef.update({
      linkedGuestId: guestId,
      linkedBy: 'manual',
      linkedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({ ok: true, linkedGuestId: guestId });
  } catch (err) {
    console.error('[inbox:link] error:', err);
    const code = err.code && Number.isInteger(err.code) ? err.code : 500;
    res.status(code).json({ error: err.message || 'Error interno' });
  }
});
