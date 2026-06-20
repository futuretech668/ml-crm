// ============================================================================
// ml-login  —  Inicia el login OAuth de Mercado Libre para el usuario actual.
// ----------------------------------------------------------------------------
// El botón "Conectar con Mercado Libre" de la app llama a:
//    /.netlify/functions/ml-login?uid=<UID_DEL_USUARIO>
// Esta función arma la URL de autorización de ML y redirige al usuario allá.
// El `state=<uid>` viaja de ida y vuelta para saber DE QUIÉN es el token cuando
// Mercado Libre nos devuelva el código en ml-callback.
//
// Variables de entorno necesarias (se configuran en Netlify, NO en el código):
//   ML_CLIENT_ID      → App ID de tu app de developers.mercadolibre.cl
//   ML_AUTH_DOMAIN    → (opcional) https://auth.mercadolibre.cl  [por defecto]
//   URL               → la pone Netlify sola (la URL pública del sitio)
// ============================================================================

const crypto = require('crypto');
const AUTH_DOMAIN = process.env.ML_AUTH_DOMAIN || 'https://auth.mercadolibre.cl';

// Firma el uid con HMAC para que ml-callback pueda comprobar que el `state`
// fue emitido por NOSOTROS y no manipulado/forjado por un tercero (anti-CSRF).
function signState(uid) {
  const secret = process.env.ML_CLIENT_SECRET || '';
  const sig = crypto.createHmac('sha256', secret).update(String(uid)).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return String(uid) + '.' + sig;
}

exports.handler = async (event) => {
  const uid = (event.queryStringParameters && event.queryStringParameters.uid) || '';
  if (!uid) {
    return { statusCode: 400, body: 'Falta el parámetro uid (usuario no identificado).' };
  }

  const clientId = process.env.ML_CLIENT_ID;
  if (!clientId) {
    return { statusCode: 500, body: 'Falta ML_CLIENT_ID en las variables de entorno de Netlify.' };
  }

  // URL pública del backend (Render). Se configura en la env var URL.
  const base = process.env.URL || ('https://' + (event.headers.host || ''));
  const redirectUri = base + '/api/ml-callback';

  const authUrl = AUTH_DOMAIN + '/authorization'
    + '?response_type=code'
    + '&client_id=' + encodeURIComponent(clientId)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&state=' + encodeURIComponent(signState(uid));

  return { statusCode: 302, headers: { Location: authUrl }, body: '' };
};
