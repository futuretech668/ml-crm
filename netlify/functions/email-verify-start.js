// ============================================================================
// email-verify-start  —  Paso 1 del registro: valida el dominio del correo y
// envía un código de 6 dígitos para confirmar que el correo es real y es del
// usuario. El código (su hash) se guarda en Firestore: crm_email_codes/{key}.
//
// POST { email }  ->  { ok:true }  |  { ok:false, reason:'format'|'domain'|'server' }
// ============================================================================

const core = require('./lib/_core');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'NexSell';

function codeEmailHtml(code) {
  return '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;">' +
    '<h2 style="color:#16C784;margin:0 0 8px;">NexSell</h2>' +
    '<p style="color:#333;font-size:15px;">Tu código de verificación es:</p>' +
    '<div style="font-size:34px;font-weight:bold;letter-spacing:8px;background:#f3f5f8;border-radius:10px;padding:16px;text-align:center;color:#0E1117;margin:12px 0;">' + code + '</div>' +
    '<p style="color:#777;font-size:13px;">Escríbelo en la app para activar tu cuenta. Vence en 10 minutos. Si no fuiste tú, ignora este correo.</p>' +
    '</div>';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return core.json(200, { ok: true });
  if (event.httpMethod !== 'POST') return core.json(405, { ok: false, reason: 'method' });

  let email;
  try { email = String((JSON.parse(event.body || '{}').email) || '').trim().toLowerCase(); } catch (e) { return core.json(400, { ok: false, reason: 'format' }); }
  if (!core.validEmail(email)) return core.json(200, { ok: false, reason: 'format' });
  if (!GMAIL_USER || !GMAIL_PASS) return core.json(500, { ok: false, reason: 'server' });

  try {
    const svc = core.getSvc();
    const token = await core.getGoogleAccessToken(svc);

    // Anti mail-bombing / abuso de SMTP saliente: límite por IP y por correo destino.
    const ip = core.clientIp(event);
    if (!(await core.checkRate(svc, token, 'evs_ip_' + ip, 5, 15 * 60 * 1000))) return core.json(429, { ok: false, reason: 'rate' });
    if (!(await core.checkRate(svc, token, 'evs_em_' + core.emailKey(email), 3, 60 * 60 * 1000))) return core.json(429, { ok: false, reason: 'rate' });

    const domain = email.split('@')[1];
    if (!(await core.domainHasMx(domain))) return core.json(200, { ok: false, reason: 'domain' });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await core.fsPatch(svc, token, 'crm_email_codes/' + core.emailKey(email), {
      codeHash: core.sha256(code),
      email: email,
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0,
      used: false,
      createdAt: Date.now()
    });
    await core.gmailSmtpSend(GMAIL_USER, GMAIL_PASS, FROM_NAME, email, 'Tu código de NexSell: ' + code, codeEmailHtml(code));
    return core.json(200, { ok: true });
  } catch (e) {
    console.error('email-verify-start:', e && e.message ? e.message : e);
    return core.json(500, { ok: false, reason: 'server' });
  }
};
