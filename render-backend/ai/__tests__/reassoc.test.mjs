// Tests de PARIDAD de reassociatePendingForProduct (Agente A).
// La auto-carga debe producir ventas IDÉNTICAS a buildMlSalesFromPending directo
// (mismos campos/importes/id), descontar stock por la variante correcta, respetar
// dismissedPending, ser idempotente y mandar lo dudoso a `suggested` sin tocar estado.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../domain.mjs';

const OPTS = {
  nowIso: '2026-06-21T12:00:00.000Z', today: '2026-06-21', time: '12:00',
  registeredBy: 'reassoc'
};

// Pending sin variantes con 2 heldSales (varias ventas en una orden).
function pendingNoVariant() {
  return {
    item_id: 'MLC1001', title: 'Audifonos Pro inalambricos', price: 25000, quantity: 1,
    suggestedProductId: null, suggestedName: null, suggestedVariantId: null,
    needsVariant: false,
    heldSales: [
      { saleId: 5550001, orderId: '2000000001', price: 25000, quantity: 2, commissionPerUnit: 2500, shippingTotal: 4000, date: '2026-06-18', time: '10:00' },
      { saleId: 5550002, orderId: '2000000002', price: 25000, quantity: 1, commissionPerUnit: 2500, shippingTotal: 2000, date: '2026-06-19', time: '11:00' }
    ],
    createdAt: '2026-06-20T00:00:00.000Z'
  };
}

function productNoVariant() {
  return {
    id: 1, name: 'Audifonos Pro', costPrice: 10000, salePrice: 25000,
    stock: 8, stockInit: 10, stockMin: 5, shipping: 2000,
    commission: 10, commissionType: 'percentage',
    hasVariants: false, variants: [], archived: false,
    createdDate: '2026-01-01T00:00:00.000Z', lastModified: '2026-01-01T00:00:00.000Z'
  };
}

// Producto con variantes negra/blanca.
function productVariants() {
  return {
    id: 2, name: 'Audifonos LE302', costPrice: 8000, salePrice: 20000,
    stock: 10, stockInit: 10, stockMin: 2, shipping: 0,
    commission: 10, commissionType: 'percentage',
    hasVariants: true, archived: false,
    variants: [
      { id: 'v2-Negra', color: 'Negra', talla: '', precioVenta: 20000, precioCosto: 8000, stock: 5, agotada: false },
      { id: 'v2-Blanca', color: 'Blanca', talla: '', precioVenta: 20000, precioCosto: 8000, stock: 5, agotada: false }
    ],
    createdDate: '2026-01-01T00:00:00.000Z', lastModified: '2026-01-01T00:00:00.000Z'
  };
}

function pendingVariant(title, suggestedVariantId = null) {
  return {
    item_id: 'MLC2001', title, price: 20000, quantity: 1,
    suggestedVariantId, needsVariant: false,
    heldSales: [
      { saleId: 6660001, orderId: '3000000001', price: 20000, quantity: 1, commissionPerUnit: 2000, shippingTotal: 0, date: '2026-06-21', time: '09:00' }
    ],
    createdAt: '2026-06-20T00:00:00.000Z'
  };
}

function baseState(product, pending) {
  return {
    products: [product], sales: [], mappings: {}, pendingMappings: [pending],
    dismissedPending: []
  };
}

// (a) Producto SIN variantes: auto-carga == buildMlSalesFromPending directo.
test('reassoc (a) — sin variantes: ventas idénticas a buildMlSalesFromPending', () => {
  const product = productNoVariant();
  const pending = pendingNoVariant();
  const state = baseState(product, pending);

  // Referencia: buildMlSalesFromPending con los MISMOS opts (sin nextId → baseId undefined).
  const expected = D.buildMlSalesFromPending(pending, productNoVariant(), {
    variantId: null, nowIso: OPTS.nowIso, today: OPTS.today, time: OPTS.time,
    registeredBy: 'reassoc', registeredAt: OPTS.nowIso
  });

  const r = D.reassociatePendingForProduct(state, product, OPTS);
  assert.equal(r.loaded.length, 1);
  assert.equal(r.suggested.length, 0);
  assert.equal(r.skipped.length, 0);
  assert.equal(r.loaded[0].registradas, 2);
  // Paridad byte a byte de cada venta auto-cargada.
  assert.deepEqual(state.sales, expected);
  assert.deepEqual(r.loaded[0].ventas, expected);
  // Stock descontado: 8 - (2+1) = 5.
  assert.equal(product.stock, 5);
  // Mapeo creado y pendiente removido + blindado.
  assert.ok(state.mappings['MLC1001']);
  assert.equal(state.pendingMappings.length, 0);
  assert.ok(state.dismissedPending.map(String).includes('MLC1001'));
});

