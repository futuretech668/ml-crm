// ============================================================================
// sync-status  —  Consulta el estado del último sync de Mercado Libre del
// usuario actual. Auto-ruteado por server.js como GET /api/sync-status.
// ----------------------------------------------------------------------------
// SEGURO:
//   · Requiere un Firebase ID token válido (Authorization: Bearer <idToken>),
//     verificado contra las claves públicas de Google. De ahí sale el uid REAL.
//   · NUNCA expone los tokens de ML (access/refresh): solo metadatos seguros.
//
// Devuelve JSON:
//   { ok, connected, mlUserId, lastCheck, lastSyncAt, processedOrdersCount,
//     pendingCount, ventasMl }
//   · connected            = existe access_token en crm_ml_tokens/{uid}
//   · lastCheck            = tk.lastCheck (ISO, lo persiste el cron)
//   · lastSyncAt           = tk.updatedAt (ms, lo persiste el cron) → ISO
//   · processedOrdersCount = nº de órdenes en tk.processedOrders (cron)
//   · pendingCount         = pendingMappings activos (no en dismissedPending)
//   · ventasMl             = nº de ventas con source==='mercadolibre'
//
// Variables de entorno: FIREBASE_SERVICE_ACCOUNT (y OWNER_EMAIL opcional).
// ============================================================================

const core = require('./lib/_core.js');

const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'futuretech.cl.668@gmail.com').toLowerCase();

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
}
function reply(status, obj) {
  return { statusCode: status, headers: Object.assign(cors(), { 'Content-Type': 'application/json; charset=utf-8' }), body: JSON.stringify(obj) };
}

// ¿Es el dueño? → su doc de estado es crm/state; el resto crm_users/{uid}.
// Misma resolución que send-report.js / ai/store.mjs resolveOwner.
async function resolveOwner(svc, gtoken, uid, email) {
  if (email && String(email).toLowerCase() === OWNER_EMAIL) return true;
  try {
    const ownerKey = core.emailKey(OWNER_EMAIL);
    const oacc = await core.fsGet(svc, gtoken, 'crm_accounts/' + ownerKey);
    const ownerUid = String((oacc && oacc.uid) || '');
    return !!ownerUid && uid === ownerUid;
  } catch (e) { return false; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET') return reply(405, { ok: false, reason: 'method' });

  // Token del usuario (Authorization: Bearer <idToken>)
  const h = event.headers || {};
  const auth = String(h.authorization || h.Authorization || '');
  const idToken = auth.replace(/^Bearer\s+/i, '').trim();
  if (!idToken) return reply(401, { ok: false, reason: 'noauth' });

  let svc;
  try { svc = core.getSvc(); } catch (e) { return reply(500, { ok: false, reason: 'config' }); }

  try {
    // 1) Verificar identidad
    let payload;
    try { payload = await core.verifyFirebaseIdToken(idToken, svc.project_id); }
    catch (e) { return reply(401, { ok: false, reason: 'badtoken' }); }
    const uid = String(payload.sub);
    const email = payload.email ? String(payload.email).toLowerCase() : '';

    const gtoken = await core.getGoogleAccessToken(svc);

    // 2) Doc de tokens de ML (NO se exponen access/refresh, solo metadatos).
    const tk = await core.fsGet(svc, gtoken, 'crm_ml_tokens/' + uid) || {};
    const connected = !!(tk && tk.access_token);

    // 3) Doc de estado (dueño → crm/state; si no → crm_users/{uid}).
    const isOwner = await resolveOwner(svc, gtoken, uid, email);
    const statePath = isOwner ? 'crm/state' : ('crm_users/' + uid);
    const state = await core.fsGet(svc, gtoken, statePath) || {};

    // pendingCount: pendingMappings activos (no descartados en dismissedPending).
    const dismissed = new Set((Array.isArray(state.dismissedPending) ? state.dismissedPending : []).map(String));
    const pending = Array.isArray(state.pendingMappings) ? state.pendingMappings : [];
    const pendingCount = pending.filter((p) => p && !dismissed.has(String(p.item_id))).length;

    // ventasMl: ventas registradas que vienen de Mercado Libre.
    const sales = Array.isArray(state.sales) ? state.sales : [];
    const ventasMl = sales.filter((s) => s && s.source === 'mercadolibre').length;

    const processedOrdersCount = Array.isArray(tk.processedOrders) ? tk.processedOrders.length : 0;
    const lastSyncAt = tk.updatedAt ? new Date(Number(tk.updatedAt)).toISOString() : null;

    return reply(200, {
      ok: true,
      connected,
      mlUserId: tk.ml_user_id != null ? Number(tk.ml_user_id) : null,
      mlNick: tk.nickname || null,
      lastCheck: tk.lastCheck || null,
      lastSyncAt,
      processedOrdersCount,
      pendingCount,
      ventasMl
    });
  } catch (e) {
    console.error('sync-status:', e && e.message ? e.message : e);
    return reply(500, { ok: false, reason: 'server' });
  }
};
