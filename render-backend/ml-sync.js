// ============================================================================
// ml-sync  —  Trae las ventas de Mercado Libre de CADA usuario conectado y las
//             registra en su documento (crm/state del dueño, o crm_users/{uid}).
// ----------------------------------------------------------------------------
// VERSIÓN AUTOSUFICIENTE: no usa librerías externas (solo 'crypto' de Node), así
// se sube a Netlify arrastrando la carpeta.
//
// Réplica en la nube de sync-ml.js: por cada token en crm_ml_tokens/{uid}:
//   1) refresca el token de ML si está por vencer,
//   2) trae las órdenes pagadas nuevas (paginando),
//   3) calcula precio, comisión (sale_fee real), envío y ganancia,
//   4) registra la venta si la publicación está mapeada; si no, la deja pendiente
//      y crea una notificación para que la IA pregunte por el producto,
//   5) escribe todo en el documento del usuario (con control de concurrencia).
//
// De momento se ejecuta MANUALMENTE visitando la URL de la función. Cuando se
// confirme que funciona, se le agrega el horario (cada 5 min) en netlify.toml.
//
// Variables de entorno (en Netlify): ML_CLIENT_ID, ML_CLIENT_SECRET,
//   FIREBASE_SERVICE_ACCOUNT, y opcionales OWNER_EMAIL, LOOKBACK_DAYS,
//   COMMISSION_CLASSIC, COMMISSION_PREMIUM, ML_API.
// ============================================================================

const crypto = require('crypto');

const ML_API = process.env.ML_API || 'https://api.mercadolibre.com';
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'futuretech.cl.668@gmail.com').toLowerCase();
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const COMMISSION_CLASSIC = Number(process.env.COMMISSION_CLASSIC || 0.135);
const COMMISSION_PREMIUM = Number(process.env.COMMISSION_PREMIUM || 0.165);
// Consultar el costo de envío REAL a ML es preciso pero lento (1 llamada por orden).
// AHORA POR DEFECTO ON (true): corremos en Render (sin límite de 10s de Netlify), así que
// leemos el envío REAL que cobró ML en cada venta, en vez del valor fijo del producto.
// Si en una orden ML no devuelve costo de envío, cae al valor configurado del producto.
// Se puede desactivar con USE_REAL_SHIPPING=false. MAX_ORDERS_PER_RUN acota por corrida.
const USE_REAL_SHIPPING = (process.env.USE_REAL_SHIPPING || 'true') !== 'false';
const MAX_ORDERS_PER_RUN = Number(process.env.MAX_ORDERS_PER_RUN || 40);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => '$' + Math.round(n).toLocaleString('es-CL');

// ---------------- Autenticación con Google (service account) ----------------
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function signJwt(claims, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const input = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const s = crypto.createSign('RSA-SHA256');
  s.update(input); s.end();
  const sig = s.sign(privateKey).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return input + '.' + sig;
}
async function getGoogleAccessToken(svc) {
  const now = Math.floor(Date.now() / 1000);
  const aud = svc.token_uri || 'https://oauth2.googleapis.com/token';
  const assertion = signJwt({
    iss: svc.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud, iat: now, exp: now + 3600
  }, svc.private_key);
  const res = await fetch(aud, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Google token: ' + JSON.stringify(data).slice(0, 200));
  return data.access_token;
}

// ---------------- Firestore REST: leer / escribir / listar ----------------
const fsUrl = (svc, path) =>
  'https://firestore.googleapis.com/v1/projects/' + svc.project_id + '/databases/(default)/documents/' + path;

function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}
function decodeFields(fields) {
  const o = {};
  for (const k in fields) o[k] = decodeValue(fields[k]);
  return o;
}
function encodeValue(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'string') return { stringValue: x };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') {
    if (!isFinite(x)) return { nullValue: null };
    return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  }
  if (Array.isArray(x)) return { arrayValue: { values: x.map(encodeValue) } };
  if (typeof x === 'object') return { mapValue: { fields: encodeFields(x) } };
  return { nullValue: null };
}
function encodeFields(obj) {
  const f = {};
  for (const k in obj) f[k] = encodeValue(obj[k]);
  return f;
}

