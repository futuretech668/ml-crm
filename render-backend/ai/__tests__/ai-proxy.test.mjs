// Regresión: /api/ai-proxy (la ruta de visión) sigue funcionando SIN CAMBIOS.
// Se prueban los caminos de validación que no requieren red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const proxy = require('../../api/ai-proxy.js');

test('ai-proxy — OPTIONS responde 200', async () => {
  const r = await proxy.handler({ httpMethod: 'OPTIONS', headers: {} });
  assert.equal(r.statusCode, 200);
});

test('ai-proxy — método no POST es 405', async () => {
  const r = await proxy.handler({ httpMethod: 'GET', headers: {} });
  assert.equal(r.statusCode, 405);
});

test('ai-proxy — sin OPENROUTER_API_KEY devuelve 500 config', async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.URL; // evita el filtro de referer
  try {
    const r = await proxy.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ model: 'xiaomi/mimo-v2.5' }) });
    assert.equal(r.statusCode, 500);
    assert.equal(JSON.parse(r.body).error, 'config');
  } finally { if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev; }
});

test('ai-proxy — modelo no permitido es 400', async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'k';
  delete process.env.URL;
  try {
    const r = await proxy.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ model: 'gpt-4-caro' }) });
    assert.equal(r.statusCode, 400);
  } finally { if (prev === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev; }
});
