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
const COMMISSION_PREMIUM = parseFloat(process.env.COMMISSION_PREMIUM || '0.165'); // 16.5%
const COMMISSION_CLASSIC = parseFloat(process.env.COMMISSION_CLASSIC || '0.135'); // 13.5%

const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const SYNC_STATE_FILE = path.join(__dirname, '.ml-sync-state.json');
const SERVICE_ACCOUNT_FILE = path.join(__dirname, 'serviceAccountKey.json');

const API = 'https://api.mercadolibre.com';

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
async function mlGet(endpoint, token) {
    const res = await fetch(API + endpoint, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('ML GET ' + endpoint + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 200));
    return res.json();
}

async function fetchPaidOrders(tokens) {
    const endpoint = `/orders/search?seller=${tokens.user_id}&order.status=paid&sort=date_desc&limit=30`;
    const data = await mlGet(endpoint, tokens.access_token);
    return data.results || [];
}

// Comisión según tipo de publicación
function commissionRateFor(listingTypeId) {
    if (listingTypeId === 'gold_pro') return COMMISSION_PREMIUM; // Premium 16.5%
    return COMMISSION_CLASSIC;                                   // Clásica 13.5% (por defecto)
}

// ===================== PROCESAR ÓRDENES =====================
async function processOrders(db, tokens) {
    const syncState = loadSyncState();
    const processed = new Set(syncState.processedOrders || []);

    const orders = await fetchPaidOrders(tokens);
    const fresh = orders.filter(o => !processed.has(String(o.id)));
    if (fresh.length === 0) { console.log('· Sin ventas nuevas.'); return; }
    console.log(`· ${fresh.length} venta(s) nueva(s) detectada(s).`);

    const stateRef = db.collection('crm').doc('state');

    for (const order of fresh) {
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
            for (const it of (order.order_items || [])) {
                const itemId = String(it.item.id);
                const title = it.item.title || itemId;
                const qty = it.quantity || 1;
                const unitPrice = it.unit_price || 0;
                const rate = commissionRateFor(it.listing_type_id);
                const saleId = Number(String(order.id).replace(/\D/g, '').slice(-12)) || Date.now();

                // Evitar duplicados por venta ML ya registrada
                if (sales.some(s => s.source === 'mercadolibre' && String(s.item_id) === itemId && s.id === saleId)) continue;

                const mapping = mappings[itemId];
                if (mapping) {
                    // ---- PUBLICACIÓN CONOCIDA: registrar automáticamente ----
                    const product = products.find(p => p.id === mapping.productId) || {};
                    const costPrice = product.costPrice || 0;
                    const shipping = (product.shipping || 0) * qty;
                    const commission = unitPrice * qty * rate;
                    const totalPrice = unitPrice * qty;
                    const profit = totalPrice - costPrice * qty - commission - shipping;

                    sales.push({
                        id: saleId,
                        date: (order.date_created || new Date().toISOString()).split('T')[0],
                        time: (order.date_created || new Date().toISOString()).split('T')[1].slice(0, 5),
                        productId: mapping.productId,
                        productName: mapping.productName || product.name || title,
                        quantity: qty,
                        salePrice: unitPrice,
                        costPrice: costPrice,
                        commission: commission,
                        commissionType: 'percentage',
                        commissionValue: +(rate * 100).toFixed(2),
                        shipping: shipping,
                        totalPrice: totalPrice,
                        profit: profit,
                        createdAt: new Date().toISOString(),
                        source: 'mercadolibre',
                        item_id: itemId
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
                    console.log(`  ✅ Venta registrada: ${mapping.productName || title} x${qty}`);
                } else {
                    // ---- PUBLICACIÓN SIN MAPEAR: acumular la venta y dejar pendiente ----
                    orderHadUnmapped = true;
                    const heldSale = {
                        saleId: saleId,
                        price: unitPrice,
                        quantity: qty,
                        commissionRate: rate,
                        date: (order.date_created || new Date().toISOString()).split('T')[0],
                        time: (order.date_created || new Date().toISOString()).split('T')[1].slice(0, 5)
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
                            commissionRate: rate,
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

    saveSyncState({ processedOrders: [...processed].slice(-500), lastCheck: new Date().toISOString() });
}

function fmt(n) { return '$' + Math.round(n).toLocaleString('es-CL'); }

// ===================== MAIN =====================
async function tick(db) {
    try {
        const tokens = await getValidToken();
        if (!tokens.user_id) {
            const me = await mlGet('/users/me', tokens.access_token);
            tokens.user_id = me.id; saveTokens(tokens);
        }
        console.log(`[${new Date().toLocaleTimeString('es-CL')}] Revisando ventas...`);
        await processOrders(db, tokens);
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