async function fsGet(svc, token, path) {
  const res = await fetch(fsUrl(svc, path), { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 404) return { exists: false, data: {}, updateTime: null };
  if (!res.ok) throw new Error('fsGet ' + res.status + ': ' + (await res.text()).slice(0, 160));
  const d = await res.json();
  return { exists: true, data: decodeFields(d.fields || {}), updateTime: d.updateTime || null };
}
async function fsPatch(svc, token, path, fields, updateTime) {
  let url = fsUrl(svc, path);
  if (updateTime) url += '?currentDocument.updateTime=' + encodeURIComponent(updateTime);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (res.status === 409 || res.status === 412 || res.status === 400) {
    const t = await res.text();
    if (/precondition|updateTime|FAILED_PRECONDITION/i.test(t)) return { ok: false, conflict: true };
    throw new Error('fsPatch ' + res.status + ': ' + t.slice(0, 160));
  }
  if (!res.ok) throw new Error('fsPatch ' + res.status + ': ' + (await res.text()).slice(0, 160));
  return { ok: true };
}
async function fsList(svc, token, collection) {
  const docs = [];
  let pageToken = '';
  do {
    let url = fsUrl(svc, collection) + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 404) break;
    if (!res.ok) throw new Error('fsList ' + res.status + ': ' + (await res.text()).slice(0, 160));
    const d = await res.json();
    for (const doc of (d.documents || [])) {
      docs.push({ id: doc.name.split('/').pop(), data: decodeFields(doc.fields || {}) });
    }
    pageToken = d.nextPageToken || '';
  } while (pageToken);
  return docs;
}

// ---------------- Cliente de Mercado Libre (por usuario) ----------------
function makeMlClient(tk, clientId, clientSecret) {
  let access = tk.access_token;
  let refresh = tk.refresh_token;
  let expiresAt = tk.expires_at;
  let userId = tk.ml_user_id;
  let refreshed = false;

  async function doRefresh() {
    const res = await fetch(ML_API + '/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refresh })
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) throw new Error('refresh ML: ' + JSON.stringify(data).slice(0, 160));
    access = data.access_token;
    refresh = data.refresh_token || refresh;
    expiresAt = Date.now() + (data.expires_in || 21600) * 1000;
    userId = data.user_id || userId;
    refreshed = true;
  }
  async function ensureFresh() {
    if (!expiresAt || Date.now() > expiresAt - 5 * 60 * 1000) await doRefresh();
  }
  async function get(endpoint, opts) {
    opts = opts || {};
    await ensureFresh();
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetch(ML_API + endpoint, { headers: Object.assign({ Authorization: 'Bearer ' + access }, opts.headers || {}) });
      } catch (e) {
        if (attempt === 3) throw e;
        await sleep(1000 * 2 ** attempt); continue;
      }
      if (res.ok) return res.json();
      if (res.status === 404 && opts.allow404) return null;
      if (res.status === 401 && attempt < 3) { await doRefresh(); continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
      throw new Error('ML ' + res.status + ': ' + (await res.text()).slice(0, 160));
    }
  }
  // Petición genérica (GET/POST/PUT/DELETE) con la MISMA gestión de token y
  // backoff que `get`. La usa el copiloto MIA para las escrituras de ML
  // (answers / items / messages). Aditivo: no cambia el comportamiento del cron.
  async function request(method, endpoint, body, opts) {
    opts = opts || {};
    await ensureFresh();
    for (let attempt = 0; attempt < 4; attempt++) {
      const init = { method, headers: Object.assign({ Authorization: 'Bearer ' + access, 'Content-Type': 'application/json', Accept: 'application/json' }, opts.headers || {}) };
      if (body !== undefined && body !== null) init.body = JSON.stringify(body);
      let res;
      try {
        res = await fetch(ML_API + endpoint, init);
      } catch (e) {
        if (attempt === 3) throw e;
        await sleep(1000 * 2 ** attempt); continue;
      }
      if (res.ok) { const t = await res.text(); return t ? JSON.parse(t) : {}; }
      if (res.status === 404 && opts.allow404) return null;
      if (res.status === 401 && attempt < 3) { await doRefresh(); continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
      throw new Error('ML ' + res.status + ': ' + (await res.text()).slice(0, 160));
    }
  }
  async function fetchOrders(status, fromISO) {
    const out = []; const limit = 50; let offset = 0;
    const fromParam = fromISO ? '&order.date_created.from=' + encodeURIComponent(fromISO) : '';
    while (true) {
      const ep = '/orders/search?seller=' + userId + '&order.status=' + status + fromParam +
        '&sort=date_asc&offset=' + offset + '&limit=' + limit;
      const data = await get(ep);
      const batch = (data && data.results) || [];
      out.push(...batch);
      const total = data && data.paging ? data.paging.total : batch.length;
      offset += limit;
      if (batch.length < limit || offset >= total || offset >= 1000) break;
    }
    return out;
  }
  return { get, request, fetchOrders, state: () => ({ access, refresh, expiresAt, userId, refreshed }) };
}

