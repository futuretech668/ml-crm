// ============================================================================
// agent.mjs — Orquestador del copiloto MIA (ESM, aislado de LangChain).
//
// Un POST a /api/ai-agent = un turno. Maneja las ops open/send/list/get/delete,
// la autenticación por Firebase ID token, la carga del doc de estado + memoria,
// la inyección de contexto en 3 capas (perfil + briefing + herramientas en
// vivo), el confirm-gate de las acciones de ML, y la persistencia de SOLO lo
// que cambió.
//
// Las dependencias externas (Firestore IO real, verificación de token, modelo
// LangChain, cliente ML) se inyectan vía `configure()` para poder testear sin
// red ni claves. Por defecto usan las implementaciones reales.
// ============================================================================

import { createRequire } from 'node:module';
import * as store from './store.mjs';
import * as domain from './domain.mjs';
import { buildCrmTools } from './tools.mjs';
import { buildMlTools } from './ml.mjs';

const require = createRequire(import.meta.url);
const core = require('../api/lib/_core.js');
const { makeMlClient } = require('../ml-sync.js');

const MAX_MSGS_PER_THREAD = 40;
const MAX_THREADS = 25;

// ---- Persona (B.1 del plan, verbatim; el último bloque se interpola) ----
const PERSONA = `Eres MIA, la asistente de ventas de NexSell, un CRM para vendedores de Mercado Libre.

IDENTIDAD Y TONO
· Respondes SIEMPRE en español (Chile), breve, claro y amable; tuteas.
· Montos en pesos chilenos con separador de miles (p. ej. $1.250.000).
· Eres una colega experta en ventas: proactiva, concreta y orientada a la acción.

REGLA DE ORO — CERO INVENCIÓN
· NUNCA inventes ni estimes cifras, fechas, pedidos, preguntas, productos ni stock.
· Toda cifra o dato que entregues DEBE venir de una herramienta que acabas de ejecutar.
  Si no lo tienes, dilo y ofrece buscarlo. No adivines el período: si no lo indican, usa
  el MES en curso y acláralo.

CÓMO TRABAJAS (eres un agente con herramientas)
· CRM local (ya sincronizado): query_sales, list_products, get_goal_progress, get_finance_summary.
· En vivo de Mercado Libre (cuenta conectada del usuario): ml_orders, ml_shipment,
  ml_questions, ml_listing, ml_messages.
· Acciones CRM (datos propios, ejecútalas directo): add_sale, delete_sale, add_product, edit_product,
  delete_product, manage_variant, list_pending_ml_sales, register_pending_ml_sale, ml_register_order,
  manage_task, save_memory, send_report.
· Acciones HACIA AFUERA de Mercado Libre (afectan clientes, confirm-gate): ml_answer_question,
  ml_update_listing, ml_send_message.
· Para cualquier dato, LLAMA a la herramienta; no respondas de memoria.
· VENTAS — cuál herramienta usar: query_sales = ventas REGISTRADAS en el CRM (el sync corre cada
  ~30 min, así que pueden ir un poco atrasadas). ml_orders = pedidos EN VIVO de Mercado Libre.
  Si el usuario pregunta por sus ventas REALES, ÚLTIMAS, RECIENTES o de HOY en Mercado Libre, o
  sospecha que falta una venta (aún sin sincronizar), USA ml_orders y aclara que son datos en vivo
  de ML.

PRODUCTOS, STOCK Y VARIANTES
· Para vender, primero ubica el producto con list_products (trae id, stock y variantes).
· VARIANTES (color/talla): si un producto las maneja, su stock vive POR VARIANTE. SIEMPRE pasa el
  variantId correcto en add_sale; NUNCA edites product.stock directo (usa manage_variant para ajustar
  el stock de una variante). Si no sabes la variante, pregúntale al usuario cuál (color/talla).
· Crear/editar/borrar variantes: manage_variant (add/edit/delete). add_product acepta variants[].
· Borrar producto: edit_product con archived:true lo OCULTA (reversible, conserva ventas). delete_product
  lo BORRA definitivo; si tiene ventas asociadas devuelve needsConfirm:true → muéstrale al usuario cuántas
  ventas tiene, pide confirmación y recién entonces llama delete_product con confirm:true.

REGISTRAR UNA VENTA DE ML QUE NO SE REGISTRÓ (el producto no existía cuando se vendió)
· Esa venta NO se perdió: la sincronización la dejó EN ESPERA porque no había un producto al cual
  asociarla. Está guardada con su FECHA REAL (aunque sea de ayer o días atrás), su comisión real y su
  envío real. El camino correcto es:
  1) list_pending_ml_sales → muéstrale al usuario las ventas en espera (título, precio, fecha).
  2) Si el producto NO existe en el CRM, créalo con add_product (pídele el COSTO real si no lo sabes).
  3) register_pending_ml_sale con el item_id de la pendiente y el id del producto → registra la venta con
     sus datos reales, descuenta stock y la saca de pendientes. (Es anti-duplicado.)
· Solo usa ml_register_order si la venta NO aparece en list_pending_ml_sales pero sí en ml_orders en vivo
  (p. ej. ocurrió después del último sync).

SEGURIDAD EN ACCIONES HACIA AFUERA (Mercado Libre)
· Responder a un comprador, modificar una publicación o enviar un mensaje afecta a CLIENTES
  REALES. Para estas acciones SIEMPRE: (1) muéstrale al usuario exactamente qué harás (el texto
  de la respuesta, el nuevo precio/stock, etc.), (2) pide confirmación explícita, (3) ejecútalo
  sólo cuando el usuario confirme en un mensaje posterior. NUNCA confirmes tú mismo.
· Las acciones sobre datos PROPIOS del CRM puedes ejecutarlas directo y confirmar con un resumen.

FORMATO
· Respuestas cortas; **negrita** para cifras clave; viñetas cuando ayuden.
· Si una herramienta no devuelve datos, dilo claro ("No tienes ventas registradas esta semana").`;