// (b) Producto CON variantes, variante inequívoca en el título → auto-carga correcta.
test('reassoc (b) — variante inequívoca: auto-carga con la variante y stock por variante', () => {
  const product = productVariants();
  const pending = pendingVariant('Audifonos LE302 color negro');
  const state = baseState(product, pending);

  const r = D.reassociatePendingForProduct(state, product, OPTS);
  assert.equal(r.loaded.length, 1);
  assert.equal(r.suggested.length, 0);
  assert.equal(r.loaded[0].variantId, 'v2-Negra');
  assert.equal(state.sales.length, 1);
  assert.equal(state.sales[0].variantId, 'v2-Negra');
  // Stock descontado de la variante Negra (5-1=4), Blanca intacta (5).
  const vNegra = product.variants.find(v => v.id === 'v2-Negra');
  const vBlanca = product.variants.find(v => v.id === 'v2-Blanca');
  assert.equal(vNegra.stock, 4);
  assert.equal(vBlanca.stock, 5);
  assert.equal(product.stock, 9);
});

// (c) Producto CON variantes, variante AMBIGUA → suggested 'ambiguous_variant', estado intacto.
test('reassoc (c) — variante ambigua: suggested ambiguous_variant, no toca estado', () => {
  const product = productVariants();
  // Título sin color → ninguna variante calza → ambigua.
  const pending = pendingVariant('Audifonos LE302');
  const state = baseState(product, pending);
  const snapStock = product.stock;

  const r = D.reassociatePendingForProduct(state, product, OPTS);
  assert.equal(r.loaded.length, 0);
  assert.equal(r.suggested.length, 1);
  assert.equal(r.suggested[0].reason, 'ambiguous_variant');
  assert.ok(Array.isArray(r.suggested[0].variantes));
  assert.equal(r.suggested[0].variantes.length, 2);
  // Estado intacto.
  assert.equal(state.sales.length, 0);
  assert.equal(state.pendingMappings.length, 1);
  assert.equal(Object.keys(state.mappings).length, 0);
  assert.equal(product.stock, snapStock);
});

// (d) Pending en dismissedPending → skipped 'dismissed', estado intacto.
test('reassoc (d) — descartado: skipped dismissed, estado intacto', () => {
  const product = productNoVariant();
  const pending = pendingNoVariant();
  const state = baseState(product, pending);
  state.dismissedPending = ['MLC1001'];

  const r = D.reassociatePendingForProduct(state, product, OPTS);
  assert.equal(r.loaded.length, 0);
  assert.equal(r.suggested.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].reason, 'dismissed');
  assert.equal(state.sales.length, 0);
  assert.equal(state.pendingMappings.length, 1);
  assert.equal(product.stock, 8);
});

// (e) Idempotencia: dos llamadas no duplican ventas.
test('reassoc (e) — idempotente: segunda llamada no duplica', () => {
  const product = productNoVariant();
  const pending = pendingNoVariant();
  const state = baseState(product, pending);

  const r1 = D.reassociatePendingForProduct(state, product, OPTS);
  assert.equal(r1.loaded.length, 1);
  assert.equal(state.sales.length, 2);
  const stockTrasUno = product.stock;

  // El pending ya salió de pendingMappings; re-inyectarlo simula que el cron lo
  // re-encolara: el dedupe source+item_id+id + dismissedPending deben blindar.
  state.pendingMappings.push(pendingNoVariant());
  const r2 = D.reassociatePendingForProduct(state, product, OPTS);
  // Está en dismissedPending → se salta (nunca re-carga un descartado).
  assert.equal(r2.loaded.length, 0);
  assert.equal(r2.skipped[0].reason, 'dismissed');
  assert.equal(state.sales.length, 2); // sin duplicar
  assert.equal(product.stock, stockTrasUno);
});

