/**
 * sync-ml.js — Sincronización Mercado Libre → Firebase (PASOS 3, 4 y 5)
 * ---------------------------------------------------------------------
 * - OAuth 2.0 con Mercado Libre
 * - Revisa ventas nuevas cada 5 minutos
 * - Por cada venta: precio real, comisión según tipo de publicación
 *   (Clásica 13.5% / Premium 16.5%), ganancia neta y cantidad
 * - fuse.js sugiere a qué producto corresponde cada publicación nueva
 * - Escribe en Firestore (doc crm/state): ventas, pendingMappings y notifications
 *
 * USO:
 *   node sync-ml.js auth     -> autorizar la cuenta de Mercado Libre (una vez)
 *   node sync-ml.js          -> iniciar la sincronización continua
 *   node sync-ml.js once     -> ejecutar una sola revisión y salir
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const admin = require('firebase-admin');
const Fuse = require('fuse.js');

// ===================== CONFIG =====================
const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI = process.env.ML_REDIRECT_URI || 'https://localhost:3000/callback';
const AUTH_DOMAIN = process.env.ML_AUTH_DOMAIN || 'https://auth.mercadolibre.cl'; // .cl para Chile (MLC)
const POLL_MINUTES = parseInt(process.env.POLL_MINUTES || '5', 10);
const COMMISSION_PREMIUM = parseFloat(process.env.COMMISSION_PREMIUM || '0.165'); // 16.5% (solo fallback)
const COMMISSION_CLASSIC = parseFloat(process.env.COMMISSION_CLASSIC || '0.135'); // 13.5% (solo fallback)
// Usar el costo de envío REAL del vendedor (GET /shipments/{id}/costs). Si se desactiva,
// se usa el costo de envío configurado en el producto local.
const USE_REAL_SHIPPING = (process.env.USE_REAL_SHIPPING || 'true') !== 'false';
// Cuántos días hacia atrás revisar como máximo en cada corrida (incremental sobre lastCheck).
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || '7', 10);

const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const SYNC_STATE_FILE = path.join(__dirname, '.ml-sync-state.json');
const SERVICE_ACCOUNT_FILE = path.join(__dirname, 'serviceAccountKey.json');

const API = 'https://api.mercadolibre.com';

// Tokens activos en memoria (para poder refrescarlos automáticamente ante un 401).
let ACTIVE_TOKENS = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ===================== FIREBASE =====================
function initFirebase() {
    if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
        console.error('❌ Falta serviceAccountKey.json. Descárgalo desde Firebase (ver INSTRUCCIONES.md, PASO 3).');
        process.exit(1);
    }
    const serviceAccount = require(SERVICE_ACCOUNT_FILE);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    return admin.firestore();
}

// ===================== TOKENS =====================
function loadTokens() {
    if (!fs.existsSync(TOKENS_FILE)) return null;
    try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch (e) { return null; }
}
function saveTokens(t) { fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2)); }

function loadSyncState() {
    if (!fs.existsSync(SYNC_STATE_FILE)) return { processedOrders: [] };
    try { return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf8')); } catch (e) { return { processedOrders: [] }; }
}
function saveSyncState(s) { fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(s, null, 2)); }

// ===================== OAUTH =====================
async function exchangeCode(code) {
    const res = await fetch(`${API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            redirect_uri: REDIRECT_URI
        })
    });
    const data = await res.json();
    if (!res.ok) throw new Error('Token exchange falló: ' + JSON.stringify(data));
    return data;
}

async function refreshAccessToken(tokens) {
    const res = await fetch(`${API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: tokens.refresh_token
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

async function getValidToken() {
    let tokens = loadTokens();
    if (!tokens) {
        console.error('❌ No autorizado. Ejecuta primero:  node sync-ml.js auth');
        process.exit(1);
    }
    // Refrescar si vence en menos de 5 min
    if (!tokens.expires_at || Date.now() > tokens.expires_at - 5 * 60 * 1000) {
        console.log('🔄 Refrescando access token...');
        tokens = await refreshAccessToken(tokens);
    }
    ACTIVE_TOKENS = tokens;
    return tokens;
}

// Flujo de autorización interactivo (node sync-ml.js auth)
function runAuthFlow() {
    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.error('❌ Falta ML_CLIENT_ID / ML_CLIENT_SECRET en .env');
        process.exit(1);
    }
    const authUrl = `${AUTH_DOMAIN}/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
    console.log('\n========================================================');
    console.log('AUTORIZACIÓN CON MERCADO LIBRE');
    console.log('========================================================\n');
    console.log('1) Abre esta URL en tu navegador y autoriza la app:\n');
    console.log('   ' + authUrl + '\n');
    console.log('2) Tras autorizar, el navegador irá a ' + REDIRECT_URI + '?code=...');
    console.log('   Es NORMAL que la página muestre un error ("no se puede conectar").');
    console.log('   Lo único importante es la barra de direcciones con el code=.\n');

    let done = false;
    const finish = async (code) => {
        if (done) return; done = true;
        try {
            const data = await exchangeCode(code);
            saveTokens({
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                user_id: data.user_id,
                expires_at: Date.now() + (data.expires_in || 21600) * 1000
            });
            console.log('\n✅ Autorización exitosa. Tokens guardados en tokens.json.');
            console.log('   Ahora ejecuta:  npm start\n');
            process.exit(0);
        } catch (e) {
            console.error('\n❌ ' + e.message);
            process.exit(1);
        }
    };

    // Opción A: servidor local (solo si el redirect es http y el navegador lo alcanza)
    try {
        const u = new URL(REDIRECT_URI);
        if (u.protocol === 'http:') {
            const port = u.port || 80;
            http.createServer((req, res) => {
                const code = new URL(req.url, REDIRECT_URI).searchParams.get('code');
                if (code) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<h2>✅ Autorización exitosa. Vuelve a la terminal.</h2>');
                    finish(code);
                } else { res.writeHead(200); res.end('Esperando code...'); }
            }).listen(port, () => {});
        }
    } catch (e) {}

    // Opción B: pegar el código manualmente (siempre funciona, también con https)
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question('3) Pega aquí la URL completa de redirección (o solo el code) y presiona Enter:\n> ', (answer) => {
        answer = (answer || '').trim();
        let code = answer;
        const m = answer.match(/[?&]code=([^&\s]+)/);
        if (m) code = decodeURIComponent(m[1]);
        rl.close();
        finish(code);
    });
}

// ===================== MERCADO LIBRE API =====================
/**
 * Petición resiliente a la API de ML:
 *  - 401: refresca el access token una vez y reintenta.
 *  - 429 / 5xx: respeta Retry-After o aplica backoff exponencial (hasta 4 intentos).
 * Devuelve el JSON, o null si la respuesta es 404 (recurso inexistente) cuando allow404=true.
 */
