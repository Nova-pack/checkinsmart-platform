'use strict';
/**
 * setup-secrets.js
 *
 * Crea los secrets necesarios para functions v2 en el proyecto PROD,
 * usando Secret Manager REST API directamente.
 *
 * Secrets:
 *   REDSYS_SECRET          (valor sandbox)
 *   RESEND_API_KEY         (placeholder, se actualiza despues)
 *   ADMIN_EMAIL_FALLBACK   (eldarvi30@gmail.com)
 *
 * Requiere:
 *   - service-account-prod.json
 *   - Secret Manager API habilitada
 *   - SA con roles/secretmanager.admin (o Editor/Owner)
 */

const { GoogleAuth } = require('google-auth-library');
const key = require('./service-account-prod.json');

const SECRETS = [
  { name: 'REDSYS_SECRET',        value: 'sq7HjrUOBfKmC576ILgskD5srU870gJ7' },
  { name: 'RESEND_API_KEY',       value: 'PLACEHOLDER_CHANGEME' },
  { name: 'ADMIN_EMAIL_FALLBACK', value: 'eldarvi30@gmail.com' },
];

const PROJECT  = key.project_id;
const auth     = new GoogleAuth({
  credentials: { client_email: key.client_email, private_key: key.private_key },
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

async function main() {
  const client = await auth.getClient();

  // 1) Verificar que Secret Manager API esté habilitada (si no, falla con 403)
  console.log(`\n🔐  Proyecto: ${PROJECT}\n`);

  // 2) Listar secrets existentes
  const listResp = await client.request({
    url: `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets`,
  }).catch(e => {
    console.error('❌  Error listando secrets:', e.response?.data?.error?.message || e.message);
    process.exit(1);
  });
  const existing = new Set((listResp.data.secrets || []).map(s => s.name.split('/').pop()));
  console.log(`📋  Secrets existentes: ${[...existing].join(', ') || '(ninguno)'}\n`);

  // 3) Crear y/o añadir versión por cada secret
  for (const { name, value } of SECRETS) {
    if (!existing.has(name)) {
      console.log(`➕  Creando ${name}...`);
      await client.request({
        url: `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets?secretId=${name}`,
        method: 'POST',
        data: { replication: { automatic: {} } },
      }).catch(e => {
        console.error(`   ❌ ${e.response?.data?.error?.message || e.message}`);
        throw e;
      });
    } else {
      console.log(`✓  ${name} ya existe, añadiendo nueva versión...`);
    }

    // Añadir versión con el valor
    await client.request({
      url: `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${name}:addVersion`,
      method: 'POST',
      data: { payload: { data: Buffer.from(value, 'utf8').toString('base64') } },
    }).then(r => {
      const ver = r.data.name.split('/').pop();
      console.log(`   🔑  versión ${ver} creada`);
    }).catch(e => {
      console.error(`   ❌ addVersion: ${e.response?.data?.error?.message || e.message}`);
      throw e;
    });
  }

  console.log('\n✅  Todos los secrets listos. Ya puedes hacer firebase deploy --only functions.\n');
}

main().catch(err => { process.exit(1); });
