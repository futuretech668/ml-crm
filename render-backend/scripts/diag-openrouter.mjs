// ============================================================================
// diag-openrouter.mjs — Diagnóstico aislado de la llamada a OpenRouter.
//
// Reproduce EXACTAMENTE la petición que hace MIA (mismo endpoint, modelo,
// headers y un payload mínimo CON tools) y muestra el status + cuerpo CRUDO
// que devuelve OpenRouter. Sirve para ver el motivo real de un 403/4xx en vez
// del genérico "server" que devuelve el backend.
//
// Uso (con la clave REAL de OpenRouter, la misma que está en Render):
//   OPENROUTER_API_KEY=sk-or-... node scripts/diag-openrouter.mjs
//   OPENROUTER_API_KEY=sk-or-... AI_MODEL=qwen/qwen-plus node scripts/diag-openrouter.mjs
// ============================================================================

const KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = process.env.AI_MODEL || 'qwen/qwen-max';
const APP_URL = process.env.APP_URL || 'https://nexsell.app';

if (!KEY || !KEY.startsWith('sk-or')) {
  console.error('✗ OPENROUTER_API_KEY ausente o placeholder. Exporta la clave REAL (sk-or-...).');
  process.exit(1);
}

// Payload mínimo PERO con tools (igual que el agente: createAgent envía tools).
const payload = {
  model: MODEL,
  temperature: 0.2,
  messages: [
    { role: 'system', content: 'Eres MIA, asistente de ventas. Responde en español, breve.' },
    { role: 'user', content: 'Hola, ¿estás ahí? Responde solo "sí".' }
  ],
  tools: [{
    type: 'function',
    function: {
      name: 'ping',
      description: 'Devuelve pong (herramienta de prueba)',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }]
};

async function call(label, headers) {
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  console.log(`\n=== ${label} ===`);
  console.log('status :', res.status, res.statusText, `(${Date.now() - t0}ms)`);
  console.log('x-or-* :', JSON.stringify({
    metadata: res.headers.get('x-openrouter-metadata'),
    requestId: res.headers.get('x-request-id')
  }));
  console.log('body   :', text.slice(0, 900));
  return res.status;
}

console.log('Modelo  :', MODEL);
console.log('Clave   :', KEY.slice(0, 10) + '… (len ' + KEY.length + ')');

// 1) Igual que el backend (con HTTP-Referer / X-Title) y pidiendo metadata para ver guardrails.
await call('CON tools + headers de app', {
  'Authorization': 'Bearer ' + KEY,
  'Content-Type': 'application/json',
  'HTTP-Referer': APP_URL,
  'X-Title': 'NexSell MIA',
  'X-OpenRouter-Metadata': 'enabled'
});

// 2) Sin tools, para aislar si el 403/4xx depende del tool-calling del modelo.
const noTools = { ...payload }; delete noTools.tools;
await (async () => {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(noTools)
  });
  const text = await res.text();
  console.log('\n=== SIN tools (mínimo) ===');
  console.log('status :', res.status, res.statusText);
  console.log('body   :', text.slice(0, 900));
})();

// 3) Lista de modelos: confirma que la clave puede al menos autenticarse.
await (async () => {
  const res = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { 'Authorization': 'Bearer ' + KEY }
  });
  console.log('\n=== GET /key (estado de la clave) ===');
  console.log('status :', res.status);
  console.log('body   :', (await res.text()).slice(0, 500));
})();
