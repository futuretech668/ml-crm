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
  assert.equal(r.sale.variantLabel, 'color Rojo / talla M');
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

// ---- Ventas de ML en espera (producto no existía al vender) ----

// Una publicación pendiente con una venta retenida de AYER (fecha real + comisión real).
function pendingState() {
  const s = goldenState();
  s.pendingMappings = [{
    item_id: 'MLC9001', title: 'Lámpara LED escritorio', price: 15000, quantity: 1,
    commissionPerUnit: 2025, suggestedProductId: null, suggestedName: null,
    heldSales: [{ saleId: 88800001, price: 15000, quantity: 1, commissionPerUnit: 2025, shippingTotal: 2990, feeSource: 'sale_fee', date: '2026-06-19', time: '17:30' }],
    createdAt: '2026-06-19T17:30:00.000Z'
  }];
  s.dismissedPending = [];
  return s;
}

test('list_pending_ml_sales — muestra las ventas en espera con su fecha real', async () => {
  const state = pendingState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.list_pending_ml_sales.invoke({}));
  assert.equal(r.length, 1);
  assert.equal(r[0].item_id, 'MLC9001');
  assert.equal(r[0].ventasRetenidas, 1);
  assert.deepEqual(r[0].fechas, ['2026-06-19']);
});

test('register_pending_ml_sale — registra con datos reales, mapea y limpia pendientes', async () => {
  const state = pendingState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  // El usuario recién creó el producto faltante.
  const prod = JSON.parse(await t.add_product.invoke({ name: 'Lámpara LED escritorio', costPrice: 6000, salePrice: 15000, stock: 10 }));
  const r = JSON.parse(await t.register_pending_ml_sale.invoke({ itemId: 'MLC9001', productId: prod.product.id }));
  assert.equal(r.ok, true);
  assert.equal(r.registradas, 1);
  const sale = r.ventas[0];
  assert.equal(sale.date, '2026-06-19');        // FECHA REAL de ayer, no hoy
  assert.equal(sale.source, 'mercadolibre');
  assert.equal(sale.feeSource, 'sale_fee');      // comisión real
  assert.equal(sale.commission, 2025);
  assert.equal(sale.shipping, 2990);             // envío real de ML
  assert.equal(sale.profit, 15000 - 6000 - 2025 - 2990);
  // Stock descontado y pendiente limpiada.
  assert.equal(state.products.find(p => p.id === prod.product.id).stock, 9);
  assert.equal(state.pendingMappings.length, 0);
  assert.equal(state.mappings['MLC9001'].productId, prod.product.id);
  assert.ok(state.dismissedPending.map(String).includes('MLC9001'));
  // Anti-duplicado: registrarla de nuevo no agrega (ya no está en pendientes).
  const again = JSON.parse(await t.register_pending_ml_sale.invoke({ itemId: 'MLC9001', productId: prod.product.id }));
  assert.ok(again.error);
});

test('register_pending_ml_sale — pide crear el producto si no existe', async () => {
  const state = pendingState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.register_pending_ml_sale.invoke({ itemId: 'MLC9001', productId: 7777 }));
  assert.ok(r.error);
  assert.equal(state.pendingMappings.length, 1); // no tocó la pendiente
});

// === Casos edge del Agente B: nunca perder una venta de ML ===

test('register_pending_ml_sale — usa la fecha REAL del pedido (7 días atrás, no hoy)', async () => {
  const state = pendingState();
  // El pendiente quedó retenido hace 7 días respecto a NOW (2026-06-20).
  state.pendingMappings[0].heldSales = [{
    saleId: 88800007, orderId: '2000000777', price: 15000, quantity: 1,
    commissionPerUnit: 2025, shippingTotal: 2990, feeSource: 'sale_fee', date: '2026-06-13', time: '08:00'
  }];
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const prod = JSON.parse(await t.add_product.invoke({ name: 'Lámpara LED escritorio', costPrice: 6000, salePrice: 15000, stock: 10 }));
  const r = JSON.parse(await t.register_pending_ml_sale.invoke({ itemId: 'MLC9001', productId: prod.product.id }));
  assert.equal(r.registradas, 1);
  const sale = r.ventas[0];
  assert.equal(sale.date, '2026-06-13');          // fecha REAL, NO la de hoy
  assert.notEqual(sale.date, ctx.today());
  assert.equal(sale.order_id, '2000000777');       // orderId real propagado
  assert.equal(sale.registeredBy, 'mia');          // auditoría
});

