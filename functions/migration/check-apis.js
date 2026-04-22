'use strict';
const { GoogleAuth } = require('google-auth-library');
const key = require('./service-account-prod.json');
const auth = new GoogleAuth({
  credentials: { client_email: key.client_email, private_key: key.private_key },
  scopes: ['https://www.googleapis.com/auth/cloud-platform']
});
(async () => {
  const client = await auth.getClient();
  const toCheck = [
    'cloudfunctions.googleapis.com',
    'cloudbuild.googleapis.com',
    'artifactregistry.googleapis.com',
    'run.googleapis.com',
    'eventarc.googleapis.com',
    'pubsub.googleapis.com',
    'storage.googleapis.com',
    'firebaseextensions.googleapis.com',
    'secretmanager.googleapis.com'
  ];
  for (const api of toCheck) {
    const url = `https://serviceusage.googleapis.com/v1/projects/${key.project_id}/services/${api}`;
    try {
      const resp = await client.request({ url });
      console.log(api.padEnd(40), resp.data.state);
    } catch (e) {
      console.log(api.padEnd(40), 'ERR', e.message.slice(0, 60));
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
