import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildMlTools } from '../ml.mjs';
import { installFetch } from './fsmock.mjs';

const require = createRequire(import.meta.url);
const { makeMlClient } = require('../../ml-sync.js');

function toolMap(ctx) {
  const m = {};
  for (const t of buildMlTools(ctx)) m[t.name] = t;
  return m;
}

// Cliente ML falso e instrumentado.
function fakeClient(opts) {
  opts = opts || {};
  const calls = [];
  return {
    _calls: calls,
    state: () => ({ userId: opts.userId || '123' }),
    async get(ep) { calls.push({ m: 'GET', ep }); return opts.get ? opts.get(ep) : null; },
    async request(method, ep, body) { calls.push({ m: method, ep, body }); return opts.request ? opts.request(method, ep, body) : {}; },
    async fetchOrders(status, from) { calls.push({ m: 'fetchOrders', status, from }); return opts.orders || []; }
  };
}

function mlCtx(client) {
  let tok = 0;
  return {
    thread: { pendingConfirms: [] },
    did: [], proposed: [],
    currentTurn: 1,
    mintToken: () => 'TOK' + (++tok),
    getClient: async () => client
  };
}

test('ml_orders — normaliza pedidos', async () => {
  const client = fakeClient({
    orders: [{
      id: 200001, date_created: '2026-06-19T10:00:00Z', status: 'paid',
      total_amount: 50000, buyer: { nickname: 'COMPRADOR1' },
      shipping: { id: 9001 },
      order_items: [{ item: { id: 'MLC1', title: 'Audífonos' }, quantity: 2, unit_price: 25000 }]
    }]
  });
  const t = toolMap(mlCtx(client));
  const r = JSON.parse(await t.ml_orders.invoke({ status: 'paid' }));
  assert.equal(r.length, 1);
  assert.equal(r[0].id, '200001');
  assert.equal(r[0].buyer, 'COMPRADOR1');
  assert.equal(r[0].shipmentId, '9001');
  assert.equal(r[0].items[0].itemId, 'MLC1');
  assert.equal(r[0].items[0].quantity, 2);
});

test('ml_questions — normaliza preguntas', async () => {
  const client = fakeClient({
    userId: '123',
    get: (ep) => ep.includes('/questions/search') ? { questions: [{ id: 7, item_id: 'MLC1', text: '¿Tiene stock?', date_created: '2026-06-20T08:00:00Z', status: 'UNANSWERED', from: { id: 555 } }] } : null
  });
  const t = toolMap(mlCtx(client));
  const r = JSON.parse(await t.ml_questions.invoke({}));
  assert.equal(r[0].questionId, '7');
  assert.equal(r[0].text, '¿Tiene stock?');
  assert.equal(r[0].itemId, 'MLC1');
});

test('ml_listing — normaliza publicación', async () => {
  const client = fakeClient({
    get: (ep) => ep.startsWith('/items/') ? { id: 'MLC1', title: 'Audífonos', price: 25000, available_quantity: 8, status: 'active', permalink: 'http://x' } : null
  });
  const t = toolMap(mlCtx(client));
  const r = JSON.parse(await t.ml_listing.invoke({ itemId: 'MLC1' }));
  assert.equal(r.price, 25000);
  assert.equal(r.available_quantity, 8);
});

test('no conectado — devuelve mensaje amable sin romper', async () => {
  const t = toolMap(mlCtx(null));
  const r = JSON.parse(await t.ml_orders.invoke({}));
  assert.equal(r.error, 'no_conectado');
});

test('confirm-gate — propone sin ejecutar, bloquea el mismo turno, ejecuta al siguiente', async () => {
  const client = fakeClient({});
  const ctx = mlCtx(client);
  const t = toolMap(ctx);

  // 1) Propuesta (sin confirmToken): NO ejecuta.
  const prop = JSON.parse(await t.ml_answer_question.invoke({ questionId: '101', text: 'Sí, hay stock.' }));
  assert.equal(prop.proposed, true);
  assert.equal(prop.confirmToken, 'TOK1');
  assert.equal(ctx.proposed.length, 1);
  assert.equal(client._calls.filter(c => c.m === 'POST').length, 0);

  // 2) Mismo turno con el token: BLOQUEADO (re-propone, no ejecuta).
  const same = JSON.parse(await t.ml_answer_question.invoke({ questionId: '101', text: 'Sí, hay stock.', confirmToken: 'TOK1' }));
  assert.equal(same.proposed, true);
  assert.equal(client._calls.filter(c => c.m === 'POST').length, 0);

  // 3) Turno posterior con el token original + firma intacta: EJECUTA.
  ctx.currentTurn = 2;
  const exec = JSON.parse(await t.ml_answer_question.invoke({ questionId: '101', text: 'Sí, hay stock.', confirmToken: 'TOK1' }));
  assert.equal(exec.ok, true);
  const posts = client._calls.filter(c => c.m === 'POST' && c.ep === '/answers');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.question_id, 101);
  assert.equal(posts[0].body.text, 'Sí, hay stock.');
  assert.equal(ctx.did[0].action, 'ml_answer_question');
});

test('confirm-gate — token forjado re-propone, no ejecuta', async () => {
  const client = fakeClient({});
  const ctx = mlCtx(client);
  ctx.currentTurn = 5;
  const t = toolMap(ctx);
  const r = JSON.parse(await t.ml_update_listing.invoke({ itemId: 'MLC1', price: 30000, confirmToken: 'BOGUS' }));
  assert.equal(r.proposed, true);
  assert.equal(client._calls.filter(c => c.m === 'PUT').length, 0);
});

test('confirm-gate — firma cambiada entre propuesta y ejecución re-propone', async () => {
  const client = fakeClient({});
  const ctx = mlCtx(client);
  const t = toolMap(ctx);
  await t.ml_update_listing.invoke({ itemId: 'MLC1', price: 30000 }); // TOK1, turno 1
  ctx.currentTurn = 2;
  // Mismo token pero precio distinto → firma no coincide → re-propone.
  const r = JSON.parse(await t.ml_update_listing.invoke({ itemId: 'MLC1', price: 99999, confirmToken: 'TOK1' }));
  assert.equal(r.proposed, true);
  assert.equal(client._calls.filter(c => c.m === 'PUT').length, 0);
});

test('makeMlClient — refresca el token al expirar', async () => {
  const restore = installFetch(async (url, opts) => {
    const u = String(url);
    if (u.includes('/oauth/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'NEW_ACCESS', refresh_token: 'NEW_REFRESH', expires_in: 21600, user_id: 123 }), text: async () => '' };
    }
    // Llamada normal tras refrescar.
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{"ok":true}' };
  });
  try {
    const client = makeMlClient({ access_token: 'OLD', refresh_token: 'r', expires_at: Date.now() - 60000, ml_user_id: '123' }, 'cid', 'csec');
    await client.get('/users/me');
    const st = client.state();
    assert.equal(st.refreshed, true);
    assert.equal(st.access, 'NEW_ACCESS');
    assert.equal(st.refresh, 'NEW_REFRESH');
  } finally { restore(); }
});