test('list_pending_ml_sales — fuzzy match: título similar pero distinto da suggested o possible', async () => {
  const state = goldenState();
  // Pendiente con título MUY parecido a "Audífonos Pro" → debe ser suggested (>0.7).
  // Otra con parecido medio → possibleMatches (0.4–0.7).
  state.pendingMappings = [
    { item_id: 'MLC-A', title: 'Audífonos Pro', price: 25000, quantity: 1,
      heldSales: [{ saleId: 1, orderId: '900', price: 25000, quantity: 1, date: '2026-06-18' }] },
    { item_id: 'MLC-B', title: 'Cargador de pared', price: 6000, quantity: 1,
      heldSales: [{ saleId: 2, orderId: '901', price: 6000, quantity: 1, date: '2026-06-18' }] }
  ];
  state.dismissedPending = [];
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.list_pending_ml_sales.invoke({}));
  const a = r.find(x => x.item_id === 'MLC-A');
  const b = r.find(x => x.item_id === 'MLC-B');
  // "Audífonos Pro" idéntico al nombre del producto → match fuerte.
  assert.equal(a.suggestedProductName, 'Audífonos Pro');
  assert.ok(a.matchScore > 0.7);
  // "Cargador para auto rápido" comparte solo "cargador" con "Cargador USB-C" → parecido medio.
  assert.ok(!b.suggestedProductName, 'no debería ser un match fuerte');
  assert.ok(Array.isArray(b.possibleMatches) && b.possibleMatches.some(m => m.productName === 'Cargador USB-C'));
  assert.ok(b.possibleMatches[0].matchScore >= 0.4 && b.possibleMatches[0].matchScore <= 0.7);
});

test('register_pending_ml_sale — anti-duplicado SIMÉTRICO (source+item_id+id)', async () => {
  const state = pendingState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const prod = JSON.parse(await t.add_product.invoke({ name: 'Lámpara LED escritorio', costPrice: 6000, salePrice: 15000, stock: 10 }));
  // Simula que el cron ya registró ESTA venta (mismo id/item_id de la heldSale).
  state.sales.push({ id: 88800001, source: 'mercadolibre', item_id: 'MLC9001', quantity: 1, productId: prod.product.id });
  const stockAntes = state.products.find(p => p.id === prod.product.id).stock;
  const r = JSON.parse(await t.register_pending_ml_sale.invoke({ itemId: 'MLC9001', productId: prod.product.id }));
  assert.equal(r.ok, true);
  assert.equal(r.registradas, 0);                 // no la volvió a registrar
  // No descontó stock de nuevo.
  assert.equal(state.products.find(p => p.id === prod.product.id).stock, stockAntes);
  // Solo existe UNA venta con ese id/item_id.
  assert.equal(state.sales.filter(s => s.source === 'mercadolibre' && String(s.item_id) === 'MLC9001' && s.id === 88800001).length, 1);
});

