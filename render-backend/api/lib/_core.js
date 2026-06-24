// ============================================================================
// _core.js  —  Utilidades compartidas por las funciones de verificación de
// correo (Google/Firestore por REST + envío SMTP por Gmail + chequeo de dominio).
// Sin librerías externas: solo módulos nativos de Node.
// ============================================================================

const crypto = require('crypto');
const tls = require('tls');
const dns = require('dns').promises;

function getSvc() {
  const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (!svc.private_key || !svc.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT inválido o ausente.');
  return svc;
}

// ---- Google access token (JWT firmado con el service account) ----
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
async function getGoogleAccessToken(svc) {
  const now = Math.floor(Date.now() / 1000);
  const aud = svc.token_uri || 'https://oauth2.googleapis.com/token';
  const assertion = signJwt({ iss: svc.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud, iat: now, exp: now + 3600 }, svc.private_key);
  const res = await fetch(aud, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Google token: ' + JSON.stringify(data).slice(0, 200));
  return data.access_token;
}

// ---- Firestore REST (un solo doc) ----
const fsUrl = (svc, path) => 'https://firestore.googleapis.com/v1/projects/' + svc.project_id + '/databases/(default)/documents/' + path;
function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}
function decodeFields(f) { const o = {}; for (const k in f) o[k] = decodeValue(f[k]); return o; }
function encodeValue(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'string') return { stringValue: x };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') { if (!isFinite(x)) return { nullValue: null }; return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x }; }
  if (Array.isArray(x)) return { arrayValue: { values: x.map(encodeValue) } };
  if (typeof x === 'object') return { mapValue: { fields: encodeFields(x) } };
  return { nullValue: null };
}
function encodeFields(o) { const f = {}; for (const k in o) f[k] = encodeValue(o[k]); return f; }
async function fsGet(svc, token, path) {
  const res = await fetch(fsUrl(svc, path), { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error('fsGet ' + res.status + ': ' + (await res.text()).slice(0, 160));
  const d = await res.json(); return decodeFields(d.fields || {});
}
// Igual que fsGet pero devuelve también el updateTime del doc (para concurrencia
// optimista, como hace ml-sync.js). No reemplaza a fsGet: los llamadores existentes
// siguen usando fsGet (que devuelve solo los datos).
async function fsGetWithMeta(svc, token, path) {
  const res = await fetch(fsUrl(svc, path), { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 404) return { exists: false, data: {}, updateTime: null };
  if (!res.ok) throw new Error('fsGet ' + res.status + ': ' + (await res.text()).slice(0, 160));
  const d = await res.json();
  return { exists: true, data: decodeFields(d.fields || {}), updateTime: d.updateTime || null };
}
// fsPatch con precondición opcional currentDocument.updateTime (mismo patrón que
// ml-sync.js:116-131). Sin updateTime se comporta igual que antes (lanza ante !ok).
// Con updateTime y conflicto (409/412/precondition) devuelve { ok:false, conflict:true }
// en vez de lanzar, para que el llamador reintente con read-modify-write.
async function fsPatch(svc, token, path, obj, updateTime) {
  let url = fsUrl(svc, path);
  if (updateTime) url += '?currentDocument.updateTime=' + encodeURIComponent(updateTime);
  const res = await fetch(url, { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: encodeFields(obj) }) });
  if (updateTime && (res.status === 409 || res.status === 412 || res.status === 400)) {
    const t = await res.text();
    if (/precondition|updateTime|FAILED_PRECONDITION/i.test(t)) return { ok: false, conflict: true };
    throw new Error('fsPatch ' + res.status + ': ' + t.slice(0, 160));
  }
  if (!res.ok) throw new Error('fsPatch ' + res.status + ': ' + (await res.text()).slice(0, 160));
  return { ok: true };
}

// ---- Envío de correo. Render bloquea el SMTP saliente, así que si está
// definido MAIL_RELAY_URL (una función en Vercel) se delega el envío ahí por
// HTTP. Si no, se intenta SMTP directo (funciona en Netlify, no en Render). ----
async function gmailSmtpSend(user, pass, fromName, to, subject, html) {
  const relay = process.env.MAIL_RELAY_URL;
  if (relay) {
    const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
    const r = await fetch(relay, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: recipients, subject, html, fromName, secret: process.env.MAIL_SECRET || '' })
    });
    let j = {}; try { j = await r.json(); } catch (_) {}
    if (!r.ok || !j.ok) throw new Error('relay ' + r.status + ' ' + (j.reason || ''));
    return true;
  }
  return smtpDirect(user, pass, fromName, to, subject, html);
}

