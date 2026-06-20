import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goldenState, NOW } from './fixtures.mjs';
import * as D from '../domain.mjs';

test('summarizeSales — totales exactos sobre el fixture', () => {
  const st = goldenState();
  const r = D.summarizeSales(st.sales);
  assert.equal(r.count, 3);
  assert.equal(r.units, 6);
  assert.equal(r.revenue, 93000);
  assert.equal(r.commission, 9000);
  assert.equal(r.shipping, 9000);
  assert.equal(r.profit, 39000);
  // Audífonos (2+1=3 u) y Cargador (3 u) empatan; el orden estable deja Audífonos primero.
  assert.equal(r.top[0].name, 'Audífonos Pro');
  assert.equal(r.top[0].qty, 3);
  assert.equal(r.top.length, 2);
});

test('salesInRange — [from,to) exclusivo y string-comparable', () => {
  const st = goldenState();
  const junio = D.salesInRange(st.sales, '2026-06-01', '2026-07-01');
  assert.equal(junio.length, 2);
  const sinTo = D.salesInRange(st.sales, '2026-06-01', null);
  assert.equal(sinTo.length, 2);
  const excl = D.salesInRange(st.sales, '2026-06-01', '2026-06-20'); // 20 excluido
  assert.equal(excl.length, 1);
  assert.equal(excl[0].id, 102);
});

test('computeGoalProgress — ganancia del mes vs objetivo', () => {
  const st = goldenState();
  const g = D.computeGoalProgress(st.goals, st.sales, NOW);
  assert.equal(g.tipoMeta, 'ganancia');
  assert.equal(g.objetivo, 50000);
  assert.equal(g.logrado, 28500); // 21000 + 7500 (solo junio)
  assert.equal(Math.round(g.pct), 57);
  assert.equal(g.cumplida, false);
});

test('computeGoalProgress — null si la meta es de otro mes', () => {
  const st = goldenState();
  st.goals.mensual.mes = '2026-05';
  assert.equal(D.computeGoalProgress(st.goals, st.sales, NOW), null);
});

test('querySales — período mes agrupado por fuente', () => {
  const st = goldenState();
  const r = D.querySales(st, { period: 'mes', now: NOW });
  assert.equal(r.totales.count, 2);
  assert.equal(r.totales.revenue, 68000);
  assert.equal(r.totales.profit, 28500);
  const porFuente = D.querySales(st, { period: 'mes', now: NOW, groupBy: 'fuente' });
  const ml = porFuente.grupos.find(g => g.grupo === 'mercadolibre');
  assert.equal(ml.revenue, 50000);
  const manual = porFuente.grupos.find(g => g.grupo === 'manual');
  assert.equal(manual.revenue, 18000);
});

test('querySales — filtro por productId y por rango explícito', () => {
  const st = goldenState();
  const r = D.querySales(st, { from: '2026-01-01', to: null, productId: 1 });
  assert.equal(r.totales.count, 2); // ventas 101 y 103
  assert.equal(r.totales.units, 3);
  assert.equal(r.totales.revenue, 75000);
});

test('productMargins — cálculo de margen idéntico a la app', () => {
  const st = goldenState();
  const m = D.productMargins(st, {});
  assert.equal(m.length, 2); // archivado excluido
  const audi = m.find(p => p.id === 1);
  assert.equal(audi.comision, 2500); // 25000 * 10%
  assert.equal(audi.margenUnitario, 10500);
  assert.equal(audi.margenPct, 42);
  assert.equal(audi.bajoStock, false);
  const carg = m.find(p => p.id === 2);
  assert.equal(carg.comision, 500); // fixed
  assert.equal(carg.margenUnitario, 2500);
  assert.equal(carg.margenPct, 41.7);
  assert.equal(carg.bajoStock, true); // stock 3 <= min 5
});

test('productMargins — lowStockOnly e includeArchived', () => {
  const st = goldenState();
  assert.equal(D.productMargins(st, { lowStockOnly: true }).length, 1);
  assert.equal(D.productMargins(st, { includeArchived: true }).length, 3);
});

test('getFinanzas — espejo exacto del Dashboard', () => {
  const st = goldenState();
  const fz = D.getFinanzas(st);
  assert.equal(fz.totalRevenue, 93000);
  assert.equal(fz.totalProfit, 39000);
  assert.equal(fz.totalCommissions, 9000);
  assert.equal(fz.totalShipping, 9000);
  assert.equal(fz.totalCost, 36000);
  assert.equal(fz.totalUnits, 6);
  assert.equal(fz.ivaAmount, 14250); // 10355 + 3895
  assert.equal(fz.publicidad, 5000);
  assert.equal(fz.netProfit, 19750); // 39000 - 14250 - 5000
});

