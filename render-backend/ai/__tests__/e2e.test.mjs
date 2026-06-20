// E2E: arranca server.js en un puerto de prueba y hace POST reales a
// /api/ai-agent con verificador de token falso + Firestore/ML mockeados +
// modelo "cerebro" scriptado. Verifica el ruteo de server.js de punta a punta.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { goldenState } from './fixtures.mjs';
import { setupAgent } from './harness.mjs';

const PORT = 4673;
process.env.PORT = String(PORT);
const require = createRequire(import.meta.url);
const server = require('../../server.js'); // arranca server.listen(PORT)

after(() => { try { server.close(); } catch (e) {} });

// POST por http nativo (no usa global.fetch, que está stubbeado para Firestore).
function httpPost(path, bodyObj, idToken) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        idToken ? { Authorization: 'Bearer ' + idToken } : {})
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, json: safeJson(buf), raw: buf }));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

test('e2e — server.js rutea /api/ai-agent: open, query, add_sale, confirm-gate', async () => {
  const ml = { _calls: [], state: () => ({ userId: '123', refreshed: false }), async get() { return null; }, async request(m, ep, b) { this._calls.push({ m, ep, b }); return {}; } };
  let captured = null;
  const brain = async (msg, byName) => {
    if (msg.includes('GANANCIA')) {
      const r = JSON.parse(await byName.query_sales.invoke({ period: 'total' }));
      return { reply: 'Ganancia total: ' + r.totales.profit };
    }
    if (msg.includes('VENDER')) {
      const r = JSON.parse(await byName.add_sale.invoke({ productId: 1, quantity: 1 }));
      return { reply: 'Venta #' + r.sale.id + ' registrada.' };
    }
    if (msg.includes('PROPONER')) {
      const r = JSON.parse(await byName.ml_answer_question.invoke({ questionId: '101', text: 'Sí.' }));
      return { reply: 'Propongo: ' + r.preview.text };
    }
    if (msg.includes('CONFIRMAR')) {
      const r = JSON.parse(await byName.ml_answer_question.invoke({ questionId: '101', text: 'Sí.', confirmToken: captured }));
      return { reply: r.ok ? 'Respondido.' : 'Re-propongo.' };
    }
    return { reply: 'ok' };
  };
  const { fs, restore } = setupAgent({ initialDb: { 'crm_users/uid1': goldenState() }, brain, mlClient: ml });
  try {
    const open = await httpPost('/api/ai-agent', { op: 'open' }, 'USERTOK');
    assert.equal(open.status, 200);
    assert.ok(open.json.threadId);

    const q = await httpPost('/api/ai-agent', { op: 'send', message: 'GANANCIA total', threadId: open.json.threadId }, 'USERTOK');
    assert.ok(q.json.reply.includes('39000'));

    const add = await httpPost('/api/ai-agent', { op: 'send', message: 'VENDER uno', threadId: open.json.threadId }, 'USERTOK');
    assert.equal(add.json.did[0].action, 'add_sale');
    assert.equal(fs.db['crm_users/uid1'].sales.length, 4);

    const p = await httpPost('/api/ai-agent', { op: 'send', message: 'PROPONER respuesta', threadId: open.json.threadId }, 'USERTOK');
    assert.equal(p.json.proposed.length, 1);
    captured = p.json.proposed[0].token;
    assert.equal(ml._calls.filter(c => c.m === 'POST').length, 0);

    const c = await httpPost('/api/ai-agent', { op: 'send', message: 'CONFIRMAR', threadId: open.json.threadId }, 'USERTOK');
    assert.ok(/respondido/i.test(c.json.reply));
    assert.equal(ml._calls.filter(c2 => c2.m === 'POST').length, 1);
  } finally { restore(); }
});

test('e2e — GET /health responde OK (server.js intacto)', async () => {
  const out = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
  assert.equal(out.status, 200);
  assert.match(out.body, /NexSell backend OK/);
});

test('e2e — método GET en /api/ai-agent es 405', async () => {
  const out = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/api/ai-agent' }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
  assert.equal(out.status, 405);
});
