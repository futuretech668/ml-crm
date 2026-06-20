// ============================================================================
// ml-emails  —  Envía los correos de NexSell en la nube (sin depender del PC).
// ----------------------------------------------------------------------------
// Réplica de la parte de correos de sync-ml.js, autosuficiente (sin librerías):
//   - Bienvenida a cada cuenta NUEVA (crm_accounts).
//   - Aviso de venta nueva y de stock bajo/agotado al dueño (crm/state).
//   - Reporte semanal (lunes) y mensual (día 1) al dueño.
//   - Reporte semanal/mensual a CADA usuario (crm_users/{uid}).
//
// Envía por Gmail vía un cliente SMTP mínimo escrito con el módulo nativo 'tls'
// (no usa nodemailer). El estado de envío (para no repetir) se guarda en
// Firestore: crm_email_state/main.
//
// De momento se dispara MANUALMENTE por URL para poder probar. Después se le
// agrega el horario en netlify.toml (igual que ml-sync).
//
// Variables de entorno (en Netlify):
//   FIREBASE_SERVICE_ACCOUNT (ya está)
//   GMAIL_USER, GMAIL_APP_PASSWORD            (la cuenta que envía)
//   EMAIL_FROM_NAME   (opcional, por defecto "NexSell")
//   REPORT_EMAIL      (opcional, dueño; por defecto futuretech.cl.668@gmail.com)
//   OWNER_EMAIL       (opcional)
//   EMAIL_ENABLED / WELCOME_EMAIL_ENABLED / USER_REPORTS_ENABLED  (opcional, 'false' apaga)
//   MAX_EMAILS_PER_RUN (opcional, por defecto 6)
// ============================================================================

const crypto = require('crypto');
const tls = require('tls');
const EMAIL_TEMPLATES = require('./lib/email-templates');

const OWNER_EMAIL = (process.env.OWNER_EMAIL || process.env.REPORT_EMAIL || 'futuretech.cl.668@gmail.com').toLowerCase();
const REPORT_EMAIL = process.env.REPORT_EMAIL || 'futuretech.cl.668@gmail.com';
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'NexSell';
const MAX_EMAILS_PER_RUN = Number(process.env.MAX_EMAILS_PER_RUN || 6);

// ---------------- Google / Firestore (igual que ml-sync) ----------------
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
async function fsPatch(svc, token, path, obj) {
  const res = await fetch(fsUrl(svc, path), { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: encodeFields(obj) }) });
  if (!res.ok) throw new Error('fsPatch ' + res.status + ': ' + (await res.text()).slice(0, 160));
}
async function fsList(svc, token, collection) {
  const docs = []; let pageToken = '';
  do {
    const url = fsUrl(svc, collection) + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 404) break;
    if (!res.ok) throw new Error('fsList ' + res.status + ': ' + (await res.text()).slice(0, 160));
    const d = await res.json();
    for (const doc of (d.documents || [])) docs.push(decodeFields(doc.fields || {}));
    pageToken = d.nextPageToken || '';
  } while (pageToken);
  return docs;
}

// ---------------- Enviador SMTP mínimo (Gmail, sin librerías) ----------------
function gmailSmtpSend(user, pass, fromName, to, subject, html) {
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
        const msg = [
          'From: ' + fromName + ' <' + user + '>',
          'To: ' + recipients.join(', '),
          'Subject: ' + encH(subject || ''),
          'MIME-Version: 1.0',
          'Content-Type: text/html; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '', bodyB64, '.'
        ].join('\r\n');
        socket.write(msg + '\r\n'); c = await expect(); if (c !== 250) throw new Error('envío ' + c);
        send('QUIT'); settled = true; try { socket.end(); } catch (_) {}
        resolve(true);
      } catch (e) { fail(e); }
    })();
  });
}