test('register_pending_ml_sale — producto con variantes descuenta la variante correcta', async () => {
  const state = goldenState();
  // Producto con variantes (Polera: Rojo/M=4, Azul/L=3, total 7).
  state.products.push(variantProduct());
  state.pendingMappings = [{
    item_id: 'MLC-VAR', title: 'Polera Azul L', price: 9000, quantity: 2,
    suggestedVariantId: 502,
    heldSales: [{ saleId: 5550001, orderId: '950', price: 9000, quantity: 2, commissionPerUnit: 1000, shippingTotal: 0, feeSource: 'sale_fee', date: '2026-06-17', time: '12:00' }],
    createdAt: '2026-06-17T12:00:00.000Z'
  }];
  state.dismissedPending = [];
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.register_pending_ml_sale.invoke({ itemId: 'MLC-VAR', productId: 50, variantId: 502 }));
  assert.equal(r.registradas, 1);
  const p = state.products.find(x => x.id === 50);
  const vAzul = p.variants.find(v => v.id === 502);
  const vRojo = p.variants.find(v => v.id === 501);
  assert.equal(vAzul.stock, 1);                   // 3 − 2 vendidas
  assert.equal(vRojo.stock, 4);                   // intacta
  assert.equal(p.stock, 5);                       // total recalculado
  assert.equal(r.ventas[0].variantId, 502);
  assert.equal(r.ventas[0].costPrice, 3000);      // costo del producto base (forma de la app)
});

test('register_pending_ml_sale — resuelve la variante por TEXTO en lenguaje natural', async () => {
  const state = goldenState();
  state.products.push(variantProduct());           // Rojo/M=501, Azul/L=502
  state.pendingMappings = [{
    item_id: 'MLC-VAR2', title: 'Polera', price: 9000, quantity: 2,
    suggestedVariantId: null,                       // la sync NO dejó variante sugerida
    heldSales: [{ saleId: 5550002, orderId: '951', price: 9000, quantity: 2, commissionPerUnit: 1000, shippingTotal: 0, feeSource: 'sale_fee', date: '2026-06-18', time: '12:00' }],
    createdAt: '2026-06-18T12:00:00.000Z'
  }];
  state.dismissedPending = [];
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  // El usuario solo dijo el color/talla en palabras (con prefijos): se resuelve sola a la 502.
  const r = JSON.parse(await t.register_pending_ml_sale.invoke({ itemId: 'MLC-VAR2', productId: 50, variante: 'color azul / talla L' }));
  assert.equal(r.registradas, 1);
  assert.equal(r.ventas[0].variantId, 502);
  const p = state.products.find(x => x.id === 50);
  assert.equal(p.variants.find(v => v.id === 502).stock, 1); // 3 − 2
});

test('resolveVariant — por id exacto, por texto y ambigüedad', () => {
  const p = variantProduct();                       // Rojo/M=501, Azul/L=502
  assert.equal(domain.resolveVariant(p, 501).id, 501);          // por id
  assert.equal(domain.resolveVariant(p, 'azul l').id, 502);     // por texto color+talla
  assert.equal(domain.resolveVariant(p, 'color rojo / talla m').id, 501); // con prefijos
  assert.equal(domain.resolveVariant(p, 'rojo'), null);         // ambigua: falta la talla -> pregunta
  assert.equal(domain.resolveVariant(p, ''), null);             // vacío
});

