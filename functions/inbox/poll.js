/**
 * Buzón IA — Poll IMAP de Gmail
 *
 * Lee los correos no procesados de una cuenta Gmail vía IMAP, los clasifica
 * con Claude y los guarda en Firestore bajo tenants/{tid}/inbox/{msgId}.
 *
 * Estado:
 *   private_config/{tid}_inbox-meta:
 *     lastUid: number      UID máximo procesado (IMAP)
 *     lastRunAt: Timestamp
 *     totalProcessed: number
 *     totalErrors: number
 */

const admin = require('firebase-admin');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { classifyEmail } = require('./classify');

const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;
const BATCH_MAX = 30; // correos máx. por ejecución

function _metaRef(db, tenantId) {
  return db.collection('private_config').doc(tenantId + '_inbox-meta');
}

function _inboxCol(db, tenantId) {
  return db.collection('tenants').doc(tenantId).collection('inbox');
}

function _faqRef(db, tenantId) {
  return db.collection('tenants').doc(tenantId).collection('config').doc('faq');
}

function _configRef(db, tenantId) {
  return db.collection('tenants').doc(tenantId).collection('config').doc('inbox');
}

async function _loadFaq(db, tenantId) {
  try {
    const snap = await _faqRef(db, tenantId).get();
    if (!snap.exists) return '';
    return snap.data().content || '';
  } catch (e) { return ''; }
}

async function _loadInboxConfig(db, tenantId) {
  const snap = await _configRef(db, tenantId).get();
  if (!snap.exists) return null;
  return snap.data();
}

async function _loadMeta(db, tenantId) {
  const snap = await _metaRef(db, tenantId).get();
  if (!snap.exists) return { lastUid: 0, totalProcessed: 0, totalErrors: 0 };
  return snap.data();
}

async function _saveMeta(db, tenantId, meta) {
  await _metaRef(db, tenantId).set(
    Object.assign({}, meta, { lastRunAt: admin.firestore.FieldValue.serverTimestamp() }),
    { merge: true }
  );
}

function _pickFrom(addr) {
  if (!addr) return { email: '', name: '' };
  if (Array.isArray(addr.value) && addr.value.length) {
    const a = addr.value[0];
    return { email: (a.address || '').toLowerCase(), name: a.name || '' };
  }
  return { email: '', name: '' };
}

function _buildDocId(msgObj) {
  // Gmail messageId suele ser único global; cae bien como ID de doc
  const raw = msgObj.messageId || ('uid-' + msgObj.uid + '-' + Date.now());
  return raw.replace(/[\/<>@\s]/g, '_').slice(0, 200);
}

/**
 * Procesa un tenant: conecta IMAP, lee correos nuevos, clasifica y guarda.
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.tenantName
 * @param {string} opts.gmailUser
 * @param {string} opts.gmailAppPassword
 * @param {string} opts.anthropicApiKey
 */