// ---------------- Utilidades de estadísticas (de sync-ml.js) ----------------
function mondayKey(d) { const x = new Date(d); const day = x.getDay(); x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day)); return x.toISOString().slice(0, 10); }
function summarizeSales(sales) {
  const list = Array.isArray(sales) ? sales : [];
  const stats = { count: 0, units: 0, revenue: 0, commission: 0, shipping: 0, profit: 0 };
  const byProduct = {};
  for (const s of list) {
    const qty = s.quantity || 1;
    const total = s.totalPrice != null ? s.totalPrice : (s.salePrice || 0) * qty;
    stats.count++; stats.units += qty; stats.revenue += total;
    stats.commission += s.commission || 0; stats.shipping += s.shipping || 0; stats.profit += (s.profit != null ? s.profit : 0);
    const name = s.productName || s.title || ('Producto ' + (s.productId || s.item_id || ''));
    if (!byProduct[name]) byProduct[name] = { name, qty: 0, revenue: 0 };
    byProduct[name].qty += qty; byProduct[name].revenue += total;
  }
  stats.top = Object.values(byProduct).sort((a, b) => b.qty - a.qty).slice(0, 5);
  return stats;
}
function salesInRange(sales, fromDate, toDate) {
  const from = fromDate ? fromDate.slice(0, 10) : null, to = toDate ? toDate.slice(0, 10) : null;
  return (sales || []).filter(s => { const d = (s.date || (s.createdAt || '').slice(0, 10)); if (!d) return false; if (from && d < from) return false; if (to && d >= to) return false; return true; });
}
function computeGoalProgress(goals, sales, now) {
  const g = (goals && goals.mensual) ? goals.mensual : null;
  if (!g || !g.objetivo) return null;
  const ym = now.toISOString().slice(0, 7);
  if (g.mes && g.mes !== ym) return null;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  let logrado = 0;
  for (const s of salesInRange(sales, monthStart, null)) {
    if (g.tipoMeta === 'ganancia') logrado += (s.profit || 0);
    else if (g.tipoMeta === 'unidades') logrado += (s.quantity || 1);
    else logrado += (s.totalPrice != null ? s.totalPrice : (s.salePrice || 0) * (s.quantity || 1));
  }
  return { tipoMeta: g.tipoMeta, objetivo: g.objetivo, logrado, cumplida: logrado >= g.objetivo };
}