test('register_pending_ml_sale — sin producto da error claro en español', async () => {
  const state = pendingState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.register_pending_ml_sale.invoke({ itemId: 'MLC9001', productId: 99999 }));
  assert.ok(r.error);
  assert.match(r.error, /no existe|créalo|add_product/i);
  assert.equal(state.pendingMappings.length, 1); // la pendiente sigue intacta
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

// ---- Lectura de TODO el estado (A) ----

test('list_tasks — lista y filtra por estado', async () => {
  const state = goldenState();
  const t = toolsByName(buildCrmTools(makeCtx(state)));
  const all = JSON.parse(await t.list_tasks.invoke({}));
  assert.equal(all.length, 1);
  assert.equal(all[0].titulo, 'Reponer cargadores');
  const hechas = JSON.parse(await t.list_tasks.invoke({ estado: 'hecha' }));
  assert.equal(hechas.length, 0);
});

test('list_expenses / list_fixed_expenses / get_finance_config / list_channels', async () => {
  const state = goldenState();
  state.customChannels = ['Instagram'];
  const t = toolsByName(buildCrmTools(makeCtx(state)));
  const ex = JSON.parse(await t.list_expenses.invoke({}));
  assert.equal(ex.total, 3000);
  assert.equal(ex.count, 1);
  const fx = JSON.parse(await t.list_fixed_expenses.invoke({}));
  assert.equal(fx.equivalenteMensual, 12000);
  const fc = JSON.parse(await t.get_finance_config.invoke({}));
  assert.equal(fc.ivaEnabled, true);
  assert.equal(fc.ivaPct, 19);
  const ch = JSON.parse(await t.list_channels.invoke({}));
  assert.deepEqual(ch.propios, ['Instagram']);
});

// ---- Escritura de TODO el estado (B) ----

test('manage_expense — add/edit/delete', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const a = JSON.parse(await t.manage_expense.invoke({ action: 'add', nombre: 'Bencina', monto: 5000 }));
  assert.equal(a.ok, true);
  assert.equal(state.expenses.length, 2);
  assert.ok(ctx.changed.has('expenses'));
  const e = JSON.parse(await t.manage_expense.invoke({ action: 'edit', id: a.expense.id, monto: 7000 }));
  assert.equal(e.expense.monto, 7000);
  const d = JSON.parse(await t.manage_expense.invoke({ action: 'delete', id: a.expense.id }));
  assert.equal(d.ok, true);
  assert.equal(state.expenses.length, 1);
});

test('manage_fixed_expense — add con frecuencia', async () => {
  const state = goldenState();
  const t = toolsByName(buildCrmTools(makeCtx(state)));
  const a = JSON.parse(await t.manage_fixed_expense.invoke({ action: 'add', nombre: 'Internet', monto: 20000, frecuencia: 'mensual' }));
  assert.equal(a.ok, true);
  assert.equal(state.gastosFijos.length, 2);
});

test('set_goal — fija la meta del mes', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.set_goal.invoke({ objetivo: 800000, tipoMeta: 'ganancia' }));
  assert.equal(r.ok, true);
  assert.equal(state.goals.mensual.objetivo, 800000);
  assert.equal(state.goals.mensual.tipoMeta, 'ganancia');
  assert.ok(ctx.changed.has('goals'));
});

test('set_goal — meta de un mes distinto al actual incluye aviso', async () => {
  const state = goldenState();
  const ctx = makeCtx(state); // today() = 2026-06-20 → mes actual 2026-06
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.set_goal.invoke({ objetivo: 500000, mes: '2026-07' }));
  assert.equal(r.ok, true);
  assert.equal(state.goals.mensual.mes, '2026-07');
  assert.ok(r.aviso, 'debe incluir aviso cuando la meta no es del mes en curso');
  assert.match(r.aviso, /2026-07/);
  assert.match(r.aviso, /mes actual/);
  // Sanidad: la meta del mes en curso NO trae aviso.
  const r2 = JSON.parse(await t.set_goal.invoke({ objetivo: 500000, mes: '2026-06' }));
  assert.equal(r2.aviso, undefined);
});

test('set_finance_config — IVA y publicidad del mes', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.set_finance_config.invoke({ ivaPct: 19, ivaEnabled: true, publicidadMonto: 8000, publicidadMes: '2026-06' }));
  assert.equal(r.ok, true);
  assert.equal(state.finConfig.ivaPct, 19);
  assert.equal(state.finConfig.publicidadMensual['2026-06'], 8000);
});

test('manage_channel — add y uso en add_sale.source', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const c = JSON.parse(await t.manage_channel.invoke({ action: 'add', nombre: 'Instagram' }));
  assert.ok(c.canales.includes('Instagram'));
  const venta = JSON.parse(await t.add_sale.invoke({ productId: 2, quantity: 1, source: 'Instagram' }));
  assert.equal(venta.sale.source, 'Instagram');
});

// ---- Validaciones endurecidas ----

