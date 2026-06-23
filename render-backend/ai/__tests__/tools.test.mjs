import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goldenState, NOW } from './fixtures.mjs';
import { buildCrmTools, toolsByName } from '../tools.mjs';
import * as domain from '../domain.mjs';
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

// Producto con variantes (color/talla), stock real por variante; product.stock = Σ.
function variantProduct() {
  return {
    id: 50, name: 'Polera', costPrice: 3000, salePrice: 8000,
    stock: 7, stockInit: 7, stockMin: 2, shipping: 0,
    commission: 0, commissionType: 'percentage',
    hasVariants: true,
    variants: [
      { id: 501, color: 'Rojo', talla: 'M', precioVenta: 8000, precioCosto: 3000, tieneEnvio: false, costoEnvio: 0, tieneComision: false, comisionTipo: 'percentage', comision: 0, stock: 4, agotada: false },
      { id: 502, color: 'Azul', talla: 'L', precioVenta: 9000, precioCosto: 3500, tieneEnvio: false, costoEnvio: 0, tieneComision: false, comisionTipo: 'percentage', comision: 0, stock: 3, agotada: false }
    ],
    archived: false, createdDate: '2026-01-01T00:00:00.000Z', lastModified: '2026-01-01T00:00:00.000Z'
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

// ---- Variantes ----

test('add_sale variante — descuenta la variante y product.stock = Σ (persiste tras recalcular)', async () => {
  const state = goldenState();
  const p = variantProduct();
  state.products.push(p);
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.add_sale.invoke({ productId: 50, variantId: 501, quantity: 2 }));
  assert.equal(r.ok, true);
  assert.equal(r.sale.salePrice, 8000);         // precio de la variante
  assert.equal(r.sale.costPrice, 3000);
  assert.equal(r.sale.variantId, 501);
  assert.equal(r.sale.variantLabel, 'Rojo / M');
  assert.equal(r.sale.profit, 16000 - 6000);    // 10000 (sin comisión ni envío)
  assert.equal(domain.findVariant(p, 501).stock, 2); // 4 - 2
  assert.equal(p.stock, 5);                      // 2 + 3
  // La clave del bug: tras un recálculo de la app, el descuento SE MANTIENE.
  domain.recalcVariantStock(p);
  assert.equal(p.stock, 5);
});

test('add_sale variante — sin variantId devuelve error guía con la lista', async () => {
  const state = goldenState();
  state.products.push(variantProduct());
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.add_sale.invoke({ productId: 50, quantity: 1 }));
  assert.ok(r.error);
  assert.equal(r.variantes.length, 2);
  assert.equal(state.sales.length, 3); // no mutó
});

test('delete_sale variante — devuelve el stock a la variante correcta', async () => {
  const state = goldenState();
  const p = variantProduct();
  state.products.push(p);
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const add = JSON.parse(await t.add_sale.invoke({ productId: 50, variantId: 502, quantity: 1 }));
  assert.equal(domain.findVariant(p, 502).stock, 2);
  const del = JSON.parse(await t.delete_sale.invoke({ id: add.sale.id }));
  assert.equal(del.ok, true);
  assert.equal(domain.findVariant(p, 502).stock, 3); // restaurado
  assert.equal(p.stock, 7);
});

test('manage_variant — add/edit/delete recalcula stock y hasVariants', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  // add: convierte un producto simple en uno con variantes
  const a = JSON.parse(await t.manage_variant.invoke({ action: 'add', productId: 1, color: 'Negro', talla: 'U', precioVenta: 25000, precioCosto: 10000, stock: 5 }));
  assert.equal(a.ok, true);
  const prod = state.products.find(p => p.id === 1);
  assert.equal(prod.hasVariants, true);
  assert.equal(prod.stock, 5);
  // edit: sube el stock
  const e = JSON.parse(await t.manage_variant.invoke({ action: 'edit', productId: 1, variantId: a.variant.id, stock: 8 }));
  assert.equal(e.stockTotal, 8);
  // delete: vuelve a producto sin variantes
  const d = JSON.parse(await t.manage_variant.invoke({ action: 'delete', productId: 1, variantId: a.variant.id }));
  assert.equal(d.ok, true);
  assert.equal(prod.hasVariants, false);
  assert.equal(prod.stock, 0);
});

