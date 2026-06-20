// ============================================================================
// send-report  —  Envía AL PROPIO usuario un reporte de sus ventas por correo,
// a pedido (desde el chat MIA). SEGURO:
//   · Requiere un Firebase ID token válido (Authorization: Bearer <idToken>) →
//     se verifica contra las claves públicas de Google. De ahí sale el uid REAL.
//   · El correo destino se deriva SIEMPRE en el servidor (reportEmail del doc del
//     usuario, o el email del token). NUNCA se acepta un destinatario del cliente.
//   · Rate-limit por uid y por IP.
//
// Variables de entorno en Netlify: FIREBASE_SERVICE_ACCOUNT (ya está),
//   GMAIL_USER, GMAIL_APP_PASSWORD (¡copiar desde Render si solo están allá!),
//   EMAIL_FROM_NAME (opcional), OWNER_EMAIL (opcional).
// ============================================================================

const core = require('./lib/_core.js');

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
function reply(status, obj) {
  return { statusCode: status, headers: Object.assign(cors(), { 'Content-Type': 'application/json; charset=utf-8' }), body: JSON.stringify(obj) };
}

const fmt = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');

// Rango de fechas del período (YYYY-MM-DD, comparación lexicográfica segura).
function rangeFor(period) {
  const now = new Date();
  const ymd = (d) => d.toISOString().slice(0, 10);
  if (period === 'daily') { const t = ymd(now); return { from: t, to: t, label: 'hoy (' + t + ')' }; }
  if (period === 'monthly') {
    const from = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
    return { from, to: ymd(now), label: 'este mes' };
  }
  // weekly (por defecto): últimos 7 días
  const from = ymd(new Date(now.getTime() - 6 * 864e5));
  return { from, to: ymd(now), label: 'esta semana (últimos 7 días)' };
}

function saleProfit(s) {
  if (typeof s.profit === 'number' && !isNaN(s.profit)) return s.profit;
  const qty = Number(s.quantity) || 0;
  const total = (typeof s.totalPrice === 'number') ? s.totalPrice : (Number(s.salePrice) || 0) * qty;
  return total - (Number(s.costPrice) || 0) * qty - (Number(s.commission) || 0) - (Number(s.shipping) || 0);
}
function saleRevenue(s) {
  if (typeof s.totalPrice === 'number') return s.totalPrice;
  return (Number(s.salePrice) || 0) * (Number(s.quantity) || 0);
}