async function mlRequest(endpoint, { method = 'GET', headers = {}, body, allow404 = false, _retried = false } = {}) {
    if (!ACTIVE_TOKENS) ACTIVE_TOKENS = await getValidToken();

    for (let attempt = 0; attempt < 4; attempt++) {
        let res;
        try {
            res = await fetch(API + endpoint, {
                method,
                headers: { Authorization: 'Bearer ' + ACTIVE_TOKENS.access_token, ...headers },
                body
            });
        } catch (netErr) {
            // Error de red: backoff y reintento
            if (attempt === 3) throw netErr;
            await sleep(1000 * 2 ** attempt);
            continue;
        }

        if (res.ok) return res.json();

        // Token vencido/revocado: refrescar una vez y reintentar desde cero
        if (res.status === 401 && !_retried) {
            console.log('🔄 401 recibido, refrescando token y reintentando...');
            ACTIVE_TOKENS = await refreshAccessToken(ACTIVE_TOKENS);
            return mlRequest(endpoint, { method, headers, body, allow404, _retried: true });
        }

        if (res.status === 404 && allow404) return null;

        // Rate limit o error transitorio del servidor: esperar y reintentar
        if (res.status === 429 || res.status >= 500) {
            const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
            const waitMs = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
            console.log(`⏳ ${res.status} en ${endpoint} — esperando ${Math.round(waitMs / 1000)}s (intento ${attempt + 1}/4)`);
            await sleep(waitMs);
            continue;
        }

        // Otros errores: no reintentar
        const text = (await res.text()).slice(0, 300);
        throw new Error(`ML ${method} ${endpoint} -> ${res.status} ${text}`);
    }
    throw new Error(`ML ${method} ${endpoint} -> agotados los reintentos`);
}

// Compatibilidad: GET simple a la API.
async function mlGet(endpoint) { return mlRequest(endpoint); }

/**
 * Trae TODAS las órdenes con un estado dado desde una fecha, paginando.
 * Usa order.date_created.from para no re-escanear el histórico completo.
 */
async function fetchOrders(tokens, status, fromISO) {
    const results = [];
    const limit = 50;
    let offset = 0;
    const fromParam = fromISO ? `&order.date_created.from=${encodeURIComponent(fromISO)}` : '';

    while (true) {
        const endpoint = `/orders/search?seller=${tokens.user_id}` +
            `&order.status=${status}${fromParam}` +
            `&sort=date_asc&offset=${offset}&limit=${limit}`;
        const data = await mlRequest(endpoint);
        const batch = data.results || [];
        results.push(...batch);

        const total = data.paging ? data.paging.total : batch.length;
        offset += limit;
        if (batch.length < limit || offset >= total || offset >= 1000) break; // 1000 = tope de offset de ML
    }
    return results;
}

/**
 * Costo de envío REAL que paga el vendedor para un envío (Mercado Envíos).
 * GET /shipments/{id}/costs -> senders[0].cost. Devuelve null si no aplica.
 */
async function getSellerShippingCost(shippingId) {
    if (!shippingId) return null;
    try {
        const costs = await mlRequest(`/shipments/${shippingId}/costs`, {
            headers: { 'x-format-new': 'true' },
            allow404: true
        });
        if (!costs) return null;
        if (Array.isArray(costs.senders) && costs.senders.length) {
            const c = costs.senders[0].cost;
            if (typeof c === 'number') return c;
        }
        if (typeof costs.gross_amount === 'number') return costs.gross_amount;
        return null;
    } catch (e) {
        console.log(`  · No se pudo obtener costo de envío del shipment ${shippingId}: ${e.message}`);
        return null;
    }
}

