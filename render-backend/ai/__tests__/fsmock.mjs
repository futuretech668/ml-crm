// Firestore REST en memoria + stub de global.fetch, para probar store/tools/e2e
// sin red. Codifica/decodifica con el mismo esquema que _core.js.

export function encodeValue(x) {
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
export function encodeFields(obj) {
  const f = {};
  for (const k in obj) f[k] = encodeValue(obj[k]);
  return f;
}
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

function jsonRes(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    headers: { get: () => null }
  };
}

// Crea un Firestore en memoria. `db` mapea 'collection/doc' -> objeto JS.
export function makeFirestore(initial) {
  const db = Object.assign({}, initial || {});
  const calls = [];
  function pathOf(url) {
    const m = String(url).match(/\/documents\/([^?]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  async function fetchStub(url, opts) {
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase();
    const path = pathOf(url);
    calls.push({ method, path, url: String(url), body: opts.body });
    if (path && db.__error && db.__error[path]) return jsonRes(db.__error[path], { error: 'forced' });
    if (method === 'GET') {
      if (Object.prototype.hasOwnProperty.call(db, path) && db[path] != null) {
        return jsonRes(200, { name: path, fields: encodeFields(db[path]), updateTime: '2026-06-20T00:00:00Z' });
      }
      return jsonRes(404, { error: 'not found' });
    }
    if (method === 'PATCH') {
      const body = JSON.parse(opts.body || '{}');
      const incoming = decodeFields(body.fields || {});
      const maskMatch = String(url).match(/updateMask\.fieldPaths=([^&]+)/g);
      if (maskMatch) {
        // PATCH con máscara: mezcla solo los campos nombrados.
        const cur = db[path] && typeof db[path] === 'object' ? Object.assign({}, db[path]) : {};
        for (const m of maskMatch) {
          const field = decodeURIComponent(m.split('=')[1]);
          cur[field] = incoming[field];
        }
        db[path] = cur;
      } else {
        // PATCH sin máscara: reemplaza el doc completo.
        db[path] = incoming;
      }
      return jsonRes(200, { name: path });
    }
    return jsonRes(400, { error: 'unsupported' });
  }
  return { db, calls, fetchStub, decodeFields, encodeFields };
}

// Service account simulado.
export const FAKE_SVC = { project_id: 'nexsell-test', client_email: 'svc@test', private_key: 'x', token_uri: 'https://oauth2.googleapis.com/token' };

// Instala el stub como global.fetch; devuelve un restore().
export function installFetch(fetchStub) {
  const prev = global.fetch;
  global.fetch = fetchStub;
  return () => { global.fetch = prev; };
}