// ---- Envío SMTP directo por Gmail (mínimo, sin nodemailer) ----
function smtpDirect(user, pass, fromName, to, subject, html) {
  return new Promise((resolve, reject) => {
    const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
    if (!recipients.length) return resolve(false);
    const socket = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' });
    socket.setEncoding('utf8');
    let buffer = '', pending = null, settled = false;
    const fail = (e) => { if (settled) return; settled = true; try { socket.destroy(); } catch (_) {} reject(e instanceof Error ? e : new Error(String(e))); };
    socket.setTimeout(25000, () => fail(new Error('SMTP timeout')));
    socket.on('error', fail);
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (pending && /(^|\n)\d{3} [^\n]*\r?\n$/.test(buffer)) {
        const code = parseInt(buffer.match(/(?:^|\n)(\d{3}) [^\n]*\r?\n$/)[1], 10);
        buffer = ''; const p = pending; pending = null; p(code);
      }
    });
    const expect = () => new Promise((res) => { pending = res; });
    const send = (line) => socket.write(line + '\r\n');
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const encH = (s) => /[^\x00-\x7F]/.test(s) ? '=?UTF-8?B?' + b64(s) + '?=' : s;
    (async () => {
      try {
        let c = await expect(); if (c !== 220) throw new Error('greeting ' + c);
        send('EHLO nexsell.netlify.app'); c = await expect(); if (c !== 250) throw new Error('EHLO ' + c);
        send('AUTH LOGIN'); c = await expect(); if (c !== 334) throw new Error('AUTH ' + c);
        send(b64(user)); c = await expect(); if (c !== 334) throw new Error('user ' + c);
        send(b64(String(pass).replace(/\s+/g, ''))); c = await expect(); if (c !== 235) throw new Error('login rechazado ' + c);
        send('MAIL FROM:<' + user + '>'); c = await expect(); if (c !== 250) throw new Error('MAIL FROM ' + c);
        for (const r of recipients) { send('RCPT TO:<' + r + '>'); c = await expect(); if (c !== 250 && c !== 251) throw new Error('RCPT ' + c); }
        send('DATA'); c = await expect(); if (c !== 354) throw new Error('DATA ' + c);
        const bodyB64 = Buffer.from(String(html || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
        const msg = ['From: ' + fromName + ' <' + user + '>', 'To: ' + recipients.join(', '), 'Subject: ' + encH(subject || ''), 'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', bodyB64, '.'].join('\r\n');
        socket.write(msg + '\r\n'); c = await expect(); if (c !== 250) throw new Error('envío ' + c);
        send('QUIT'); settled = true; try { socket.end(); } catch (_) {}
        resolve(true);
      } catch (e) { fail(e); }
    })();
  });
}

