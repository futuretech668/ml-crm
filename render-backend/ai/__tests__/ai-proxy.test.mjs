// Regresión: /api/ai-proxy (la ruta de visión).
// AHORA exige un Firebase ID token válido (antes solo filtraba por Referer, que es
// falsificable → un tercero podía gastar la clave de OpenRouter). Se prueban los
// caminos de validación que no requieren red, con el verificador de token stubbeado.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../../api/lib/_core.js');
const proxy = require('../../api/ai-proxy.js');

// Stubs: ai-proxy llama todo vía core.X, así que sustituimos el verificador y los
// helpers que tocarían red. Token 'GOOD' = sesión válida; cualquier otro = inválido.
core.getSvc = () => ({ project_id: 'test-proj' });
core.getGoogleAccessToken = async () => 'gtoken-test';
core.checkRate = async () => true;
core.verifyFirebaseIdToken = async (idToken) => {
  if (idToken === 'GOOD') return { sub: 'uid1', email: 'vendedor@x.com' };
  throw new Error('bad token');
};
const AUTH = { authorization: 'Bearer GOOD' };

test('ai-proxy — OPTIONS responde 200', async () => {
  const r = await proxy.handler({ httpMethod: 'OPTIONS', headers: {} });
  assert.equal(r.statusCode, 200);
});

test('ai-proxy — método no POST es 405', async () => {
  const r = await proxy.handler({ httpMethod: 'GET', headers: {} });
  assert.equal(r.statusCode, 405);
});

test('ai-proxy — sin token devuelve 401', async () => {
  const r = await proxy.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ model: 'xiaomi/mimo-v2.5' }) });
  assert.equal(r.statusCode, 401);
});

test('ai-proxy — token inválido devuelve 401', async () => {
  const r = await proxy.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer BAD' }, body: JSON.stringify({ model: 'xiaomi/mimo-v2.5' }) });
  assert.equal(r.statusCode, 401);
});

test('ai-proxy — con token pero sin OPENROUTER_API_KEY devuelve 500 config', async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.URL; // evita el filtro de referer
  try {
    const r = await proxy.handler({ httpMethod: 'POST', headers: { ...AUTH }, body: JSON.stringify({ model: 'xiaomi/mimo-v2.5' }) });
    assert.equal(r.statusCode, 500);
    assert.equal(JSON.parse(r.body).error, 'config');
  } finally { if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev; }
});

test('ai-proxy — con token, modelo no permitido es 400', async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'k';
  delete process.env.URL;
  try {
    const r = await proxy.handler({ httpMethod: 'POST', headers: { ...AUTH }, body: JSON.stringify({ model: 'gpt-4-caro' }) });
    assert.equal(r.statusCode, 400);
  } finally { if (prev === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev; }
});
