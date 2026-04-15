/**
 * Checksmart — Firebase Cloud Functions
 *
 * redsysGateway: Genera el formulario firmado para TPV Redsys y redirige al banco.
 * El frontend hace POST aquí en lugar de a un PHP externo.
 */

const functions = require('firebase-functions/v2/https');
const { onRequest } = functions;
const admin  = require('firebase-admin');
const crypto = require('crypto');
const { Resend } = require('resend');

admin.initializeApp();

// ─── Configuración Resend (email) ────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM     = 'noreply@checksmart.com';
const EMAIL_PLATFORM = 'Checksmart';

function getResend() {
  return new Resend(RESEND_API_KEY);
}

// Plantilla email admin: nueva reserva pagada
function htmlAdminNuevaReserva(guest, tenant) {
  const nombre  = tenant.nombre  || 'Área';
  const logo    = `https://checksmart.com/assets/logo.svg`;
  const primary = (tenant.colores && tenant.colores.primario) || '#0288d1';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:'Segoe UI',Arial,sans-serif;background:#f0f4f8;margin:0;padding:0}
.wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.hdr{background:${primary};padding:28px 32px;text-align:center}
.hdr img{height:48px}
.body{padding:32px}
h2{margin:0 0 16px;color:#1a1a2e;font-size:1.3rem}
.badge{display:inline-block;background:#dcfce7;color:#16a34a;padding:4px 14px;border-radius:20px;font-weight:700;font-size:.9rem;margin-bottom:20px}
table{width:100%;border-collapse:collapse;font-size:.95rem}
td{padding:10px 12px;border-bottom:1px solid #f0f4f8;color:#374151}
td:first-child{font-weight:600;color:#6b7280;width:40%}
.btn{display:inline-block;margin-top:24px;padding:12px 28px;background:${primary};color:#fff;border-radius:8px;text-decoration:none;font-weight:700}
.ftr{background:#f8f9fa;padding:16px 32px;text-align:center;font-size:.8rem;color:#9ca3af}
</style></head><body>
<div class="wrap">
  <div class="hdr"><img src="${logo}" alt="${nombre}"></div>
  <div class="body">
    <span class="badge">💳 Pago confirmado</span>
    <h2>Nueva reserva en ${nombre}</h2>
    <table>
      <tr><td>Código</td><td><strong>${guest.bookCode || '-'}</strong></td></tr>
      <tr><td>Cliente</td><td>${guest.name || '-'}</td></tr>
      <tr><td>Email</td><td>${guest.email || '-'}</td></tr>
      <tr><td>Teléfono</td><td>${guest.phone || '-'}</td></tr>
      <tr><td>Vehículo</td><td>${guest.vehicleType || '-'} · ${guest.plate || '-'}</td></tr>
      <tr><td>Entrada</td><td>${guest.dateIn || '-'}</td></tr>
      <tr><td>Salida</td><td>${guest.dateOut || '-'}</td></tr>
      <tr><td>Noches</td><td>${guest.nights || '-'}</td></tr>
      <tr><td>Importe</td><td><strong>${guest.totalPrice || '-'} €</strong></td></tr>
      <tr><td>Pax</td><td>${guest.adults || 0} adultos · ${guest.children || 0} niños</td></tr>
    </table>
    <a class="btn" href="https://checksmart.com/app/">Abrir panel de gestión →</a>
  </div>
  <div class="ftr">Checksmart · Gestión inteligente de áreas · checksmart.com</div>
</div></body></html>`;
}

// Plantilla email cliente: confirmación de plaza
function htmlClienteConfirmacion(guest, tenant, parcela) {
  const nombre  = tenant.nombre  || 'Área';
  const primary = (tenant.colores && tenant.colores.primario) || '#0288d1';
  const email   = tenant.email   || '';
  const tel     = tenant.telefono || '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:'Segoe UI',Arial,sans-serif;background:#f0f4f8;margin:0;padding:0}
.wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.hdr{background:${primary};padding:28px 32px;text-align:center;color:#fff}
.hdr h1{margin:12px 0 0;font-size:1.4rem}
.body{padding:32px}
.badge{display:inline-block;background:#dcfce7;color:#16a34a;padding:6px 18px;border-radius:20px;font-weight:700;font-size:1rem;margin-bottom:20px}
.parcela{text-align:center;margin:24px 0;padding:20px;background:#f0f9ff;border-radius:12px;border:2px solid ${primary}}
.parcela .num{font-size:3rem;font-weight:800;color:${primary};line-height:1}
.parcela .lbl{color:#6b7280;font-size:.9rem;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:.95rem}
td{padding:10px 12px;border-bottom:1px solid #f0f4f8;color:#374151}
td:first-child{font-weight:600;color:#6b7280;width:40%}
.ftr{background:#f8f9fa;padding:20px 32px;text-align:center;font-size:.85rem;color:#6b7280}
.ftr a{color:${primary};text-decoration:none}
</style></head><body>
<div class="wrap">
  <div class="hdr">
    <div style="font-size:2rem">✅</div>
    <h1>¡Reserva confirmada!</h1>
  </div>
  <div class="body">
    <p>Hola <strong>${guest.name || 'viajero'}</strong>,</p>
    <p>Tu reserva en <strong>${nombre}</strong> está confirmada. Te esperamos.</p>
    ${parcela ? `<div class="parcela"><div class="num">${parcela}</div><div class="lbl">Tu plaza asignada</div></div>` : ''}
    <table>
      <tr><td>Código reserva</td><td><strong>${guest.bookCode || '-'}</strong></td></tr>
      <tr><td>Entrada</td><td><strong>${guest.dateIn || '-'}</strong></td></tr>
      <tr><td>Salida</td><td><strong>${guest.dateOut || '-'}</strong></td></tr>
      <tr><td>Noches</td><td>${guest.nights || '-'}</td></tr>
      <tr><td>Vehículo</td><td>${guest.vehicleType || '-'} · ${guest.plate || '-'}</td></tr>
      <tr><td>Importe pagado</td><td><strong>${guest.totalPrice || '-'} €</strong></td></tr>
    </table>
    <p style="margin-top:24px;color:#6b7280;font-size:.9rem">
      Si tienes alguna duda contáctanos en
      ${email ? `<a href="mailto:${email}" style="color:${primary}">${email}</a>` : ''}
      ${tel ? ` · ${tel}` : ''}
    </p>
  </div>
  <div class="ftr">
    ${nombre} · <a href="mailto:${email}">${email}</a><br>
    <span style="font-size:.75rem;color:#9ca3af">Gestionado con Checksmart</span>
  </div>
</div></body></html>`;
}

// ─── Configuración Redsys (variables de entorno) ──────────────────────────────
// ─── Config Redsys por tenant ─────────────────────────────────────────────────
// Cada tenant tiene sus propias credenciales en Firestore: private_config/{tenantId}
// La colección private_config está bloqueada al navegador (solo accesible desde Functions).
// Fallback global: variables de entorno (usado por 'demo' / Area Málaga Beach).

const _redsysCache = {}; // cache en memoria por instancia de la función

async function getTenantRedsys(tenantId) {
  if (_redsysCache[tenantId]) return _redsysCache[tenantId];

  try {
    const doc = await admin.firestore().collection('private_config').doc(tenantId).get();
    if (doc.exists && doc.data().redsys) {
      const r = doc.data().redsys;
      _redsysCache[tenantId] = {
        merchantCode: r.merchantCode,
        terminal:     r.terminal  || '1',
        currency:     r.currency  || '978',
        secretKey:    r.secretKey,
        live:         r.live      || false,
        endpoint:     r.live
          ? 'https://sis.redsys.es/sis/realizarPago'
          : 'https://sis-t.redsys.es:25443/sis/realizarPago',
      };
      return _redsysCache[tenantId];
    }
  } catch (e) {
    console.warn('[Redsys] No se pudo cargar config de tenant:', tenantId, e.message);
  }

  // Fallback: variables de entorno (Area Málaga Beach / demo)
  return {
    merchantCode: process.env.REDSYS_MERCHANT_CODE || '999008881',
    terminal:     process.env.REDSYS_TERMINAL      || '1',
    currency:     '978',
    secretKey:    process.env.REDSYS_SECRET        || 'sq7HjrUOBfKmC576ILgskD5srU870gJ7',
    live:         process.env.REDSYS_LIVE === 'true',
    endpoint:     process.env.REDSYS_LIVE === 'true'
      ? 'https://sis.redsys.es/sis/realizarPago'
      : 'https://sis-t.redsys.es:25443/sis/realizarPago',
  };
}

// Busca tenantId por merchantCode (usado en redsysNotification para verificar firma)
async function getTenantByMerchantCode(merchantCode) {
  try {
    const snap = await admin.firestore().collection('private_config')
      .where('redsys.merchantCode', '==', merchantCode)
      .limit(1)
      .get();
    if (!snap.empty) return snap.docs[0].id;
  } catch (e) {
    console.warn('[Redsys] Error buscando tenant por merchantCode:', e.message);
  }
  return 'demo';
}

// ─── Helpers Redsys ──────────────────────────────────────────────────────────

/**
 * Genera la firma HMAC-SHA256 según el protocolo SHA-256 de Redsys.
 */
function redsysSign(merchantParams, orderNumber, secretKey) {
  // Decodificar clave secreta de base64
  const keyBuffer = Buffer.from(secretKey, 'base64');
  // Diversificar clave con número de pedido (3DES)
  const iv = Buffer.alloc(8, 0);
  const cipher = crypto.createCipheriv('des-ede3-cbc', keyBuffer, iv);
  cipher.setAutoPadding(false);
  const orderPadded = Buffer.alloc(8, 0x00);
  Buffer.from(orderNumber.padEnd(8, '0').slice(0, 8), 'ascii').copy(orderPadded);
  const diversifiedKey = Buffer.concat([cipher.update(orderPadded), cipher.final()]);
  // HMAC-SHA256 del merchantParams (base64) con la clave diversificada
  const hmac = crypto.createHmac('sha256', diversifiedKey);
  hmac.update(merchantParams);
  return hmac.digest('base64');
}

/**
 * Construye los parámetros del comerciante para Redsys.
 */
function buildMerchantParams(params) {
  const {
    amount, order, description, email, lang,
    urlOk, urlKo, urlNotification,
    merchantCode, terminal, currency, endpoint,
    csrfToken
  } = params;

  // Redsys espera amount en céntimos, sin decimales, con ceros a la izquierda, 12 chars
  const amountCents = Math.round(parseFloat(amount) * 100).toString().padStart(12, '0');
  // Número de pedido: 4-12 chars, empieza con número
  const orderStr = order.replace(/[^A-Za-z0-9]/g, '').padStart(4, '0').slice(0, 12);

  const merchantData = {
    DS_MERCHANT_AMOUNT:          amountCents,
    DS_MERCHANT_ORDER:           orderStr,
    DS_MERCHANT_MERCHANTCODE:    merchantCode,
    DS_MERCHANT_CURRENCY:        currency,
    DS_MERCHANT_TRANSACTIONTYPE: '0',  // Autorización
    DS_MERCHANT_TERMINAL:        terminal,
    DS_MERCHANT_MERCHANTURL:     urlNotification,
    DS_MERCHANT_URLOK:           urlOk,
    DS_MERCHANT_URLKO:           urlKo,
    DS_MERCHANT_PRODUCTDESCRIPTION: (description || 'Reserva Checksmart').slice(0, 125),
    DS_MERCHANT_TITULAR:         email || '',
    DS_MERCHANT_CONSUMERLANGUAGE: lang || '001',
    DS_MERCHANT_MERCHANTDATA:    csrfToken || '',  // devuelto intacto en notificación
  };

  return Buffer.from(JSON.stringify(merchantData)).toString('base64');
}

// ─── Cloud Function: redsysGateway ───────────────────────────────────────────

exports.redsysGateway = onRequest({ region: 'europe-west1', cors: true, secrets: ['REDSYS_SECRET', 'RESEND_API_KEY', 'ADMIN_EMAIL_FALLBACK'] }, async function (req, res) {

    // CORS
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

    const body = req.body || {};
    const { amount, order, description, email, lang, csrf_token, type } = body;

    // Validaciones básicas
    if (!amount || !order) {
      res.status(400).json({ error: 'Faltan parámetros requeridos: amount, order' });
      return;
    }
    if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0 || parseFloat(amount) > 9999) {
      res.status(400).json({ error: 'Importe inválido' });
      return;
    }
    if (!/^[A-Z]{3}-[A-Z0-9]{6}$/.test(order) && !/^[A-Za-z0-9]{4,12}$/.test(order)) {
      res.status(400).json({ error: 'Número de pedido inválido' });
      return;
    }

    // Cargar credenciales Redsys del tenant
    const tenantId  = body.tenantId || 'demo';
    const cfg       = await getTenantRedsys(tenantId);
    const baseUrl   = `https://${tenantId}.checksmart.com`;

    const merchantParamsB64 = buildMerchantParams({
      amount,
      order,
      description,
      email,
      lang: lang || '001',
      urlOk:           `${baseUrl}/booking/?pago=ok&order=${order}`,
      urlKo:           `${baseUrl}/booking/?pago=ko&order=${order}`,
      urlNotification: `https://europe-west1-area-malaga-beach.cloudfunctions.net/redsysNotification`,
      merchantCode:    cfg.merchantCode,
      terminal:        cfg.terminal,
      currency:        cfg.currency,
      csrfToken:       csrf_token || '',
    });

    // Extraer número de pedido limpio para la firma
    const orderClean = order.replace(/[^A-Za-z0-9]/g, '').padStart(4, '0').slice(0, 12);
    const signature  = redsysSign(merchantParamsB64, orderClean, cfg.secretKey);

    // Devolver HTML con formulario auto-submit que redirige al banco
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Redirigiendo al banco...</title></head>
<body>
<p style="font-family:sans-serif;text-align:center;margin-top:80px">
  Redirigiendo al banco de forma segura...<br>
  <small style="color:#888">Por favor, no cierre esta ventana.</small>
</p>
<form id="f" method="POST" action="${cfg.endpoint}">
  <input type="hidden" name="Ds_SignatureVersion" value="HMAC_SHA256_V1">
  <input type="hidden" name="Ds_MerchantParameters" value="${merchantParamsB64}">
  <input type="hidden" name="Ds_Signature" value="${signature}">
</form>
<script>document.getElementById('f').submit();</script>
</body>
</html>`;

    res.set('Content-Type', 'text/html');
    res.send(html);
  });

// ─── Cloud Function: redsysNotification ──────────────────────────────────────
// Redsys envía notificación POST aquí tras cada pago. Actualizamos Firestore.

exports.redsysNotification = onRequest({ region: 'europe-west1', secrets: ['REDSYS_SECRET', 'RESEND_API_KEY', 'ADMIN_EMAIL_FALLBACK'] }, async function (req, res) {

    if (req.method !== 'POST') { res.status(405).send(''); return; }

    try {
      const { Ds_SignatureVersion, Ds_MerchantParameters, Ds_Signature } = req.body;

      if (!Ds_MerchantParameters || !Ds_Signature) {
        res.status(400).send('Bad request'); return;
      }

      // Decodificar parámetros
      const paramsStr = Buffer.from(Ds_MerchantParameters, 'base64').toString('utf8');
      const params    = JSON.parse(paramsStr);
      const order     = params.Ds_Order || '';
      const responseCode = parseInt(params.Ds_Response || '9999', 10);

      // Identificar tenant por merchantCode y cargar su clave secreta
      const merchantCode = params.Ds_MerchantCode || '';
      const tenantId     = await getTenantByMerchantCode(merchantCode);
      const cfg          = await getTenantRedsys(tenantId);

      // Verificar firma con la clave del tenant correcto
      const expectedSig = redsysSign(Ds_MerchantParameters, order, cfg.secretKey);
      if (expectedSig !== Ds_Signature) {
        console.warn('[Redsys] Firma inválida para pedido', order);
        res.status(400).send('Invalid signature'); return;
      }

      // responseCode < 100 = pago exitoso
      const success = responseCode < 100;
      const csrfToken = params.Ds_MerchantData || '';

      if (success) {
        // Buscar la reserva en Firestore y marcarla como pagada
        const db = admin.firestore();
        const bookCode = 'AMB-' + order.replace(/^0+/, '').slice(-6);

        // Buscar en todos los tenants (en producción el tenantId vendría en los datos)
        const tenantsSnap = await db.collection('tenants').listDocuments();
        for (const tenantRef of tenantsSnap) {
          const guestsSnap = await tenantRef.collection('guests')
            .where('bookCode', '==', bookCode)
            .limit(1)
            .get();
          if (!guestsSnap.empty) {
            const guestData = guestsSnap.docs[0].data();
            await guestsSnap.docs[0].ref.update({
              paid: true,
              paidMethod: 'redsys_tpv',
              paidAt: admin.firestore.FieldValue.serverTimestamp(),
              redsysOrder: order,
              redsysResponse: responseCode,
              status: 'confirmed',
            });
            console.log('[Redsys] Pago confirmado para booking', bookCode);

            // Enviar email al admin del tenant
            try {
              const tenantDoc = await tenantRef.get();
              const tenant = tenantDoc.exists ? tenantDoc.data() : {};
              const adminEmail = tenant.email || process.env.ADMIN_EMAIL_FALLBACK;
              if (adminEmail && RESEND_API_KEY) {
                const resend = getResend();
                await resend.emails.send({
                  from: `${EMAIL_PLATFORM} <${EMAIL_FROM}>`,
                  to:   adminEmail,
                  replyTo: guestData.email || undefined,
                  subject: `💳 Nueva reserva ${bookCode} — ${tenant.nombre || tenantRef.id}`,
                  html: htmlAdminNuevaReserva({ ...guestData, bookCode }, tenant),
                });
                console.log('[Email] Notificación admin enviada a', adminEmail);
              }
            } catch (emailErr) {
              console.warn('[Email] Error enviando notificación admin:', emailErr.message);
            }

            break;
          }
        }
      }

      // Redsys espera 200 OK
      res.status(200).send('OK');

    } catch (err) {
      console.error('[Redsys] Error en notificación:', err);
      res.status(500).send('Error');
    }
  });

// ─── Cloud Function: sendConfirmation ─────────────────────────────────────────
// El admin llama a esta función desde el panel para enviar la confirmación al cliente.
// POST { tenantId, guestId, parcela }  (parcela es opcional)

exports.sendConfirmation = onRequest({ region: 'europe-west1', cors: true, secrets: ['RESEND_API_KEY'] }, async function (req, res) {

  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST')   { res.status(405).send('Method not allowed'); return; }

  try {
    const { tenantId, guestId, parcela } = req.body || {};
    if (!tenantId || !guestId) {
      res.status(400).json({ error: 'Faltan tenantId o guestId' }); return;
    }

    const db        = admin.firestore();
    const tenantRef = db.collection('tenants').doc(tenantId);
    const guestRef  = tenantRef.collection('guests').doc(guestId);

    const [tenantSnap, guestSnap] = await Promise.all([tenantRef.get(), guestRef.get()]);
    if (!guestSnap.exists) {
      res.status(404).json({ error: 'Reserva no encontrada' }); return;
    }

    const tenant    = tenantSnap.exists ? tenantSnap.data() : {};
    const guest     = guestSnap.data();
    const clientEmail = guest.email;

    if (!clientEmail) {
      res.status(400).json({ error: 'El cliente no tiene email registrado' }); return;
    }
    if (!RESEND_API_KEY) {
      res.status(500).json({ error: 'Email no configurado (falta RESEND_API_KEY)' }); return;
    }

    // Si se envía parcela, actualizar Firestore
    if (parcela) {
      await guestRef.update({ parcela, confirmationSentAt: admin.firestore.FieldValue.serverTimestamp() });
    } else {
      await guestRef.update({ confirmationSentAt: admin.firestore.FieldValue.serverTimestamp() });
    }

    const resend = getResend();
    const tenantNombre = tenant.nombre || tenantId;
    const tenantEmail  = tenant.email  || EMAIL_FROM;

    await resend.emails.send({
      from:    `${tenantNombre} (via Checksmart) <${EMAIL_FROM}>`,
      to:      clientEmail,
      replyTo: tenantEmail,
      subject: `✅ Reserva confirmada ${guest.bookCode || ''} — ${tenantNombre}`,
      html:    htmlClienteConfirmacion({ ...guest, bookCode: guest.bookCode }, tenant, parcela),
    });

    console.log('[Email] Confirmación enviada a', clientEmail, 'para reserva', guest.bookCode);
    res.status(200).json({ ok: true, to: clientEmail });

  } catch (err) {
    console.error('[sendConfirmation] Error:', err);
    res.status(500).json({ error: err.message });
  }
});