// ---- Utilidades varias ----
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function emailKey(email) { return String(email || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_'); }
const validEmail = (e) => /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(String(e || ''));

// ¿El dominio del correo puede recibir mensajes? (tiene MX, o al menos resuelve).
async function domainHasMx(domain) {
  if (!domain) return false;
  try { const mx = await dns.resolveMx(domain); if (mx && mx.length) return true; } catch (e) {}
  try { const a = await dns.resolve4(domain); if (a && a.length) return true; } catch (e) {}
  try { const a6 = await dns.resolve6(domain); if (a6 && a6.length) return true; } catch (e) {}
  return false;
}

// Valida y CONSUME un código de verificación de correo (crm_email_codes/{emailKey}).
// Misma lógica que email-verify-check, reutilizable por auth-register / auth-recover.
async function consumeCode(svc, token, email, code) {
  const path = 'crm_email_codes/' + emailKey(email);
  const rec = await fsGet(svc, token, path);
  if (!rec || !rec.codeHash || rec.used) return { ok: false, reason: 'nocode' };
  if (Date.now() > (rec.expiresAt || 0)) return { ok: false, reason: 'expired' };
  if ((rec.attempts || 0) >= 6) return { ok: false, reason: 'attempts' };
  if (sha256(code) !== rec.codeHash) {
    rec.attempts = (rec.attempts || 0) + 1;
    await fsPatch(svc, token, path, rec);
    return { ok: false, reason: 'wrong' };
  }
  rec.used = true; rec.codeHash = null; rec.usedAt = Date.now();
  await fsPatch(svc, token, path, rec);
  return { ok: true };
}

// IP del cliente (Netlify) para los límites anti-abuso.
function clientIp(event) {
  const h = (event && event.headers) || {};
  return String(h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
}
// Límite simple por "bucket" (ip / email / etc.) en Firestore: máx `max` cada `windowMs`.
// (crm_rate solo lo toca el backend.) No es transaccional, pero acota el abuso de forma efectiva.
async function checkRate(svc, token, bucketKey, max, windowMs) {
  const path = 'crm_rate/' + String(bucketKey).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 100);
  const now = Date.now();
  const rec = await fsGet(svc, token, path);
  if (!rec || !rec.windowStart || (now - rec.windowStart) > windowMs) {
    await fsPatch(svc, token, path, { windowStart: now, count: 1 });
    return true;
  }
  if ((rec.count || 0) >= max) return false;
  await fsPatch(svc, token, path, { windowStart: rec.windowStart, count: (rec.count || 0) + 1 });
  return true;
}

// ---- Verificación de Firebase ID token (sin firebase-admin) ----
// Verifica firma RS256 contra las claves públicas de Google + aud/iss/exp. Devuelve el payload (payload.sub = uid)
// o lanza un Error. Cachea las claves públicas según su Cache-Control.
let _gKeysCache = { keys: null, exp: 0 };
async function googleSecureTokenKeys() {
  const now = Date.now();
  if (_gKeysCache.keys && now < _gKeysCache.exp) return _gKeysCache.keys;
  const res = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  if (!res.ok) throw new Error('No se pudieron obtener las claves públicas de Google');
  const keys = await res.json();
  let maxAge = 3600;
  const cc = (res.headers.get && res.headers.get('cache-control')) || '';
  const m = cc.match(/max-age=(\d+)/); if (m) maxAge = parseInt(m[1], 10);
  _gKeysCache = { keys, exp: now + Math.max(60, maxAge) * 1000 };
  return keys;
}
function _b64urlToBuf(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function _b64urlToJson(s) { return JSON.parse(_b64urlToBuf(s).toString('utf8')); }
async function verifyFirebaseIdToken(idToken, projectId) {
  if (!idToken || typeof idToken !== 'string') throw new Error('token ausente');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('token malformado');
  const header = _b64urlToJson(parts[0]);
  const payload = _b64urlToJson(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('alg/kid inválido');
  const keys = await googleSecureTokenKeys();
  const cert = keys[header.kid];
  if (!cert) throw new Error('kid desconocido');
  const pub = new crypto.X509Certificate(cert).publicKey;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), pub, _b64urlToBuf(parts[2]));
  if (!ok) throw new Error('firma inválida');
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error('aud inválido');
  if (payload.iss !== 'https://securetoken.google.com/' + projectId) throw new Error('iss inválido');
  if (!payload.sub) throw new Error('sub ausente');
  if ((payload.exp || 0) < now - 60) throw new Error('token expirado');
  if ((payload.iat || 0) > now + 300) throw new Error('iat futuro');
  return payload;
}

function json(status, obj) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' },
    body: JSON.stringify(obj)
  };
}

module.exports = { getSvc, getGoogleAccessToken, fsGet, fsGetWithMeta, fsPatch, gmailSmtpSend, sha256, emailKey, validEmail, domainHasMx, consumeCode, clientIp, checkRate, verifyFirebaseIdToken, json };
