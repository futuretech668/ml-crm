// Arnés de pruebas para agent.mjs: configura dependencias inyectadas (Firestore
// en memoria vía fsmock, verificador de token falso, modelo "cerebro" scriptable)
// para ejercitar el orquestador completo sin red ni claves.

import * as agent from '../agent.mjs';
import { makeFirestore, FAKE_SVC, installFetch } from './fsmock.mjs';

// Envuelve un "cerebro" (userMsg, byName, systemPrompt) => {reply} como agente LangChain.
function makeBrainAgent(systemPrompt, tools, brain) {
  const byName = {};
  for (const t of tools) byName[t.name] = t;
  return {
    invoke: async ({ messages }) => {
      const last = messages[messages.length - 1];
      const out = await brain(String(last.content), byName, systemPrompt);
      const reply = (out && typeof out === 'object') ? out.reply : out;
      return { messages: [...messages, { role: 'assistant', content: reply }] };
    }
  };
}

// initialDb: mapa 'col/doc' -> objeto. brain: cerebro scriptable. mlClient: cliente ML falso o null.
export function setupAgent({ initialDb, brain, mlClient, now }) {
  const fs = makeFirestore(initialDb || {});
  const restore = installFetch(fs.fetchStub);
  let idc = 5000, toks = 0, threads = 0;
  const fixedNow = now || new Date('2026-06-20T12:00:00.000Z');

  agent.configure({
    getSvc: () => FAKE_SVC,
    getGToken: async () => 'gtoken-test',
    verifyToken: async (idToken) => {
      if (idToken === 'BAD') throw new Error('bad token');
      if (idToken === 'OWNER') return { sub: 'OWNER_UID', email: 'futuretech.cl.668@gmail.com' };
      return { sub: 'uid1', email: 'vendedor@x.com' };
    },
    checkRate: async () => true,
    resolveOwner: async (svc, gt, uid, email) => email === 'futuretech.cl.668@gmail.com',
    getMlClient: async () => mlClient || null,
    sendReport: async () => ({ queued: true }),
    now: () => fixedNow,
    nextId: () => ++idc,
    mintToken: () => 'c_' + (++toks),
    genThreadId: () => 't_test_' + (++threads),
    makeAgent: async (sp, tools) => makeBrainAgent(sp, tools, brain || (async () => ({ reply: 'Listo.' })))
  });

  return { fs, restore, FAKE_SVC };
}

// Construye un `event` POST como el que arma server.js.
export function postEvent(bodyObj, idToken) {
  return {
    httpMethod: 'POST',
    headers: idToken ? { authorization: 'Bearer ' + idToken } : {},
    body: JSON.stringify(bodyObj)
  };
}

export async function call(bodyObj, idToken) {
  const r = await agent.handle(postEvent(bodyObj, idToken));
  return { status: r.statusCode, json: JSON.parse(r.body) };
}
