// ============================================================================
// server.js  —  Backend único de NexSell en Render.
// Levanta un servidor con módulo nativo 'http' (sin librerías) que expone:
//
//   API (consumida por el front en Vercel, vía la constante API_BASE):
//     GET/POST /api/<nombre>   -> ejecuta render-backend/api/<nombre>.js
//       p. ej. /api/ml-login, /api/ml-callback, /api/ai-proxy,
//              /api/auth-register, /api/send-report, etc.
//
//   Cron externo gratis (ej. cron-job.org) cada ~30 min:
//     GET /run-sync?key=SECRETO    -> sincroniza ventas de Mercado Libre
//     GET /run-emails?key=SECRETO  -> envía los correos pendientes
//
//   GET / (o /health)             -> "NexSell backend OK" (para probar)
//
// Variables de entorno:
//   RUN_SECRET  -> clave que el cron debe mandar en ?key=... (protege sync/correos)
//   APP_URL     -> URL del front en Vercel (origen permitido por CORS; opcional)
//   + las que usan las funciones (ML_*, FIREBASE_SERVICE_ACCOUNT, GMAIL_*, etc.)
// ============================================================================

const http = require('http');
const runSync = require('./ml-sync.js').handler;
const runEmails = require('./ml-emails.js').handler;

const PORT = process.env.PORT || 3000;
const SECRET = process.env.RUN_SECRET || '';

// Origen permitido para CORS. Si se define APP_URL (URL del front en Vercel) se
// restringe a ese origen; si no, se permite cualquiera ('*').
const ALLOW_ORIGIN = process.env.APP_URL || '*';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

// Las funciones de la API viven en render-backend/api/<nombre>.js y exportan
// `handler(event)` devolviendo { statusCode, headers, body }. Se cargan de forma
// perezosa la primera vez que se piden y se cachean.
const apiCache = {};
function loadApi(name) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;          // evita path traversal
  if (apiCache[name] !== undefined) return apiCache[name];
  try { apiCache[name] = require('./api/' + name + '.js').handler; }
  catch (e) { apiCache[name] = null; }
  return apiCache[name];
}

// Lee el cuerpo crudo de la petición (para los POST de ai-proxy, auth-*, send-report).
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2_000_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://local'); } catch (e) { res.writeHead(400); return res.end('bad request'); }
  const path = url.pathname;

  // Preflight CORS para las llamadas cross-origin del front (Vercel -> Render).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  if (path === '/' || path === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('NexSell backend OK');
  }

  // ---- API: /api/<nombre> -> render-backend/api/<nombre>.js ----
  if (path.startsWith('/api/')) {
    const name = path.slice('/api/'.length);
    const handler = loadApi(name);
    if (!handler) { res.writeHead(404, CORS_HEADERS); return res.end('not found'); }

    // Construye el `event` con el mismo contrato que esperaban en Netlify.
    const queryStringParameters = {};
    for (const [k, v] of url.searchParams) queryStringParameters[k] = v;
    const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : '';
    const event = { httpMethod: req.method, headers: req.headers, queryStringParameters, body, path };

    try {
      const r = (await handler(event)) || {};
      const headers = Object.assign({}, CORS_HEADERS, r.headers || {});
      res.writeHead(r.statusCode || 200, headers);
      return res.end(r.body || '');
    } catch (e) {
      console.error('api/' + name + ':', e && e.message ? e.message : e);
      res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS_HEADERS));
      return res.end('error');
    }
  }

  // ---- Cron: /run-sync y /run-emails (protegidos por RUN_SECRET) ----
  // Protección OBLIGATORIA: exige ?key= == RUN_SECRET. Si RUN_SECRET no está configurado,
  // se NIEGA el acceso (nunca se degrada a "abierto"), evitando disparos anónimos.
  if (!SECRET || url.searchParams.get('key') !== SECRET) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }

  try {
    let r = null;
    if (path === '/run-sync') r = await runSync({});
    else if (path === '/run-emails') r = await runEmails({});
    else { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    res.writeHead((r && r.statusCode) || 200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end((r && r.body) || '{}');
  } catch (e) {
    console.error('server:', e && e.message ? e.message : e);   // detalle solo en logs del servidor
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('error');
  }
});

server.listen(PORT, () => console.log('NexSell backend escuchando en el puerto ' + PORT));
