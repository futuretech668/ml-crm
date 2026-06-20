import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goldenState, NOW } from './fixtures.mjs';
import { buildCrmTools, toolsByName } from '../tools.mjs';
import { emptyAiDoc } from '../store.mjs';

// Construye un ctx determinista para las herramientas.
function makeCtx(state) {
  let id = 1000;
  return {
    state,
    changed: new Set(),
    did: [],
    aiDoc: emptyAiDoc(),
    now: () => NOW,
    nextId: () => ++id,
    nowIso: () => '2026-06-20T12:00:00.000Z',
    today: () => '2026-06-20',
    time: () => '12:00'
  };
}

test('query_sales — devuelve JSON con totales del mes', async () => {
  const ctx = makeCtx(goldenState());
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.query_sales.invoke({ period: 'mes' }));
  assert.equal(r.totales.revenue, 68000);
  assert.equal(r.totales.profit, 28500);
});

test('list_products — bajo stock', async () => {
  const ctx = makeCtx(goldenState());
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.list_products.invoke({ lowStockOnly: true }));
  assert.equal(r.length, 1);
  assert.equal(r[0].nombre, 'Cargador USB-C');
});

test('get_goal_progress — devuelve progreso o sinMeta', async () => {
  const ctx = makeCtx(goldenState());
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.get_goal_progress.invoke({}));
  assert.equal(r.logrado, 28500);
  const ctx2 = makeCtx({ ...goldenState(), goals: {} });
  const t2 = toolsByName(buildCrmTools(ctx2));
  const r2 = JSON.parse(await t2.get_goal_progress.invoke({}));
  assert.equal(r2.sinMeta, true);
});

test('get_finance_summary — total', async () => {
  const ctx = makeCtx(goldenState());
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.get_finance_summary.invoke({ period: 'total' }));
  assert.equal(r.gananciaNeta, 19750);
});

test('add_sale — empuja venta, descuenta stock, registra did', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const before = state.products.find(p => p.id === 2).stock; // 3
  const r = JSON.parse(await t.add_sale.invoke({ productId: 2, quantity: 2, shipping: 1000 }));
  assert.equal(r.ok, true);
  assert.equal(r.sale.totalPrice, 12000); // 6000 * 2
  assert.equal(r.sale.profit, 12000 - 2000 * 2 - 0 - 1000); // 7000
  assert.equal(state.sales.length, 4);
  assert.equal(state.products.find(p => p.id === 2).stock, before - 2); // 1
  assert.ok(ctx.changed.has('sales') && ctx.changed.has('products'));
  assert.equal(ctx.did[0].action, 'add_sale');
});

test('add_sale — producto inexistente devuelve error sin mutar', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.add_sale.invoke({ productId: 9999, quantity: 1 }));
  assert.ok(r.error);
  assert.equal(state.sales.length, 3);
});

test('delete_sale — restaura stock', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const before = state.products.find(p => p.id === 1).stock; // 8
  const r = JSON.parse(await t.delete_sale.invoke({ id: 101 })); // qty 2, producto 1
  assert.equal(r.ok, true);
  assert.equal(state.sales.length, 2);
  assert.equal(state.products.find(p => p.id === 1).stock, before + 2); // 10
});

test('add_product + edit_product', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.add_product.invoke({ name: 'Mouse', costPrice: 3000, salePrice: 9000, stock: 10 }));
  assert.equal(r.ok, true);
  assert.equal(state.products.length, 4);
  const e = JSON.parse(await t.edit_product.invoke({ id: r.product.id, salePrice: 9500 }));
  assert.equal(e.product.salePrice, 9500);
  assert.ok(e.product.lastModified);
});

test('manage_task — add, complete, delete', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const a = JSON.parse(await t.manage_task.invoke({ action: 'add', titulo: 'Llamar proveedor' }));
  assert.equal(a.task.estado, 'pendiente');
  const c = JSON.parse(await t.manage_task.invoke({ action: 'complete', id: a.task.id }));
  assert.equal(c.task.estado, 'hecha');
  const d = JSON.parse(await t.manage_task.invoke({ action: 'delete', id: a.task.id }));
  assert.equal(d.ok, true);
});

test('save_memory — agrega nota a aiDoc.memory', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.save_memory.invoke({ note: 'Prefiere reportes los lunes.' }));
  assert.equal(r.ok, true);
  assert.equal(ctx.aiDoc.memory[0], 'Prefiere reportes los lunes.');
  assert.equal(ctx.did[0].action, 'save_memory');
});

test('send_report — usa la función inyectada', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  ctx.sendReport = async (period) => ({ sentTo: 'd***@x.com', period });
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.send_report.invoke({ period: 'mes' }));
  assert.equal(r.ok, true);
  assert.equal(r.period, 'monthly');
  assert.equal(ctx.did[0].action, 'send_report');
});
