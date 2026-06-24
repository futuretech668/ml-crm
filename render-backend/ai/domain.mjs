// ============================================================================
// domain.mjs — Funciones de dominio PURAS para el copiloto MIA.
//
// Estas funciones son el "contrato de exactitud": las cifras que entrega la IA
// DEBEN ser byte-idénticas a las que muestran la app (index.html) y el cron
// (sync-ml.js / ml-sync.js). Por eso la matemática canónica se porta VERBATIM
// desde esos archivos (mismos nombres de función abajo). Cero números inventados.
//
// Fuentes verbatim:
//   · sync-ml.js: summarizeSales (629), salesInRange (652), computeGoalProgress
//     (887), orderDateParts (317), saleIdFor (322).
//   · index.html: margen de producto (6056-6058), getFinanzas (5323),
//     publicidadTotal (7370), publicidadDelMes (7375), ivaResumenMeses (7502),
//     totalGastosFijosMensual (7630), gastoFijoMensual (7620), saleRevenue
//     (7691), monthKey (7702); builders de venta (4172-4191) y producto
//     (4050-4094).
// ============================================================================

// ---------------------------------------------------------------------------
// Agregación de ventas (VERBATIM de sync-ml.js)
// ---------------------------------------------------------------------------

// Suma estadísticas (ventas/ingresos/comisión/envío/ganancia/unidades + top productos).
export function summarizeSales(sales) {
  const list = Array.isArray(sales) ? sales : [];
  const stats = { count: 0, units: 0, revenue: 0, commission: 0, shipping: 0, profit: 0 };
  const byProduct = {};
  for (const s of list) {
    const qty = s.quantity || 1;
    const total = s.totalPrice != null ? s.totalPrice : (s.salePrice || 0) * qty;
    stats.count += 1;
    stats.units += qty;
    stats.revenue += total;
    stats.commission += s.commission || 0;
    stats.shipping += s.shipping || 0;
    stats.profit += (s.profit != null ? s.profit : 0);
    const name = s.productName || s.title || ('Producto ' + (s.productId || s.item_id || ''));
    if (!byProduct[name]) byProduct[name] = { name, qty: 0, revenue: 0 };
    byProduct[name].qty += qty;
    byProduct[name].revenue += total;
  }
  stats.top = Object.values(byProduct).sort((a, b) => b.qty - a.qty).slice(0, 5);
  return stats;
}

// Filtra ventas cuya fecha (campo 'date' = YYYY-MM-DD) cae en [fromDate, toDate) — toDate exclusivo.
export function salesInRange(sales, fromDate, toDate) {
  const from = fromDate ? fromDate.slice(0, 10) : null;
  const to = toDate ? toDate.slice(0, 10) : null;
  return (sales || []).filter(s => {
    const d = (s.date || (s.createdAt || '').slice(0, 10));
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d >= to) return false;
    return true;
  });
}

// Progreso de la META mensual, calculado desde las ventas del mes en curso.
// Devuelve null si no hay meta para el mes actual. (VERBATIM de sync-ml.js:887;
// se añade `pct` derivado, sin alterar la lógica original.)
export function computeGoalProgress(goals, sales, now) {
  const g = (goals && goals.mensual) ? goals.mensual : null;
  if (!g || !g.objetivo) return null;
  const ym = now.toISOString().slice(0, 7);
  if (g.mes && g.mes !== ym) return null; // la meta guardada es de otro mes
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthSales = salesInRange(sales, monthStart, null);
  let logrado = 0;
  for (const s of monthSales) {
    if (g.tipoMeta === 'ganancia') logrado += (s.profit || 0);
    else if (g.tipoMeta === 'unidades') logrado += (s.quantity || 1);
    else logrado += (s.totalPrice != null ? s.totalPrice : (s.salePrice || 0) * (s.quantity || 1));
  }
  const pct = g.objetivo > 0 ? (logrado / g.objetivo) * 100 : 0;
  return { tipoMeta: g.tipoMeta, objetivo: g.objetivo, logrado, pct, cumplida: logrado >= g.objetivo };
}

// saleId determinístico por (orden, ítem) — VERBATIM de sync-ml.js.
export function orderDateParts(order) {
  const iso = order.date_created || new Date().toISOString();
  return { date: iso.split('T')[0], time: (iso.split('T')[1] || '00:00').slice(0, 5) };
}
export function saleIdFor(order, itemId) {
  const base = String(order.id).replace(/\D/g, '').slice(-11) || String(Date.now());
  const tail = String(itemId).replace(/\D/g, '').slice(-3) || '0';
  return Number(base + tail.padStart(3, '0'));
}