async function pollTenantInbox(opts) {
  const db = admin.firestore();
  const tid = opts.tenantId;
  const log = (...a) => console.log('[inbox:' + tid + ']', ...a);

  const meta = await _loadMeta(db, tid);
  const faq = await _loadFaq(db, tid);

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: opts.gmailUser, pass: opts.gmailAppPassword },
    logger: false
  });

  let processed = 0;
  let errors = 0;
  let newLastUid = meta.lastUid || 0;

  try {
    await client.connect();
    log('IMAP conectado');

    const lock = await client.getMailboxLock('INBOX');
    try {
      // Search por UID > lastUid. Si es primera vez, trae los correos de las
      // últimas 24h (leídos o no), para no perder los de prueba que el usuario
      // haya podido abrir en Gmail antes de refrescar, pero sin clasificar
      // 5 años de histórico.
      let uids;
      if (meta.lastUid && meta.lastUid > 0) {
        uids = await client.search({ uid: (meta.lastUid + 1) + ':*' });
      } else {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        uids = await client.search({ since: since });
      }

      // Limita a BATCH_MAX para no pasarse del tiempo de ejecución
      uids = (uids || []).slice(0, BATCH_MAX);
      log('correos a procesar:', uids.length);

      for (const uid of uids) {
        try {
          const msg = await client.fetchOne(uid, { source: true, envelope: true, uid: true });
          if (!msg || !msg.source) continue;

          const parsed = await simpleParser(msg.source);
          const from = _pickFrom(parsed.from);
          const to = parsed.to && parsed.to.text ? parsed.to.text : '';
          const subject = parsed.subject || '(sin asunto)';
          const bodyText = parsed.text || '';
          const bodyHtml = parsed.html || '';
          const receivedAt = parsed.date ? admin.firestore.Timestamp.fromDate(parsed.date) : admin.firestore.FieldValue.serverTimestamp();
          const messageId = parsed.messageId || ('uid-' + uid);
          const docId = _buildDocId({ messageId, uid });

          // Clasificación IA
          let cls;
          try {
            cls = await classifyEmail({
              apiKey: opts.anthropicApiKey,
              faqMarkdown: faq,
              tenantName: opts.tenantName || tid,
              subject: subject,
              bodyText: bodyText,
              fromEmail: from.email
            });
          } catch (e) {
            log('clasificación falló UID', uid, '→', e.message);
            cls = {
              category: 'unclassified',
              confidence: 0,
              language: 'other',
              priority: 'normal',
              summary: '(error IA: ' + e.message + ')',
              extracted: {},
              tags: []
            };
          }

          // Vinculación automática por email: buscamos si este remitente
          // ya figura como huésped del tenant. Si sí, enlazamos el correo
          // a su expediente para que aparezca en la pestaña 📧 Correos
          // de su ficha 360.
          let linkedGuestId = null;
          let linkedBy = null;
          if (from.email) {
            try {
              const gSnap = await db.collection('tenants').doc(tid)
                .collection('guests')
                .where('email', '==', from.email)
                .limit(1)
                .get();
              if (!gSnap.empty) {
                linkedGuestId = gSnap.docs[0].id;
                linkedBy = 'auto-email';
              }
            } catch (eLink) {
              log('auto-link falló para', from.email, '→', eLink.message);
            }
          }

          const doc = {
            messageId: messageId,
            threadId: parsed.inReplyTo || null,
            uid: uid,
            from: from.email,
            fromName: from.name,
            to: to,
            subject: subject,
            bodyText: bodyText.slice(0, 20000),
            bodyHtml: bodyHtml.slice(0, 40000),
            receivedAt: receivedAt,
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
            category: cls.category,
            confidence: cls.confidence,
            language: cls.language,
            priority: cls.priority,
            summary: cls.summary || '',
            extracted: cls.extracted || {},
            tags: cls.tags || [],
            status: 'new',
            aiDraft: '',
            source: 'gmail-imap'
          };
          if (linkedGuestId) {
            doc.linkedGuestId = linkedGuestId;
            doc.linkedBy = linkedBy;
            doc.linkedAt = admin.firestore.FieldValue.serverTimestamp();
          }

          await _inboxCol(db, tid).doc(docId).set(doc, { merge: true });
          processed++;
          if (uid > newLastUid) newLastUid = uid;

        } catch (eUid) {
          errors++;
          log('error procesando UID', uid, '→', eUid.message);
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (eConn) {
    // Log extendido para poder diagnosticar problemas de IMAP sin tener que
    // hacer otro deploy: mostramos mensaje + código + respuesta del servidor.
    log('IMAP error:', eConn.message,
        '| code=', eConn.code || '(none)',
        '| response=', (eConn.response || eConn.responseText || '').toString().slice(0, 300),
        '| authenticationFailed=', eConn.authenticationFailed || false,
        '| source=', eConn.source || '(none)',
        '| stack=', (eConn.stack || '').split('\n').slice(0, 3).join(' | '));
    errors++;
  }

  await _saveMeta(db, tid, {
    lastUid: newLastUid,
    totalProcessed: (meta.totalProcessed || 0) + processed,
    totalErrors: (meta.totalErrors || 0) + errors
  });

  log('listo · procesados=' + processed + ' · errores=' + errors + ' · lastUid=' + newLastUid);
  return { processed, errors, lastUid: newLastUid };
}

module.exports = { pollTenantInbox };
