// ============================================================================
// ml-callback  —  Recibe la autorización de Mercado Libre y guarda los tokens.
// ----------------------------------------------------------------------------
// VERSIÓN AUTOSUFICIENTE: no usa firebase-admin ni ninguna librería externa.
// Escribe en Firestore por su API REST, autenticándose con el service account
// mediante un JWT firmado con el módulo 'crypto' que ya trae Node. Así esta
// función se puede subir a Netlify arrastrando la carpeta (sin npm install).
//
// Flujo: ML redirige aquí con ?code=...&state=<uid>  →
//   1) canjea el code por access_token + refresh_token (usa el CLIENT_SECRET),
//   2) guarda los tokens en Firestore: crm_ml_tokens/{uid},
//   3) devuelve al usuario a la app con ?ml=connected (o ?ml=error).
//
// Variables de entorno (en Netlify):
//   ML_CLIENT_ID, ML_CLIENT_SECRET
//   FIREBASE_SERVICE_ACCOUNT  → el JSON del service account de Firebase (como texto)
//   ML_API                    → (opcional) https://api.mercadolibre.com  [por defecto]
//   URL                       → la pone Netlify sola
// ============================================================================

const crypto = require('crypto');
// Fuente ÚNICA del redirect_uri (compartida con ml-login.js). DEBE coincidir
// EXACTO en ambos lados o ML rechaza el canje. Ver api/lib/ml-redirect.js.
const { resolveRedirectUri } = require('./lib/ml-redirect.js');

const TOKEN_URL = (process.env.ML_API || 'https://api.mercadolibre.com') + '/oauth/token';

// Verifica el `state` firmado por ml-login (HMAC con ML_CLIENT_SECRET). Devuelve el
// uid solo si la firma es válida (anti-CSRF / anti-manipulación). Si no, null.
function verifyState(state) {
  const raw = String(state || '');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const uid = raw.slice(0, dot), sig = raw.slice(dot + 1);
  const secret = process.env.ML_CLIENT_SECRET || '';
  const expected = crypto.createHmac('sha256', secret).update(uid).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  try {
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch (e) { return null; }
  return uid;
}

// ---- Helpers para autenticarse con Google (service account) sin librerías ----
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(claims, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const input = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  const sig = signer.sign(privateKey).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return input + '.' + sig;
}

// Obtiene un token de acceso de Google con permiso para escribir en Firestore.
async function getGoogleAccessToken(svc) {
  const now = Math.floor(Date.now() / 1000);
  const aud = svc.token_uri || 'https://oauth2.googleapis.com/token';
  const claims = {
    iss: svc.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: aud,
    iat: now,
    exp: now + 3600
  };
  const assertion = signJwt(claims, svc.private_key);
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: assertion
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Google token: ' + JSON.stringify(data).slice(0, 200));
  return data.access_token;
}

// Tipos de campo que exige la API REST de Firestore.
const strField = (v) => (v == null ? { nullValue: null } : { stringValue: String(v) });
const intField = (v) => (v == null ? { nullValue: null } : { integerValue: String(v) });

// Guarda (crea o reemplaza) el documento crm_ml_tokens/{uid}.
async function saveTokenDoc(svc, accessToken, uid, fields) {
  const url = 'https://firestore.googleapis.com/v1/projects/' + svc.project_id +
    '/databases/(default)/documents/crm_ml_tokens/' + encodeURIComponent(uid);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: fields })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Firestore write ' + res.status + ': ' + t.slice(0, 200));
  }
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const code = q.code;
  const uid = verifyState(q.state);   // null si el state fue forjado/manipulado
  const oauthError = q.error;

  const base = process.env.URL || ('https://' + (event.headers.host || ''));
  // El usuario vuelve a la APP (front en Vercel), no al backend. APP_URL = URL del front.
  const appUrl = (process.env.APP_URL || base).replace(/\/+$/, '');
  const backTo = (status) => ({ statusCode: 302, headers: { Location: appUrl + '/?ml=' + status }, body: '' });

  if (oauthError) { console.warn('OAuth ML cancelado/erróneo:', oauthError); return backTo('error'); }
  if (!code || !uid) return backTo('error');

  const clientId = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('Faltan ML_CLIENT_ID / ML_CLIENT_SECRET en Netlify.');
    return backTo('error');
  }

  let svc;
  try {
    svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (!svc.private_key || !svc.client_email || !svc.project_id) throw new Error('incompleto');
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT inválido o ausente:', e.message);
    return backTo('error');
  }

  // redirect_uri resuelto por la fuente única compartida (la MISMA que usa
  // ml-login.js). DEBE coincidir EXACTO con el del paso de autorización o ML
  // rechaza el canje por mismatch. Fijar ML_REDIRECT_URI en producción.
  const redirectUri = resolveRedirectUri(event);

  try {
    // 1) Canjear el código de Mercado Libre por los tokens.
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        redirect_uri: redirectUri
      })
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      console.error('Error canjeando token de ML:', data);
      return backTo('error');
    }

    // 2) Guardar en Firestore (crm_ml_tokens/{uid}) vía REST.
    const googleToken = await getGoogleAccessToken(svc);
    await saveTokenDoc(svc, googleToken, uid, {
      ml_user_id: intField(data.user_id),
      access_token: strField(data.access_token),
      refresh_token: strField(data.refresh_token),
      scope: strField(data.scope),
      token_type: strField(data.token_type),
      expires_at: intField(Date.now() + (Number(data.expires_in || 0) * 1000)),
      connectedAt: intField(Date.now()),
      updatedAt: intField(Date.now())
    });

    return backTo('connected');
  } catch (e) {
    console.error('Excepción en ml-callback:', e);
    return backTo('error');
  }
};