// Comisión por unidad: usa el sale_fee REAL de ML; si falta, cae al % por tipo de publicación.
function unitCommissionFor(orderItem) {
    if (typeof orderItem.sale_fee === 'number' && orderItem.sale_fee > 0) {
        return { perUnit: orderItem.sale_fee, source: 'sale_fee' };
    }
    const rate = orderItem.listing_type_id === 'gold_pro' ? COMMISSION_PREMIUM : COMMISSION_CLASSIC;
    return { perUnit: (orderItem.unit_price || 0) * rate, source: 'estimado', rate };
}

// ===================== PROCESAR ÓRDENES =====================
// Fecha "desde" incremental: último chequeo (con 1 día de solape) acotado por LOOKBACK_DAYS.
function incrementalFromISO(syncState) {
    const lookbackMs = LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const floor = Date.now() - lookbackMs;
    const since = syncState.lastCheck
        ? Date.parse(syncState.lastCheck) - 24 * 60 * 60 * 1000
        : floor;
    return new Date(Math.max(floor, Math.min(since, Date.now()))).toISOString();
}

function orderDateParts(order) {
    const iso = order.date_created || new Date().toISOString();
    return { date: iso.split('T')[0], time: (iso.split('T')[1] || '00:00').slice(0, 5) };
}

// saleId determinístico por (orden, ítem): así un pedido multi-ítem no colisiona en el mismo id.
function saleIdFor(order, itemId) {
    const base = String(order.id).replace(/\D/g, '').slice(-11) || String(Date.now());
    const tail = String(itemId).replace(/\D/g, '').slice(-3) || '0';
    return Number(base + tail.padStart(3, '0'));
}