test('add_sale — rechaza cantidad 0/negativa sin mutar stock', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  await assert.rejects(() => t.add_sale.invoke({ productId: 2, quantity: 0 }));
  await assert.rejects(() => t.add_sale.invoke({ productId: 2, quantity: -3 }));
  assert.equal(state.sales.length, 3);            // no registró
  assert.equal(state.products.find(p => p.id === 2).stock, 3); // stock intacto
});

test('add_product — rechaza precios/stock negativos', async () => {
  const state = goldenState();
  const t = toolsByName(buildCrmTools(makeCtx(state)));
  await assert.rejects(() => t.add_product.invoke({ name: 'X', costPrice: -1, salePrice: 100, stock: 1 }));
  await assert.rejects(() => t.add_product.invoke({ name: 'X', costPrice: 1, salePrice: 100, stock: -5 }));
  assert.equal(state.products.length, 3);
});

test('manage_expense / manage_fixed_expense — rechazan monto negativo', async () => {
  const state = goldenState();
  const t = toolsByName(buildCrmTools(makeCtx(state)));
  await assert.rejects(() => t.manage_expense.invoke({ action: 'add', nombre: 'X', monto: -100 }));
  await assert.rejects(() => t.manage_fixed_expense.invoke({ action: 'add', nombre: 'Y', monto: -50 }));
});

// ---- set_goal: tipoMeta unidades ----

test('set_goal — acepta tipoMeta unidades y se refleja en get_goal_progress', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.set_goal.invoke({ objetivo: 10, tipoMeta: 'unidades' }));
  assert.equal(r.ok, true);
  assert.equal(state.goals.mensual.tipoMeta, 'unidades');
  const g = JSON.parse(await t.get_goal_progress.invoke({}));
  // Mes en curso (junio): ventas 101 (qty 2) + 102 (qty 3) = 5 unidades.
  assert.equal(g.tipoMeta, 'unidades');
  assert.equal(g.logrado, 5);
});

// ---- set_finance_config: IVA manual del SII por mes ----

test('set_finance_config — fija ivaMensual de un mes sin pisar otros', async () => {
  const state = goldenState();
  state.finConfig.ivaMensual = { '2026-05': 1000 };
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.set_finance_config.invoke({ ivaMensualMonto: 7500, ivaMensualMes: '2026-06' }));
  assert.equal(r.ok, true);
  assert.equal(state.finConfig.ivaMensual['2026-06'], 7500);
  assert.equal(state.finConfig.ivaMensual['2026-05'], 1000); // no pisado
  assert.ok(ctx.changed.has('finConfig'));
});

test('set_finance_config — rechaza ivaPct fuera de 0-100', async () => {
  const state = goldenState();
  const t = toolsByName(buildCrmTools(makeCtx(state)));
  await assert.rejects(() => t.set_finance_config.invoke({ ivaPct: 150 }));
  await assert.rejects(() => t.set_finance_config.invoke({ ivaPct: -5 }));
});

// ---- Notificaciones ----

test('mark_notification_read / dismiss_notification', async () => {
  const state = goldenState();
  state.notifications = [
    { id: 'n1', type: 'info', text: 'Aviso 1', read: false, createdAt: '2026-06-20T00:00:00.000Z' },
    { id: 'n2', type: 'info', text: 'Aviso 2', read: false, createdAt: '2026-06-20T00:00:00.000Z' }
  ];
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const r = JSON.parse(await t.mark_notification_read.invoke({ id: 'n1' }));
  assert.equal(r.ok, true);
  assert.equal(state.notifications.find(x => x.id === 'n1').read, true);
  assert.ok(ctx.changed.has('notifications'));
  const d = JSON.parse(await t.dismiss_notification.invoke({ id: 'n2' }));
  assert.equal(d.ok, true);
  assert.equal(state.notifications.length, 1);
  const bad = JSON.parse(await t.dismiss_notification.invoke({ id: 'nope' }));
  assert.ok(bad.error);
});

// ---- Perfil de negocio ----