test('financeSummary total y mes', () => {
  const st = goldenState();
  const total = D.financeSummary(st, { period: 'total', now: NOW });
  assert.equal(total.ingresos, 93000);
  assert.equal(total.gananciaOperativa, 39000);
  assert.equal(total.iva, 14250);
  assert.equal(total.gastosFijosMes, 12000);
  assert.equal(total.gastosVariables, 3000);
  assert.equal(total.gananciaNeta, 19750);

  const mes = D.financeSummary(st, { period: 'mes', now: NOW });
  assert.equal(mes.ingresos, 68000);
  assert.equal(mes.gananciaOperativa, 28500);
  assert.equal(mes.iva, 10355);
  assert.equal(mes.publicidad, 5000);
  assert.equal(mes.gastosFijosMes, 12000);
  assert.equal(mes.gastosVariables, 3000);
  assert.equal(mes.gananciaNeta, -1855); // 28500 - 3000 - 12000 - 5000 - 10355
});

test('rangeFor — períodos nombrados', () => {
  const r = D.rangeFor('hoy', NOW);
  assert.equal(r.from, '2026-06-20');
  assert.equal(r.to, '2026-06-21');
  assert.equal(D.rangeFor('mes', NOW).from, '2026-06-01');
  assert.equal(D.rangeFor('año', NOW).from, '2026-01-01');
  assert.equal(D.rangeFor('total', NOW).from, null);
});

test('buildSalePayload — forma byte-idéntica a index.html', () => {
  const st = goldenState();
  const product = st.products[0];
  const sale = D.buildSalePayload(product, { quantity: 2, commission: 10, commissionType: 'percentage', shipping: 4000 },
    { id: 999, today: '2026-06-20', time: '10:00', nowIso: '2026-06-20T10:00:00.000Z' });
  assert.deepEqual(sale, {
    id: 999, date: '2026-06-20', time: '10:00', productId: 1, productName: 'Audífonos Pro',
    quantity: 2, salePrice: 25000, costPrice: 10000, commission: 5000,
    commissionType: 'percentage', commissionValue: 10, shipping: 4000,
    totalPrice: 50000, profit: 21000, source: 'manual', variantId: null, variantLabel: '',
    createdAt: '2026-06-20T10:00:00.000Z'
  });
});

test('buildProductPayload — forma byte-idéntica a index.html', () => {
  const p = D.buildProductPayload({ name: 'Mouse', costPrice: 3000, salePrice: 9000, stock: 10, stockMin: 3, shipping: 800, commission: 12 },
    { id: 555, nowIso: '2026-06-20T10:00:00.000Z' });
  assert.deepEqual(p, {
    id: 555, name: 'Mouse', costPrice: 3000, salePrice: 9000, stock: 10, stockInit: 10,
    stockMin: 3, shipping: 800, commission: 12, commissionType: 'percentage',
    hasVariants: false, variants: [], archived: false,
    createdDate: '2026-06-20T10:00:00.000Z', lastModified: '2026-06-20T10:00:00.000Z'
  });
});

test('buildBusinessProfile — digest determinista', () => {
  const st = goldenState();
  const bp = D.buildBusinessProfile(st);
  assert.equal(bp.productCount, 2);
  assert.equal(bp.salesCount, 3);
  assert.ok(bp.text.includes('producto'));
  assert.ok(bp.metaTxt.includes('ganancia'));
});

test('computeBriefing — foto del día + sugerencias', () => {
  const st = goldenState();
  const b = D.computeBriefing(st, 2, NOW);
  assert.equal(b.ventasHoy.count, 1); // venta 101 es de hoy
  assert.equal(b.ventasHoy.revenue, 50000);
  assert.equal(b.preguntasMlSinResponder, 2);
  assert.equal(b.bajoStock.count, 1);
  assert.equal(Math.round(b.meta.pct), 57);
  const sugs = D.briefingSuggestions(b);
  assert.ok(sugs.length >= 1 && sugs.length <= 4);
  assert.ok(sugs.some(s => s.includes('pregunta')));
});

test('fmtClp — separador de miles chileno', () => {
  assert.equal(D.fmtClp(1250000), '$1.250.000');
  assert.equal(D.fmtClp(0), '$0');
});