async function processOrders(db, tokens) {
    const syncState = loadSyncState();
    const processed = new Set(syncState.processedOrders || []);
    const fromISO = incrementalFromISO(syncState);

    const orders = await fetchOrders(tokens, 'paid', fromISO);
    const fresh = orders.filter(o => !processed.has(String(o.id)));
    if (fresh.length === 0) console.log(`· Sin ventas nuevas desde ${fromISO.slice(0, 10)}.`);
    else console.log(`· ${fresh.length} venta(s) nueva(s) detectada(s).`);

    const stateRef = db.collection('crm').doc('state');

    for (const order of fresh) {
        // Costo de envío REAL del vendedor — se obtiene FUERA de la transacción.
        const realShip = USE_REAL_SHIPPING ? await getSellerShippingCost(order.shipping && order.shipping.id) : null;
        const items = order.order_items || [];
        const totalQty = items.reduce((s, it) => s + (it.quantity || 1), 0) || 1;
        const { date, time } = orderDateParts(order);

        const hadUnmapped = await db.runTransaction(async (tx) => {
            const snap = await tx.get(stateRef);
            const state = snap.exists ? snap.data() : {};
            const products = state.products || [];
            const sales = state.sales || [];
            const mappings = state.mappings || {};
            const pendingMappings = state.pendingMappings || [];
            const notifications = state.notifications || [];

            const fuse = new Fuse(products.filter(p => !p.archived), {
                keys: ['name'], threshold: 0.5, includeScore: true
            });

            let orderHadUnmapped = false;
            for (const it of items) {
                const itemId = String(it.item.id);
                const title = it.item.title || itemId;
                const qty = it.quantity || 1;
                const unitPrice = it.unit_price || 0;
                const comm = unitCommissionFor(it);                       // {perUnit, source}
                const commissionPerUnit = +comm.perUnit.toFixed(2);
                // Reparto del envío real del vendedor proporcional a la cantidad de cada línea.
                const lineShip = realShip != null ? +(realShip * (qty / totalQty)).toFixed(2) : null;
                const saleId = saleIdFor(order, itemId);

                // Evitar duplicados por venta ML ya registrada
                if (sales.some(s => s.source === 'mercadolibre' && String(s.item_id) === itemId && s.id === saleId)) continue;

                const mapping = mappings[itemId];
                if (mapping) {
                    // ---- PUBLICACIÓN CONOCIDA: registrar automáticamente ----
                    const product = products.find(p => p.id === mapping.productId) || {};
                    const costPrice = product.costPrice || 0;
                    const shipping = lineShip != null ? lineShip : (product.shipping || 0) * qty;
                    const commission = +(commissionPerUnit * qty).toFixed(2);
                    const totalPrice = unitPrice * qty;
                    const profit = totalPrice - costPrice * qty - commission - shipping;

                    sales.push({
                        id: saleId,
                        date, time,
                        productId: mapping.productId,
                        productName: mapping.productName || product.name || title,
                        quantity: qty,
                        salePrice: unitPrice,
                        costPrice: costPrice,
                        commission: commission,
                        commissionType: 'percentage',
                        commissionValue: unitPrice > 0 ? +((commissionPerUnit / unitPrice) * 100).toFixed(2) : 0,
                        shipping: shipping,
                        totalPrice: totalPrice,
                        profit: profit,
                        createdAt: new Date().toISOString(),
                        source: 'mercadolibre',
                        item_id: itemId,
                        order_id: String(order.id),
                        feeSource: comm.source,                  // 'sale_fee' (real) | 'estimado'
                        shippingSource: lineShip != null ? 'ml' : 'local'
                    });
                    const idx = products.findIndex(p => p.id === mapping.productId);
                    if (idx >= 0) products[idx].stock = Math.max(0, (products[idx].stock || 0) - qty);

                    notifications.push({
                        id: 'n-' + saleId + '-' + itemId,
                        type: 'sale',
                        text: `✅ Venta registrada: **${mapping.productName || title}** x${qty} - ${fmt(totalPrice)}`,
                        createdAt: new Date().toISOString(),
                        read: false
                    });
                    console.log(`  ✅ Venta: ${mapping.productName || title} x${qty} · comisión ${fmt(commission)} (${comm.source}) · envío ${fmt(shipping)} (${lineShip != null ? 'ML' : 'local'})`);
                } else {
                    // ---- PUBLICACIÓN SIN MAPEAR: acumular la venta y dejar pendiente ----
                    orderHadUnmapped = true;
                    const heldSale = {
                        saleId: saleId,
                        price: unitPrice,
                        quantity: qty,
                        commissionPerUnit: commissionPerUnit,    // comisión real por unidad (sale_fee)
                        shippingTotal: lineShip,                 // envío real de la línea (o null -> usa el local)
                        feeSource: comm.source,
                        date, time
                    };
                    let pending = pendingMappings.find(p => String(p.item_id) === itemId);
                    if (pending) {
                        // Misma publicación que ya está pendiente: sumar esta venta (sin duplicar)
                        pending.heldSales = pending.heldSales || [];
                        if (!pending.heldSales.some(h => h.saleId === saleId)) pending.heldSales.push(heldSale);
                    } else {
                        const best = fuse.search(title)[0];
                        const suggested = best ? best.item : null;
                        pendingMappings.push({
                            item_id: itemId,
                            title: title,
                            price: unitPrice,
                            quantity: qty,
                            commissionPerUnit: commissionPerUnit,
                            suggestedProductId: suggested ? suggested.id : null,
                            suggestedName: suggested ? suggested.name : null,
                            heldSales: [heldSale],
                            createdAt: new Date().toISOString()
                        });
                        notifications.push({
                            id: 'p-' + itemId,
                            type: 'unknown',
                            text: `🆕 Publicación nueva: "${title}" (${fmt(unitPrice)} x${qty}). ${suggested ? '¿Es **' + suggested.name + '**?' : '¿A qué producto corresponde?'} Respóndelo en el chat.`,
                            createdAt: new Date().toISOString(),
                            read: false
                        });
                        console.log(`  🆕 Publicación nueva pendiente: ${title}` + (suggested ? ` (sugerido: ${suggested.name})` : ''));
                    }
                }
            }

            tx.set(stateRef, {
                products, sales, mappings, pendingMappings, notifications,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedBy: 'sync-ml'
            }, { merge: true });

            return orderHadUnmapped;
        });

        // Solo marcamos como procesada si TODOS sus ítems quedaron registrados.
        // Si algún ítem quedó sin mapear, la orden se revisa de nuevo y se registra al confirmar el producto.
        if (!hadUnmapped) processed.add(String(order.id));
    }

    const ss = loadSyncState();
    saveSyncState({ ...ss, processedOrders: [...processed].slice(-1000), lastCheck: new Date().toISOString() });
}

// ===================== CANCELACIONES / REEMBOLSOS =====================
// Detecta órdenes canceladas y revierte la venta registrada (restituye stock).
async function processCancellations(db, tokens, fromISO) {
    const cancelled = new Set((loadSyncState().cancelledOrders) || []);
    let orders;
    try {
        orders = await fetchOrders(tokens, 'cancelled', fromISO);
    } catch (e) {
        console.log('  · No se pudieron revisar cancelaciones:', e.message);
        return;
    }
    const fresh = orders.filter(o => !cancelled.has(String(o.id)));
    if (fresh.length === 0) return;

    const stateRef = db.collection('crm').doc('state');
    for (const order of fresh) {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(stateRef);
            const state = snap.exists ? snap.data() : {};
            const products = state.products || [];
            const sales = state.sales || [];
            const pendingMappings = state.pendingMappings || [];
            const notifications = state.notifications || [];

            let reversed = 0;
            for (const it of (order.order_items || [])) {
                const itemId = String(it.item.id);
                const saleId = saleIdFor(order, itemId);
                const idx = sales.findIndex(s => s.source === 'mercadolibre' && String(s.item_id) === itemId && s.id === saleId);
                if (idx >= 0) {
                    const s = sales[idx];
                    const p = products.find(pr => pr.id === s.productId);
                    if (p) p.stock = (p.stock || 0) + (s.quantity || 1);   // restituir stock
                    sales.splice(idx, 1);                                   // quitar la venta para que los totales se autocorrijan
                    reversed++;
                    notifications.push({
                        id: 'c-' + saleId + '-' + itemId,
                        type: 'cancel',
                        text: `↩️ Venta cancelada en ML: **${s.productName}** x${s.quantity}. Stock restituido.`,
                        createdAt: new Date().toISOString(),
                        read: false
                    });
                }
                // Si quedó como pendiente sin mapear, eliminar esa venta retenida.
                const pend = pendingMappings.find(pm => String(pm.item_id) === itemId);
                if (pend && Array.isArray(pend.heldSales)) pend.heldSales = pend.heldSales.filter(h => h.saleId !== saleId);
            }

            tx.set(stateRef, {
                products, sales, pendingMappings, notifications,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedBy: 'sync-ml'
            }, { merge: true });

            if (reversed) console.log(`  ↩️ Orden cancelada ${order.id}: ${reversed} venta(s) revertida(s).`);
        });
        cancelled.add(String(order.id));
    }

    const ss = loadSyncState();
    saveSyncState({ ...ss, cancelledOrders: [...cancelled].slice(-500) });
}