// ---------------------------------------------------------------------------
// Helpers de finanzas (VERBATIM de index.html)
// ---------------------------------------------------------------------------

// Ingreso de una venta (con el mismo fallback canónico de la app). index.html:7691
export function saleRevenue(s) {
  if (!s) return 0;
  if (typeof s.totalPrice === 'number') return s.totalPrice;
  return (Number(s.salePrice) || 0) * (Number(s.quantity) || 0);
}

// Clave YYYY-MM a partir de una fecha YYYY-MM-DD. index.html:7702
export function monthKey(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  return dateStr.slice(0, 7);
}

// Equivalente mensual de un gasto fijo. index.html:7620
export function gastoFijoMensual(g) {
  const m = Number(g && g.monto) || 0;
  const f = (g && g.frecuencia) || 'mensual';
  if (f === 'semanal') return m * 52 / 12;   // ~4.33 semanas por mes
  if (f === 'anual') return m / 12;
  return m;                                   // mensual
}

// Suma el equivalente mensual de los gastos fijos. index.html:7630
export function totalGastosFijosMensual(gastosFijos, ym) {
  return (Array.isArray(gastosFijos) ? gastosFijos : []).reduce((a, g) => {
    if (ym && g && g.desde && g.desde > ym) return a;
    return a + gastoFijoMensual(g);
  }, 0);
}

// Suma de toda la publicidad mensual registrada. index.html:7370
export function publicidadTotal(finConfig) {
  const pm = (finConfig && finConfig.publicidadMensual) || {};
  return Object.keys(pm).reduce((a, k) => a + (Number(pm[k]) || 0), 0);
}
// Publicidad de un mes concreto (YYYY-MM). index.html:7375
export function publicidadDelMes(finConfig, ym) {
  return Number(((finConfig && finConfig.publicidadMensual) || {})[ym]) || 0;
}

// Resumen de IVA mes a mes (manual del SII donde exista, automático en el resto).
// VERBATIM de index.html:7502.
export function ivaResumenMeses(state) {
  const finConfig = (state && state.finConfig) || {};
  const enabled = !!finConfig.ivaEnabled;
  const pct = enabled ? (Number(finConfig.ivaPct) || 0) / 100 : 0;
  const manual = finConfig.ivaMensual || {};
  const sales = Array.isArray(state && state.sales) ? state.sales : [];
  const byMonth = {};
  sales.forEach((s) => {
    const ym = monthKey(s.date); if (!ym) return;
    if (!byMonth[ym]) byMonth[ym] = { ym, bruta: 0, comisiones: 0, envios: 0 };
    byMonth[ym].bruta += saleRevenue(s);
    byMonth[ym].comisiones += (Number(s.commission) || 0);
    byMonth[ym].envios += (Number(s.shipping) || 0);
  });
  // Incluir meses que tienen IVA manual aunque no tengan ventas registradas.
  Object.keys(manual).forEach((ym) => { if (!byMonth[ym]) byMonth[ym] = { ym, bruta: 0, comisiones: 0, envios: 0 }; });
  const meses = Object.keys(byMonth).sort().reverse().map((ym) => {
    const m = byMonth[ym];
    const gananciaNeta = m.bruta - m.comisiones - m.envios;
    const ivaAuto = Math.max(0, gananciaNeta) * pct;
    const tieneManual = Object.prototype.hasOwnProperty.call(manual, ym) && manual[ym] != null;
    const iva = (enabled && tieneManual) ? (Number(manual[ym]) || 0) : ivaAuto;
    return { ym, bruta: m.bruta, comisiones: m.comisiones, envios: m.envios,
      gananciaNeta, iva, tipo: (tieneManual ? 'manual' : 'auto'),
      netaReal: gananciaNeta - iva };
  });
  const totalIva = meses.reduce((a, x) => a + x.iva, 0);
  const totalNetaReal = meses.reduce((a, x) => a + x.netaReal, 0);
  return { meses, totalIva, totalNetaReal };
}

