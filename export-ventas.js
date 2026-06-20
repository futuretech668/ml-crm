/**
 * export-ventas.js — SOLO LECTURA
 * Trae las ventas (órdenes pagadas) de los últimos N meses desde Mercado Libre,
 * las agrupa por producto (sin duplicados) y muestra: nombre, precio y unidades.
 * NO escribe nada en Firebase ni en la app. Guarda un JSON local para el paso de carga.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const API = 'https://api.mercadolibre.com';
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const MONTHS = parseInt(process.argv[2] || '2', 10);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function loadTokens() { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); }
function saveTokens(t) { fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2)); }

async function refresh(tokens) {
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET, refresh_token: tokens.refresh_token
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Refresh falló: ' + JSON.stringify(data));
  const updated = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    user_id: data.user_id || tokens.user_id,
    expires_at: Date.now() + (data.expires_in || 21600) * 1000
  };
  saveTokens(updated);
  return updated;
}

let TOK = null;
async function getToken() {
  TOK = loadTokens();
  if (!TOK.expires_at || Date.now() > TOK.expires_at - 5 * 60 * 1000) {
    console.log('🔄 Refrescando token...');
    TOK = await refresh(TOK);
  }
  return TOK;
}

async function mlGet(endpoint, _retried = false) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(API + endpoint, { headers: { Authorization: 'Bearer ' + TOK.access_token } });
    if (res.ok) return res.json();
    if (res.status === 401 && !_retried) { TOK = await refresh(TOK); return mlGet(endpoint, true); }
    if (res.status === 429 || res.status >= 500) { await sleep(1000 * 2 ** i); continue; }
    throw new Error(`ML GET ${endpoint} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error('Reintentos agotados: ' + endpoint);
}

async function fetchPaidOrders(userId, fromISO) {
  const out = [];
  let offset = 0;
  while (true) {
    const ep = `/orders/search?seller=${userId}&order.status=paid` +
      `&order.date_created.from=${encodeURIComponent(fromISO)}` +
      `&sort=date_asc&offset=${offset}&limit=50`;
    const data = await mlGet(ep);
    const batch = data.results || [];
    out.push(...batch);
    const total = data.paging ? data.paging.total : batch.length;
    offset += 50;
    if (batch.length < 50 || offset >= total || offset >= 1000) break;
  }
  return out;
}

function fmt(n) { return '$' + Math.round(n).toLocaleString('es-CL'); }

(async () => {
  const tokens = await getToken();
  if (!tokens.user_id) { const me = await mlGet('/users/me'); tokens.user_id = me.id; saveTokens(tokens); }

  const fromISO = new Date(Date.now() - MONTHS * 30 * 24 * 60 * 60 * 1000).toISOString();
  console.log(`\n📅 Buscando ventas PAGADAS desde ${fromISO.slice(0, 10)} (últimos ${MONTHS} meses)...\n`);

  const orders = await fetchPaidOrders(tokens.user_id, fromISO);
  console.log(`   Órdenes encontradas: ${orders.length}\n`);

  // Agrupar por NOMBRE (mismo producto = un solo registro, sin duplicados).
  // Conserva las publicaciones (item_ids) que componen cada producto.
  const norm = (s) => s.toLowerCase().trim().replace(/\s+/g, ' ');
  const map = new Map();
  for (const o of orders) {
    for (const it of (o.order_items || [])) {
      const id = String(it.item.id);
      const title = (it.item.title || id).trim();
      const key = norm(title);
      const qty = it.quantity || 1;
      const price = it.unit_price || 0;
      if (!map.has(key)) map.set(key, { name: title, units: 0, prices: new Set(), orders: 0, itemIds: new Set() });
      const g = map.get(key);
      g.units += qty;
      g.orders += 1;
      if (price) g.prices.add(price);
      g.itemIds.add(id);
      g.name = title;
    }
  }

  const rows = [...map.values()].map(g => {
    const prices = [...g.prices];
    const priceMin = prices.length ? Math.min(...prices) : 0;
    const priceMax = prices.length ? Math.max(...prices) : 0;
    return {
      name: g.name,
      price: priceMax,                 // precio de venta (mayor visto)
      priceVaries: priceMin !== priceMax,
      priceMin, priceMax,
      units: g.units,
      ordersCount: g.orders,
      itemIds: [...g.itemIds],
      listings: g.itemIds.size
    };
  }).sort((a, b) => b.units - a.units);

  // Salida en consola
  console.log('═'.repeat(72));
  console.log('  PRODUCTOS VENDIDOS (agrupados, sin duplicados)');
  console.log('═'.repeat(72));
  rows.forEach((r, i) => {
    const precio = r.priceVaries ? `${fmt(r.priceMin)}–${fmt(r.priceMax)}` : fmt(r.price);
    console.log(`${String(i + 1).padStart(2)}. ${r.name}`);
    console.log(`     Precio: ${precio}   |   Unidades: ${r.units}   |   Ventas: ${r.ordersCount}`);
  });
  console.log('═'.repeat(72));
  console.log(`  TOTAL productos distintos: ${rows.length}`);
  console.log(`  TOTAL unidades vendidas:   ${rows.reduce((s, r) => s + r.units, 0)}`);
  console.log('═'.repeat(72));

  // Guardar JSON local (NO es la app) para el paso de carga posterior
  fs.writeFileSync(path.join(__dirname, '_ventas_2meses.json'), JSON.stringify(rows, null, 2));
  console.log('\n💾 Guardado en _ventas_2meses.json (solo local, no se cargó nada a la app).\n');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