test('set_business_profile / regenerate_business_profile', async () => {
  const state = goldenState();
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const s = JSON.parse(await t.set_business_profile.invoke({ text: 'Vende audio premium en Santiago.' }));
  assert.equal(s.ok, true);
  assert.equal(ctx.aiDoc.businessProfile.text, 'Vende audio premium en Santiago.');
  assert.ok(ctx.aiDoc.businessProfile.updatedAt);
  const empty = JSON.parse(await t.set_business_profile.invoke({ text: '   ' }));
  assert.ok(empty.error);
  const reg = JSON.parse(await t.regenerate_business_profile.invoke({}));
  assert.equal(reg.ok, true);
  assert.ok(reg.businessProfile.text.length > 0);
  assert.ok(typeof reg.businessProfile.productCount === 'number');
});

// ---- Pendientes de ML: descartar / recuperar ----

test('dismiss_pending_sale / restore_pending_sale', async () => {
  const state = goldenState();
  state.pendingMappings = [{ item_id: 'MLC9001', title: 'Lámpara', price: 15000, quantity: 1 }];
  state.dismissedPending = [];
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const d = JSON.parse(await t.dismiss_pending_sale.invoke({ itemId: 'MLC9001' }));
  assert.equal(d.ok, true);
  assert.ok(state.dismissedPending.map(String).includes('MLC9001'));
  // No la registró como venta:
  assert.equal(state.sales.length, 3);
  // Ya no aparece en pendientes visibles:
  const vis = JSON.parse(await t.list_pending_ml_sales.invoke({}));
  assert.equal(vis.length, 0);
  // Recuperar:
  const r = JSON.parse(await t.restore_pending_sale.invoke({ itemId: 'MLC9001' }));
  assert.equal(r.ok, true);
  assert.equal(state.dismissedPending.length, 0);
  const vis2 = JSON.parse(await t.list_pending_ml_sales.invoke({}));
  assert.equal(vis2.length, 1);
  // Descartar algo inexistente:
  const bad = JSON.parse(await t.dismiss_pending_sale.invoke({ itemId: 'NADA' }));
  assert.ok(bad.error);
});

// ---- Mapeos ML: listar y re-mapear ----

test('list_mappings / remap_item', async () => {
  const state = goldenState();
  state.mappings = { MLC1: { productId: 1, productName: 'Audífonos Pro' } };
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const list = JSON.parse(await t.list_mappings.invoke({}));
  assert.equal(list.length, 1);
  assert.equal(list[0].item_id, 'MLC1');
  assert.equal(list[0].productId, 1);
  // Re-mapear a otro producto:
  const r = JSON.parse(await t.remap_item.invoke({ itemId: 'MLC1', productId: 2 }));
  assert.equal(r.ok, true);
  assert.equal(state.mappings.MLC1.productId, 2);
  assert.equal(state.mappings.MLC1.productName, 'Cargador USB-C');
  assert.ok(ctx.changed.has('mappings'));
  // No toca ventas ya registradas:
  assert.ok(state.sales.some(s => s.productId === 1));
  // Producto inexistente:
  const bad = JSON.parse(await t.remap_item.invoke({ itemId: 'MLC1', productId: 9999 }));
  assert.ok(bad.error);
});

test('remap_item — exige variantId si el producto maneja variantes', async () => {
  const state = goldenState();
  state.products.push(variantProduct()); // id 50
  state.mappings = { MLC1: { productId: 1, productName: 'Audífonos Pro' } };
  const ctx = makeCtx(state);
  const t = toolsByName(buildCrmTools(ctx));
  const need = JSON.parse(await t.remap_item.invoke({ itemId: 'MLC1', productId: 50 }));
  assert.ok(need.error);
  assert.equal(need.variantes.length, 2);
  const okv = JSON.parse(await t.remap_item.invoke({ itemId: 'MLC1', productId: 50, variantId: 501 }));
  assert.equal(okv.ok, true);
  assert.equal(state.mappings.MLC1.variantId, 501);
  assert.equal(state.mappings.MLC1.variantLabel, 'color Rojo / talla M');
});
