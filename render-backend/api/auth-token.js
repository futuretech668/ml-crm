// ============================================================================
// auth-token  —  Login del lado del SERVIDOR + emisión de "pase" de Firebase.
// ----------------------------------------------------------------------------
// El frontend manda { email, password }. Aquí:
//   1) Se lee la cuenta en crm_accounts/{emailKey} (con el service account).
//   2) Se valida la contraseña: hash = SHA-256( salt + '|' + password )  (igual
//      que hashPw del frontend), comparado contra el hash guardado.
//   3) Si calza, se firma un CUSTOM TOKEN de Firebase (JWT RS256 con la clave
//      del service account) con uid = el uid de la cuenta.
// El frontend luego hace signInWithCustomToken(token) → request.auth.uid = uid,
// y las reglas de Firestore pueden exigir que cada quien toque SOLO su doc.
//
// Requiere la variable de entorno FIREBASE_SERVICE_ACCOUNT (ya está en Netlify).
// ============================================================================

const crypto = require('crypto');
const { getSvc, getGoogleAccessToken, fsGet, fsPatch, hashPassword, verifyPassword, isScryptHash, emailKey, validEmail, clientIp, checkRate, json } = require('./lib/_core.js');

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function signJwt(claims, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const input = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const s = crypto.createSign('RSA-SHA256'); s.update(input); s.end();
  const sig = s.sign(privateKey).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return input + '.' + sig;
}
// Igual que hashPw() del frontend: SHA-256 hex de (salt + '|' + password).
function hashPw(salt, pw) {
  return crypto.createHash('sha256').update(String(salt) + '|' + String(pw)).digest('hex');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, reason: 'method' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, reason: 'badjson' }); }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!validEmail(email) || !password) return json(400, { ok: false, reason: 'missing' });

  let svc;
  try { svc = getSvc(); } catch (e) { return json(500, { ok: false, reason: 'config' }); }

  try {
    const gtoken = await getGoogleAccessToken(svc);

    // Anti fuerza bruta en el LOGIN: límite por IP (12/10min) y por correo (8/15min).
    // Acota el probar muchas contraseñas sin trabar al usuario legítimo que reintenta.
    if (!(await checkRate(svc, gtoken, 'login_ip_' + clientIp(event), 12, 10 * 60 * 1000))) return json(429, { ok: false, reason: 'rate' });
    if (!(await checkRate(svc, gtoken, 'login_em_' + emailKey(email), 8, 15 * 60 * 1000))) return json(429, { ok: false, reason: 'rate' });

    const acc = await fsGet(svc, gtoken, 'crm_accounts/' + emailKey(email));
    if (!acc || !acc.uid || !acc.hash) return json(401, { ok: false, reason: 'nouser' });

    // Verificación de contraseña.
    //  · Cuentas nuevas: hash scrypt (KDF lento) → verifyPassword.
    //  · Cuentas viejas: hash SHA-256(salt+'|'+pw). Se valida en tiempo constante y,
    //    si calza, se RE-HASHEA a scrypt de forma transparente (migración al entrar).
    let okPass = false;
    const stored = String(acc.hash);
    if (isScryptHash(stored)) {
      okPass = verifyPassword(password, stored);
    } else if (acc.salt) {
      const h = hashPw(acc.salt, password);
      const a = Buffer.from(h), b = Buffer.from(stored);
      okPass = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (okPass) {
        try { await fsPatch(svc, gtoken, 'crm_accounts/' + emailKey(email), Object.assign({}, acc, { hash: hashPassword(password), salt: '' })); } catch (_) { /* el login no falla si la migración no se pudo guardar */ }
      }
    }
    if (!okPass) return json(401, { ok: false, reason: 'badpass' });

    // ¿Es el dueño? Se decide en el SERVIDOR (no en el navegador). Va como Custom Claim
    // dentro del token de Firebase (request.auth.token.isOwner) y también en la respuesta.
    const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'futuretech.cl.668@gmail.com').toLowerCase();
    const isOwner = email === OWNER_EMAIL;

    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({
      iss: svc.client_email,
      sub: svc.client_email,
      aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
      iat: now,
      exp: now + 3600,
      uid: String(acc.uid),
      claims: { isOwner: isOwner, email: email }
    }, svc.private_key);

    return json(200, { ok: true, token, uid: String(acc.uid), isOwner: isOwner });
  } catch (e) {
    console.error('auth-token:', e && e.message ? e.message : e);
    return json(500, { ok: false, reason: 'server' });
  }
};