// Finanzas TOTALES (sin filtro de fecha) — VERBATIM de index.html:5323 (getFinanzas).
export function getFinanzas(state) {
  const sales = Array.isArray(state && state.sales) ? state.sales : [];
  const totalRevenue = sales.reduce((a, s) => a + (s.totalPrice || 0), 0);
  const totalProfitBruta = sales.reduce((a, s) => a + (s.profit || 0), 0);
  const totalCommissions = sales.reduce((a, s) => a + (s.commission || 0), 0);
  const totalShipping = sales.reduce((a, s) => a + (s.shipping || 0), 0);
  const totalCost = sales.reduce((a, s) => a + ((s.costPrice || 0) * (s.quantity || 0)), 0);
  const totalUnits = sales.reduce((a, s) => a + (s.quantity || 0), 0);
  const ivaR = ivaResumenMeses(state);
  const ivaAmount = ivaR.totalIva || 0;
  const publicidad = publicidadTotal(state && state.finConfig);
  const netProfit = totalProfitBruta - ivaAmount - publicidad;
  return {
    totalRevenue, totalProfit: totalProfitBruta, totalCommissions, totalShipping,
    totalCost, totalUnits, ivaAmount, publicidad, netProfit,
    netMargin: totalRevenue > 0 ? (netProfit / totalRevenue * 100) : 0,
    grossMargin: totalRevenue > 0 ? (totalProfitBruta / totalRevenue * 100) : 0,
    count: sales.length
  };
}

// ---------------------------------------------------------------------------
// Rangos de período (NL → fechas). YYYY-MM-DD, comparación lexicográfica.
// ---------------------------------------------------------------------------