// (e2) Idempotencia por DEDUPE puro: aunque NO esté en dismissedPending, el triple
// criterio source+item_id+id evita duplicar (defensa independiente del blindaje).
test('reassoc (e2) — dedupe source+item_id+id evita duplicar sin dismissedPending', () => {
  const product = productNoVariant();
  const pending = pendingNoVariant();
  const state = baseState(product, pending);

  D.reassociatePendingForProduct(state, product, OPTS);
  assert.equal(state.sales.length, 2);
  // Forzamos el peor caso: limpiamos el blindaje y el mapeo, re-encolamos.
  state.dismissedPending = [];
  delete state.mappings['MLC1001'];
  state.pendingMappings.push(pendingNoVariant());
  const stockAntes = product.stock;

  const r = D.reassociatePendingForProduct(state, product, OPTS);
  // Re-procesa el pending pero ninguna venta es nueva (mismo id determinista).
  assert.equal(r.loaded.length, 1);
  assert.equal(r.loaded[0].registradas, 0);
  assert.equal(state.sales.length, 2); // sin duplicar
  assert.equal(product.stock, stockAntes); // no se vuelve a descontar
});

// (f) Score medio (0.4 <= score < 0.8) → suggested 'medium_match', estado intacto.
test('reassoc (f) — score medio: suggested medium_match, estado intacto', () => {
  // Producto "Audifonos Pro Bluetooth Premium" (4 tokens); título trae 2 → score 0.5.
  const product = productNoVariant();
  product.name = 'Audifonos Pro Bluetooth Premium';
  const pending = pendingNoVariant();
  pending.title = 'Audifonos Pro generico';
  const state = baseState(product, pending);
  const score = D.scoreProductTitle(product, pending.title);
  assert.ok(score >= 0.4 && score < 0.8, `score esperado en [0.4,0.8): ${score}`);

  const r = D.reassociatePendingForProduct(state, product, OPTS);
  assert.equal(r.loaded.length, 0);
  assert.equal(r.suggested.length, 1);
  assert.equal(r.suggested[0].reason, 'medium_match');
  assert.equal(state.sales.length, 0);
  assert.equal(state.pendingMappings.length, 1);
  assert.equal(Object.keys(state.mappings).length, 0);
  assert.equal(product.stock, 8);
});

// Paridad de normalización: scoreProductTitle y suggestProduct deben coincidir.
test('scoreProductTitle — paridad con suggestProduct', () => {
  const products = [productNoVariant()];
  const title = 'Audifonos Pro inalambricos';
  // suggestProduct elige por scoreProductTitle internamente.
  const best = D.suggestProduct(products, title, 0.4);
  assert.ok(best);
  assert.equal(best.id, 1);
  assert.equal(D.scoreProductTitle(productNoVariant(), title), 1); // "audifonos pro" ambas en el título
});

// suggestVariant reforzado: tolera género (negra/negro) y nombre de variante.
test('suggestVariant — tolerancia de género negra/negro', () => {
  const product = productVariants();
  // Título dice "negro" (masculino) y la variante es "Negra" (femenino) → debe calzar.
  const v = D.suggestVariant(product, 'Audifonos LE302 color negro');
  assert.ok(v);
  assert.equal(v.id, 'v2-Negra');
  // Sin género presente → ambigua (null).
  assert.equal(D.suggestVariant(product, 'Audifonos LE302'), null);
});

test('suggestVariant — considera el nombre libre de la variante', () => {
  const product = {
    id: 9, name: 'Polera', hasVariants: true,
    variants: [
      { id: 'a', color: '', talla: '', nombre: 'Edicion Limitada', stock: 3 },
      { id: 'b', color: '', talla: '', nombre: 'Estandar', stock: 3 }
    ]
  };
  const v = D.suggestVariant(product, 'Polera edicion limitada');
  assert.ok(v);
  assert.equal(v.id, 'a');
});
