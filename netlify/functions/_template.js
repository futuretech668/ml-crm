// ============================================================================
// _template.js — Plantilla para funciones NUEVAS que tocan datos sensibles.
// ----------------------------------------------------------------------------
// Regla de arquitectura: a partir de ahora, toda operación nueva sobre datos
// (ventas, productos, dinero) se hace en una Netlify Function como esta, NO con
// Firestore directo desde el navegador.
//
// Este proyecto NO usa firebase-admin: Firestore se accede por REST con el
// service account (ver lib/_core.js: fsGet/fsPatch/getGoogleAccessToken).
// Para identificar al usuario hay que VERIFICAR su ID token de Firebase.
// ============================================================================

const core = require('./lib/_core');
// TODO (cuando se construya la 1ª función real): agregar a _core.js un helper
//   verifyIdToken(idToken) -> { uid, claims }  que valide la firma RS256 del
//   token contra las claves públicas de Google
//   (https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com),
//   y comprobar aud === projectId, iss y exp. Mientras no exista, esta plantilla
//   es solo de referencia.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return core.json(200, { ok: true });
  if (event.httpMethod !== 'POST') return core.json(405, { ok: false, reason: 'method' });

  // 1) Verificar el ID token (el front lo manda en el header Authorization).
  const authz = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  if (!idToken) return core.json(401, { ok: false, reason: 'no-auth' });

  // const { uid, claims } = await core.verifyIdToken(idToken);   // <-- helper a implementar
  // if (!uid) return core.json(401, { ok: false, reason: 'bad-token' });

  // 2) Operar en Firestore SOLO sobre el doc del propio uid.
  // const svc = core.getSvc();
  // const gtoken = await core.getGoogleAccessToken(svc);
  // const data = await core.fsGet(svc, gtoken, 'crm_users/' + uid);

  // 3) Responder solo con lo que corresponde a ese usuario.
  return core.json(200, { ok: true });
};
