// ============================================================================
// auth-recover  —  Cambia la contraseña en el SERVIDOR (el front nunca toca crm_accounts).
// POST { email, code, newPassword }
//   1) valida el código de verificación de correo,
//   2) genera nuevo salt+hash (en el server) y actualiza crm_accounts/{emailKey}.
// ============================================================================

const crypto = require('crypto');
const core = require('./lib/_core');

function rndHex(n) { return crypto.randomBytes(n).toString('hex'); }
function hashPw(salt, pw) { return crypto.createHash('sha256').update(String(salt) + '|' + String(pw)).digest('hex'); }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return core.json(200, { ok: true });
  if (event.httpMethod !== 'POST') return core.json(405, { ok: false, reason: 'method' });

  let email, code, np;
  try {
    const b = JSON.parse(event.body || '{}');
    email = String(b.email || '').trim().toLowerCase();
    code = String(b.code || '').trim();
    np = String(b.newPassword || '');
  } catch (e) { return core.json(400, { ok: false, reason: 'format' }); }
  if (!core.validEmail(email) || !/^\d{6}$/.test(code) || np.length < 6) return core.json(200, { ok: false, reason: 'format' });

  try {
    const svc = core.getSvc();
    const token = await core.getGoogleAccessToken(svc);

    // Anti fuerza bruta: máx 5 intentos / 15 min por IP.
    if (!(await core.checkRate(svc, token, 'rec_ip_' + core.clientIp(event), 5, 15 * 60 * 1000))) return core.json(429, { ok: false, reason: 'rate' });

    const path = 'crm_accounts/' + core.emailKey(email);
    const acc = await core.fsGet(svc, token, path);
    if (!acc || !acc.uid) return core.json(200, { ok: false, reason: 'nouser' });

    const v = await core.consumeCode(svc, token, email, code);
    if (!v.ok) return core.json(200, v);

    acc.salt = '';
    acc.hash = core.hashPassword(np); // scrypt (incluye su propio salt)
    await core.fsPatch(svc, token, path, acc);

    return core.json(200, { ok: true });
  } catch (e) {
    console.error('auth-recover:', e && e.message ? e.message : e);
    return core.json(500, { ok: false, reason: 'server' });
  }
};
