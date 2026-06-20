/**
 * import-ventas.js
 *   (sin flag)   -> PREVIEW: lee ML + Firebase y muestra qué se cargaría. NO escribe.
 *   --commit     -> ESCRIBE las ventas en Firebase (crm/state). NO toca stock.
 *
 * Reglas:
 *  - Solo registra ventas cuyo producto YA existe en la app (mapeo por nombre, IA/tokens).
 *  - Lee de cada venta los valores REALES: precio (unit_price), comisión (sale_fee),
 *    envío del vendedor (/shipments/{id}/costs -> senders[0].cost).
 *  - El costo unitario sale del producto local (ML no lo conoce). Profit = real.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const API = 'https://api.mercadolibre.com';
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const MONTHS = 2;
const COMMISSION_CLASSIC = 0.135, COMMISSION_PREMIUM = 0.165;
const COMMIT = process.argv.includes('--commit');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => '$' + Math.round(n).toLocaleString('es-CL');

// ---------- tokens ML ----------
let TOK = null;
function loadTokens() { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); }
function saveTokens(t) { fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2)); }
async function refresh(t) {
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: t.refresh_token })
  });
  const d = await res.json();
  if (!res.ok) throw new Error('Refresh: ' + JSON.stringify(d));
  const u = { access_token: d.access_token, refresh_token: d.refresh_token || t.refresh_token, user_id: d.user_id || t.user_id, expires_at: Date.now() + (d.expires_in || 21600) * 1000 };
  saveTokens(u); return u;
}
async function getToken() {
  TOK = loadTokens();
  if (!TOK.expires_at || Date.now() > TOK.expires_at - 5 * 60 * 1000) { console.log('🔄 Refrescando token...'); TOK = await refresh(TOK); }
  return TOK;
}
async function mlGet(ep, _r = false) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(API + ep, { headers: { Authorization: 'Bearer ' + TOK.access_token, 'x-format-new': 'true' } });
    if (res.ok) return res.json();
    if (res.status === 401 && !_r) { TOK = await refresh(TOK); return mlGet(ep, true); }
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) { await sleep(1000 * 2 ** i); continue; }
    throw new Error(`ML ${ep} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
  throw new Error('Reintentos agotados: ' + ep);
}

// ---------- matcher por nombre (tokens) ----------
const STOP = new Set(['de', 'con', 'para', 'y', 'a', 'o', 'en', 'del', 'al', 'la', 'el', 'los', 'las', 'un', 'una', 'compatible', 'color']);
const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
function toks(s) {
  return new Set(stripAccents(String(s)).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 2 && !STOP.has(w)));
}
function bestMatch(title, products) {
  const T = toks(title);
  let best = null, bestScore = 0, bestShared = 0;
  for (const p of products) {
    const P = toks(p.name);
    let shared = 0; for (const w of P) if (T.has(w)) shared++;
    const union = new Set([...T, ...P]).size;
    const jacc = union ? shared / union : 0;
    const ratioP = P.size ? shared / P.size : 0;       // cuánto del producto está cubierto
    const score = jacc * 0.5 + ratioP * 0.5;
    if (score > bestScore) { bestScore = score; best = p; bestShared = shared; }
  }
  return { product: best, score: +bestScore.toFixed(2), shared: bestShared };
}
function unitCommission(it) {
  if (typeof it.sale_fee === 'number' && it.sale_fee > 0) return { perUnit: it.sale_fee, source: 'sale_fee' };
  const rate = it.listing_type_id === 'gold_pro' ? COMMISSION_PREMIUM : COMMISSION_CLASSIC;
  return { perUnit: (it.unit_price || 0) * rate, source: 'estimado' };
}

// ---------- Firebase ----------
admin.initializeApp({ credential: admin.credential.cert(require(path.join(__dirname, 'serviceAccountKey.json'))) });
const db = admin.firestore();
const stateRef = db.collection('crm').doc('state');

function saleIdFor(orderId, itemId) {
  const base = String(orderId).replace(/\D/g, '').slice(-11) || String(Date.now());
  const tail = String(itemId).replace(/\D/g, '').slice(-3) || '0';
  return Number(base + tail.padStart(3, '0'));
}

(async () => {
  await getToken();
  const snap = await stateRef.get();
  const state = snap.exists ? snap.data() : {};
  const products = (state.products || []).filter(p => !p.archived);
  const existingSales = state.sales || [];
  const existingIds = new Set(existingSales.map(s => s.id));

  // 1) Traer órdenes pagadas (con detalle completo) de los últimos 2 meses
  const fromISO = new Date(Date.now() - MONTHS * 30 * 864e5).toISOString();
  console.log(`\n📅 Órdenes pagadas desde ${fromISO.slice(0, 10)}...`);
  const orders = [];
  let offset = 0;
  while (true) {
    const d = await mlGet(`/orders/search?seller=${TOK.user_id}&order.status=paid&order.date_created.from=${encodeURIComponent(fromISO)}&sort=date_asc&offset=${offset}&limit=50`);
    const b = d.results || []; orders.push(...b);
    const total = d.paging ? d.paging.total : b.length; offset += 50;
    if (b.length < 50 || offset >= total || offset >= 1000) break;
  }
  console.log(`   ${orders.length} órdenes.\n   Leyendo detalle real (comisión + envío) de cada una...`);

  // 2) Construir ventas matcheadas
  const toLoad = [];      // ventas que se cargarían
  const skipped = new Map(); // título -> {units, reason}
  const shipCache = new Map();

  for (const o of orders) {
    const full = await mlGet(`/orders/${o.id}`) || o;
    const items = full.order_items || [];
    const matchedItems = items.map(it => ({ it, m: bestMatch(it.item.title || '', products) })).filter(x => x.m.product && x.m.score >= 0.34);

    // envío real solo si hay match en la orden
    let realShip = null;
    if (matchedItems.length && full.shipping && full.shipping.id) {
      if (shipCache.has(full.shipping.id)) realShip = shipCache.get(full.shipping.id);
      else {
        const costs = await mlGet(`/shipments/${full.shipping.id}/costs`);
        realShip = costs && Array.isArray(costs.senders) && costs.senders[0] && typeof costs.senders[0].cost === 'number'
          ? costs.senders[0].cost : (costs && typeof costs.gross_amount === 'number' ? costs.gross_amount : null);
        shipCache.set(full.shipping.id, realShip);
      }
    }
    const totalQty = items.reduce((s, it) => s + (it.quantity || 1), 0) || 1;

    for (const it of items) {
      const title = it.item.title || String(it.item.id);
      const qty = it.quantity || 1;
      const m = bestMatch(title, products);
      if (!m.product || m.score < 0.34) {
        const e = skipped.get(title) || { units: 0 };
        e.units += qty; skipped.set(title, e); continue;
      }
      const unitPrice = it.unit_price || 0;
      const comm = unitCommission(it);
      const commission = +(comm.perUnit * qty).toFixed(2);
      const lineShip = realShip != null ? +(realShip * (qty / totalQty)).toFixed(2) : (m.product.shipping || 0) * qty;
      const costPrice = m.product.costPrice || 0;
      const totalPrice = unitPrice * qty;
      const profit = totalPrice - costPrice * qty - commission - lineShip;
      const iso = full.date_created || new Date().toISOString();
      const saleId = saleIdFor(full.id, it.item.id);
      if (existingIds.has(saleId)) continue; // ya cargada

      toLoad.push({
        id: saleId, date: iso.split('T')[0], time: (iso.split('T')[1] || '00:00').slice(0, 5),
        productId: m.product.id, productName: m.product.name,
        quantity: qty, salePrice: unitPrice, costPrice,
        commission, commissionType: 'percentage',
        commissionValue: unitPrice > 0 ? +((comm.perUnit / unitPrice) * 100).toFixed(2) : 0,
        shipping: lineShip, totalPrice, profit,
        createdAt: new Date().toISOString(), source: 'mercadolibre', item_id: String(it.item.id), order_id: String(full.id),
        feeSource: comm.source, shippingSource: realShip != null ? 'ml' : 'local',
        _matchScore: m.score, _mlTitle: title
      });
    }
  }

  // 3) Mostrar preview agrupado por producto
  console.log('\n' + '═'.repeat(74));
  console.log('  PREVIEW — ventas que se cargarían (mapeadas a productos existentes)');
  console.log('═'.repeat(74));
  const byProd = {};
  toLoad.forEach(s => { (byProd[s.productName] = byProd[s.productName] || []).push(s); });
  let totRev = 0, totProfit = 0;
  for (const [name, arr] of Object.entries(byProd)) {
    const units = arr.reduce((s, x) => s + x.quantity, 0);
    const rev = arr.reduce((s, x) => s + x.totalPrice, 0);
    const comm = arr.reduce((s, x) => s + x.commission, 0);
    const ship = arr.reduce((s, x) => s + x.shipping, 0);
    const prof = arr.reduce((s, x) => s + x.profit, 0);
    const minScore = Math.min(...arr.map(x => x._matchScore));
    totRev += rev; totProfit += prof;
    console.log(`\n▸ ${name}`);
    console.log(`   ventas: ${arr.length} · unidades: ${units} · confianza match: ${minScore >= 0.5 ? 'alta' : 'REVISAR (' + minScore + ')'}`);
    console.log(`   ingresos: ${fmt(rev)} · comisión ML: ${fmt(comm)} · envío: ${fmt(ship)} · ganancia: ${fmt(prof)}`);
    const prices = [...new Set(arr.map(x => x.salePrice))].sort((a, b) => a - b);
    console.log(`   precios vistos: ${prices.map(fmt).join(', ')}`);
    const titles = [...new Set(arr.map(x => x._mlTitle))];
    if (titles.length && titles[0] !== name) console.log(`   publicación ML: "${titles[0]}"${titles.length > 1 ? ' (+' + (titles.length - 1) + ')' : ''}`);
  }
  console.log('\n' + '─'.repeat(74));
  console.log(`  TOTAL a cargar: ${toLoad.length} ventas · ingresos ${fmt(totRev)} · ganancia ${fmt(totProfit)}`);
  console.log('─'.repeat(74));
  console.log('\n  OMITIDOS (no existen como producto en la app):');
  [...skipped.entries()].forEach(([t, e]) => console.log(`   ✗ ${t.slice(0, 60)} (${e.units} u.)`));

  fs.writeFileSync(path.join(__dirname, '_preview-carga.json'), JSON.stringify(toLoad, null, 2));
  console.log('\n💾 Detalle en _preview-carga.json');

  // 4) Commit (solo con --commit)
  if (!COMMIT) {
    console.log('\n🟡 MODO PREVIEW — no se escribió nada. Para cargar: node import-ventas.js --commit\n');
    process.exit(0);
  }

  console.log('\n⏳ Escribiendo en Firebase (sin tocar stock)...');
  await db.runTransaction(async (tx) => {
    const s = (await tx.get(stateRef)).data() || {};
    const sales = s.sales || [];
    const mappings = s.mappings || {};
    const have = new Set(sales.map(v => v.id));
    let added = 0;
    for (const v of toLoad) {
      if (have.has(v.id)) continue;
      const { _matchScore, _mlTitle, ...clean } = v;
      sales.push(clean); have.add(v.id); added++;
      // recordar el mapeo publicación->producto para futuras syncs automáticas
      mappings[v.item_id] = { productId: v.productId, productName: v.productName };
    }
    tx.set(stateRef, { sales, mappings, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: 'import-ventas' }, { merge: true });
    console.log(`   ✅ ${added} ventas agregadas.`);
  });
  console.log('\n✅ Carga completa.\n');
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
