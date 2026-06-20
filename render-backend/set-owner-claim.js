// ============================================================================
// set-owner-claim.js  —  Marca (o quita) el CUSTOM CLAIM de dueño en una cuenta.
// ----------------------------------------------------------------------------
// El "dueño" (acceso al doc histórico crm/state) se identifica SOLO por un custom
// claim `owner=true` firmado por el backend dentro del token de Firebase. Ningún
// correo de dueño vive en el cliente ni en firestore.rules. Esto fija ese claim
// usando la API Admin de Identity Toolkit con el service account.
//
// El correo del dueño se pasa EN TIEMPO DE EJECUCIÓN (argumento o env), nunca se
// hardcodea. Requiere que FIREBASE_SERVICE_ACCOUNT sea el service account de Firebase
// Admin (permiso firebaseauth.admin).
//
// Uso:
//   export FIREBASE_SERVICE_ACCOUNT='{...}'
//   node render-backend/set-owner-claim.js dueño@correo.com           # fija owner=true
//   node render-backend/set-owner-claim.js dueño@correo.com --revoke  # quita owner
//
// Tras fijarlo, el dueño debe cerrar sesión y volver a entrar (o esperar ~1 h) para
// que su token recoja el claim. La app usa getIdTokenResult(true) para refrescarlo.
// ============================================================================

const { getSvc, getGoogleAccessToken } = require('./api/lib/_core.js');

(async () => {
  const email = String(process.argv[2] || process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const revoke = process.argv.includes('--revoke');
  if (!email) { console.error('Uso: node render-backend/set-owner-claim.js <correo-del-dueño> [--revoke]'); process.exit(1); }

  const svc = getSvc();
  const token = await getGoogleAccessToken(svc, 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform');
  const base = 'https://identitytoolkit.googleapis.com/v1/projects/' + svc.project_id + '/accounts';

  // 1) Buscar el uid por correo.
  let res = await fetch(base + ':lookup', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: [email] }) });
  let data = await res.json();
  if (!res.ok) throw new Error('lookup ' + res.status + ': ' + JSON.stringify(data).slice(0, 200));
  const u = (data.users || [])[0];
  if (!u || !u.localId) { console.error('No existe en Firebase Auth una cuenta con ' + email + '. ¿Ya la importaste/registraste?'); process.exit(1); }

  // 2) Fijar/quitar el claim owner, preservando cualquier otro claim existente.
  let attrs = {};
  try { attrs = JSON.parse(u.customAttributes || '{}'); } catch (e) {}
  if (revoke) delete attrs.owner; else attrs.owner = true;

  res = await fetch(base + ':update', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ localId: u.localId, customAttributes: JSON.stringify(attrs) }) });
  data = await res.json();
  if (!res.ok) throw new Error('update ' + res.status + ': ' + JSON.stringify(data).slice(0, 200));

  console.log('OK: ' + email + ' (uid ' + u.localId + ') -> owner=' + (revoke ? 'quitado' : 'true') + '.');
  console.log('El dueño debe cerrar sesión y volver a entrar para que el token recoja el cambio.');
})().catch((e) => { console.error('set-owner-claim:', e && e.message ? e.message : e); process.exit(1); });