async function getShip(ml, shippingId) {
  if (!shippingId) return null;
  try {
    const costs = await ml.get('/shipments/' + shippingId + '/costs', { allow404: true, headers: { 'x-format-new': 'true' } });
    if (!costs) return null;
    if (Array.isArray(costs.senders) && costs.senders.length && typeof costs.senders[0].cost === 'number') return costs.senders[0].cost;
    if (typeof costs.gross_amount === 'number') return costs.gross_amount;
    return null;
  } catch (e) { return null; }
}

// ---------------- Lógica de registro (igual que sync-ml.js) ----------------
function unitCommissionFor(it) {
  if (typeof it.sale_fee === 'number' && it.sale_fee > 0) return { perUnit: it.sale_fee, source: 'sale_fee' };
  const rate = it.listing_type_id === 'gold_pro' ? COMMISSION_PREMIUM : COMMISSION_CLASSIC;
  return { perUnit: (it.unit_price || 0) * rate, source: 'estimado' };
}
function orderDateParts(order) {
  const iso = order.date_created || new Date().toISOString();
  return { date: iso.split('T')[0], time: (iso.split('T')[1] || '00:00').slice(0, 5) };
}
function saleIdFor(order, itemId) {
  const base = String(order.id).replace(/\D/g, '').slice(-11) || String(Date.now());
  const tail = String(itemId).replace(/\D/g, '').slice(-3) || '0';
  return Number(base + tail.padStart(3, '0'));
}
// Conectores en español que NO aportan a la comparación (se ignoran).
const STOPWORDS = new Set(['de', 'la', 'el', 'los', 'las', 'con', 'para', 'por', 'y', 'a', 'en', 'un', 'una', 'del', 'al', 'o']);
// Compara el nombre de la publicación de ML con los productos registrados.
// minScore por defecto 0.4 (sugerencia); con 0.8 sirve para auto-mapear.
function suggestProduct(products, title, minScore) {
  minScore = (typeof minScore === 'number') ? minScore : 0.4;
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
  const tWords = new Set(norm(title));
  let best = null, bestScore = 0;
  for (const p of products) {
    if (p.archived) continue;
    const pWords = norm(p.name);
    if (!pWords.length) continue;
    let m = 0; for (const w of pWords) if (tWords.has(w)) m++;
    const score = m / pWords.length;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= minScore ? best : null;
}

// Resuelve la variante de un producto a partir del título de ML por color/talla.
// Devuelve la variante SOLO si calza exactamente una (claro); null si hay duda
// (ninguna o varias) para preguntarle al usuario. VERBATIM en domain.mjs / index.html.
function suggestVariant(product, title) {
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

// stock_total = suma de variantes; marca agotada la que llega a 0 (VERBATIM frontend/domain).
function recalcVariantStock(product) {
  if (product && product.hasVariants && Array.isArray(product.variants)) {
    product.variants.forEach((v) => { v.agotada = (Number(v.stock) || 0) <= 0; });
    product.stock = product.variants.reduce((a, v) => a + (Number(v.stock) || 0), 0);
  }
  return product ? product.stock : 0;
}

function applyOrder(order, ctx) {
  const { products, sales, mappings, pendingMappings, notifications } = ctx;
  const dismissed = new Set((ctx.dismissedPending || []).map(String)); // publicaciones que el usuario ya descartó
  const items = order.order_items || [];
  const totalQty = items.reduce((s, it) => s + (it.quantity || 1), 0) || 1;
  const { date, time } = orderDateParts(order);
  const realShip = order.__realShip;
  let added = 0, pending = 0, hadUnmapped = false;

  for (const it of items) {
    const itemId = String(it.item.id);
    const title = it.item.title || itemId;
    const qty = it.quantity || 1;
    const unitPrice = it.unit_price || 0;
    const comm = unitCommissionFor(it);
    const commissionPerUnit = +comm.perUnit.toFixed(2);
    const lineShip = realShip != null ? +(realShip * (qty / totalQty)).toFixed(2) : null;
    const saleId = saleIdFor(order, itemId);

    if (sales.some((s) => s.source === 'mercadolibre' && String(s.item_id) === itemId && s.id === saleId)) continue;

    // Si el usuario YA descartó esta publicación (y no la mapeó), no la registres ni la muestres otra vez.
    if (dismissed.has(itemId) && !mappings[itemId]) continue;

    const vLabel = (v) => [v && v.color ? ('color ' + v.color) : null, v && v.talla ? ('talla ' + v.talla) : null].filter(Boolean).join(' / ');
    // Texto de variante que ML manda en variation_attributes (color/talla EXACTOS del
    // pedido): es mucho más confiable que adivinar por el título. Si viene, se usa para
    // resolver la variante; si no, se cae al título como antes.
    const mlVarText = ((it.item && it.item.variation_attributes) || [])
      .map((a) => a && (a.value_name || a.value_id)).filter(Boolean).join(' ');
    const vText = mlVarText || title;
    let mapping = mappings[itemId];
    let needsVariant = false; // producto claro pero variante ambigua -> se pregunta
    // Auto-mapeo inteligente: si el nombre coincide en >80% con un producto registrado,
    // se mapea solo y se registra la venta directo (no molesta al usuario con una notificación).
    if (!mapping) {
      const auto = suggestProduct(products, title, 0.8);
      if (auto) {
        if (auto.hasVariants) {
          // Producto con variantes: solo auto-mapear si la variante es CLARA (color/talla en el título).
          const av = suggestVariant(auto, vText);
          if (av) { mapping = { productId: auto.id, productName: auto.name, variantId: av.id, variantLabel: vLabel(av) }; mappings[itemId] = mapping; }
          else { needsVariant = true; } // claro el producto, ambigua la variante -> pendiente
        } else {
          mapping = { productId: auto.id, productName: auto.name };
          mappings[itemId] = mapping;
        }
      }
    } else {
      // Mapeo ya confirmado: si es un producto con variantes y aún no tiene variante
      // fijada, intentar resolverla si el título la hace clara (no re-pregunta lo ya confirmado).
      const prod = products.find((p) => p.id === mapping.productId);
      if (prod && prod.hasVariants && mapping.variantId == null) {
        const av = suggestVariant(prod, vText);
        if (av) { mapping.variantId = av.id; mapping.variantLabel = vLabel(av); }
      }
    }
    if (mapping && !needsVariant) {
      const product = products.find((p) => p.id === mapping.productId) || {};
      const variantId = mapping.variantId != null ? mapping.variantId : null;
      const _mvCost = (product.hasVariants && variantId != null && Array.isArray(product.variants))
        ? product.variants.find((x) => String(x.id) === String(variantId)) : null;
      const costPrice = _mvCost ? (Number(_mvCost.precioCosto) || 0) : (product.costPrice || 0);
      const shipping = lineShip != null ? lineShip : (product.shipping || 0) * qty;
      const commission = +(commissionPerUnit * qty).toFixed(2);
      const totalPrice = unitPrice * qty;
      const profit = totalPrice - costPrice * qty - commission - shipping;
      const variantLabel = mapping.variantLabel || '';
      const _pName = mapping.productName || product.name || title;
      const _resolvedName = variantLabel ? (_pName + ' (' + variantLabel + ')') : _pName;
      sales.push({
        id: saleId, date, time,
        productId: mapping.productId, productName: _resolvedName,
        quantity: qty, salePrice: unitPrice, costPrice, commission,
        commissionType: 'percentage',
        commissionValue: unitPrice > 0 ? +((commissionPerUnit / unitPrice) * 100).toFixed(2) : 0,
        shipping, totalPrice, profit, createdAt: new Date().toISOString(),
        source: 'mercadolibre', item_id: itemId, order_id: String(order.id),
        feeSource: comm.source, shippingSource: lineShip != null ? 'ml' : 'local',
        variantId, variantLabel,
        // Auditoría (campos aditivos): de dónde vino y cómo se resolvió el nombre.
        registeredAt: new Date().toISOString(), registeredBy: 'sync',
        originalTitle: title, resolvedProductName: _resolvedName, nameConflictResolved: false
      });
      const idx = products.findIndex((p) => p.id === mapping.productId);
      if (idx >= 0) {
        const prod = products[idx];
        const mv = (prod.hasVariants && variantId != null && Array.isArray(prod.variants))
          ? prod.variants.find((x) => String(x.id) === String(variantId)) : null;
        if (mv) { mv.stock = Math.max(0, (Number(mv.stock) || 0) - qty); recalcVariantStock(prod); }
        else { prod.stock = Math.max(0, (prod.stock || 0) - qty); }
      }
      // (Quitado a propósito) Ya NO se crea una notificación "Venta registrada" en el chat por cada venta de ML.
      // La venta se guarda igual (sales.push arriba) y se refleja en Dashboard/Finanzas. Solo se eliminó el aviso del chat.
      added++;
    } else {
      hadUnmapped = true;
      // Guardamos el orderId REAL en cada heldSale (antes solo sobrevivía embebido en
      // saleId): así la venta registrada desde el pendiente tendrá su order_id real.
      const heldSale = { saleId, orderId: String(order.id), price: unitPrice, quantity: qty, commissionPerUnit, shippingTotal: lineShip, feeSource: comm.source, date, time };
      const pend = pendingMappings.find((p) => String(p.item_id) === itemId);
      if (pend) {
        pend.heldSales = pend.heldSales || [];
        if (!pend.heldSales.some((h) => h.saleId === saleId)) pend.heldSales.push(heldSale);
      } else {
        // Si el producto venía claro (auto-mapeo >80%) pero la variante es ambigua,
        // usar ese producto como sugerencia; si no, adivinar por nombre (>=0.4).
        const suggested = (needsVariant ? suggestProduct(products, title, 0.8) : null) || suggestProduct(products, title);
        const sVar = (suggested && suggested.hasVariants) ? suggestVariant(suggested, vText) : null;
        pendingMappings.push({
          item_id: itemId, title, price: unitPrice, quantity: qty, commissionPerUnit,
          suggestedProductId: suggested ? suggested.id : null,
          suggestedName: suggested ? suggested.name : null,
          suggestedVariantId: sVar ? sVar.id : null,
          suggestedVariantLabel: sVar ? vLabel(sVar) : null,
          needsVariant: !!(suggested && suggested.hasVariants),
          heldSales: [heldSale], createdAt: new Date().toISOString()
        });
        notifications.push({
          id: 'p-' + itemId, type: 'unknown',
          text: '🆕 Publicación nueva: "' + title + '" (' + fmt(unitPrice) + ' x' + qty + '). ' +
            (suggested ? '¿Es **' + suggested.name + '**?' : '¿A qué producto corresponde?') + ' Respóndelo en el chat.',
          createdAt: new Date().toISOString(), read: false
        });
        pending++;
      }
    }
  }
  return { added, pending, hadUnmapped };
}

async function syncOneUser(svc, gtoken, uid, tk, email, clientId, clientSecret) {
  const owner = !!email && email === OWNER_EMAIL;
  const statePath = owner ? 'crm/state' : 'crm_users/' + uid;

  const ml = makeMlClient(tk, clientId, clientSecret);

  const lookbackMs = LOOKBACK_DAYS * 864e5;
  const floor = Date.now() - lookbackMs;
  const since = tk.lastCheck ? Date.parse(tk.lastCheck) - 864e5 : floor;
  const fromISO = new Date(Math.max(floor, Math.min(since, Date.now()))).toISOString();

  const orders = await ml.fetchOrders('paid', fromISO);
  const processed = new Set(Array.isArray(tk.processedOrders) ? tk.processedOrders.map(String) : []);
  const allFresh = orders.filter((o) => !processed.has(String(o.id)));
  const fresh = allFresh.slice(0, MAX_ORDERS_PER_RUN);
  const restantes = allFresh.length - fresh.length;

  let nuevas = 0, pendientes = 0;

  if (fresh.length) {
    for (const order of fresh) order.__realShip = USE_REAL_SHIPPING ? await getShip(ml, order.shipping && order.shipping.id) : null;

    let written = false;
    for (let attempt = 0; attempt < 3 && !written; attempt++) {
      const cur = await fsGet(svc, gtoken, statePath);
      const state = cur.data || {};
      const ctx = {
        products: state.products || [], sales: state.sales || [], mappings: state.mappings || {},
        pendingMappings: state.pendingMappings || [], notifications: state.notifications || [],
        dismissedPending: state.dismissedPending || []
      };
      let added = 0, pend = 0; const newlyDone = [];
      for (const order of fresh) {
        const r = applyOrder(order, ctx);
        added += r.added; pend += r.pending;
        if (!r.hadUnmapped) newlyDone.push(String(order.id));
      }
      const out = Object.assign({}, state);
      delete out.updatedAt; delete out.updatedBy;
      out.products = ctx.products; out.sales = ctx.sales; out.mappings = ctx.mappings;
      out.pendingMappings = ctx.pendingMappings; out.notifications = ctx.notifications;
      const fields = encodeFields(out);
      fields.updatedAt = { timestampValue: new Date().toISOString() };
      fields.updatedBy = { stringValue: 'ml-sync-cloud' };

      const w = await fsPatch(svc, gtoken, statePath, fields, cur.updateTime);
      if (w.ok) {
        written = true; nuevas = added; pendientes = pend;
        for (const id of newlyDone) processed.add(id);
      } else {
        await sleep(400); // conflicto: el doc cambió, reintentar leyendo de nuevo
      }
    }
    if (!written) throw new Error('conflicto de escritura repetido');
  }

  // Guardar el doc del token SOLO si hubo algo nuevo (ventas nuevas o token refrescado).
  // Antes se escribía en CADA corrida aunque no vendiera nada → 48 escrituras/día/usuario
  // desperdiciadas. Con esto el gasto de Firestore baja al mínimo. La dedupe por
  // processedOrders evita reprocesar, así que es seguro no actualizar lastCheck cada vez.
  const st = ml.state();
  if (fresh.length || st.refreshed) {
    const newTk = Object.assign({}, tk);
    newTk.processedOrders = [...processed].slice(-1000);
    newTk.lastCheck = new Date().toISOString();
    if (st.refreshed) {
      newTk.access_token = st.access;
      newTk.refresh_token = st.refresh;
      newTk.expires_at = st.expiresAt;
    }
    newTk.updatedAt = Date.now();
    await fsPatch(svc, gtoken, 'crm_ml_tokens/' + uid, encodeFields(newTk), null);
  }

  return { nuevas, pendientes, restantes };
}

// Reutilizable por el copiloto MIA (render-backend/ai/ml.mjs) para refrescar
// tokens y llamar a la API de ML por usuario. Exportación aditiva.
exports.makeMlClient = makeMlClient;

exports.handler = async () => {
  let svc;
  try {
    svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (!svc.private_key || !svc.project_id) throw new Error('incompleto');
  } catch (e) {
    return { statusCode: 500, body: 'FIREBASE_SERVICE_ACCOUNT inválido o ausente.' };
  }
  const clientId = process.env.ML_CLIENT_ID, clientSecret = process.env.ML_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { statusCode: 500, body: 'Faltan ML_CLIENT_ID / ML_CLIENT_SECRET.' };

  try {
    const gtoken = await getGoogleAccessToken(svc);

    const accounts = await fsList(svc, gtoken, 'crm_accounts');
    const uidEmail = {};
    for (const a of accounts) if (a.data.uid) uidEmail[a.data.uid] = String(a.data.email || '').toLowerCase();

    const tokenDocs = await fsList(svc, gtoken, 'crm_ml_tokens');
    let totalNuevas = 0; const detalle = [];

    // Procesar usuarios en LOTES paralelos (más rápido y aguanta muchos más usuarios por corrida).
    // BATCH modesto para no pasar el límite de la API de Mercado Libre ni la memoria de Render.
    const BATCH = Number(process.env.SYNC_BATCH || 5);
    const validos = tokenDocs.filter((td) => {
      const tk = td.data;
      if (!tk.access_token || !tk.ml_user_id) { detalle.push(td.id + ': sin token válido'); return false; }
      return true;
    });
    for (let i = 0; i < validos.length; i += BATCH) {
      const grupo = validos.slice(i, i + BATCH);
      const resultados = await Promise.all(grupo.map(async (td) => {
        try {
          const r = await syncOneUser(svc, gtoken, td.id, td.data, uidEmail[td.id], clientId, clientSecret);
          return { id: td.id, r };
        } catch (e) {
          console.error('ml-sync usuario ' + td.id + ':', e.message);
          return { id: td.id, err: e.message };
        }
      }));
      for (const x of resultados) {
        if (x.err) { detalle.push(x.id + ': ERROR ' + x.err); continue; }
        totalNuevas += x.r.nuevas;
        detalle.push(x.id + ': ' + x.r.nuevas + ' nuevas' +
          (x.r.pendientes ? ', ' + x.r.pendientes + ' pendientes' : '') +
          (x.r.restantes ? ', ' + x.r.restantes + ' quedan para la próxima corrida' : ''));
      }
    }

    const summary = { ok: true, usuarios: tokenDocs.length, ventasNuevas: totalNuevas, detalle };
    console.log('ml-sync:', JSON.stringify(summary));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(summary, null, 2) };
  } catch (e) {
    console.error('ml-sync fatal:', e);
    return { statusCode: 500, body: 'Error: ' + e.message };
  }
};
