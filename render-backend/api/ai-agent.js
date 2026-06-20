// ============================================================================
// ai-agent  —  Handler CJS delgado del copiloto MIA. Auto-ruteado por server.js
// como /api/ai-agent. Hace el guard de método/CORS y delega en el agente ESM
// (LangChain v1) con import() dinámico. Mantiene server.js intacto.
//
// Variables de entorno: OPENROUTER_API_KEY, AI_MODEL (opcional),
//   FIREBASE_SERVICE_ACCOUNT, ML_CLIENT_ID, ML_CLIENT_SECRET, OWNER_EMAIL, APP_URL.
//
// /api/ai-proxy (visión) queda intacto: este handler es independiente.
// ============================================================================

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: Object.assign(cors(), { 'Content-Type': 'application/json; charset=utf-8' }), body: JSON.stringify({ ok: false, reason: 'method' }) };
  }
  try {
    const agent = await import('../ai/agent.mjs');
    const r = await agent.handle(event);
    return { statusCode: r.statusCode, headers: Object.assign(cors(), r.headers || {}), body: r.body };
  } catch (e) {
    console.error('ai-agent:', e && e.message ? e.message : e);
    return { statusCode: 500, headers: Object.assign(cors(), { 'Content-Type': 'application/json; charset=utf-8' }), body: JSON.stringify({ ok: false, reason: 'server' }) };
  }
};
