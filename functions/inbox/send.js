/**
 * Buzón IA — envío de respuesta por SMTP Gmail (Fase 2B)
 *
 * Usa nodemailer + el mismo App Password con el que leemos IMAP.
 * Threading: se pasa In-Reply-To y References con el Message-Id del
 * correo original para que Gmail agrupe la respuesta en el hilo correcto.
 */

const nodemailer = require('nodemailer');

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;

/**
 * Envía una respuesta al correo original.
 * @param {object} opts
 * @param {string} opts.gmailUser           - ej. "camperparkroquetas@gmail.com"
 * @param {string} opts.gmailAppPassword
 * @param {string} opts.fromName            - ej. "Camper Park Roquetas"
 * @param {string} opts.toEmail             - destinatario (puede traer "Nombre <mail>")
 * @param {string} opts.toName              - opcional, para formatear
 * @param {string} opts.subject             - asunto (se antepone "Re: " si no lo tiene)
 * @param {string} opts.body                - cuerpo en texto plano
 * @param {string} opts.inReplyToMessageId  - Message-Id del correo original (con o sin <>)
 * @returns {Promise<{messageId:string,accepted:string[]}>}
 */
async function sendReply(opts) {
  const subject = /^re:\s*/i.test(opts.subject || '')
    ? opts.subject
    : ('Re: ' + (opts.subject || '(sin asunto)'));

  // Normalizar Message-Id con <> para cabeceras
  let inReplyTo = (opts.inReplyToMessageId || '').trim();
  if (inReplyTo && !/^</.test(inReplyTo)) inReplyTo = '<' + inReplyTo + '>';

  // Formato To:
  let to = opts.toEmail || '';
  if (opts.toName && !/</.test(to)) to = '"' + opts.toName.replace(/"/g, '') + '" <' + to + '>';

  const fromName = (opts.fromName || '').replace(/"/g, '');
  const from = fromName ? '"' + fromName + '" <' + opts.gmailUser + '>' : opts.gmailUser;

  // Cuerpo HTML sencillo: respeta saltos de línea
  const htmlBody = (opts.body || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true, // SSL en 465
    auth: { user: opts.gmailUser, pass: opts.gmailAppPassword }
  });

  const info = await transporter.sendMail({
    from: from,
    to: to,
    subject: subject,
    text: opts.body || '',
    html: '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222;line-height:1.55">' + htmlBody + '</div>',
    inReplyTo: inReplyTo || undefined,
    references: inReplyTo || undefined
  });

  return {
    messageId: info.messageId || '',
    accepted: info.accepted || []
  };
}

module.exports = { sendReply };