function fmt(n) { return '$' + Math.round(n).toLocaleString('es-CL'); }

// ===================== EMAILS (NexSell) =====================
// Todo este bloque es ADITIVO. No modifica ninguna función existente.
// Provee notificaciones por correo vía Resend (REST, fetch nativo de Node 18+).

const EMAIL_TEMPLATES = require('./email-templates');

// Correo de la cuenta dueña por defecto (a donde llegan los avisos si no se configura REPORT_EMAIL).
const DEFAULT_REPORT_EMAIL = 'futuretech.cl.668@gmail.com';

/**
 * Envía un correo con Resend. No-op silencioso si:
 *   - EMAIL_ENABLED está en 'false', o
 *   - falta RESEND_API_KEY.
 * Nunca lanza: ante cualquier error solo registra un aviso y devuelve false.
 */
// Transporte Gmail SMTP (nodemailer), creado una sola vez y reutilizado.
// Solo se activa si hay GMAIL_USER + GMAIL_APP_PASSWORD en el .env.
let _gmailTransport = null;
function getGmailTransport() {
    if (_gmailTransport) return _gmailTransport;
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) return null;
    const nodemailer = require('nodemailer');
    _gmailTransport = nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass: pass.replace(/\s+/g, '') } // la contraseña de aplicación suele venir con espacios
    });
    return _gmailTransport;
}

async function sendEmail(to, subject, html) {
    if ((process.env.EMAIL_ENABLED || 'true') === 'false') return false;
    const recipients = Array.isArray(to) ? to : [to];

    // ---- Opción 1: Gmail SMTP (envía a CUALQUIER correo, gratis) ----
    const gmail = getGmailTransport();
    if (gmail) {
        const fromName = process.env.EMAIL_FROM_NAME || 'NexSell';
        try {
            await gmail.sendMail({ from: `${fromName} <${process.env.GMAIL_USER}>`, to: recipients.join(', '), subject, html });
            console.log(`  📧 Correo enviado (Gmail) a ${recipients.join(', ')}: ${subject}`);
            return true;
        } catch (e) {
            console.warn('email(gmail): fallo al enviar:', e.message);
            return false;
        }
    }

    // ---- Opción 2: Resend (respaldo; remitente de prueba solo llega a tu propio correo) ----
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return false; // sin ningún proveedor -> no-op silencioso
    const from = process.env.EMAIL_FROM || 'NexSell <onboarding@resend.dev>';
    try {
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ from, to: recipients, subject, html })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            console.warn('email: Resend respondió', r.status, JSON.stringify(data).slice(0, 200));
            return false;
        }
        console.log(`  📧 Correo enviado a ${recipients.join(', ')}: ${subject}`);
        return true;
    } catch (e) {
        console.warn('email: fallo al enviar:', e.message);
        return false;
    }
}

// Lunes (00:00) de la semana de una fecha dada -> 'YYYY-MM-DD' (clave para no repetir el reporte semanal).
function mondayKey(d) {
    const x = new Date(d);
    const day = x.getDay();               // 0=domingo ... 1=lunes
    const diff = (day === 0 ? -6 : 1 - day);
    x.setDate(x.getDate() + diff);
    return x.toISOString().slice(0, 10);
}

