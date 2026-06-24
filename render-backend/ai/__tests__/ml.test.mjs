import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildMlTools } from '../ml.mjs';
import { installFetch } from './fsmock.mjs';
import { goldenState } from './fixtures.mjs';

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

test('confirm-gate — token CADUCA tras varios turnos (re-propone, no ejecuta)', async () => {
  const client = fakeClient({});
  const ctx = mlCtx(client);
  const t = toolMap(ctx);
  // Propuesta en el turno 1 → TOK1.
  const prop = JSON.parse(await t.ml_answer_question.invoke({ questionId: '101', text: 'Sí.' }));
  assert.equal(prop.confirmToken, 'TOK1');
  // Muchos turnos después (> TTL de 5), el token ya caducó → re-propone con token nuevo.
  ctx.currentTurn = 10;
  const exec = JSON.parse(await t.ml_answer_question.invoke({ questionId: '101', text: 'Sí.', confirmToken: 'TOK1' }));
  assert.equal(exec.proposed, true);
  assert.notEqual(exec.confirmToken, 'TOK1');
  assert.equal(client._calls.filter(c => c.m === 'POST').length, 0);
});

test('confirm-gate — pendingConfirms se poda (caducados fuera, cap a 20)', async () => {
  const client = fakeClient({});
  const ctx = mlCtx(client);
  const t = toolMap(ctx);
  // Genera 30 propuestas distintas a lo largo de turnos consecutivos.
  for (let i = 1; i <= 30; i++) {
    ctx.currentTurn = i;
    await t.ml_update_listing.invoke({ itemId: 'MLC' + i, price: 1000 + i });
  }
  // Tras la poda, nunca quedan más de 20 tokens pendientes vivos.
  assert.ok(ctx.thread.pendingConfirms.length <= 20);
  // Y los que quedan están dentro del TTL respecto al último turno.
  for (const p of ctx.thread.pendingConfirms) {
    assert.ok((ctx.currentTurn - p.issuedAtTurn) <= 5);
  }
});

test('confirm-gate — el cap de 20 se aplica con tokens TODOS dentro del TTL', async () => {
  // Caso que el test anterior NO ejercita: 25 propuestas vivas DENTRO del TTL
  // (mismo turno base) → la poda por TTL no elimina nada y SÍ se dispara el cap a 20.
  const client = fakeClient({});
  const ctx = mlCtx(client);
  ctx.currentTurn = 1;
  const t = toolMap(ctx);
  for (let i = 1; i <= 25; i++) {
    await t.ml_update_listing.invoke({ itemId: 'MLC' + i, price: 1000 + i });
  }
  // Todos se emitieron en el turno 1 (dentro del TTL de 5) → solo el cap los recorta.
  assert.equal(ctx.thread.pendingConfirms.length, 20);
  // Y deben ser los 20 MÁS RECIENTES (slice(-20)): MLC6..MLC25 — se perdieron MLC1..MLC5.
  const sigs = ctx.thread.pendingConfirms.map(p => p.actionSig);
  assert.ok(sigs.some(s => s.includes('MLC25')));
  assert.ok(sigs.some(s => s.includes('MLC6')));
  assert.ok(!sigs.some(s => s.includes('"price":1001'))); // MLC1 (1000+1) fue podado
});

test('confirm-gate — TTL es inclusivo en su borde (turno+5 ejecuta, turno+6 no)', async () => {
  // Verifica que NO hay off-by-one en el límite del TTL (<= 5).
  const mk = () => { const c = fakeClient({}); const ctx = mlCtx(c); return { c, ctx, t: toolMap(ctx) }; };
  // Borde exacto: propuesta en turno 1, confirmación en turno 6 → diff = 5 = TTL → EJECUTA.
  {
    const { c, ctx, t } = mk();
    await t.ml_answer_question.invoke({ questionId: '101', text: 'Sí.' }); // TOK1, turno 1
    ctx.currentTurn = 6;
    const r = JSON.parse(await t.ml_answer_question.invoke({ questionId: '101', text: 'Sí.', confirmToken: 'TOK1' }));
    assert.equal(r.ok, true, 'diff=5 debe ejecutar (TTL inclusivo)');
    assert.equal(c._calls.filter(x => x.m === 'POST').length, 1);
  }
  // Un turno más allá: propuesta en turno 1, confirmación en turno 7 → diff = 6 > TTL → re-propone.
  {
    const { c, ctx, t } = mk();
    await t.ml_answer_question.invoke({ questionId: '101', text: 'Sí.' }); // TOK1, turno 1
    ctx.currentTurn = 7;
    const r = JSON.parse(await t.ml_answer_question.invoke({ questionId: '101', text: 'Sí.', confirmToken: 'TOK1' }));
    assert.equal(r.proposed, true, 'diff=6 debe re-proponer (caducado)');
    assert.equal(c._calls.filter(x => x.m === 'POST').length, 0);
  }
});

