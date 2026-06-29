// ============================================================================
// ai-proxy  —  Oculta la API key de OpenRouter. El frontend llama aquí (sin la
// key) y esta función reenvía la petición a OpenRouter agregando la key real,
// que vive SOLO en las variables de entorno de Netlify (no en el HTML público).
//
// Protecciones anti-abuso económico:
//   · Allow-list de modelos (solo los que usa la app) → nadie pide modelos caros.
//   · Tope de max_tokens.
//   · Rate-limit por IP (best-effort, vía Firestore).
//   · Filtro Referer/Origin (capa extra, no única).
//
// Variables de entorno en Netlify: OPENROUTER_API_KEY, FIREBASE_SERVICE_ACCOUNT (para el rate-limit).
// ============================================================================

const core = require('./lib/_core');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Solo los modelos que la app realmente usa. Cualquier otro se rechaza.
const ALLOWED_MODELS = new Set([
  'xiaomi/mimo-v2.5',
  'meta-llama/llama-3.2-11b-vision-instruct:free'
]);
const MAX_TOKENS_CAP = 1500;

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Title, HTTP-Referer',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
function reply(status, obj) {
  return { statusCode: status, headers: Object.assign(cors(), { 'Content-Type': 'application/json; charset=utf-8' }), body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method' });

  // Autenticación: exige un Firebase ID token válido (igual que ai-agent / sync-status).
  // Antes la única barrera era el Referer (falsificable con curl) → un tercero podía
  // gastar la clave de OpenRouter. Ahora hace falta una sesión real.
  const hh = event.headers || {};
  const idToken = String(hh.authorization || hh.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!idToken) return reply(401, { error: 'noauth' });
  let svc;
  try { svc = core.getSvc(); } catch (e) { return reply(500, { error: 'config' }); }
  try { await core.verifyFirebaseIdToken(idToken, svc.project_id); }
  catch (e) { return reply(401, { error: 'badtoken' }); }

  // Capa extra (no única): preferir llamadas que digan venir del propio sitio.
  const host = (process.env.URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const ref = ((event.headers && (event.headers.referer || event.headers.Referer)) || '') + ' ' +
              ((event.headers && (event.headers.origin || event.headers.Origin)) || '');
  if (host && ref.indexOf(host) === -1) return reply(403, { error: 'forbidden' });

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return reply(500, { error: 'config' });

  // Parsear y VALIDAR el cuerpo: solo modelos permitidos + tope de tokens.
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'bad json' }); }
  if (!body.model || !ALLOWED_MODELS.has(String(body.model))) return reply(400, { error: 'modelo no permitido' });
  if (!(typeof body.max_tokens === 'number') || body.max_tokens > MAX_TOKENS_CAP) body.max_tokens = MAX_TOKENS_CAP;

  // Rate-limit por IP (best-effort: si Firestore falla, no rompe el chat).
  try {
    const gtoken = await core.getGoogleAccessToken(svc);
    const ip = core.clientIp(event);
    if (!(await core.checkRate(svc, gtoken, 'ai_ip_' + ip, 40, 60 * 60 * 1000))) return reply(429, { error: 'rate limit' });
  } catch (e) { /* no bloquear el chat si el rate-limit no está disponible */ }

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'HTTP-Referer': (process.env.URL || 'https://nexsell.netlify.app'),
        'X-Title': 'NexSell'
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    return { statusCode: res.status, headers: Object.assign(cors(), { 'Content-Type': 'application/json; charset=utf-8' }), body: text };
  } catch (e) {
    console.error('ai-proxy:', e && e.message ? e.message : e);
    return reply(502, { error: 'upstream error' });
  }
};
