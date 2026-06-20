// Live smoke (GATED): solo corre con OPENROUTER_API_KEY. Confirma que el modelo
// real hace tool-calling de verdad contra las herramientas del CRM. Sin clave,
// se SALTA (coherente con el ethos zero-dep / CI sin secretos).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goldenState, NOW } from './fixtures.mjs';
import { buildCrmTools } from '../tools.mjs';
import { emptyAiDoc } from '../store.mjs';

const HAS_KEY = !!process.env.OPENROUTER_API_KEY;

test('live smoke — el modelo real llama a una herramienta y aterriza la cifra', { skip: !HAS_KEY ? 'sin OPENROUTER_API_KEY' : false }, async () => {
  const { createAgent } = await import('langchain');
  const { ChatOpenAI } = await import('@langchain/openai');

  // Contexto con herramientas instrumentadas para registrar las llamadas.
  const called = [];
  let id = 9000;
  const ctx = {
    state: goldenState(), changed: new Set(), did: [], aiDoc: emptyAiDoc(),
    now: () => NOW, nextId: () => ++id, nowIso: () => NOW.toISOString(), today: () => '2026-06-20', time: () => '12:00'
  };
  const tools = buildCrmTools(ctx).map((t) => {
    const orig = t.invoke.bind(t);
    t.invoke = async (args, cfg) => { called.push(t.name); return orig(args, cfg); };
    return t;
  });

  const model = new ChatOpenAI({
    model: process.env.AI_MODEL || 'qwen/qwen-max',
    apiKey: process.env.OPENROUTER_API_KEY,
    temperature: 0,
    configuration: { baseURL: 'https://openrouter.ai/api/v1', defaultHeaders: { 'X-Title': 'NexSell MIA test' } }
  });
  const agent = createAgent({
    model, tools,
    systemPrompt: 'Eres MIA. Para CUALQUIER cifra usa una herramienta; nunca inventes. Responde en español, breve.'
  });

  const res = await agent.invoke({ messages: [{ role: 'user', content: '¿cuánta ganancia llevo este mes? Usa las herramientas.' }] });
  const msgs = res.messages || [];
  const last = msgs[msgs.length - 1];
  const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
  assert.ok(called.length > 0, 'el modelo debió llamar al menos una herramienta');
  assert.ok(text && text.length > 0, 'debe haber respuesta');
});
