// ============================================================================
// auth-register  —  Crea la cuenta en el SERVIDOR (el front nunca toca crm_accounts).
// POST { email, password, code }
//   1) valida el código de verificación de correo (crm_email_codes),
//   2) crea crm_accounts/{emailKey} con uid/salt/hash/recovery (hash en el server),
//   3) devuelve { ok, uid, recovery, token } (token = pase de Firebase).
// ============================================================================

const crypto = require('crypto');
const core = require('./lib/_core');

function rndHex(n) { return crypto.randomBytes(n).toString('hex'); }
function hashPw(salt, pw) { return crypto.createHash('sha256').update(String(salt) + '|' + String(pw)).digest('hex'); }
function base64url(buf) { return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function signJwt(claims, pk) {
  const input = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + base64url(JSON.stringify(claims));
  const s = crypto.createSign('RSA-SHA256'); s.update(input); s.end();
  return input + '.' + s.sign(pk).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function mintToken(svc, uid, isOwner, email) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: svc.client_email, sub: svc.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now, exp: now + 3600, uid: String(uid), claims: { isOwner: !!isOwner, email: String(email || '') }
  }, svc.private_key);
}

// IP del cliente (Netlify) para el límite anti-bot.
function clientIp(event) {
  const h = event.headers || {};
  return String(h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
}
// Límite simple por IP en Firestore (crm_rate/{ip}): máx 5 intentos cada 5 minutos.
// Devuelve true si se permite, false si excede. (crm_rate solo lo toca el backend.)
async function checkRate(svc, token, ip) {
  const key = 'crm_rate/' + String(ip).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 80);
  const now = Date.now(), WINDOW = 5 * 60 * 1000, MAX = 5;
  let rec = await core.fsGet(svc, token, key);
  if (!rec || !rec.windowStart || (now - rec.windowStart) > WINDOW) {
    await core.fsPatch(svc, token, key, { windowStart: now, count: 1 });
    return true;
  }
  if ((rec.count || 0) >= MAX) return false;
  await core.fsPatch(svc, token, key, { windowStart: rec.windowStart, count: (rec.count || 0) + 1 });
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return core.json(200, { ok: true });
  if (event.httpMethod !== 'POST') return core.json(405, { ok: false, reason: 'method' });

  let email, password, code, website;
  try {
    const b = JSON.parse(event.body || '{}');
    email = String(b.email || '').trim().toLowerCase();
    password = String(b.password || '');
    code = String(b.code || '').trim();
    website = String(b.website || '');
  } catch (e) { return core.json(400, { ok: false, reason: 'format' }); }
  // Honeypot: el campo oculto 'website' debe venir VACÍO. Si trae algo, es un bot → fuera.
  if (website.trim()) return core.json(400, { ok: false, reason: 'bot' });
  if (!core.validEmail(email) || password.length < 6 || !/^\d{6}$/.test(code)) return core.json(200, { ok: false, reason: 'format' });

  try {
    const svc = core.getSvc();
    const token = await core.getGoogleAccessToken(svc);

    // Límite anti-bot por IP: máx 5 intentos cada 5 minutos.
    if (!(await checkRate(svc, token, clientIp(event)))) return core.json(429, { ok: false, reason: 'rate' });

    const path = 'crm_accounts/' + core.emailKey(email);
    const existing = await core.fsGet(svc, token, path);
    if (existing && existing.uid) return core.json(200, { ok: false, reason: 'exists' });

    const v = await core.consumeCode(svc, token, email, code);
    if (!v.ok) return core.json(200, v);

    const hash = core.hashPassword(password); // scrypt (incluye su propio salt)
    const recovery = rndHex(5).toUpperCase();
    const uid = 'u_' + (crypto.randomUUID ? crypto.randomUUID() : rndHex(8));
    await core.fsPatch(svc, token, path, { uid, email, salt: '', hash, recovery, createdAt: new Date().toISOString() });

    const isOwner = email === (process.env.OWNER_EMAIL || 'futuretech.cl.668@gmail.com').toLowerCase();
    return core.json(200, { ok: true, uid, recovery, isOwner: isOwner, token: mintToken(svc, uid, isOwner, email) });
  } catch (e) {
    console.error('auth-register:', e && e.message ? e.message : e);
    return core.json(500, { ok: false, reason: 'server' });
  }
};