// ---------------- Handler ----------------
exports.handler = async () => {
  if ((process.env.EMAIL_ENABLED || 'true') === 'false') return { statusCode: 200, body: 'EMAIL_ENABLED=false (correos apagados).' };
  const gUser = process.env.GMAIL_USER, gPass = process.env.GMAIL_APP_PASSWORD;
  if (!gUser || !gPass) return { statusCode: 500, body: 'Faltan GMAIL_USER / GMAIL_APP_PASSWORD en Netlify.' };

  let svc;
  try { svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); if (!svc.private_key) throw 0; }
  catch (e) { return { statusCode: 500, body: 'FIREBASE_SERVICE_ACCOUNT inválido.' }; }

  const budget = { sent: 0, max: MAX_EMAILS_PER_RUN };
  const log = [];
  const send = async (to, subject, html) => {
    if (budget.sent >= budget.max) { log.push('(tope alcanzado, queda para próxima corrida)'); return false; }
    try { const ok = await gmailSmtpSend(gUser, gPass, FROM_NAME, to, subject, html); if (ok) { budget.sent++; log.push('→ ' + to + ': ' + subject); } return ok; }
    catch (e) { log.push('✗ ' + to + ': ' + e.message); return false; }
  };

  try {
    const gtoken = await getGoogleAccessToken(svc);
    const est = await fsGet(svc, gtoken, 'crm_email_state/main'); // estado de envíos (dedup)
    const accounts = await fsList(svc, gtoken, 'crm_accounts');
    const ownerState = await fsGet(svc, gtoken, 'crm/state');
    const now = new Date();
    let changed = false;

    // ---- BIENVENIDAS ----
    if ((process.env.WELCOME_EMAIL_ENABLED || 'true') !== 'false') {
      const welcomed = new Set(est.welcomedAccounts || []);
      const keyOf = (a) => String(a.uid || a.email || '');
      if (!est.welcomedInit) {
        for (const a of accounts) { const k = keyOf(a); if (k) welcomed.add(k); }
        est.welcomedInit = true; est.welcomedAccounts = [...welcomed].slice(-5000); changed = true;
        log.push('Bienvenidas inicializadas (línea base, sin envíos a cuentas existentes).');
      } else {
        for (const a of accounts) {
          const k = keyOf(a); if (!k || welcomed.has(k)) continue;
          if (!a.email) { welcomed.add(k); changed = true; continue; }
          const { subject, html } = EMAIL_TEMPLATES.buildWelcomeEmail(a);
          if (await send(a.email, subject, html)) { welcomed.add(k); changed = true; }
        }
        est.welcomedAccounts = [...welcomed].slice(-5000);
      }
    }

    // ---- AVISOS DEL DUEÑO (venta nueva, stock bajo, reportes) ----
    const products = ownerState.products || [], sales = ownerState.sales || [];
    const emailedSales = new Set(est.emailedSales || []);
    const emailedLowStock = new Set(est.emailedLowStock || []);

    if (!est.emailedInit) {
      for (const s of sales) if (s && s.source === 'mercadolibre' && s.id != null) emailedSales.add(String(s.id));
      for (const p of products) { if (!p || p.archived) continue; const st = p.stock || 0, min = (p.stockMin != null ? p.stockMin : 5); const id = (p.id != null ? p.id : (p.name || '')); if (st <= 0) emailedLowStock.add(id + ':out'); else if (st <= min) emailedLowStock.add(id + ':low'); }
      est.emailedInit = true; est.lastWeekly = mondayKey(now); est.lastMonthly = now.toISOString().slice(0, 7);
      est.emailedSales = [...emailedSales].slice(-2000); est.emailedLowStock = [...emailedLowStock].slice(-500);
      changed = true; log.push('Avisos del dueño inicializados (línea base, sin envíos del histórico).');
    } else {
      // Resumen DIARIO de ventas (UN solo correo al día, no uno por cada venta) — hora de Chile.
      const dailyHour = Number(process.env.DAILY_SUMMARY_HOUR || 21);   // 21:00 (9 PM) hora de Chile
      // Correo del resumen: el que el dueño configuró en la app (ownerState.reportEmail) tiene prioridad; si no, env/var por defecto.
      const ownerCfgEmail = String(ownerState.reportEmail || '').trim();
      const SUMMARY_EMAIL = (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerCfgEmail) ? ownerCfgEmail : (process.env.SUMMARY_EMAIL || REPORT_EMAIL));
      const clParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(now);
      const clVal = (t) => (clParts.find(p => p.type === t) || {}).value;
      const chileDay = clVal('year') + '-' + clVal('month') + '-' + clVal('day');
      const chileHour = Number(clVal('hour')) % 24;
      if (chileHour >= dailyHour && est.lastDailySummary !== chileDay) {
        const hoy = sales.filter(s => s && (s.date || (s.createdAt || '').slice(0, 10)) === chileDay);
        if (hoy.length) {
          const stats = summarizeSales(hoy); stats.periodLabel = chileDay; stats.items = hoy;
          const { subject, html } = EMAIL_TEMPLATES.buildDailySummary(stats);
          if (await send(SUMMARY_EMAIL, subject, html)) { est.lastDailySummary = chileDay; changed = true; }
        } else {
          est.lastDailySummary = chileDay; changed = true; // sin ventas hoy: NO se envía nada
        }
        for (const s of hoy) if (s.id != null) emailedSales.add(String(s.id));
      }
      // Stock bajo / agotado
      for (const p of products) {
        if (!p || p.archived) continue;
        const stock = p.stock || 0, min = (p.stockMin != null ? p.stockMin : 5);
        let level = stock <= 0 ? 'out' : (stock <= min ? 'low' : null);
        if (!level) continue;
        const key = (p.id != null ? p.id : (p.name || '')) + ':' + level;
        if (emailedLowStock.has(key)) continue;
        const { subject, html } = EMAIL_TEMPLATES.buildLowStockEmail(p);
        if (await send(REPORT_EMAIL, subject, html)) { emailedLowStock.add(key); changed = true; }
      }
      for (const p of products) { if (!p) continue; const stock = p.stock || 0, min = (p.stockMin != null ? p.stockMin : 5); if (stock > min) { const id = (p.id != null ? p.id : (p.name || '')); if (emailedLowStock.delete(id + ':low')) changed = true; if (emailedLowStock.delete(id + ':out')) changed = true; } }
      // Fechas de Chile para semanal/mensual (mismo huso que el diario).
      const [_cy, _cm, _cd] = chileDay.split('-').map(Number);
      const chileDow = new Date(Date.UTC(_cy, _cm - 1, _cd)).getUTCDay();   // 0 = domingo
      const chileLastDay = new Date(Date.UTC(_cy, _cm, 0)).getUTCDate();     // último día del mes
      // Reporte SEMANAL: domingo a las 21:00 (hora de Chile).
      if (chileHour >= dailyHour && chileDow === 0 && est.lastWeekly !== chileDay) {
        const from = new Date(now.getTime() - 7 * 864e5).toISOString();
        const stats = summarizeSales(salesInRange(sales, from, null)); stats.periodLabel = 'Semana al ' + chileDay;
        const { subject, html } = EMAIL_TEMPLATES.buildWeeklyReport(stats);
        if (await send(SUMMARY_EMAIL, subject, html)) { est.lastWeekly = chileDay; changed = true; }
      }
      // Reporte MENSUAL: último día del mes a las 21:00 (hora de Chile), del mes que termina.
      const curMonthKey = _cy + '-' + String(_cm).padStart(2, '0');
      if (chileHour >= dailyHour && _cd === chileLastDay && est.lastMonthly !== curMonthKey) {
        const mStart = new Date(Date.UTC(_cy, _cm - 1, 1)).toISOString();
        const stats = summarizeSales(salesInRange(sales, mStart, null));
        stats.periodLabel = new Date(Date.UTC(_cy, _cm - 1, 1)).toLocaleDateString('es-CL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        const pStart = new Date(Date.UTC(_cy, _cm - 2, 1)).toISOString();
        const p2 = summarizeSales(salesInRange(sales, pStart, mStart));
        stats.prev = { profit: p2.profit, revenue: p2.revenue, units: p2.units, count: p2.count, label: new Date(Date.UTC(_cy, _cm - 2, 1)).toLocaleDateString('es-CL', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
        const { subject, html } = EMAIL_TEMPLATES.buildMonthlyReport(stats);
        if (await send(SUMMARY_EMAIL, subject, html)) { est.lastMonthly = curMonthKey; changed = true; }
      }
      est.emailedSales = [...emailedSales].slice(-2000); est.emailedLowStock = [...emailedLowStock].slice(-500);
    }

    // ---- CORREOS POR USUARIO (cada NO-dueño, sobre SUS datos, a SU correo) ----
    //  · Stock bajo/agotado: en cada corrida (igual que el dueño), con dedupe por usuario.
    //  · Resumen diario de ventas: 1 vez al día a las 23:00 (Chile), solo si hubo ventas.
    if ((process.env.USER_REPORTS_ENABLED || 'true') !== 'false') {
      const dHour = Number(process.env.DAILY_SUMMARY_HOUR || 21);
      const dParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(now);
      const dVal = (t) => (dParts.find(p => p.type === t) || {}).value;
      const dDay = dVal('year') + '-' + dVal('month') + '-' + dVal('day');
      const dCurHour = Number(dVal('hour')) % 24;
      const ldu = est.lastDailyByUser || {};   // { uid: 'YYYY-MM-DD' }  (resumen ya enviado hoy)
      const lsu = est.lowStockByUser || {};     // { uid: ['id:level', ...] }  (stock ya avisado)
      for (const acc of accounts) {
        const email = acc.email, uid = acc.uid;
        if (!email || !uid || String(email).toLowerCase() === OWNER_EMAIL) continue; // el dueño tiene los suyos
        if (budget.sent >= budget.max) break;
        const data = await fsGet(svc, gtoken, 'crm_users/' + uid);

        // 1) Stock bajo / agotado de SUS productos (cada corrida)
        const seen = new Set(lsu[uid] || []);
        for (const p of (data.products || [])) {
          if (!p || p.archived) continue;
          const stock = p.stock || 0, min = (p.stockMin != null ? p.stockMin : 5);
          const pid = (p.id != null ? p.id : (p.name || ''));
          const level = stock <= 0 ? 'out' : (stock <= min ? 'low' : null);
          if (!level) { seen.delete(pid + ':low'); seen.delete(pid + ':out'); continue; } // repuesto → puede volver a avisar
          const k = pid + ':' + level;
          if (seen.has(k)) continue;
          if (budget.sent >= budget.max) break;
          const { subject, html } = EMAIL_TEMPLATES.buildLowStockEmail(p);
          if (await send(email, subject, html)) { seen.add(k); changed = true; }
        }
        lsu[uid] = [...seen].slice(-200);

        // 2) Resumen diario de SUS ventas (21:00, solo si vendió hoy) — a su correo configurado o, si no, al de la cuenta.
        if (dCurHour >= dHour && ldu[uid] !== dDay) {
          const cfgEmail = String(data.reportEmail || '').trim();
          const destDaily = (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfgEmail) ? cfgEmail : email);
          const hoy = (data.sales || []).filter(s => s && (s.date || (s.createdAt || '').slice(0, 10)) === dDay);
          if (hoy.length) {
            const stats = summarizeSales(hoy); stats.periodLabel = dDay; stats.items = hoy;
            const { subject, html } = EMAIL_TEMPLATES.buildDailySummary(stats);
            if (await send(destDaily, subject, html)) { ldu[uid] = dDay; changed = true; }
          } else { ldu[uid] = dDay; changed = true; } // sin ventas: marcar y no enviar
        }
      }
      est.lastDailyByUser = ldu;
      est.lowStockByUser = lsu;
    }

    // ---- REPORTES POR USUARIO (no dueño), lunes o día 1 ----
    if ((process.env.USER_REPORTS_ENABLED || 'true') !== 'false') {
      const rHour = Number(process.env.DAILY_SUMMARY_HOUR || 21);
      const rParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(now);
      const rVal = (t) => (rParts.find(p => p.type === t) || {}).value;
      const rDay = rVal('year') + '-' + rVal('month') + '-' + rVal('day');
      const rHourNow = Number(rVal('hour')) % 24;
      const [ry, rm, rd] = rDay.split('-').map(Number);
      const rDow = new Date(Date.UTC(ry, rm - 1, rd)).getUTCDay();    // 0 = domingo
      const rLastDay = new Date(Date.UTC(ry, rm, 0)).getUTCDate();
      const isWeekly = (rHourNow >= rHour && rDow === 0);             // domingo 21:00
      const isMonthly = (rHourNow >= rHour && rd === rLastDay);       // último día del mes 21:00
      if (isWeekly || isMonthly) {
        const luw = est.lastUserWeekly || {}, lum = est.lastUserMonthly || {};
        for (const acc of accounts) {
          const email = acc.email, uid = acc.uid;
          if (!email || !uid || String(email).toLowerCase() === OWNER_EMAIL) continue;
          if (budget.sent >= budget.max) break;
          const data = await fsGet(svc, gtoken, 'crm_users/' + uid);
          const usales = data.sales || [], goals = data.goals || {}, name = String(email).split('@')[0];
          if (isWeekly) {
            const wk = rDay;   // domingo (clave única de la semana)
            if (luw[uid] !== wk) {
              const stats = summarizeSales(salesInRange(usales, new Date(now.getTime() - 7 * 864e5).toISOString(), null));
              const goal = computeGoalProgress(goals, usales, now);
              if (stats.count > 0 || (goal && goal.objetivo)) {
                const { subject, html } = EMAIL_TEMPLATES.buildUserReport({ name, periodLabel: 'Semana al ' + wk, stats, goal });
                if (await send(email, subject, html)) { luw[uid] = wk; changed = true; }
              } else { luw[uid] = wk; changed = true; }
            }
          }
          if (isMonthly) {
            const mo = ry + '-' + String(rm).padStart(2, '0');
            if (lum[uid] !== mo) {
              const mStart = new Date(Date.UTC(ry, rm - 1, 1)).toISOString();
              const stats = summarizeSales(salesInRange(usales, mStart, null));
              if (stats.count > 0) {
                const { subject, html } = EMAIL_TEMPLATES.buildUserReport({ name, periodLabel: new Date(Date.UTC(ry, rm - 1, 1)).toLocaleDateString('es-CL', { month: 'long', year: 'numeric', timeZone: 'UTC' }), stats, goal: null });
                if (await send(email, subject, html)) { lum[uid] = mo; changed = true; }
              } else { lum[uid] = mo; changed = true; }
            }
          }
        }
        est.lastUserWeekly = luw; est.lastUserMonthly = lum;
      }
    }

    if (changed) { est.updatedAt = Date.now(); await fsPatch(svc, gtoken, 'crm_email_state/main', est); }

    const summary = { ok: true, enviados: budget.sent, detalle: log };
    console.log('ml-emails:', JSON.stringify(summary));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(summary, null, 2) };
  } catch (e) {
    console.error('ml-emails fatal:', e);
    return { statusCode: 500, body: 'Error: ' + e.message };
  }
};