// Inicio de semana (lunes), igual que index.html:6029 (_startOfWeek).
function startOfWeekYmd(now) {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // lunes = 0
  d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
const ymd = (d) => d.toISOString().slice(0, 10);

// Devuelve { from, to(exclusivo, o null), label } para un período nombrado.
export function rangeFor(period, now) {
  now = now || new Date();
  const today = ymd(now);
  switch (period) {
    case 'hoy': {
      const t = new Date(now); t.setDate(t.getDate() + 1);
      return { from: today, to: ymd(t), label: 'hoy (' + today + ')' };
    }
    case 'semana': {
      const from = startOfWeekYmd(now);
      return { from, to: null, label: 'esta semana (desde ' + from + ')' };
    }
    case 'mes': {
      const from = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
      return { from, to: null, label: 'este mes' };
    }
    case 'año':
    case 'ano': {
      const from = now.getFullYear() + '-01-01';
      return { from, to: null, label: 'este año (' + now.getFullYear() + ')' };
    }
    case 'total':
    default:
      return { from: null, to: null, label: 'histórico (total)' };
  }
}

// ---------------------------------------------------------------------------
// Analítica de ventas (query_sales) — sobre el doc cargado.
// ---------------------------------------------------------------------------

export function querySales(state, args) {
  args = args || {};
  const sales = Array.isArray(state && state.sales) ? state.sales : [];
  let range;
  if (args.from || args.to) {
    range = { from: args.from || null, to: args.to || null, label: 'rango ' + (args.from || '…') + ' → ' + (args.to || '…') };
  } else {
    range = rangeFor(args.period || 'mes', args.now);
  }
  let list = salesInRange(sales, range.from, range.to);
  if (args.productId != null) list = list.filter(s => s.productId === args.productId);
  if (args.source) list = list.filter(s => (s.source || 'manual') === args.source);

  const totales = summarizeSales(list);
  const top = totales.top;
  delete totales.top;

  let grupos = null;
  if (args.groupBy) {
    const keyer = args.groupBy === 'producto'
      ? (s) => s.productName || ('Producto ' + (s.productId || s.item_id || ''))
      : args.groupBy === 'fuente'
        ? (s) => s.source || 'manual'
        : (s) => (s.date || (s.createdAt || '').slice(0, 10)); // 'dia'
    const buckets = {};
    for (const s of list) {
      const k = keyer(s) || 'N/D';
      if (!buckets[k]) buckets[k] = [];
      buckets[k].push(s);
    }
    grupos = Object.keys(buckets).sort().map((k) => {
      const g = summarizeSales(buckets[k]);
      delete g.top;
      return { grupo: k, ...g };
    });
  }

  return { rango: range.label, from: range.from, to: range.to, totales, top, grupos };
}

// ---------------------------------------------------------------------------
// Márgenes de producto (list_products) — VERBATIM del cálculo index.html:6056.
// ---------------------------------------------------------------------------

export function productMargins(state, args) {
  args = args || {};
  const products = Array.isArray(state && state.products) ? state.products : [];
  let list = products.filter(p => args.includeArchived ? true : !p.archived);
  let out = list.map((p) => {
    const comm = p.commissionType === 'fixed' ? p.commission : p.salePrice * (p.commission / 100);
    const margenUnit = p.salePrice - p.costPrice - comm - p.shipping;
    const margenPct = p.salePrice > 0 ? (margenUnit / p.salePrice) * 100 : 0;
    const stockMin = (p.stockMin != null ? p.stockMin : 5);
    return {
      id: p.id,
      nombre: p.name,
      precioVenta: p.salePrice,
      precioCompra: p.costPrice,
      comision: Math.round(comm),
      envio: p.shipping,
      stock: p.stock,
      stockMin,
      margenUnitario: Math.round(margenUnit),
      margenPct: +margenPct.toFixed(1),
      bajoStock: (p.stock || 0) <= stockMin,
      archivado: !!p.archived
    };
  });
  if (args.lowStockOnly) out = out.filter(p => p.bajoStock);
  const sortBy = args.sortBy;
  if (sortBy === 'margen') out.sort((a, b) => b.margenUnitario - a.margenUnitario);
  else if (sortBy === 'margenPct') out.sort((a, b) => b.margenPct - a.margenPct);
  else if (sortBy === 'stock') out.sort((a, b) => (a.stock || 0) - (b.stock || 0));
  else if (sortBy === 'nombre') out.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
  return out;
}

// ---------------------------------------------------------------------------
// Resumen de finanzas (get_finance_summary).
//   · 'total' → espejo de getFinanzas (la cifra que muestra el Dashboard).
//   · 'mes'   → fórmula del "Resumen del mes" (index.html:7826 agg):
//               neta = ganancia operativa − gastos variables − gastos fijos
//                      − publicidad del mes − IVA del mes.
// ---------------------------------------------------------------------------

export function financeSummary(state, args) {
  args = args || {};
  const period = args.period === 'mes' ? 'mes' : 'total';
  const sales = Array.isArray(state && state.sales) ? state.sales : [];
  const gastosFijos = Array.isArray(state && state.gastosFijos) ? state.gastosFijos : [];
  const expenses = Array.isArray(state && state.expenses) ? state.expenses : [];
  const finConfig = (state && state.finConfig) || {};

  if (period === 'total') {
    const fz = getFinanzas(state);
    const now = args.now || new Date();
    const curYm = now.toISOString().slice(0, 7);
    const gastosFijosMes = totalGastosFijosMensual(gastosFijos, curYm);
    const gastosVariables = expenses.reduce((a, e) => a + (Number(e.monto) || 0), 0);
    return {
      periodo: 'total',
      ingresos: fz.totalRevenue,
      gananciaOperativa: fz.totalProfit,
      comisiones: fz.totalCommissions,
      envios: fz.totalShipping,
      iva: fz.ivaAmount,
      publicidad: fz.publicidad,
      gastosFijosMes,
      gastosVariables,
      gananciaNeta: fz.netProfit, // operativa − IVA − publicidad (cifra del Dashboard)
      margenNetoPct: fz.netMargin
    };
  }

  // period === 'mes'
  const now = args.now || new Date();
  const ym = now.toISOString().slice(0, 7);
  const ivaR = ivaResumenMeses(state);
  const mesIva = (ivaR.meses.filter(m => m.ym === ym)[0] || {}).iva || 0;
  let ingresos = 0, gananciaOperativa = 0, comisiones = 0, envios = 0;
  sales.forEach((s) => {
    if (monthKey(s.date) !== ym) return;
    ingresos += saleRevenue(s);
    gananciaOperativa += (s.profit || 0);
    comisiones += (Number(s.commission) || 0);
    envios += (Number(s.shipping) || 0);
  });
  const gastosVariables = expenses.reduce((a, e) => (monthKey(e.fecha) === ym ? a + (Number(e.monto) || 0) : a), 0);
  const gastosFijosMes = totalGastosFijosMensual(gastosFijos, ym);
  const publicidad = publicidadDelMes(finConfig, ym);
  const gananciaNeta = gananciaOperativa - gastosVariables - gastosFijosMes - publicidad - mesIva;
  return {
    periodo: 'mes',
    ingresos,
    gananciaOperativa,
    comisiones,
    envios,
    iva: mesIva,
    publicidad,
    gastosFijosMes,
    gastosVariables,
    gananciaNeta,
    margenNetoPct: ingresos > 0 ? (gananciaNeta / ingresos * 100) : 0
  };
}

// ---------------------------------------------------------------------------
// Builders de payload (forma byte-idéntica a la app).
// ---------------------------------------------------------------------------

// Construye una venta con la MISMA forma que index.html:4172-4191.
// `nowIso`/`saleId`/`time` se inyectan para que el resultado sea determinista
// (la app usa Date.now()/toLocaleTimeString; aquí el llamador los provee).
// Si `opts.variant` viene, precio/costo/envío/comisión se derivan de la variante
// (con override por `args`) y se sella variantId/variantLabel — igual que la app
// cuando se vende una variante (index.html:4747-4775, variantGain 5659-5667).
export function buildSalePayload(product, args, opts) {
  opts = opts || {};
  const v = opts.variant || null;
  const quantity = Number(args.quantity);
  const precioUnit = (args.salePrice != null) ? Number(args.salePrice)
    : (v ? Number(v.precioVenta != null ? v.precioVenta : (v.precio || 0)) : Number(product.salePrice));
  const costoUnit = (args.costPrice != null) ? Number(args.costPrice)
    : (v ? Number(v.precioCosto || 0) : Number(product.costPrice));
  const envioTotal = (args.shipping != null) ? Number(args.shipping)
    : (v && v.tieneEnvio ? (Number(v.costoEnvio) || 0) * quantity : 0);
  const totalPrice = precioUnit * quantity;

  // Comisión: 'fixed' (monto) o 'percentage' (% sobre el total) — igual que index.html:4156.
  // Default desde la variante si ésta cobra comisión y no se pasó override.
  let commissionAmount = 0, comisionTipo = 'fixed', comisionValor = 0;
  let cVal = (args.commission != null) ? Number(args.commission)
    : (v && v.tieneComision ? Number(v.comision || 0) : null);
  let cTipo = (args.commission != null) ? args.commissionType
    : (v && v.tieneComision ? v.comisionTipo : null);
  if (cVal != null) {
    comisionValor = cVal || 0;
    if (cTipo === 'percentage') { comisionTipo = 'percentage'; commissionAmount = totalPrice * comisionValor / 100; }
    else { comisionTipo = 'fixed'; commissionAmount = comisionValor; }
  }
  const totalProfit = totalPrice - (costoUnit * quantity) - commissionAmount - envioTotal;

  return {
    id: opts.id,
    date: args.date || opts.today,
    time: opts.time || '00:00',
    productId: product.id,
    productName: product.name,
    quantity,
    salePrice: precioUnit,
    costPrice: costoUnit,
    commission: commissionAmount,
    commissionType: comisionTipo,
    commissionValue: comisionValor,
    shipping: envioTotal,
    totalPrice,
    profit: totalProfit,
    source: args.source || 'manual',
    variantId: v ? v.id : null,
    variantLabel: v ? variantLabelOf(v) : '',
    createdAt: opts.nowIso
  };
}

// Construye un producto con la MISMA forma que index.html:4050-4094.
// Si `args.variants` viene, el producto maneja stock POR VARIANTE: hasVariants=true
// y stock = Σ variants.stock (campo derivado, igual que index.html).
export function buildProductPayload(args, opts) {
  opts = opts || {};
  const rawVariants = Array.isArray(args.variants) ? args.variants : [];
  const variants = rawVariants.map((v, i) => buildVariantPayload(v, { id: (opts.id || 0) * 1000 + i + 1 }));
  const hasVariants = variants.length > 0;
  const stock = hasVariants
    ? variants.reduce((a, v) => a + (Number(v.stock) || 0), 0)
    : (Number(args.stock) || 0);
  return {
    id: opts.id,
    name: args.name,
    costPrice: Number(args.costPrice) || 0,
    salePrice: Number(args.salePrice) || 0,
    stock,
    stockInit: stock,
    stockMin: Number(args.stockMin) || 0,
    shipping: Number(args.shipping) || 0,
    commission: Number(args.commission) || 0,
    commissionType: args.commissionType || 'percentage',
    hasVariants,
    variants,
    archived: false,
    createdDate: opts.nowIso,
    lastModified: opts.nowIso
  };
}

// ---------------------------------------------------------------------------
// Variantes y stock (lógica PORTADA de index.html para ser byte-idéntica).
// ---------------------------------------------------------------------------

// Etiqueta legible de una variante: "color / talla" (index.html:5640-5645).
export function variantLabelOf(v) {
  const parts = [];
  if (v && v.color) parts.push(v.color);
  if (v && v.talla) parts.push(v.talla);
  return parts.join(' / ');
}

// Construye una variante con la forma de la app (index.html:5874, 5904-5911).
export function buildVariantPayload(args, opts) {
  opts = opts || {};
  const stock = Number(args.stock) || 0;
  return {
    id: opts.id,
    color: args.color || '',
    colorHex: args.colorHex || '',
    talla: args.talla || '',
    precioVenta: Number(args.precioVenta != null ? args.precioVenta : (args.salePrice || 0)) || 0,
    precioCosto: Number(args.precioCosto != null ? args.precioCosto : (args.costPrice || 0)) || 0,
    tieneEnvio: !!args.tieneEnvio,
    costoEnvio: Number(args.costoEnvio) || 0,
    tieneComision: !!args.tieneComision,
    comisionTipo: args.comisionTipo || 'percentage',
    comision: Number(args.comision) || 0,
    stock,
    agotada: stock <= 0
  };
}

// Busca una variante por id (comparación como string, igual que index.html:5349).
export function findVariant(product, variantId) {
  if (!product || !Array.isArray(product.variants)) return null;
  return product.variants.find(v => String(v.id) === String(variantId)) || null;
}

// stock_total = suma de las variantes; marca agotada la que llega a 0 (index.html:5649-5655).
export function recalcVariantStock(product) {
  if (product && product.hasVariants && Array.isArray(product.variants)) {
    product.variants.forEach(v => { v.agotada = (Number(v.stock) || 0) <= 0; });
    product.stock = product.variants.reduce((a, v) => a + (Number(v.stock) || 0), 0);
  }
  return product ? product.stock : 0;
}

// Aplica un delta de stock (negativo = venta, positivo = devolución). Si el producto
// maneja variantes y se indica variantId, ajusta la variante y recalcula el total;
// si no, ajusta el stock simple. Replica index.html:4769-4775 / 5347-5353.
export function applyStockDelta(product, variantId, delta) {
  if (!product) return;
  if (product.hasVariants && variantId != null) {
    const v = findVariant(product, variantId);
    if (v) {
      v.stock = Math.max(0, (Number(v.stock) || 0) + delta);
      recalcVariantStock(product);
      return;
    }
    // Variante no encontrada: cae al stock simple como respaldo.
  }
  product.stock = Math.max(0, (Number(product.stock) || 0) + delta);
}

// ---------------------------------------------------------------------------
// Mercado Libre — comisión e id de venta (VERBATIM de ml-sync.js).
// ---------------------------------------------------------------------------

export const COMMISSION_CLASSIC = Number(process.env.ML_COMMISSION_CLASSIC || 0.135);
export const COMMISSION_PREMIUM = Number(process.env.ML_COMMISSION_PREMIUM || 0.165);

// Comisión por unidad: real (sale_fee) si está disponible, si no estimada por tasa
// según el tipo de publicación (ml-sync.js:244-248).
export function unitCommissionFor(it) {
  if (typeof it.sale_fee === 'number' && it.sale_fee > 0) return { perUnit: it.sale_fee, source: 'sale_fee' };
  const rate = it.listing_type_id === 'gold_pro' ? COMMISSION_PREMIUM : COMMISSION_CLASSIC;
  return { perUnit: (it.unit_price || 0) * rate, source: 'estimado' };
}
// El id determinista de venta de ML (mismos dígitos que el cron, para el dedupe
// order_id+item_id) ya existe arriba como saleIdFor(order, itemId) — se reutiliza.

// Conectores en español que NO aportan a la comparación (ml-sync.js:259).
const STOPWORDS = new Set(['de', 'la', 'el', 'los', 'las', 'con', 'para', 'por', 'y', 'a', 'en', 'un', 'una', 'del', 'al', 'o']);

// Compara el nombre de una publicación de ML con los productos registrados y
// devuelve el mejor match si supera minScore (VERBATIM de ml-sync.js:262-277).
// minScore 0.4 = sugerencia; 0.8 = auto-mapeo confiable.
export function suggestProduct(products, title, minScore) {
  minScore = (typeof minScore === 'number') ? minScore : 0.4;
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
  const tWords = new Set(norm(title));
  let best = null, bestScore = 0;
  for (const p of (products || [])) {
    if (p.archived) continue;
    const pWords = norm(p.name);
    if (!pWords.length) continue;
    let m = 0; for (const w of pWords) if (tWords.has(w)) m++;
    const score = m / pWords.length;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= minScore ? best : null;
}

// Dado un producto con variantes y el título de la publicación de ML, intenta
// resolver la variante por color/talla presentes en el título (ej. "audífonos
// negros" -> variante "Negro"). Devuelve la variante SOLO si calza exactamente
// una (caso claro -> auto-asociar); null si hay ambigüedad (ninguna o varias),
// para que el usuario elija. Singulariza para casar "negros" con "negro".
// Replicado VERBATIM en ml-sync.js y en index.html.
export function suggestVariant(product, title) {
  if (!product || !product.hasVariants || !Array.isArray(product.variants) || !product.variants.length) return null;
  const sing = (w) => (w.length > 3 && w.endsWith('s')) ? w.slice(0, -1) : w;
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !STOPWORDS.has(w)).map(sing);
  const tWords = new Set(norm(title));
  const matches = [];
  for (const v of product.variants) {
    const vTokens = [...norm(v.color), ...norm(v.talla)];
    if (!vTokens.length) continue;
    if (vTokens.every((w) => tWords.has(w))) matches.push(v);
  }
  return matches.length === 1 ? matches[0] : null;
}

// Construye las ventas de ML RETENIDAS de una publicación pendiente al mapearla a un
// producto — port VERBATIM de registerMLSale (index.html:7064-7113). Usa la comisión
// y el envío REALES capturados por la sync (commissionPerUnit/shippingTotal) y la
// FECHA REAL del pedido (h.date). NO muta estado: devuelve las ventas listas para que
// el llamador haga dedupe/push y descuente stock.
export function buildMlSalesFromPending(pending, product, opts) {
  opts = opts || {};
  // Variante: explícita en opts (la que el usuario eligió) o la que ya quedó
  // resuelta en el pending; si el producto no maneja variantes, queda en null.
  const variant = (product && product.hasVariants)
    ? (opts.variantId != null ? findVariant(product, opts.variantId)
       : (pending.suggestedVariantId != null ? findVariant(product, pending.suggestedVariantId) : null))
    : null;
  const variantId = variant ? variant.id : null;
  const variantLabel = variant ? variantLabelOf(variant) : '';
  const held = (pending.heldSales && pending.heldSales.length)
    ? pending.heldSales
    : [{ saleId: pending.saleId, price: pending.price, quantity: pending.quantity, commissionRate: pending.commissionRate, date: pending.date, time: pending.time }];
  return held.map((h, i) => {
    const qty = h.quantity || 1;
    const unitPrice = h.price || product.salePrice;
    const rate = (h.commissionRate != null) ? h.commissionRate : ((product.commission || 0) / 100);
    const commissionAmount = (h.commissionPerUnit != null) ? h.commissionPerUnit * qty : unitPrice * qty * rate;
    const shipping = (h.shippingTotal != null) ? h.shippingTotal : (product.shipping || 0) * qty;
    const totalPrice = unitPrice * qty;
    const profit = totalPrice - (product.costPrice * qty) - commissionAmount - shipping;
    const saleId = h.saleId || ((opts.baseId || 0) + i);
    return {
      id: saleId,
      date: h.date || opts.today,
      time: h.time || opts.time || '00:00',
      productId: product.id,
      productName: product.name,
      quantity: qty,
      salePrice: unitPrice,
      costPrice: product.costPrice,
      commission: commissionAmount,
      commissionType: 'percentage',
      commissionValue: unitPrice > 0 ? +((commissionAmount / qty / unitPrice) * 100).toFixed(2) : +(rate * 100).toFixed(2),
      shipping,
      totalPrice,
      profit,
      createdAt: opts.nowIso,
      source: 'mercadolibre',
      item_id: pending.item_id,
      feeSource: (h.commissionPerUnit != null) ? 'sale_fee' : 'estimado',
      shippingSource: (h.shippingTotal != null) ? 'ml' : 'local',
      variantId,
      variantLabel
    };
  });
}

// ---------------------------------------------------------------------------
// Sistema de Briefing (la inyección de contexto en 3 capas).
// ---------------------------------------------------------------------------

// Capa 1 — Perfil de negocio durable (determinista). Resumen de identidad.
export function buildBusinessProfile(state) {
  const products = (Array.isArray(state && state.products) ? state.products : []).filter(p => !p.archived);
  const sales = Array.isArray(state && state.sales) ? state.sales : [];
  const totales = summarizeSales(sales);
  const topNames = totales.top.map(t => t.name).slice(0, 3);

  // Margen típico (mediana de margenPct de los productos con precio).
  const margins = productMargins(state, {}).map(p => p.margenPct).filter(x => isFinite(x)).sort((a, b) => a - b);
  let margenTipico = null;
  if (margins.length) margenTipico = margins[Math.floor(margins.length / 2)];

  const metaTxt = metaText(state && state.goals, 'sin meta definida');

  const parts = [];
  parts.push('Vende ~' + products.length + ' producto(s) activo(s)');
  if (topNames.length) parts.push('top: ' + topNames.join(', '));
  if (margenTipico != null) parts.push('margen típico ~' + margenTipico.toFixed(0) + '%');
  parts.push('meta: ' + metaTxt);
  parts.push(sales.length + ' venta(s) registradas en total');

  return {
    text: parts.join('; ') + '.',
    productCount: products.length,
    topProducts: topNames,
    margenTipicoPct: margenTipico,
    metaTxt,
    salesCount: sales.length
  };
}

// Capa 2 — Briefing del día (foto determinista). ventasHoy + ganancia mes vs
// meta + preguntas ML sin responder + productos bajo stock.
export function computeBriefing(state, mlQuestionsCount, now) {
  now = now || new Date();
  const sales = Array.isArray(state && state.sales) ? state.sales : [];
  const hoy = rangeFor('hoy', now);
  const ventasHoy = summarizeSales(salesInRange(sales, hoy.from, hoy.to));
  delete ventasHoy.top;

  const goal = computeGoalProgress(state && state.goals, sales, now);
  const lowStock = productMargins(state, { lowStockOnly: true });
  const lowStockNames = lowStock.map(p => p.nombre).slice(0, 5);

  const preguntas = (typeof mlQuestionsCount === 'number') ? mlQuestionsCount : null;

  return {
    horaIso: now.toISOString(),
    ventasHoy: { count: ventasHoy.count, units: ventasHoy.units, revenue: ventasHoy.revenue, profit: ventasHoy.profit },
    meta: goal, // null si no hay meta
    preguntasMlSinResponder: preguntas,
    bajoStock: { count: lowStock.length, productos: lowStockNames }
  };
}

// Sugerencias proactivas derivadas del briefing (para los chips de la UI).
export function briefingSuggestions(briefing) {
  const s = [];
  if (briefing.preguntasMlSinResponder) s.push('Tienes ' + briefing.preguntasMlSinResponder + ' pregunta(s) sin responder en ML — ¿las revisamos?');
  if (briefing.bajoStock && briefing.bajoStock.count) s.push(briefing.bajoStock.count + ' producto(s) bajo stock — ¿los vemos?');
  if (briefing.meta) {
    if (briefing.meta.cumplida) s.push('¡Ya cumpliste tu meta del mes! ¿Quieres el detalle?');
    else s.push('Vas en ' + Math.round(briefing.meta.pct) + '% de tu meta del mes — ¿cómo cerrarla?');
  }
  if (briefing.ventasHoy && briefing.ventasHoy.count) s.push('Resumen de tus ventas de hoy');
  if (!s.length) s.push('¿Cuánto gané esta semana?');
  return s.slice(0, 4);
}

// Formato de pesos chilenos con separador de miles (p. ej. $1.250.000).
export function fmtClp(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');
}

// Texto legible de la meta mensual ("ganancia $500.000/mes"). Una sola fuente
// para el perfil de negocio y la línea de contexto del system prompt.
export function metaText(goals, emptyText) {
  const g = goals && goals.mensual;
  if (!g || !g.objetivo) return emptyText || 'sin meta';
  const tipo = g.tipoMeta === 'ganancia' ? 'ganancia' : (g.tipoMeta === 'unidades' ? 'unidades' : 'ingresos');
  return tipo + ' ' + fmtClp(g.objetivo) + (g.tipoMeta === 'unidades' ? ' u' : '') + '/mes';
}
