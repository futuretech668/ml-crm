// ============================================================================
// migrate-accounts-to-auth.js  —  Migración única a Firebase Authentication.
// ----------------------------------------------------------------------------
// Lee todas las cuentas de crm_accounts (Firestore REST, con el service account)
// y genera un archivo `accounts-import.json` en el formato de `firebase auth:import`,
// PRESERVANDO el uid de cada cuenta. Así los docs existentes (crm_users/{uid} y el
// doc del dueño crm/state) siguen perteneciendo al mismo usuario tras la migración.
//
// Las contraseñas NO se migran: el hash propio era SHA-256(salt + '|' + pass), un
// formato que el importador de Firebase no reproduce. Por eso cada usuario crea su
// contraseña una vez con el enlace de "¿Olvidaste tu contraseña?" (Firebase la envía).
// Los usuarios se marcan emailVerified=true (ya verificaron en el sistema anterior),
// así que NO tienen que volver a verificar el correo, solo fijar contraseña.
//
// Uso:
//   1) export FIREBASE_SERVICE_ACCOUNT='{...json del service account...}'
//   2) node render-backend/migrate-accounts-to-auth.js
//   3) firebase auth:import accounts-import.json --project ml-manager-cfa0e
// ============================================================================

const fs = require('fs');
const { getSvc, getGoogleAccessToken } = require('./api/lib/_core.js');

// Lista todos los docs de una colección por REST (paginado).
async function fsList(svc, token, collection) {
  const base = 'https://firestore.googleapis.com/v1/projects/' + svc.project_id +
    '/databases/(default)/documents/' + collection;
  const out = [];
  let pageToken = '';
  do {
    const url = base + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 404) break;
    if (!res.ok) throw new Error('fsList ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const d = await res.json();
    for (const doc of (d.documents || [])) {
      const f = doc.fields || {};
      out.push({
        uid: f.uid && f.uid.stringValue,
        email: f.email && f.email.stringValue
      });
    }
    pageToken = d.nextPageToken || '';
  } while (pageToken);
  return out;
}

(async () => {
  const svc = getSvc();
  const token = await getGoogleAccessToken(svc);
  const accounts = await fsList(svc, token, 'crm_accounts');

  const seen = new Set();
  const users = [];
  for (const a of accounts) {
    if (!a.uid || !a.email) continue;
    const email = a.email.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    users.push({ localId: a.uid, email, emailVerified: true });
  }

  fs.writeFileSync('accounts-import.json', JSON.stringify({ users }, null, 2));
  console.log('OK: ' + users.length + ' cuentas escritas en accounts-import.json');
  console.log('Siguiente paso:');
  console.log('  firebase auth:import accounts-import.json --project ' + svc.project_id);
  console.log('Luego avisa a los usuarios que entren con "¿Olvidaste tu contraseña?" para fijar su clave.');
})().catch((e) => { console.error('migración:', e && e.message ? e.message : e); process.exit(1); });
