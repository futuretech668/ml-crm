// ============================================================================
// store.mjs — Capa de persistencia del copiloto MIA (Firestore REST).
//
// Responsabilidades:
//   · Seleccionar el doc de estado del usuario (crm/state si dueño, si no
//     crm_users/{uid}) y cargarlo.
//   · Escribir SOLO los campos de array que cambiaron (read-modify-write con
//     updateMask), igual que hace el cron — sin clobberear el resto del doc.
//   · Cargar/guardar el doc backend-only crm_ai/{uid} (memoria + hilos).
//   · Leer/escribir los tokens de Mercado Libre (crm_ml_tokens/{uid}).
//
// Reusa _core.fsGet (decodifica) y _core.getGoogleAccessToken. El PATCH con
// máscara se hace aquí porque _core.fsPatch escribe el doc completo (sin
// máscara), lo que borraría campos que no tocamos del doc de estado.
// ============================================================================

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../api/lib/_core.js');

const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'futuretech.cl.668@gmail.com').toLowerCase();

// ---- Codificación Firestore (mínima, para el PATCH con máscara) ----
function encodeValue(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'string') return { stringValue: x };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') {
    if (!isFinite(x)) return { nullValue: null };
    return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  }
  if (Array.isArray(x)) return { arrayValue: { values: x.map(encodeValue) } };
  if (typeof x === 'object') return { mapValue: { fields: encodeFields(x) } };
  return { nullValue: null };
}
function encodeFields(obj) {
  const f = {};
  for (const k in obj) f[k] = encodeValue(obj[k]);
  return f;
}

const fsUrl = (svc, path) =>
  'https://firestore.googleapis.com/v1/projects/' + svc.project_id + '/databases/(default)/documents/' + path;

// PATCH con updateMask: actualiza SOLO los campos nombrados; deja el resto intacto.
export async function patchMasked(svc, gtoken, path, obj, fieldPaths) {
  const mask = fieldPaths.map(f => 'updateMask.fieldPaths=' + encodeURIComponent(f)).join('&');
  const url = fsUrl(svc, path) + '?' + mask;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + gtoken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields(obj) })
  });
  if (!res.ok) throw new Error('patchMasked ' + res.status + ': ' + (await res.text()).slice(0, 160));
}

// ---- Selección y carga del doc de estado ----

export function selectStatePath(uid, isOwner) {
  return isOwner ? 'crm/state' : ('crm_users/' + uid);
}

// ¿El usuario es el dueño? Se decide por el uid registrado en crm_accounts del
// correo dueño (igual que send-report), con respaldo por email del token.
export async function resolveOwner(svc, gtoken, uid, email) {
  if (email && String(email).toLowerCase() === OWNER_EMAIL) return true;
  try {
    const ownerKey = core.emailKey(OWNER_EMAIL);
    const oacc = await core.fsGet(svc, gtoken, 'crm_accounts/' + ownerKey);
    const ownerUid = String((oacc && oacc.uid) || '');
    return !!ownerUid && uid === ownerUid;
  } catch (e) { return false; }
}

export async function loadState(svc, gtoken, statePath) {
  const data = await core.fsGet(svc, gtoken, statePath);
  return data || {};
}

// Guarda SOLO los campos indicados del doc de estado (read-modify-write seguro).
export async function saveStateFields(svc, gtoken, statePath, state, fieldPaths) {
  const obj = {};
  for (const f of fieldPaths) obj[f] = state[f];
  await patchMasked(svc, gtoken, statePath, obj, fieldPaths);
}

// ---- Doc backend-only crm_ai/{uid} (memoria + hilos) ----

export function emptyAiDoc() {
  return { businessProfile: null, memory: [], threadIndex: [], threads: {} };
}

export async function loadAiDoc(svc, gtoken, uid) {
  const data = await core.fsGet(svc, gtoken, 'crm_ai/' + uid);
  const doc = Object.assign(emptyAiDoc(), data || {});
  if (!Array.isArray(doc.memory)) doc.memory = [];
  if (!Array.isArray(doc.threadIndex)) doc.threadIndex = [];
  if (!doc.threads || typeof doc.threads !== 'object') doc.threads = {};
  return doc;
}

// El doc crm_ai lo posee 100% el backend → se escribe completo (sin máscara).
export async function saveAiDoc(svc, gtoken, uid, doc) {
  await core.fsPatch(svc, gtoken, 'crm_ai/' + uid, {
    businessProfile: doc.businessProfile || null,
    memory: Array.isArray(doc.memory) ? doc.memory : [],
    threadIndex: Array.isArray(doc.threadIndex) ? doc.threadIndex : [],
    threads: doc.threads || {}
  });
}

// Id de hilo fácil y único: t_<epoch>_<rand>. epoch/rand se inyectan (determinista en tests).
export function newThreadId(epoch, rand) {
  return 't_' + epoch + '_' + rand;
}

// ---- Tokens de Mercado Libre ----

export async function loadMlToken(svc, gtoken, uid) {
  const tk = await core.fsGet(svc, gtoken, 'crm_ml_tokens/' + uid);
  if (!tk || !tk.access_token || !tk.ml_user_id) return null;
  return tk;
}

// Persiste el token refrescado SIN tocar processedOrders/lastCheck del cron.
export async function saveMlToken(svc, gtoken, uid, st, nowMs) {
  await patchMasked(svc, gtoken, 'crm_ml_tokens/' + uid, {
    access_token: st.access,
    refresh_token: st.refresh,
    expires_at: st.expiresAt,
    updatedAt: nowMs
  }, ['access_token', 'refresh_token', 'expires_at', 'updatedAt']);
}

export { core };
