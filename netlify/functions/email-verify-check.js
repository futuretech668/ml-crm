// ============================================================================
// email-verify-check  —  Paso 2 del registro: confirma el código que el usuario
// escribió. Compara contra el hash guardado (el cliente NUNCA ve el código real).
// Limita intentos y respeta el vencimiento.
//
// POST { email, code }  ->  { ok:true }
//                       |   { ok:false, reason:'wrong'|'expired'|'nocode'|'attempts'|'server' }
// ============================================================================

const core = require('./lib/_core');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return core.json(200, { ok: true });
  if (event.httpMethod !== 'POST') return core.json(405, { ok: false, reason: 'method' });

  let email, code;
  try {
    const b = JSON.parse(event.body || '{}');
    email = String(b.email || '').trim().toLowerCase();
    code = String(b.code || '').trim();
  } catch (e) { return core.json(400, { ok: false, reason: 'format' }); }
  if (!core.validEmail(email) || !/^\d{6}$/.test(code)) return core.json(200, { ok: false, reason: 'wrong' });

  try {
    const svc = core.getSvc();
    const token = await core.getGoogleAccessToken(svc);
    const path = 'crm_email_codes/' + core.emailKey(email);
    const rec = await core.fsGet(svc, token, path);

    if (!rec || !rec.codeHash || rec.used) return core.json(200, { ok: false, reason: 'nocode' });
    if (Date.now() > (rec.expiresAt || 0)) return core.json(200, { ok: false, reason: 'expired' });
    if ((rec.attempts || 0) >= 6) return core.json(200, { ok: false, reason: 'attempts' });

    if (core.sha256(code) !== rec.codeHash) {
      rec.attempts = (rec.attempts || 0) + 1;
      await core.fsPatch(svc, token, path, rec);
      return core.json(200, { ok: false, reason: 'wrong' });
    }

    // Correcto: invalidar el código para que no se reutilice.
    rec.used = true; rec.codeHash = null; rec.usedAt = Date.now();
    await core.fsPatch(svc, token, path, rec);
    return core.json(200, { ok: true });
  } catch (e) {
    console.error('email-verify-check:', e.message);
    return core.json(500, { ok: false, reason: 'server' });
  }
};