export function buildSystemPrompt({ nombre, meta, mlConectado, memoria, businessProfile, fechaHoy, hoyIso }) {
  const notas = (Array.isArray(memoria) && memoria.length) ? memoria.map(m => '  · ' + m).join('\n') : '  (sin notas todavía)';
  const perfil = (businessProfile && businessProfile.text) ? businessProfile.text : '(aún sin perfil; constrúyelo conociendo al usuario)';
  const ml = mlConectado === true ? 'conectado' : (mlConectado === false ? 'no conectado' : 'usa las herramientas ml_* para consultarlo (te avisan si no está conectado)');
  return PERSONA + `

FECHA Y HORA ACTUAL (REAL — úsala SIEMPRE; NUNCA inventes la fecha ni uses la de tu entrenamiento)
· Ahora es ${fechaHoy || hoyIso || '(desconocida)'} (hora de Chile).${hoyIso ? ' Hoy en ISO: ' + hoyIso + '.' : ''}
· "Hoy", "ayer", "esta semana" y "este mes" SIEMPRE se calculan a partir de esta fecha real, no de otra.

PERFIL DEL NEGOCIO (durable)
· ${perfil}

CONTEXTO DEL USUARIO
· Nombre: ${nombre || 'vendedor'} · Meta del mes: ${meta || 'sin meta'} · Mercado Libre: ${ml}
· Notas que recuerdas de este usuario:
${notas}
· El briefing del inicio es una foto de ese momento; para cifras exactas o actuales, usa las herramientas.`;
}

// ---- Dependencias inyectables (reales por defecto) ----
const deps = {
  getSvc: () => core.getSvc(),
  getGToken: (svc) => core.getGoogleAccessToken(svc),
  verifyToken: (idToken, projectId) => core.verifyFirebaseIdToken(idToken, projectId),
  checkRate: (...a) => core.checkRate(...a),
  resolveOwner: (...a) => store.resolveOwner(...a),
  makeAgent: defaultMakeAgent,
  getMlClient: defaultGetMlClient,
  sendReport: defaultSendReport,
  now: () => new Date(),
  nextId: () => Number(String(Date.now()) + String(Math.floor(Math.random() * 100)).padStart(2, '0')),
  mintToken: () => 'c_' + Math.random().toString(36).slice(2, 12),
  genThreadId: () => store.newThreadId(Date.now(), Math.random().toString(36).slice(2, 6))
};
export function configure(overrides) { Object.assign(deps, overrides); }

async function defaultMakeAgent(systemPrompt, tools) {
  const { createAgent } = await import('langchain');
  const { ChatOpenAI } = await import('@langchain/openai');
  const model = new ChatOpenAI({
    model: process.env.AI_MODEL || 'qwen/qwen-plus',
    apiKey: process.env.OPENROUTER_API_KEY,
    temperature: 0.2,
    configuration: {
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.APP_URL || 'https://nexsell.app',
        'X-Title': 'NexSell MIA'
      }
    }
  });
  return createAgent({ model, tools, systemPrompt });
}