test('edit_product — stock en producto con variantes es rechazado; archived funciona', async () => {
  const state = goldenState();
  state.products.push(variantProduct());
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const bad = JSON.parse(await t.edit_product.invoke({ id: 50, stock: 99 }));
  assert.ok(bad.error);
  const ok = JSON.parse(await t.edit_product.invoke({ id: 1, archived: true }));
  assert.equal(ok.product.archived, true);
});

// ---- Borrar producto ----

test('delete_product — pide confirmación si tiene ventas, borra con confirm', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const need = JSON.parse(await t.delete_product.invoke({ id: 1 })); // producto 1 tiene ventas
  assert.equal(need.needsConfirm, true);
  assert.equal(state.products.some(p => p.id === 1), true); // no borrado
  const done = JSON.parse(await t.delete_product.invoke({ id: 1, confirm: true }));
  assert.equal(done.ok, true);
  assert.equal(state.products.some(p => p.id === 1), false); // borrado
  assert.ok(state.sales.some(s => s.productId === 1)); // ventas conservadas
});

test('delete_product — borra directo si no tiene ventas', async () => {
  const state = goldenState();
  state.products.push(variantProduct()); // id 50, sin ventas
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.delete_product.invoke({ id: 50 }));
  assert.equal(r.ok, true);
  assert.equal(state.products.some(p => p.id === 50), false);
});

// ---- Ventas de ML faltantes ----

test('ml_register_order — registra con comisión real, mapea y es anti-duplicado', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const before = state.products.find(p => p.id === 2).stock; // 3
  const args = { orderId: '2000000123', itemId: 'MLC555', productId: 2, quantity: 1, unitPrice: 8000, saleFee: 1080, listingTypeId: 'gold_special' };
  const r = JSON.parse(await t.ml_register_order.invoke(args));
  assert.equal(r.ok, true);
  assert.equal(r.sale.source, 'mercadolibre');
  assert.equal(r.sale.feeSource, 'sale_fee');
  assert.equal(r.sale.commission, 1080);
  assert.equal(r.sale.commissionValue, 13.5); // 1080/8000*100
  assert.equal(r.sale.item_id, 'MLC555');
  assert.equal(state.mappings['MLC555'].productId, 2);
  assert.equal(state.products.find(p => p.id === 2).stock, before - 1);
  const saleCount = state.sales.length;
  // Dedupe: mismo pedido no se duplica.
  const again = JSON.parse(await t.ml_register_order.invoke(args));
  assert.equal(again.alreadyRegistered, true);
  assert.equal(state.sales.length, saleCount);
});

test('ml_register_order — estima comisión cuando no hay saleFee (gold_pro 16.5%)', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.ml_register_order.invoke({ orderId: '999', itemId: 'MLC777', productId: 1, quantity: 1, unitPrice: 10000, listingTypeId: 'gold_pro' }));
  assert.equal(r.ok, true);
  assert.equal(r.sale.feeSource, 'estimado');
  assert.equal(r.sale.commission, 1650); // 10000 * 0.165
});

test('ml_register_order — exige crear el producto si no existe', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.ml_register_order.invoke({ orderId: '1', itemId: 'MLC0', productId: 8888, quantity: 1, unitPrice: 5000 }));
  assert.ok(r.error);
  assert.equal(state.sales.length, 3);
});

test('add_product — acepta variants[] y deriva stock total', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.add_product.invoke({
    name: 'Gorro', costPrice: 2000, salePrice: 6000, stock: 0,
    variants: [
      { color: 'Verde', talla: 'U', precioVenta: 6000, precioCosto: 2000, stock: 3 },
      { color: 'Gris', talla: 'U', precioVenta: 6000, precioCosto: 2000, stock: 2 }
    ]
  }));
  assert.equal(r.ok, true);
  assert.equal(r.product.hasVariants, true);
  assert.equal(r.product.variants.length, 2);
  assert.equal(r.product.stock, 5);
});