// Suma estadísticas (ventas/ingresos/comisión/envío/ganancia/unidades + top productos) sobre un arreglo de ventas.
function summarizeSales(sales) {
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
function salesInRange(sales, fromDate, toDate) {
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

/**
 * Procesa y envía las notificaciones por correo. 100% aditivo y a prueba de fallos:
 * cualquier error queda contenido (lo invoca tick() dentro de un try/catch).
 *
 * Lee crm/state (products, sales) y envía al REPORT_EMAIL (o a la cuenta dueña):
 *   - Venta nueva (source mercadolibre, no notificada antes -> emailedSales)
 *   - Stock bajo (<= stockMin y > 0) o agotado (0), sin repetir el mismo nivel -> emailedLowStock
 *   - Reporte semanal los lunes (una vez por semana -> lastWeekly)
 *   - Reporte mensual el día 1 (una vez por mes -> lastMonthly)
 * El estado de envío se persiste en .ml-sync-state.json SIN borrar campos previos.
 */
async function processEmailNotifications(db) {
    if ((process.env.EMAIL_ENABLED || 'true') === 'false') return;
    if (!process.env.RESEND_API_KEY) return; // sin credenciales no hacemos nada

    const to = process.env.REPORT_EMAIL || DEFAULT_REPORT_EMAIL;

    const snap = await db.collection('crm').doc('state').get();
    const state = snap.exists ? snap.data() : {};
    const products = state.products || [];
    const sales = state.sales || [];

    // Estado de envíos previo (sin perder campos existentes del .ml-sync-state.json).
    const ss = loadSyncState();
    const emailedSales = new Set(ss.emailedSales || []);
    const emailedLowStock = new Set(ss.emailedLowStock || []);
    let changed = false;

    // ---- 0) PRIMERA CORRIDA: línea base, NO enviar correos del histórico ----
    // Si el seguimiento de correos nunca se inicializó (no existe emailedInit en el
    // estado), marcamos TODAS las ventas y avisos de stock actuales como "ya
    // notificados" y salimos. Así evitamos un envío masivo de las ~48 ventas
    // históricas (y de cada producto con stock bajo) la primera vez que se activa
    // el sistema de correos. A partir de la 2ª corrida solo se avisa lo NUEVO.
    if (!ss.emailedInit) {
        for (const s of sales) {
            if (s && s.source === 'mercadolibre' && s.id != null) emailedSales.add(String(s.id));
        }
        for (const p of products) {
            if (!p || p.archived) continue;
            const st0 = p.stock || 0;
            const min0 = (p.stockMin != null ? p.stockMin : 5);
            const id0 = (p.id != null ? p.id : (p.name || ''));
            if (st0 <= 0) emailedLowStock.add(id0 + ':out');
            else if (st0 <= min0) emailedLowStock.add(id0 + ':low');
        }
        const baseNow = new Date();
        const fresh0 = loadSyncState();
        saveSyncState({
            ...fresh0,
            ...ss,
            emailedInit: true,
            // No reenviar reportes pasados: fijamos la semana/mes actuales como ya cubiertos.
            lastWeekly: mondayKey(baseNow),
            lastMonthly: baseNow.toISOString().slice(0, 7),
            emailedSales: [...emailedSales].slice(-2000),
            emailedLowStock: [...emailedLowStock].slice(-500)
        });
        console.log('  📧 Sistema de correos inicializado (línea base, sin envíos del histórico).');
        return;
    }

    // ---- 1) VENTAS NUEVAS ----
    // (DESACTIVADO a propósito) Ya NO se manda un correo por cada venta. La nube (Render) envía
    // UN resumen diario. Aquí solo marcamos las ventas como vistas para no reprocesarlas.
    const newSales = sales.filter(s =>
        s && s.source === 'mercadolibre' && s.id != null && !emailedSales.has(String(s.id))
    );
    for (const sale of newSales) { emailedSales.add(String(sale.id)); changed = true; }

    // ---- 2) STOCK BAJO / AGOTADO ----
    for (const p of products) {
        if (!p || p.archived) continue;
        const stock = p.stock || 0;
        const min = (p.stockMin != null ? p.stockMin : 5);
        let level = null;
        if (stock <= 0) level = 'out';
        else if (stock <= min) level = 'low';
        if (!level) continue;
        const key = (p.id != null ? p.id : (p.name || '')) + ':' + level;
        if (emailedLowStock.has(key)) continue;
        const { subject, html } = EMAIL_TEMPLATES.buildLowStockEmail(p);
        const ok = await sendEmail(to, subject, html);
        if (ok) {
            emailedLowStock.add(key);
            // Si vuelve a haber stock por encima del mínimo, limpiamos las marcas para poder avisar otra vez.
            changed = true;
        }
    }
    // Limpia marcas de stock de productos que ya se reabastecieron (stock > stockMin).
    for (const p of products) {
        if (!p) continue;
        const stock = p.stock || 0;
        const min = (p.stockMin != null ? p.stockMin : 5);
        if (stock > min) {
            const id = (p.id != null ? p.id : (p.name || ''));
            if (emailedLowStock.delete(id + ':low')) changed = true;
            if (emailedLowStock.delete(id + ':out')) changed = true;
        }
    }

    // ---- 3) REPORTE SEMANAL (lunes, idealmente desde las 9am) ----
    const now = new Date();
    // Mejora best-effort (Agente 3): el reporte semanal se envía los lunes a partir
    // de las 9am. Como el proceso revisa cada ~5 min, en cuanto pasen las 9:00 del
    // lunes se dispara en el siguiente tick. La marca lastWeekly evita repetirlo.
    if (now.getDay() === 1 && now.getHours() >= 9) {
        const thisMonday = mondayKey(now);
        if (ss.lastWeekly !== thisMonday) {
            const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const stats = summarizeSales(salesInRange(sales, from, null));
            stats.periodLabel = 'Semana del ' + thisMonday;
            const { subject, html } = EMAIL_TEMPLATES.buildWeeklyReport(stats);
            const ok = await sendEmail(to, subject, html);
            if (ok) { ss.lastWeekly = thisMonday; changed = true; }
        }
    }

    // ---- 4) REPORTE MENSUAL (día 1) ----
    if (now.getDate() === 1) {
        const thisMonth = now.toISOString().slice(0, 7); // YYYY-MM
        if (ss.lastMonthly !== thisMonth) {
            // Resumen del mes ANTERIOR (el que acaba de cerrar).
            const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1);
            const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const stats = summarizeSales(salesInRange(sales, prevMonthStart.toISOString(), prevMonthEnd.toISOString()));
            stats.periodLabel = prevMonthStart.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
            // Comparativa con el mes anterior a ese (Agente 3): se adjunta stats.prev
            // para que la plantilla muestre la variación. buildMonthlyReport es tolerante
            // si stats.prev no viene (no rompe nada).
            const prev2Start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
            const prev2Stats = summarizeSales(salesInRange(sales, prev2Start.toISOString(), prevMonthStart.toISOString()));
            stats.prev = {
                profit: prev2Stats.profit,
                revenue: prev2Stats.revenue,
                units: prev2Stats.units,
                count: prev2Stats.count,
                label: prev2Start.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' })
            };
            const { subject, html } = EMAIL_TEMPLATES.buildMonthlyReport(stats);
            const ok = await sendEmail(to, subject, html);
            if (ok) { ss.lastMonthly = thisMonth; changed = true; }
        }
    }

    if (changed) {
        // Releemos el estado por si processOrders escribió mientras tanto, y conservamos TODO.
        const fresh = loadSyncState();
        saveSyncState({
            ...fresh,
            ...ss,
            emailedSales: [...emailedSales].slice(-2000),
            emailedLowStock: [...emailedLowStock].slice(-500)
        });
    }
}

/**
 * Envía un correo de BIENVENIDA a cada cuenta NUEVA registrada en la app.
 * 100% aditivo y a prueba de fallos (lo invoca tick() dentro de un try/catch).
 *
 * - Lee la colección crm_accounts (donde el registro de la app guarda cada cuenta).
 * - Dedup por cuenta (uid) en .ml-sync-state.json -> welcomedAccounts.
 * - PRIMERA corrida = línea base: marca las cuentas YA existentes como saludadas
 *   SIN enviar nada (evita spamear cuentas previas al activar el sistema).
 *
 * Nota Resend: con el remitente de prueba (onboarding@resend.dev) SOLO se puede
 * enviar a la dirección con la que te registraste en Resend. Para escribir a
 * CUALQUIER correo de usuario debes verificar un dominio propio en Resend.
 */
async function processWelcomeEmails(db) {
    if ((process.env.EMAIL_ENABLED || 'true') === 'false') return;
    if (!process.env.RESEND_API_KEY) return;                          // sin credenciales -> no-op
    if ((process.env.WELCOME_EMAIL_ENABLED || 'true') === 'false') return; // interruptor opcional

    let accounts = [];
    try {
        const qs = await db.collection('crm_accounts').get();
        qs.forEach(d => accounts.push(d.data() || {}));
    } catch (e) {
        console.warn('welcome: no se pudo leer crm_accounts:', e.message);
        return;
    }
    if (!accounts.length) return;

    const ss = loadSyncState();
    const welcomed = new Set(ss.welcomedAccounts || []);
    const keyOf = (a) => String(a.uid || a.email || '');

    // Línea base: primera vez -> marcar todas las cuentas actuales como saludadas (sin enviar).
    if (!ss.welcomedInit) {
        for (const a of accounts) { const k = keyOf(a); if (k) welcomed.add(k); }
        const fresh0 = loadSyncState();
        saveSyncState({ ...fresh0, ...ss, welcomedInit: true, welcomedAccounts: [...welcomed].slice(-5000) });
        console.log('  📧 Bienvenidas inicializadas (línea base, sin envíos a cuentas existentes).');
        return;
    }

    let changed = false;
    for (const a of accounts) {
        const k = keyOf(a);
        if (!k || welcomed.has(k)) continue;
        if (!a.email) { welcomed.add(k); changed = true; continue; }
        const { subject, html } = EMAIL_TEMPLATES.buildWelcomeEmail(a);
        const ok = await sendEmail(a.email, subject, html);
        if (ok) { welcomed.add(k); changed = true; }
        // Si falla (p.ej. remitente de prueba no autorizado a ese correo) NO se marca:
        // se reintentará en el próximo ciclo y se enviará en cuanto se verifique el dominio.
    }

    if (changed) {
        const fresh = loadSyncState();
        saveSyncState({ ...fresh, ...ss, welcomedAccounts: [...welcomed].slice(-5000) });
    }
}

// ¿Hay algún proveedor de correo configurado? (Gmail SMTP o Resend)
function emailProviderReady() {
    return !!(process.env.RESEND_API_KEY || (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD));
}

// Progreso de la META mensual del usuario, calculado desde SUS ventas del mes en curso.
// Devuelve null si no hay meta para el mes actual.
function computeGoalProgress(goals, sales, now) {
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
    return { tipoMeta: g.tipoMeta, objetivo: g.objetivo, logrado, cumplida: logrado >= g.objetivo };
}

/**
 * Envía a CADA usuario (no dueño) su PROPIO reporte a su correo:
 *   - Semanal (lunes desde 9am): resumen de sus últimos 7 días + progreso de su meta del mes.
 *   - Mensual (día 1): resumen del mes anterior.
 * 100% aditivo y a prueba de fallos. Dedup por usuario en .ml-sync-state.json
 * (lastUserWeekly / lastUserMonthly). El DUEÑO se omite (ya recibe sus reportes
 * por REPORT_EMAIL en processEmailNotifications, sin duplicar).
 */
async function processUserReports(db) {
    if ((process.env.EMAIL_ENABLED || 'true') === 'false') return;
    if (!emailProviderReady()) return;
    if ((process.env.USER_REPORTS_ENABLED || 'true') === 'false') return;

    const now = new Date();
    const isWeekly = (now.getDay() === 1 && now.getHours() >= 9);
    const isMonthly = (now.getDate() === 1);
    if (!isWeekly && !isMonthly) return; // solo se envían lunes (semanal) o día 1 (mensual)

    let accounts = [];
    try {
        const qs = await db.collection('crm_accounts').get();
        qs.forEach(d => accounts.push(d.data() || {}));
    } catch (e) { console.warn('user-reports: no se pudo leer crm_accounts:', e.message); return; }
    if (!accounts.length) return;

    const ownerEmail = String(process.env.OWNER_EMAIL || DEFAULT_REPORT_EMAIL).toLowerCase();
    const ss = loadSyncState();
    const lastUserWeekly = ss.lastUserWeekly || {};
    const lastUserMonthly = ss.lastUserMonthly || {};
    let changed = false;

    for (const acc of accounts) {
        const email = acc.email, uid = acc.uid;
        if (!email || !uid) continue;
        if (String(email).toLowerCase() === ownerEmail) continue; // el dueño ya recibe sus reportes

        // Datos del usuario (cada cuenta no-dueña vive en crm_users/{uid}).
        let data = {};
        try { const s = await db.collection('crm_users').doc(uid).get(); data = s.exists ? s.data() : {}; }
        catch (e) { continue; }
        const sales = data.sales || [];
        const goals = data.goals || {};
        const name = String(email).split('@')[0];

        // ---- SEMANAL (lunes) ----
        if (isWeekly) {
            const wkKey = mondayKey(now);
            if (lastUserWeekly[uid] !== wkKey) {
                const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
                const stats = summarizeSales(salesInRange(sales, from, null));
                const goal = computeGoalProgress(goals, sales, now);
                if (stats.count > 0 || (goal && goal.objetivo)) {
                    const label = 'Semana del ' + wkKey;
                    const { subject, html } = EMAIL_TEMPLATES.buildUserReport({ name, periodLabel: label, stats, goal });
                    const ok = await sendEmail(email, subject, html);
                    if (ok) { lastUserWeekly[uid] = wkKey; changed = true; }
                } else { lastUserWeekly[uid] = wkKey; changed = true; } // sin actividad: marcar para no reintentar toda la semana
            }
        }

        // ---- MENSUAL (día 1) ----
        if (isMonthly) {
            const moKey = now.toISOString().slice(0, 7);
            if (lastUserMonthly[uid] !== moKey) {
                const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                const prevEnd = new Date(now.getFullYear(), now.getMonth(), 1);
                const stats = summarizeSales(salesInRange(sales, prevStart.toISOString(), prevEnd.toISOString()));
                if (stats.count > 0) {
                    const label = prevStart.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
                    const { subject, html } = EMAIL_TEMPLATES.buildUserReport({ name, periodLabel: label, stats, goal: null });
                    const ok = await sendEmail(email, subject, html);
                    if (ok) { lastUserMonthly[uid] = moKey; changed = true; }
                } else { lastUserMonthly[uid] = moKey; changed = true; }
            }
        }
    }

    if (changed) {
        const fresh = loadSyncState();
        saveSyncState({ ...fresh, ...ss, lastUserWeekly, lastUserMonthly });
    }
}

// ===================== MAIN =====================
async function tick(db) {
    try {
        const tokens = await getValidToken();
        if (!tokens.user_id) {
            const me = await mlGet('/users/me');
            tokens.user_id = me.id; saveTokens(tokens);
            ACTIVE_TOKENS = tokens;
        }
        console.log(`[${new Date().toLocaleTimeString('es-CL')}] Revisando ventas...`);
        await processOrders(db, tokens);
        await processCancellations(db, tokens, incrementalFromISO(loadSyncState()));
        try { await processEmailNotifications(db); } catch (e) { console.warn('email:', e.message); }
        try { await processWelcomeEmails(db); } catch (e) { console.warn('welcome:', e.message); }
        try { await processUserReports(db); } catch (e) { console.warn('user-reports:', e.message); }
    } catch (e) {
        console.error('⚠️ Error en la revisión:', e.message);
    }
}

async function main() {
    const mode = process.argv[2];
    if (mode === 'auth') { runAuthFlow(); return; }

    const db = initFirebase();
    if (mode === 'once') { await tick(db); process.exit(0); }

    console.log(`🚀 Sincronización ML iniciada. Revisando cada ${POLL_MINUTES} min. (Ctrl+C para salir)`);
    await tick(db);
    setInterval(() => tick(db), POLL_MINUTES * 60 * 1000);
}

main();
