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

// ─── Base URL de Cloud Functions (dinámica según proyecto) ──────────────────
// GCP expone el projectId en tiempo de ejecución. Así evitamos hardcodear
// la URL (p.ej. area-malaga-beach) y al desplegar a checkingsmart-564a0
// las URLs internas se auto-corrigen.
function _detectProjectId() {
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
  if (process.env.GCP_PROJECT)    return process.env.GCP_PROJECT;
  if (process.env.FIREBASE_CONFIG) {
    try { return JSON.parse(process.env.FIREBASE_CONFIG).projectId; } catch (e) {}
  }
  return 'checkingsmart-564a0'; // fallback de seguridad
}
const GCP_PROJECT = _detectProjectId();
const FN_BASE = `https://europe-west1-${GCP_PROJECT}.cloudfunctions.net`;

// ─── Configuración Resend (email) ────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM     = 'noreply@checkingsmart.com';
const EMAIL_PLATFORM = 'Checkingsmart';

function getResend() {
  return new Resend(RESEND_API_KEY);
}

// Plantilla email admin: nueva reserva pagada
function htmlAdminNuevaReserva(guest, tenant) {
  const nombre  = tenant.nombre  || 'Área';
  const logo    = `https://checkingsmart.com/assets/logo.svg`;
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
    <a class="btn" href="https://checkingsmart.com/app/">Abrir panel de gestión →</a>
  </div>
  <div class="ftr">Checkingsmart · Gestión inteligente de áreas · checkingsmart.com</div>
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
    <span style="font-size:.75rem;color:#9ca3af">Gestionado con Checkingsmart</span>
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
 * Genera la firma según el protocolo oficial HMAC_SHA256_V1 de Redsys.
 *
 * Referencias:
 *  - https://pagosonline.redsys.es/conexion-redireccion.html
 *  - Librería oficial redsys-easy (Node) — algoritmo idéntico
 *
 * Algoritmo:
 * 1. Decodificar la secretKey de base64 → 24 bytes (clave 3DES)
 * 2. Diversificar clave: 3DES-EDE-CBC(orderNumber con zero-padding, key, iv=0x00*8)
 * 3. HMAC-SHA256(merchantParamsB64, diversifiedKey) → base64 → Ds_Signature
 *
 * Notas:
 *  - La IV es de 8 bytes (blocksize de 3DES), no de 16 como AES.
 *  - El padding es con bytes 0x00 hasta completar bloque (NO PKCS7).
 *  - La firma se codifica en base64 estándar, NO base64url.
 */
function redsysSign(merchantParams, orderNumber, secretKey) {
  // 1. Decodificar clave base64 → 24 bytes (3DES key)
  const key = Buffer.from(secretKey, 'base64');
  // 2. 3DES-CBC con zero-padding sobre el orderNumber
  const BLOCK = 8;
  const iv = Buffer.alloc(BLOCK, 0);
  const orderBuf = Buffer.from(orderNumber, 'utf8');
  const padLen = BLOCK - (orderBuf.length % BLOCK);
  const orderPadded = Buffer.concat([orderBuf, Buffer.alloc(padLen === 0 ? BLOCK : padLen, 0)]);
  const cipher = crypto.createCipheriv('des-ede3-cbc', key, iv);
  cipher.setAutoPadding(false);
  const diversifiedKey = Buffer.concat([cipher.update(orderPadded), cipher.final()]);
  // 3. HMAC-SHA256 del merchantParamsB64 con diversifiedKey → base64
  return crypto.createHmac('sha256', diversifiedKey).update(merchantParams).digest('base64');
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

  // Redsys espera amount en céntimos, sin decimales. SIN ceros a la izquierda.
  // "000000007200" hace que Redsys muestre 0,00€ — debe ser "7200"
  const amountCents = Math.round(parseFloat(amount) * 100).toString();
  // Número de pedido: 4-12 chars alfanuméricos, DEBE empezar por 4 dígitos numéricos (SIS0042)
  let orderClean = order.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  // Si no empieza por 4 dígitos, anteponemos los últimos 4 del timestamp en segundos
  if (!/^\d{4}/.test(orderClean)) {
    const ts4 = String(Math.floor(Date.now() / 1000)).slice(-4);
    orderClean = (ts4 + orderClean).slice(0, 12);
  }
  const orderStr = orderClean.padStart(4, '0');

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
    DS_MERCHANT_PRODUCTDESCRIPTION: (description || 'Reserva Checkingsmart').slice(0, 125),
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

    // LOG diagnóstico — ver qué recibimos del booking
    console.log('[Gateway] body recibido:', JSON.stringify({
      amount, order, tenantId: body.tenantId,
      csrf_token: (csrf_token||'').substring(0,20),
      amountType: typeof amount, orderType: typeof order
    }));

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
    const baseUrl   = `https://${tenantId}.checkingsmart.com`;

    const merchantParamsB64 = buildMerchantParams({
      amount,
      order,
      description,
      email,
      lang: lang || '001',
      urlOk:           `${baseUrl}/booking/?pago=ok&order=${order}`,
      urlKo:           `${baseUrl}/booking/?pago=ko&order=${order}`,
      urlNotification: `${FN_BASE}/redsysNotification`,
      merchantCode:    cfg.merchantCode,
      terminal:        cfg.terminal,
      currency:        cfg.currency,
      csrfToken:       csrf_token || '',
    });

    // Número de pedido limpio — mismo proceso que en buildMerchantParams para que la firma cuadre
    let orderCleanSig = order.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    if (!/^\d{4}/.test(orderCleanSig)) {
      const ts4 = String(Math.floor(Date.now() / 1000)).slice(-4);
      orderCleanSig = (ts4 + orderCleanSig).slice(0, 12);
    }
    orderCleanSig = orderCleanSig.padStart(4, '0');
    const signature  = redsysSign(merchantParamsB64, orderCleanSig, cfg.secretKey);

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
        const db = admin.firestore();

        // MerchantData puede ser:
        //   a) Solo el bookCode "XXX-XXXXXX" (nuevo formato — prefijo tenant-aware: CPR, AMB, etc.)
        //   b) JSON { bookCode, tenantId } (formato anterior — Redsys a veces lo trunca)
        //   c) Hex nonce (formato muy antiguo)
        let bookCode = null;
        if (csrfToken) {
          try {
            const parsed = JSON.parse(csrfToken);
            if (parsed && parsed.bookCode) bookCode = parsed.bookCode;
          } catch (e) {
            // No es JSON → probar directamente como bookCode (cualquier prefijo 3-4 letras)
            if (/^[A-Z]{2,4}-[A-Z0-9]{6}$/.test(csrfToken)) bookCode = csrfToken;
          }
        }
        // Sin fallback inventado: si no tenemos bookCode, la búsqueda por redsysOrder
        // (más abajo) identifica la reserva correctamente sin depender del prefijo del tenant.

        console.log('[Redsys] Buscando booking. bookCode:', bookCode, '| redsysOrder:', order, '| MerchantData:', csrfToken);

        // Buscar en todos los tenants por bookCode y como fallback por redsysOrder
        const tenantsSnap = await db.collection('tenants').listDocuments();
        for (const tenantRef of tenantsSnap) {
          let guestsSnap = { empty: true, docs: [] };
          if (bookCode) {
            guestsSnap = await tenantRef.collection('guests')
              .where('bookCode', '==', bookCode)
              .limit(1)
              .get();
          }
          if (guestsSnap.empty) {
            // Fallback: buscar por redsysOrder (número de pedido numérico enviado al banco)
            guestsSnap = await tenantRef.collection('guests')
              .where('redsysOrder', '==', order)
              .limit(1)
              .get();
          }
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

// ─── Plantilla email masivo (comunicaciones) ──────────────────────────────────
function htmlBulkEmail(opts) {
  var tenant      = opts.tenant      || {};
  var primary     = opts.primary     || '#0288d1';
  var logoUrl     = opts.logoUrl     || '';
  var tenantNombre = opts.tenantNombre || 'Área';
  var subject     = opts.subject     || '';
  var body        = opts.body        || '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:'Segoe UI',Arial,sans-serif;background:#f0f4f8;margin:0;padding:0}
.wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.hdr{background:${primary};padding:24px 32px;text-align:center}
.hdr img{height:48px;max-width:220px;object-fit:contain}
.hdr-title{color:#fff;font-size:1.1rem;font-weight:700;margin-top:8px;opacity:.9}
.body{padding:32px;color:#374151;line-height:1.7;font-size:.95rem}
.ftr{background:#f8f9fa;padding:16px 32px;text-align:center;font-size:.8rem;color:#9ca3af}
</style></head><body>
<div class="wrap">
  <div class="hdr">
    <img src="${logoUrl}" alt="${tenantNombre}" onerror="this.style.display='none'">
    <div class="hdr-title">${tenantNombre}</div>
  </div>
  <div class="body">${body}</div>
  <div class="ftr">Checkingsmart · Gestión inteligente de áreas · checkingsmart.com</div>
</div></body></html>`;
}

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
      from:    `${tenantNombre} (via Checkingsmart) <${EMAIL_FROM}>`,
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

// ─── Cloud Function: sendBulkEmail ───────────────────────────────────────────
// Admin envía un email masivo a reservas futuras con cuerpo personalizable.
// POST { tenantId, guestIds: string[], subject: string, htmlBody: string }

exports.sendBulkEmail = onRequest({ region: 'europe-west1', cors: true, secrets: ['RESEND_API_KEY'] }, async function (req, res) {

  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST')   { res.status(405).send('Method not allowed'); return; }

  try {
    const { tenantId, guestIds, subject, htmlBody } = req.body || {};
    if (!tenantId || !Array.isArray(guestIds) || !guestIds.length || !subject || !htmlBody) {
      res.status(400).json({ error: 'Faltan parámetros: tenantId, guestIds, subject, htmlBody' }); return;
    }
    if (!RESEND_API_KEY) {
      res.status(500).json({ error: 'Email no configurado (falta RESEND_API_KEY)' }); return;
    }

    const db         = admin.firestore();
    const tenantRef  = db.collection('tenants').doc(tenantId);
    const tenantSnap = await tenantRef.get();
    const tenant     = tenantSnap.exists ? tenantSnap.data() : {};

    const resend       = getResend();
    const tenantNombre = tenant.nombre || tenantId;
    const tenantEmail  = tenant.email  || EMAIL_FROM;
    const primary      = (tenant.colores && tenant.colores.primario) || '#0288d1';
    const logoUrl      = `https://checkingsmart.com/tenants/${tenantId}/logo.png`;

    let sent = 0, errors = 0;
    const results = [];

    for (const guestId of guestIds) {
      try {
        const guestSnap = await tenantRef.collection('guests').doc(guestId).get();
        if (!guestSnap.exists) { results.push({ guestId, error: 'No encontrado' }); errors++; continue; }
        const guest = guestSnap.data();
        if (!guest.email) { results.push({ guestId, error: 'Sin email' }); errors++; continue; }

        // Sustituir variables en el cuerpo
        const payUrl   = `${FN_BASE}/paymentPage?tenant=${encodeURIComponent(tenantId)}&code=${encodeURIComponent(guest.bookCode || '')}`;
        const payBtn   = `<a href="${payUrl}" style="display:inline-block;margin:8px 0;padding:14px 32px;background:${primary};color:#fff;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem">💳 Pagar ahora →</a>`;

        const personalBody = htmlBody
          .replace(/\{\{nombre\}\}/g,       ((guest.name || '') + ' ' + (guest.surname || '')).trim())
          .replace(/\{\{fechaEntrada\}\}/g,  guest.dateIn  || '')
          .replace(/\{\{fechaSalida\}\}/g,   guest.dateOut || '')
          .replace(/\{\{parcela\}\}/g,       guest.pitchCode || '')
          .replace(/\{\{importe\}\}/g,       (guest.totalPrice || '0') + ' €')
          .replace(/\{\{codigo\}\}/g,        guest.bookCode || '')
          .replace(/\{\{linkPago\}\}/g,      payBtn);

        const html = htmlBulkEmail({ tenant, primary, logoUrl, tenantNombre, subject, body: personalBody });

        await resend.emails.send({
          from:    `${tenantNombre} (via Checkingsmart) <${EMAIL_FROM}>`,
          to:      guest.email,
          replyTo: tenantEmail,
          subject: subject,
          html:    html,
        });

        sent++;
        results.push({ guestId, email: guest.email, ok: true });
      } catch (err) {
        errors++;
        results.push({ guestId, error: err.message });
        console.error('[sendBulkEmail] Error en guestId=' + guestId + ':', err.message);
      }
    }

    console.log(`[sendBulkEmail] tenantId=${tenantId} sent=${sent} errors=${errors}`);
    res.status(200).json({ ok: true, sent, errors, results });

  } catch (err) {
    console.error('[sendBulkEmail] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Cloud Function: paymentPage ─────────────────────────────────────────────
// Enlace de pago directo para emails masivos.
// GET ?tenant=XXX&code=AMB-YYYYYY[&result=ok|ko]
// Devuelve una página HTML con el resumen de la reserva y el formulario Redsys firmado.

exports.paymentPage = onRequest({ region: 'europe-west1', secrets: ['REDSYS_SECRET'] }, async function (req, res) {

  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).send('Method not allowed'); return; }

  const tenantId = req.query.tenant || '';
  const bookCode = req.query.code  || '';
  const result   = req.query.result || ''; // 'ok' | 'ko' | ''

  if (!tenantId || !bookCode) {
    res.status(400).send(htmlPayError('Enlace de pago inválido', 'El enlace no contiene los datos necesarios.'));
    return;
  }

  try {
    const db         = admin.firestore();
    const tenantRef  = db.collection('tenants').doc(tenantId);

    const [tenantSnap, guestsSnap] = await Promise.all([
      tenantRef.get(),
      tenantRef.collection('guests').where('bookCode', '==', bookCode).limit(1).get(),
    ]);

    if (guestsSnap.empty) {
      res.status(404).send(htmlPayError('Reserva no encontrada', 'No existe ninguna reserva con ese código.'));
      return;
    }

    const tenant      = tenantSnap.exists ? tenantSnap.data() : {};
    const guest       = guestsSnap.docs[0].data();
    const nombre      = tenant.nombre  || tenantId;
    const primary     = (tenant.colores && tenant.colores.primario) || '#0288d1';
    const logoUrl     = `https://checkingsmart.com/tenants/${tenantId}/logo.png`;

    // Página de resultado después del pago
    if (result === 'ok') {
      res.send(htmlPayResult('ok', nombre, primary, logoUrl, guest));
      return;
    }
    if (result === 'ko') {
      res.send(htmlPayResult('ko', nombre, primary, logoUrl, guest));
      return;
    }

    // Ya pagado → mostrar confirmación
    if (guest.paid) {
      res.send(htmlPayResult('already', nombre, primary, logoUrl, guest));
      return;
    }

    // Construir formulario Redsys firmado
    const cfg        = await getTenantRedsys(tenantId);
    const orderStr   = bookCode.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    const baseUrl    = `https://${tenantId}.checkingsmart.com`;
    const selfUrl    = `${FN_BASE}/paymentPage`;

    const merchantParamsB64 = buildMerchantParams({
      amount:          guest.totalPrice || '0',
      order:           orderStr,
      description:     `Reserva ${bookCode} — ${nombre}`,
      email:           guest.email || '',
      lang:            '001',
      urlOk:           `${selfUrl}?tenant=${encodeURIComponent(tenantId)}&code=${encodeURIComponent(bookCode)}&result=ok`,
      urlKo:           `${selfUrl}?tenant=${encodeURIComponent(tenantId)}&code=${encodeURIComponent(bookCode)}&result=ko`,
      urlNotification: `${FN_BASE}/redsysNotification`,
      merchantCode:    cfg.merchantCode,
      terminal:        cfg.terminal,
      currency:        cfg.currency,
      csrfToken:       JSON.stringify({ tenantId, bookCode }),
    });

    const orderClean = orderStr.padStart(4, '0').slice(0, 12);
    const signature  = redsysSign(merchantParamsB64, orderClean, cfg.secretKey);

    res.set('Content-Type', 'text/html');
    res.send(htmlPayPage({ nombre, primary, logoUrl, guest, bookCode, cfg, merchantParamsB64, signature }));

  } catch (err) {
    console.error('[paymentPage] Error:', err);
    res.status(500).send(htmlPayError('Error interno', 'Por favor contacta con el establecimiento.'));
  }
});

// ── Plantillas HTML para paymentPage ─────────────────────────────────────────

function payBaseWrap(primary, logoUrl, nombre, content) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pago de Reserva — ${nombre}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;background:#f0f4f8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 32px rgba(0,0,0,.10);max-width:480px;width:100%;overflow:hidden}
.hdr{background:${primary};padding:24px 28px;text-align:center}
.hdr img{height:44px;max-width:180px;object-fit:contain;margin-bottom:8px;display:block;margin:0 auto 8px}
.hdr-t{color:#fff;font-size:1rem;font-weight:700;opacity:.92}
.body{padding:28px}
h2{font-size:1.15rem;margin-bottom:14px;color:#1a1a2e}
.row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f0f4f8;font-size:.9rem}
.row:last-of-type{border:none}
.row label{color:#6b7280;font-weight:600;font-size:.82rem}
.total{background:#f0f4f8;border-radius:8px;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;margin:16px 0}
.total-label{font-weight:700;color:#374151}
.total-amt{font-size:1.4rem;font-weight:800;color:${primary}}
.pay-btn{display:block;width:100%;padding:15px;background:${primary};color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;text-align:center;margin-top:4px;transition:.15s}
.pay-btn:hover{opacity:.9}
.ftr{background:#f8f9fa;padding:12px 20px;text-align:center;font-size:.75rem;color:#9ca3af}
.badge{display:inline-block;padding:5px 14px;border-radius:20px;font-size:.8rem;font-weight:700;margin-bottom:16px}
.badge-ok{background:#dcfce7;color:#16a34a}
.badge-ko{background:#fee2e2;color:#dc2626}
.note{font-size:.78rem;color:#9ca3af;text-align:center;margin-top:10px;line-height:1.5}
</style></head><body>
<div class="card">
  <div class="hdr">
    <img src="${logoUrl}" alt="${nombre}" onerror="this.style.display='none'">
    <div class="hdr-t">${nombre}</div>
  </div>
  <div class="body">${content}</div>
  <div class="ftr">Pago seguro gestionado por Checkingsmart · SSL cifrado</div>
</div></body></html>`;
}

function htmlPayPage({ nombre, primary, logoUrl, guest, bookCode, cfg, merchantParamsB64, signature }) {
  const content = `
    <h2>Resumen de tu reserva</h2>
    <div class="row"><label>Código</label><strong>${bookCode}</strong></div>
    <div class="row"><label>Nombre</label><span>${(guest.name||'')+' '+(guest.surname||'')}</span></div>
    <div class="row"><label>Parcela</label><span>${guest.pitchCode||'—'}</span></div>
    <div class="row"><label>Entrada</label><span>${guest.dateIn||'—'}</span></div>
    <div class="row"><label>Salida</label><span>${guest.dateOut||'—'}</span></div>
    <div class="row"><label>Noches</label><span>${guest.nights||'—'}</span></div>
    <div class="total">
      <span class="total-label">Total a pagar</span>
      <span class="total-amt">${parseFloat(guest.totalPrice||0).toFixed(2)} €</span>
    </div>
    <form method="POST" action="${cfg.endpoint}" id="pay-form">
      <input type="hidden" name="Ds_SignatureVersion" value="HMAC_SHA256_V1">
      <input type="hidden" name="Ds_MerchantParameters" value="${merchantParamsB64}">
      <input type="hidden" name="Ds_Signature" value="${signature}">
      <button type="submit" class="pay-btn">🔒 Pagar ${parseFloat(guest.totalPrice||0).toFixed(2)} € de forma segura</button>
    </form>
    <div class="note">Serás redirigido al TPV seguro de tu banco.<br>No compartir este enlace.</div>`;
  return payBaseWrap(primary, logoUrl, nombre, content);
}

function htmlPayResult(type, nombre, primary, logoUrl, guest) {
  let content = '';
  if (type === 'ok') {
    content = `
      <div style="text-align:center;padding:8px 0 16px">
        <div style="font-size:3rem;margin-bottom:8px">✅</div>
        <span class="badge badge-ok">Pago realizado con éxito</span>
        <h2 style="margin-bottom:8px">¡Gracias, ${guest.name||''}!</h2>
        <p style="color:#6b7280;font-size:.9rem">Tu reserva <strong>${guest.bookCode||''}</strong> está confirmada.<br>Recibirás una confirmación en ${guest.email||'tu email'}.</p>
      </div>`;
  } else if (type === 'ko') {
    content = `
      <div style="text-align:center;padding:8px 0 16px">
        <div style="font-size:3rem;margin-bottom:8px">❌</div>
        <span class="badge badge-ko">Pago no completado</span>
        <h2 style="margin-bottom:8px">El pago no se ha procesado</h2>
        <p style="color:#6b7280;font-size:.9rem">Por favor inténtalo de nuevo o contacta con el establecimiento.</p>
      </div>`;
  } else { // already paid
    content = `
      <div style="text-align:center;padding:8px 0 16px">
        <div style="font-size:3rem;margin-bottom:8px">✅</div>
        <span class="badge badge-ok">Reserva ya pagada</span>
        <h2 style="margin-bottom:8px">Esta reserva ya está confirmada</h2>
        <p style="color:#6b7280;font-size:.9rem">El pago de la reserva <strong>${guest.bookCode||''}</strong> ya fue procesado. ¡Hasta pronto!</p>
      </div>`;
  }
  return payBaseWrap(primary, logoUrl, nombre, content);
}

function htmlPayError(title, msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0f4f8}
  .box{background:#fff;border-radius:12px;padding:32px;max-width:400px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.08)}
  h2{color:#dc2626;margin-bottom:8px}p{color:#6b7280;font-size:.9rem}</style></head>
  <body><div class="box"><div style="font-size:2.5rem;margin-bottom:12px">⚠️</div>
  <h2>${title}</h2><p>${msg}</p></div></body></html>`;
}

// ─── Cloud Function: powernetData ─────────────────────────────────────────────
// Proxy autenticado hacia PowerNet Camping.
// GET ?tenantId=camperpark-roquetas&parcel=42&rango=7
// Credenciales en Firestore private_config/{tenantId}.powernet.{email,password}
// Devuelve datos de consumo eléctrico de la parcela indicada.

const _pnSessions = {}; // cache sesión por tenant: { cookie, ts }

async function pnLogin(baseUrl, email, password) {
  const loginRes = await fetch(`${baseUrl}/login/signin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'CheckingSmart/1.0',
    },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
    redirect: 'manual',
  });
  // Recopilar todas las Set-Cookie del redirect
  const setCookieHeaders = loginRes.headers.getSetCookie
    ? loginRes.headers.getSetCookie()
    : (loginRes.headers.get('set-cookie') ? [loginRes.headers.get('set-cookie')] : []);

  const cookies = setCookieHeaders
    .map(c => c.split(';')[0])
    .filter(Boolean)
    .join('; ');

  if (!cookies) throw new Error('Login PowerNet fallido: no se recibió cookie de sesión');
  return cookies;
}

async function pnGetSession(tenantId, baseUrl, email, password) {
  const cached = _pnSessions[tenantId];
  // Reusar sesión si tiene menos de 30 min
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return cached.cookie;
  const cookie = await pnLogin(baseUrl, email, password);
  _pnSessions[tenantId] = { cookie, ts: Date.now() };
  return cookie;
}

exports.powernetData = onRequest({ region: 'europe-west1', cors: true }, async function (req, res) {

  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  try {
    const tenantId  = req.query.tenantId || '';
    const parcelNum = req.query.parcel   || '';  // número de parcela visible (ej: "42")
    const rango     = req.query.rango    || '7'; // 1 | 7 | 30

    if (!tenantId || !parcelNum) {
      res.status(400).json({ error: 'Faltan parámetros: tenantId, parcel' }); return;
    }

    // Cargar config PowerNet del tenant desde Firestore (colección privada)
    const db     = admin.firestore();
    const cfgDoc = await db.collection('private_config').doc(tenantId).get();
    const cfg    = cfgDoc.exists ? cfgDoc.data() : {};
    const pn     = cfg.powernet || {};

    if (!pn.email || !pn.password) {
      res.status(503).json({ error: 'PowerNet no configurado para este tenant (falta email/password en private_config)' });
      return;
    }

    // Leer mapa parcelaNum→internalId desde private_config o desde tenants
    const parcelMap = pn.parcelMap || {};
    const internalId = parcelMap[String(parcelNum)];
    if (!internalId) {
      res.status(404).json({ error: `Parcela ${parcelNum} sin ID PowerNet en el mapa` }); return;
    }

    const baseUrl = pn.baseUrl || 'https://app.powernet-camping.com';

    // Obtener sesión (con cache)
    let cookie;
    try {
      cookie = await pnGetSession(tenantId, baseUrl, pn.email, pn.password);
    } catch (loginErr) {
      // Sesión caducada → forzar re-login
      delete _pnSessions[tenantId];
      cookie = await pnGetSession(tenantId, baseUrl, pn.email, pn.password);
    }

    // Llamar al endpoint de gráfico para el rango solicitado
    const grafRes = await fetch(`${baseUrl}/parcel/grafico`, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/x-www-form-urlencoded',
        'X-Requested-With':  'XMLHttpRequest',
        'Cookie':            cookie,
        'User-Agent':        'CheckingSmart/1.0',
      },
      body: `parcel_id=${internalId}&rango=${rango}`,
    });

    if (!grafRes.ok) {
      // Sesión expirada → borrar caché y reintentar una vez
      delete _pnSessions[tenantId];
      cookie = await pnGetSession(tenantId, baseUrl, pn.email, pn.password);
      const retry = await fetch(`${baseUrl}/parcel/grafico`, {
        method: 'POST',
        headers: {
          'Content-Type':     'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Cookie':           cookie,
          'User-Agent':       'CheckingSmart/1.0',
        },
        body: `parcel_id=${internalId}&rango=${rango}`,
      });
      if (!retry.ok) throw new Error(`PowerNet HTTP ${retry.status}`);
      const retryData = await retry.json();
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, success: true, parcel: parcelNum, internalId, rango, ...retryData });
      return;
    }

    const data = await grafRes.json();
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, success: true, parcel: parcelNum, internalId, rango, ...data });

  } catch (err) {
    console.error('[powernetData] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── assignTenantClaim — Asigna custom claim tenantId al usuario ──────────────
// POST /assignTenantClaim  Authorization: Bearer {idToken}  Body: { tenantId }
// La llamada viene desde login/index.html tras autenticación exitosa.
// Esto permite que Firestore rules puedan verificar request.auth.token.tenantId.
exports.assignTenantClaim = onRequest({
  region: 'europe-west1',
  cors: [
    'https://checkingsmart.com',
    'https://www.checkingsmart.com',
    'https://checkingsmart-564a0.web.app',
    'https://checkingsmart-564a0.firebaseapp.com',
    'https://camperparkroquetas.com',
    'https://www.camperparkroquetas.com',
    'https://areamalagabeach.com',
    'https://www.areamalagabeach.com',
    'http://localhost'
  ]
}, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // Verificar token del usuario
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token requerido' }); return;
  }
  const idToken = authHeader.slice(7);
  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    res.status(401).json({ error: 'Token inválido: ' + e.message }); return;
  }

  const { tenantId } = req.body;
  if (!tenantId || !/^[a-z0-9\-]{2,50}$/.test(tenantId)) {
    res.status(400).json({ error: 'tenantId inválido' }); return;
  }

  // Verificar que el email del usuario pertenece a ese tenant
  const EMAIL_MAP = {
    'info@areamalagabeach.com':      'area-malaga-beach',
    'areamalagabeach@gmail.com':     'area-malaga-beach',
    'camperparkroquetas@gmail.com':  'camperpark-roquetas',
    'eldarvi30@gmail.com':           'camperpark-roquetas', // admin global
  };
  const userEmail = (decodedToken.email || '').toLowerCase();
  const allowedTenant = EMAIL_MAP[userEmail];

  // Admin global (eldarvi30) puede acceder a cualquier tenant
  const isGlobalAdmin = userEmail === 'eldarvi30@gmail.com';

  if (!isGlobalAdmin && allowedTenant !== tenantId) {
    res.status(403).json({ error: 'No autorizado para este tenant' }); return;
  }

  // Asignar custom claim
  const claims = {
    tenantId: tenantId,
    role: isGlobalAdmin ? 'superadmin' : 'admin',
    updatedAt: Date.now()
  };
  await admin.auth().setCustomUserClaims(decodedToken.uid, claims);

  res.json({ ok: true, uid: decodedToken.uid, claims });
});

// ─── Buzón IA (inbox inteligente) ─────────────────────────────────────────────
// Re-exporta las funciones programadas y manuales del módulo inbox/.
const inbox = require('./inbox');
exports.pollInboxScheduled    = inbox.pollInboxScheduled;
exports.pollInboxManual       = inbox.pollInboxManual;
exports.generateInboxDraft    = inbox.generateInboxDraft;
exports.sendInboxReply        = inbox.sendInboxReply;
exports.translateInboxMessage = inbox.translateInboxMessage;
exports.linkInboxMessage      = inbox.linkInboxMessage;