async function defaultGetMlClient(svc, gtoken, uid) {
  const tk = await store.loadMlToken(svc, gtoken, uid);
  if (!tk) return null;
  return makeMlClient(tk, process.env.ML_CLIENT_ID, process.env.ML_CLIENT_SECRET);
}

async function defaultSendReport(svc, gtoken, uid, period, idToken) {
  // Reutiliza el handler real de send-report (verifica token, arma el HTML y
  // envía por Gmail SMTP) en vez de re-implementar nada. period: 'monthly'|'weekly'.
  const sr = require('../api/send-report.js');
  const r = await sr.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + idToken }, body: JSON.stringify({ period }) });
  const data = JSON.parse((r && r.body) || '{}');
  if (!data.ok) throw new Error(data.reason || 'send_report');
  return { sentTo: data.sentTo, count: data.count };
}

// ---- Utilidades ----
const ok = (obj) => ({ statusCode: 200, headers: jsonHeaders(), body: JSON.stringify({ ok: true, ...obj }) });
const fail = (status, reason, msg) => ({ statusCode: status, headers: jsonHeaders(), body: JSON.stringify({ ok: false, reason, ...(msg ? { msg } : {}) }) });
function jsonHeaders() {
  return { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
}
function bearer(event) {
  const h = (event && event.headers) || {};
  const a = h.authorization || h.Authorization || '';
  const m = String(a).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}
// Extrae status + mensaje de un error lanzado por el SDK de OpenAI/LangChain al
// llamar a OpenRouter. Sin esto, un 404/403/429 del proveedor quedaba escondido
// tras un genérico "server" y era imposible diagnosticar (p. ej. el clásico
// "No endpoints found for <modelo>" cuando el slug no tiene proveedor disponible).
function upstreamInfo(e) {
  const status = (e && (e.status || e.statusCode || (e.response && e.response.status))) || null;
  let detail = '';
  try {
    const raw = (e && (e.error || (e.response && e.response.data))) || null;
    if (raw) detail = (raw.error && raw.error.message) ? String(raw.error.message) : JSON.stringify(raw);
    else detail = (e && e.message) ? String(e.message) : '';
  } catch (_) { detail = (e && e.message) ? String(e.message) : ''; }
  return { status, detail: detail.slice(0, 300) };
}
function contentToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  return String(content == null ? '' : content);
}
// Texto de briefing determinista (sin LLM) para la primera respuesta de MIA.
function briefingText(state, profile, briefing) {
  const L = [];
  L.push('¡Hola! Soy **MIA**, tu copiloto de ventas. 👋');
  if (profile && profile.text) L.push('Lo que sé de tu negocio: ' + profile.text);
  const v = briefing.ventasHoy;
  if (v && v.count) L.push('Hoy llevas **' + v.count + '** venta(s) por **' + domain.fmtClp(v.revenue) + '** (' + domain.fmtClp(v.profit) + ' de ganancia).');
  else L.push('Aún no registras ventas hoy.');
  if (briefing.meta) {
    if (briefing.meta.cumplida) L.push('¡Ya **cumpliste tu meta** del mes! 🎉');
    else L.push('Vas en **' + Math.round(briefing.meta.pct) + '%** de tu meta del mes.');
  }
  if (briefing.preguntasMlSinResponder) L.push('Tienes **' + briefing.preguntasMlSinResponder + '** pregunta(s) sin responder en Mercado Libre.');
  if (briefing.bajoStock && briefing.bajoStock.count) L.push('**' + briefing.bajoStock.count + '** producto(s) bajo stock' + (briefing.bajoStock.productos.length ? ' (' + briefing.bajoStock.productos.join(', ') + ')' : '') + '.');
  L.push('_Esto es una foto de ahora; para cifras exactas pídemelas y las consulto._');
  return L.join('\n');
}

