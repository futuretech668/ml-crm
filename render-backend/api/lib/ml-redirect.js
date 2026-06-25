// ============================================================================
// ml-redirect  —  ÚNICA fuente de verdad del redirect_uri de OAuth de Mercado
// Libre. Lo usan ml-login.js (al ARMAR la URL de autorización) y ml-callback.js
// (al CANJEAR el code por tokens).
//
// IMPORTANTE: Mercado Libre exige que el redirect_uri del canje COINCIDA EXACTO
// con el que se usó para pedir la autorización. Si difieren (p.ej. porque el
// header host cambia entre una llamada y otra, o porque process.env.URL no está
// fijado), ML rechaza el intercambio con "invalid redirect_uri" / mismatch.
//
// Por eso AMBOS archivos DEBEN llamar a esta misma función. En PRODUCCIÓN conviene
// fijar la variable de entorno ML_REDIRECT_URI con el valor canónico
// (p.ej. https://tu-backend.onrender.com/api/ml-callback) para evitar cualquier
// ambigüedad derivada del host. Si no está definida, se cae al cálculo por
// process.env.URL y, en último término, por el header host de la petición.
// ============================================================================

function resolveRedirectUri(event) {
  // 1) Fuente canónica explícita (recomendada en producción).
  const fixed = String(process.env.ML_REDIRECT_URI || '').trim();
  if (fixed) return fixed.replace(/\/+$/, '');

  // 2) Fallback: base derivada de process.env.URL o del header host de la petición.
  const headers = (event && event.headers) || {};
  const host = headers.host || headers.Host || '';
  const base = (process.env.URL || ('https://' + host)).replace(/\/+$/, '');
  return base + '/api/ml-callback';
}

module.exports = { resolveRedirectUri };
