/**
 * test-imap-local.js
 *
 * Prueba IMAP localmente con una App Password pasada como argumento,
 * sin tocar Secret Manager ni Cloud Functions.
 *
 * Uso:
 *   node test-imap-local.js "abcd efgh ijkl mnop"
 *
 * Gmail acepta la password con o sin espacios. Este script ELIMINA los
 * espacios automáticamente antes de intentar el login.
 */

const { ImapFlow } = require('imapflow');

const USER = 'camperparkroquetas@gmail.com';
const HOST = 'imap.gmail.com';
const PORT = 993;

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error('[ERROR] Falta la App Password como argumento.');
    console.error('Uso: node test-imap-local.js "abcd efgh ijkl mnop"');
    process.exit(2);
  }

  const pass = raw.replace(/\s+/g, '');
  console.log('[INFO] Cuenta:', USER);
  console.log('[INFO] Longitud password (sin espacios):', pass.length,
    pass.length === 16 ? '✓ (16 chars OK)' : '✗ (debería ser 16)');

  const client = new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user: USER, pass: pass },
    logger: false
  });

  try {
    console.log('[INFO] Conectando a', HOST + ':' + PORT + '...');
    await client.connect();
    console.log('[OK]  Autenticación correcta.');

    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true, unseen: true });
      console.log('[OK]  INBOX: total=' + status.messages + ', no leídos=' + status.unseen);

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const uids = await client.search({ since: since });
      console.log('[OK]  Correos últimas 24h:', (uids || []).length);
    } finally {
      lock.release();
    }

    await client.logout();
    console.log('');
    console.log('==========================================');
    console.log(' RESULTADO: PASSWORD VÁLIDA');
    console.log('==========================================');
    process.exit(0);
  } catch (e) {
    console.log('');
    console.log('==========================================');
    console.log(' RESULTADO: PASSWORD RECHAZADA POR GMAIL');
    console.log('==========================================');
    console.log('mensaje:', e.message);
    console.log('code:', e.code || '(none)');
    console.log('response:', (e.response || e.responseText || '').toString().slice(0, 300));
    console.log('authenticationFailed:', e.authenticationFailed || false);
    process.exit(1);
  }
}

main();