function buildReportHtml(period, range, sales) {
  let revenue = 0, profit = 0, units = 0;
  const byProd = {};
  sales.forEach((s) => {
    revenue += saleRevenue(s); profit += saleProfit(s); units += (Number(s.quantity) || 0);
    const k = s.productName || 'Producto';
    if (!byProd[k]) byProd[k] = { qty: 0, rev: 0 };
    byProd[k].qty += (Number(s.quantity) || 0);
    byProd[k].rev += saleRevenue(s);
  });
  const top = Object.keys(byProd).map((k) => ({ name: k, qty: byProd[k].qty, rev: byProd[k].rev }))
    .sort((a, b) => b.rev - a.rev).slice(0, 8);
  const periodTxt = period === 'daily' ? 'Reporte de hoy' : (period === 'monthly' ? 'Reporte del mes' : 'Reporte de la semana');
  const filas = top.map((p) =>
    '<tr><td style="padding:8px 10px;border-bottom:1px solid #eee;">' + String(p.name).replace(/[<>]/g, '') + '</td>' +
    '<td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;">' + p.qty + '</td>' +
    '<td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;">' + fmt(p.rev) + '</td></tr>'
  ).join('') || '<tr><td colspan="3" style="padding:10px;color:#777;">Sin ventas en el período.</td></tr>';
  return '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:20px;color:#0E1117;">' +
    '<h2 style="color:#16C784;margin:0 0 4px;">NexSell</h2>' +
    '<p style="color:#333;font-size:15px;margin:0 0 16px;">' + periodTxt + ' — ' + range.label + '</p>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">' +
      '<div style="flex:1;min-width:150px;background:#f3f5f8;border-radius:10px;padding:12px 14px;"><div style="font-size:12px;color:#777;">Ventas</div><div style="font-size:20px;font-weight:800;">' + sales.length + ' · ' + units + ' u.</div></div>' +
      '<div style="flex:1;min-width:150px;background:#f3f5f8;border-radius:10px;padding:12px 14px;"><div style="font-size:12px;color:#777;">Ingresos</div><div style="font-size:20px;font-weight:800;color:#2563eb;">' + fmt(revenue) + '</div></div>' +
      '<div style="flex:1;min-width:150px;background:#f3f5f8;border-radius:10px;padding:12px 14px;"><div style="font-size:12px;color:#777;">Ganancia</div><div style="font-size:20px;font-weight:800;color:#16C784;">' + fmt(profit) + '</div></div>' +
    '</div>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr>' +
      '<th style="text-align:left;padding:8px 10px;border-bottom:2px solid #ddd;">Producto</th>' +
      '<th style="text-align:right;padding:8px 10px;border-bottom:2px solid #ddd;">Unid.</th>' +
      '<th style="text-align:right;padding:8px 10px;border-bottom:2px solid #ddd;">Ingresos</th>' +
    '</tr></thead><tbody>' + filas + '</tbody></table>' +
    '<p style="color:#999;font-size:12px;margin-top:18px;">Reporte generado a pedido desde el asistente de NexSell.</p>' +
    '</div>';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, reason: 'method' });

  // Correos apagados a propósito: respuesta clara, NO un error de servidor.
  if ((process.env.EMAIL_ENABLED || 'true') === 'false') return reply(200, { ok: false, reason: 'disabled', msg: 'El envío de correos está desactivado por el administrador.' });
  if (!process.env.RESEND_API_KEY) return reply(500, { ok: false, reason: 'config', msg: 'Falta configurar el correo en el servidor.' });

  // Token del usuario (Authorization: Bearer <idToken>)
  const h = event.headers || {};
  const auth = String(h.authorization || h.Authorization || '');
  const idToken = auth.replace(/^Bearer\s+/i, '').trim();
  if (!idToken) return reply(401, { ok: false, reason: 'noauth' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const period = (body.period === 'daily' || body.period === 'monthly') ? body.period : 'weekly';

  let svc;
  try { svc = core.getSvc(); } catch (e) { return reply(500, { ok: false, reason: 'config' }); }

  try {
    // 1) Verificar identidad
    let payload;
    try { payload = await core.verifyFirebaseIdToken(idToken, svc.project_id); }
    catch (e) { return reply(401, { ok: false, reason: 'badtoken' }); }
    const uid = String(payload.sub);

    const gtoken = await core.getGoogleAccessToken(svc);

    // Anti-abuso: máx 5 reportes/hora por usuario y por IP.
    if (!(await core.checkRate(svc, gtoken, 'rep_uid_' + uid, 5, 60 * 60 * 1000))) return reply(429, { ok: false, reason: 'rate', msg: 'Demasiados reportes seguidos. Intenta más tarde.' });
    if (!(await core.checkRate(svc, gtoken, 'rep_ip_' + core.clientIp(event), 15, 60 * 60 * 1000))) return reply(429, { ok: false, reason: 'rate' });

    // 2) ¿Es el dueño? → su doc es crm/state; el resto crm_users/{uid}
    const ownerKey = core.emailKey(process.env.OWNER_EMAIL || 'futuretech.cl.668@gmail.com');
    let ownerUid = '';
    try { const oacc = await core.fsGet(svc, gtoken, 'crm_accounts/' + ownerKey); ownerUid = String((oacc && oacc.uid) || ''); } catch (e) {}
    const isOwner = ownerUid && uid === ownerUid;
    const statePath = isOwner ? 'crm/state' : ('crm_users/' + uid);

    const state = await core.fsGet(svc, gtoken, statePath);

    // 3) Destinatario: SOLO derivado del servidor (reportEmail del doc, o email del token). Nunca del request.
    let to = '';
    const cfg = String((state && state.reportEmail) || '').trim();
    if (core.validEmail(cfg)) to = cfg;
    if (!to && payload.email && core.validEmail(String(payload.email))) to = String(payload.email).trim().toLowerCase();
    if (!to) return reply(400, { ok: false, reason: 'no_email', msg: 'No tengo a qué correo enviarlo. Configura tu correo en Configuración → Notificaciones y reportes.' });

    // 4) Calcular el reporte del período sobre SUS ventas
    const sales = Array.isArray(state && state.sales) ? state.sales : [];
    const range = rangeFor(period);
    const enRango = sales.filter((s) => {
      const d = s.date || (s.createdAt || '').slice(0, 10);
      return d && d >= range.from && d <= range.to;
    });
    const html = buildReportHtml(period, range, enRango);
    const subject = 'NexSell — ' + (period === 'daily' ? 'Reporte de hoy' : (period === 'monthly' ? 'Reporte del mes' : 'Reporte de la semana'));

    const sent = await core.sendEmail(to, subject, html);
    if (!sent) return reply(502, { ok: false, reason: 'send', msg: 'No se pudo enviar el correo.' });

    // Enmascarar el correo para no exponerlo entero en la respuesta.
    const masked = to.replace(/^(.).*(@.*)$/, '$1***$2');
    return reply(200, { ok: true, sentTo: masked, count: enRango.length });
  } catch (e) {
    console.error('send-report:', e && e.message ? e.message : e);
    return reply(500, { ok: false, reason: 'server' });
  }
};