// ---- Entrada principal ----
export async function handle(event) {
  if (event.httpMethod && event.httpMethod !== 'POST') return fail(405, 'method');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return fail(400, 'bad_json'); }
  const op = body.op || 'send';

  const idToken = bearer(event);
  if (!idToken) return fail(401, 'no_token');

  let svc;
  try { svc = deps.getSvc(); } catch (e) { return fail(500, 'config'); }

  let payload;
  try { payload = await deps.verifyToken(idToken, svc.project_id); }
  catch (e) { return fail(401, 'bad_token'); }
  const uid = String(payload.sub);
  const email = payload.email ? String(payload.email).toLowerCase() : '';

  let gtoken;
  try { gtoken = await deps.getGToken(svc); } catch (e) { return fail(500, 'gtoken'); }

  // Rate-limit (best-effort) y resolución de dueño son independientes → en paralelo.
  let rateOk = true, isOwner = false;
  try {
    [rateOk, isOwner] = await Promise.all([
      deps.checkRate(svc, gtoken, 'ai_uid_' + uid, 60, 60 * 60 * 1000).catch(() => true),
      deps.resolveOwner(svc, gtoken, uid, email)
    ]);
  } catch (e) { isOwner = false; }
  if (!rateOk) return fail(429, 'rate', 'Vas muy rápido. Intenta en un momento.');
  const statePath = store.selectStatePath(uid, isOwner);

  // El doc de estado (por path) y el doc de IA (por uid) son lecturas independientes → en paralelo.
  let state, aiDoc;
  try {
    [state, aiDoc] = await Promise.all([
      store.loadState(svc, gtoken, statePath),
      store.loadAiDoc(svc, gtoken, uid)
    ]);
  } catch (e) {
    return fail(500, 'load');
  }

  try {
    if (op === 'list') return ok({ threads: aiDoc.threadIndex });
    if (op === 'get') {
      const th = aiDoc.threads[body.threadId];
      return ok({ messages: (th && th.messages) || [], threadId: body.threadId });
    }
    if (op === 'delete') {
      delete aiDoc.threads[body.threadId];
      aiDoc.threadIndex = aiDoc.threadIndex.filter(t => t.id !== body.threadId);
      await store.saveAiDoc(svc, gtoken, uid, aiDoc);
      return ok({ deleted: body.threadId });
    }
    if (op === 'open') return await opOpen({ svc, gtoken, uid, email, state, aiDoc });
    return await opSend({ svc, gtoken, uid, email, statePath, state, aiDoc, body, idToken });
  } catch (e) {
    const u = upstreamInfo(e);
    console.error('ai-agent op ' + op + ':', u.status ? ('upstream ' + u.status) : '', u.detail || (e && e.message) || e);
    // Errores del proveedor de IA (OpenRouter) traducidos a algo accionable en vez del genérico "server".
    if (u.status === 404 || /no endpoints? found/i.test(u.detail)) {
      return fail(502, 'model_unavailable', 'El modelo de IA no está disponible ahora mismo. Avísale al equipo (revisa AI_MODEL).');
    }
    if (u.status === 401 || u.status === 403) {
      return fail(502, 'upstream_auth', 'Hay un problema de configuración con el proveedor de IA.');
    }
    if (u.status === 429) {
      return fail(429, 'upstream_rate', 'El proveedor de IA está saturado. Intenta en un momento.');
    }
    return fail(500, 'server', 'Tuve un problema procesando eso. Intenta de nuevo.');
  }
}

// ---- op: open (briefing + perfil de negocio + sugerencias) ----
async function opOpen({ svc, gtoken, uid, email, state, aiDoc }) {
  let profileBuilt = false;
  if (!aiDoc.businessProfile || !aiDoc.businessProfile.text) {
    aiDoc.businessProfile = { ...domain.buildBusinessProfile(state), updatedAt: deps.now().toISOString() };
    profileBuilt = true;
  }

  // Preguntas ML sin responder (perezoso; null si no conectado o falla).
  let preguntas = null;
  try {
    const client = await deps.getMlClient(svc, gtoken, uid);
    if (client) {
      const data = await client.get('/questions/search?seller_id=' + client.state().userId + '&status=UNANSWERED');
      preguntas = ((data && data.questions) || []).length;
    }
  } catch (e) { preguntas = null; }

  const briefing = domain.computeBriefing(state, preguntas, deps.now());
  const reply = briefingText(state, aiDoc.businessProfile, briefing);
  const suggestions = domain.briefingSuggestions(briefing);

  const threadId = deps.genThreadId();
  const nowIso = deps.now().toISOString();
  createThread(aiDoc, { id: threadId, title: 'Nueva conversación', preview: reply.slice(0, 80), seedMessages: [{ role: 'assistant', content: reply }], briefingAt: nowIso, nowIso });
  pruneThreads(aiDoc);
  await store.saveAiDoc(svc, gtoken, uid, aiDoc);

  return ok({ threadId, reply, suggestions, profileBuilt });
}