// ctx enriquecido para ml_register_order_by_id (necesita state/changed/nextId/fechas).
function mlCtxFull(client, state) {
  let id = 7000;
  return {
    thread: { pendingConfirms: [] }, did: [], proposed: [], currentTurn: 1,
    mintToken: () => 'T', getClient: async () => client,
    state, changed: new Set(),
    nextId: () => ++id,
    nowIso: () => '2026-06-20T12:00:00.000Z',
    today: () => '2026-06-20', time: () => '12:00'
  };
}

test('ml_register_order_by_id — comisión y envío reales, auto-mapeo, dedupe', async () => {
  const state = goldenState();
  const client = fakeClient({
    get: (ep) => {
      if (ep.startsWith('/orders/302')) return {
        id: 302, date_created: '2026-06-18T10:00:00Z', status: 'paid',
        shipping: { id: 9001 },
        order_items: [{ item: { id: 'MLC1', title: 'Audífonos Pro' }, quantity: 1, unit_price: 25000, sale_fee: 3375, listing_type_id: 'gold_special' }]
      };
      if (ep.startsWith('/shipments/9001/costs')) return { senders: [{ cost: 2990 }] };
      return null;
    }
  });
  const ctx = mlCtxFull(client, state);
  const t = toolMap(ctx);
  const before = state.products.find(p => p.id === 1).stock; // 8
  const r = JSON.parse(await t.ml_register_order_by_id.invoke({ orderId: 302 }));
  assert.equal(r.ok, true);
  assert.equal(r.registradas, 1);
  assert.equal(r.pendingItems.length, 0);
  const sale = r.ventas[0];
  assert.equal(sale.date, '2026-06-18');        // fecha real del pedido
  assert.equal(sale.feeSource, 'sale_fee');
  assert.equal(sale.commission, 3375);          // comisión real
  assert.equal(sale.shipping, 2990);            // envío real
  assert.equal(sale.shippingSource, 'ml');
  assert.equal(sale.source, 'mercadolibre');
  assert.equal(sale.item_id, 'MLC1');
  assert.equal(sale.order_id, '302');
  assert.equal(state.products.find(p => p.id === 1).stock, before - 1);
  assert.equal(state.mappings['MLC1'].productId, 1); // auto-mapeo por nombre
  // Dedupe: registrar el mismo pedido de nuevo no agrega.
  const again = JSON.parse(await t.ml_register_order_by_id.invoke({ orderId: 302 }));
  assert.equal(again.registradas, 0);
  assert.equal(again.yaRegistradas.length, 1);
});

test('ml_register_order_by_id — producto inexistente → pendingItems con sugerencia', async () => {
  const state = goldenState();
  const client = fakeClient({
    get: (ep) => ep.startsWith('/orders/500') ? {
      id: 500, date_created: '2026-06-18T10:00:00Z', status: 'paid', shipping: { id: null },
      order_items: [{ item: { id: 'MLC9', title: 'Producto Totalmente Nuevo XYZ' }, quantity: 1, unit_price: 9000, sale_fee: 1200 }]
    } : null
  });
  const ctx = mlCtxFull(client, state);
  const t = toolMap(ctx);
  const r = JSON.parse(await t.ml_register_order_by_id.invoke({ orderId: 500 }));
  assert.equal(r.registradas, 0);
  assert.equal(r.pendingItems.length, 1);
  assert.equal(r.pendingItems[0].itemId, 'MLC9');
  assert.equal(r.pendingItems[0].unitPrice, 9000);
  assert.equal(r.pendingItems[0].saleFee, 1200);
  assert.equal(state.sales.length, 3); // no registró nada
});

test('ml_register_order_by_id — pedido no encontrado', async () => {
  const state = goldenState();
  const client = fakeClient({ get: () => null });
  const t = toolMap(mlCtxFull(client, state));
  const r = JSON.parse(await t.ml_register_order_by_id.invoke({ orderId: 999 }));
  assert.equal(r.error, 'no_encontrado');
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