// ---- op: send (un turno real del agente) ----
async function opSend({ svc, gtoken, uid, email, statePath, state, aiDoc, body, idToken }) {
  const message = String(body.message || '').trim();
  if (!message) return fail(400, 'no_message', 'Escríbeme algo para ayudarte.');

  let threadId = body.threadId;
  if (!threadId || !aiDoc.threads[threadId]) {
    threadId = deps.genThreadId();
    createThread(aiDoc, { id: threadId, title: message.slice(0, 40), preview: message.slice(0, 80), nowIso: deps.now().toISOString() });
  }
  const thread = aiDoc.threads[threadId];
  const currentTurn = (thread.turn || 0) + 1;

  // Contexto enlazado en el servidor para las herramientas.
  const ctx = {
    state,
    changed: new Set(),
    did: [],
    proposed: [],
    aiDoc,
    thread,
    currentTurn,
    now: deps.now,
    nextId: deps.nextId,
    nowIso: () => deps.now().toISOString(),
    today: () => deps.now().toISOString().slice(0, 10),
    time: () => deps.now().toISOString().slice(11, 16),
    mintToken: deps.mintToken,
    getClient: () => deps.getMlClient(svc, gtoken, uid),
    sendReport: (period) => deps.sendReport(svc, gtoken, uid, period, idToken)
  };

  const tools = [...buildCrmTools(ctx), ...buildMlTools(ctx)];
  // No probamos ML aquí: el cliente se construye perezosamente solo si una
  // herramienta ml_* lo usa (las herramientas avisan si no hay conexión).
  const _ahora = deps.now();
  let _fechaHoy = '';
  try { _fechaHoy = _ahora.toLocaleString('es-CL', { timeZone: 'America/Santiago', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { _fechaHoy = _ahora.toISOString(); }
  let _hoyIso = '';
  try { _hoyIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(_ahora); } catch (e) { _hoyIso = _ahora.toISOString().slice(0, 10); }
  const systemPrompt = buildSystemPrompt({
    nombre: (email && email.split('@')[0]) || 'vendedor',
    meta: domain.metaText(state && state.goals),
    memoria: aiDoc.memory,
    businessProfile: aiDoc.businessProfile,
    fechaHoy: _fechaHoy,
    hoyIso: _hoyIso
  });

  const agent = await deps.makeAgent(systemPrompt, tools);
  const prior = (thread.messages || []).slice(-MAX_MSGS_PER_THREAD).map(m => ({ role: m.role, content: m.content }));
  const result = await agent.invoke({ messages: [...prior, { role: 'user', content: message }] });
  const msgs = (result && result.messages) || [];
  const reply = contentToString(msgs.length ? msgs[msgs.length - 1].content : '') || 'Listo.';

  // Append del turno + actualización del índice.
  thread.messages.push({ role: 'user', content: message });
  thread.messages.push({ role: 'assistant', content: reply });
  if (thread.messages.length > MAX_MSGS_PER_THREAD * 2) thread.messages = thread.messages.slice(-MAX_MSGS_PER_THREAD * 2);
  thread.turn = currentTurn;
  const nowIso = deps.now().toISOString();
  const idx = aiDoc.threadIndex.find(t => t.id === threadId);
  if (idx) { idx.updatedAt = nowIso; idx.preview = reply.slice(0, 80); if (idx.title === 'Nueva conversación') idx.title = message.slice(0, 40); }

  // Persistencia de SOLO lo que cambió.
  if (ctx.changed.size) {
    try { await store.saveStateFields(svc, gtoken, statePath, state, [...ctx.changed]); }
    catch (e) { console.error('ai-agent saveState:', e && e.message); }
  }
  // Token ML refrescado durante el turno → persistir.
  try {
    const cl = ctx._client;
    if (cl && cl.state && cl.state().refreshed) await store.saveMlToken(svc, gtoken, uid, cl.state(), Date.now());
  } catch (e) { /* no romper la respuesta */ }

  pruneThreads(aiDoc);
  await store.saveAiDoc(svc, gtoken, uid, aiDoc);

  return ok({ reply, did: ctx.did, proposed: ctx.proposed, threadId });
}

// Crea un hilo nuevo (doc + entrada de índice) con la misma forma en open y send.
function createThread(aiDoc, { id, title, preview, seedMessages, briefingAt, nowIso }) {
  aiDoc.threads[id] = { messages: seedMessages || [], pendingConfirms: [], turn: 0, briefingAt: briefingAt || null };
  aiDoc.threadIndex.unshift({ id, title, createdAt: nowIso, updatedAt: nowIso, preview: preview || '' });
}

function pruneThreads(aiDoc) {
  if (aiDoc.threadIndex.length > MAX_THREADS) {
    const keep = aiDoc.threadIndex.slice(0, MAX_THREADS);
    const keepIds = new Set(keep.map(t => t.id));
    aiDoc.threadIndex = keep;
    for (const id of Object.keys(aiDoc.threads)) if (!keepIds.has(id)) delete aiDoc.threads[id];
  }
}
