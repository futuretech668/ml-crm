import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goldenState } from './fixtures.mjs';
import { setupAgent, call } from './harness.mjs';

const TOKEN = 'USERTOK';

function userDb() { return { 'crm_users/uid1': goldenState() }; }

// Cliente ML falso para los tests que lo necesitan.
function fakeMl(opts) {
  opts = opts || {};
  const calls = [];
  return {
    _calls: calls,
    state: () => ({ userId: '123', refreshed: !!opts.refreshed }),
    async get(ep) { calls.push({ m: 'GET', ep }); return opts.get ? opts.get(ep) : null; },
    async request(method, ep, body) { calls.push({ m: method, ep, body }); return {}; },
    async fetchOrders() { return opts.orders || []; }
  };
}

test('auth — sin token 401, token inválido 401', async () => {
  const { restore } = setupAgent({ initialDb: userDb() });
  try {
    const a = await call({ op: 'send', message: 'hola' }, null);
    assert.equal(a.status, 401);
    assert.equal(a.json.reason, 'no_token');
    const b = await call({ op: 'send', message: 'hola' }, 'BAD');
    assert.equal(b.status, 401);
    assert.equal(b.json.reason, 'bad_token');
  } finally { restore(); }
});

test('op:open — briefing grounded + sugerencias + perfil persistido', async () => {
  const { fs, restore } = setupAgent({ initialDb: userDb() });
  try {
    const r = await call({ op: 'open' }, TOKEN);
    assert.equal(r.status, 200);
    assert.ok(r.json.threadId);
    assert.ok(/MIA/.test(r.json.reply));
    assert.ok(r.json.reply.includes('$50.000')); // ventas de hoy del fixture
    assert.ok(Array.isArray(r.json.suggestions) && r.json.suggestions.length >= 1);
    assert.equal(r.json.profileBuilt, true);
    // businessProfile + threadIndex persistidos en crm_ai/uid1.
    const ai = fs.db['crm_ai/uid1'];
    assert.ok(ai.businessProfile.text);
    assert.equal(ai.threadIndex.length, 1);
    assert.ok(ai.threads[r.json.threadId].messages.length === 1);
  } finally { restore(); }
});

test('op:send — pregunta de lectura enruta a query_sales y aterriza la cifra', async () => {
  const brain = async (msg, byName) => {
    const r = JSON.parse(await byName.query_sales.invoke({ period: 'semana' }));
    return { reply: 'Esta semana llevas ' + r.totales.profit + ' de ganancia.' };
  };
  const { fs, restore } = setupAgent({ initialDb: userDb(), brain });
  try {
    const r = await call({ op: 'send', message: '¿cuánto gané esta semana?' }, TOKEN);
    assert.equal(r.status, 200);
    assert.ok(r.json.reply.includes('21000')); // venta de hoy (en semana en curso)
    assert.ok(r.json.threadId);
    // El hilo quedó persistido con el turno.
    const th = fs.db['crm_ai/uid1'].threads[r.json.threadId];
    assert.equal(th.messages.length, 2); // user + assistant
    assert.equal(th.turn, 1);
  } finally { restore(); }
});

test('op:send — add_sale escribe en el doc de estado y descuenta stock', async () => {
  const brain = async (msg, byName) => {
    const r = JSON.parse(await byName.add_sale.invoke({ productId: 2, quantity: 1 }));
    return { reply: 'Registré la venta #' + r.sale.id + '.' };
  };
  const { fs, restore } = setupAgent({ initialDb: userDb(), brain });
  try {
    const r = await call({ op: 'send', message: 'agrega una venta del producto 2' }, TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.json.did[0].action, 'add_sale');
    const st = fs.db['crm_users/uid1'];
    assert.equal(st.sales.length, 4); // 3 + 1
    assert.equal(st.products.find(p => p.id === 2).stock, 2); // 3 - 1
  } finally { restore(); }
});

test('op:send — ml_questions sin conexión devuelve "no conectado"', async () => {
  const brain = async (msg, byName) => {
    const r = JSON.parse(await byName.ml_questions.invoke({}));
    return { reply: r.error === 'no_conectado' ? 'No estás conectado a Mercado Libre.' : 'ok' };
  };
  const { restore } = setupAgent({ initialDb: userDb(), brain, mlClient: null });
  try {
    const r = await call({ op: 'send', message: '¿qué preguntas tengo?' }, TOKEN);
    assert.ok(/no estás conectado/i.test(r.json.reply));
  } finally { restore(); }
});

test('confirm-gate end-to-end — propone en un turno, ejecuta en el siguiente', async () => {
  const ml = fakeMl({});
  // Turno 1: propone (sin token). Turno 2: ejecuta (con el token del proposed).
  let captured = null;
  const brain = async (msg, byName) => {
    if (msg.includes('CONFIRMA')) {
      const r = JSON.parse(await byName.ml_answer_question.invoke({ questionId: '101', text: 'Sí, hay stock.', confirmToken: captured }));
      return { reply: r.ok ? 'Respondí la pregunta.' : 'Vuelvo a proponer.' };
    }
    const r = JSON.parse(await byName.ml_answer_question.invoke({ questionId: '101', text: 'Sí, hay stock.' }));
    return { reply: 'Propongo responder: "' + r.preview.text + '". ¿Confirmas?' };
  };
  const { restore } = setupAgent({ initialDb: userDb(), brain, mlClient: ml });
  try {
    const r1 = await call({ op: 'send', message: 'responde la pregunta 101' }, TOKEN);
    assert.equal(r1.json.proposed.length, 1);
    captured = r1.json.proposed[0].token;
    assert.equal(ml._calls.filter(c => c.m === 'POST').length, 0); // aún no ejecuta

    const r2 = await call({ op: 'send', message: 'CONFIRMA', threadId: r1.json.threadId }, TOKEN);
    assert.ok(/respondí/i.test(r2.json.reply));
    assert.equal(r2.json.did[0].action, 'ml_answer_question');
    assert.equal(ml._calls.filter(c => c.m === 'POST' && c.ep === '/answers').length, 1);
  } finally { restore(); }
});

test('scoping — el dueño usa crm/state; el modelo no puede suplantar uid', async () => {
  const db = { 'crm/state': goldenState(), 'crm_users/uid1': { sales: [], products: [] } };
  const brain = async (msg, byName) => {
    const r = JSON.parse(await byName.query_sales.invoke({ period: 'total' }));
    return { reply: 'Ventas totales: ' + r.totales.count };
  };
  const { fs, restore } = setupAgent({ initialDb: db, brain });
  try {
    const r = await call({ op: 'send', message: 'cuántas ventas tengo' }, 'OWNER');
    assert.ok(r.json.reply.includes('3')); // crm/state tiene 3 ventas
    assert.ok(fs.calls.some(c => c.method === 'GET' && c.path === 'crm/state'));
  } finally { restore(); }
});

test('history ops — list, get, delete', async () => {
  const { restore } = setupAgent({ initialDb: userDb() });
  try {
    const opened = await call({ op: 'open' }, TOKEN);
    const tid = opened.json.threadId;
    const list = await call({ op: 'list' }, TOKEN);
    assert.equal(list.json.threads.length, 1);
    assert.equal(list.json.threads[0].id, tid);
    const got = await call({ op: 'get', threadId: tid }, TOKEN);
    assert.equal(got.json.messages.length, 1);
    const del = await call({ op: 'delete', threadId: tid }, TOKEN);
    assert.equal(del.json.deleted, tid);
    const list2 = await call({ op: 'list' }, TOKEN);
    assert.equal(list2.json.threads.length, 0);
  } finally { restore(); }
});

test('contrato — bad_json (400) y no_message (400) con la forma de error documentada', async () => {
  const { restore } = setupAgent({ initialDb: userDb() });
  try {
    // body no parseable → 400 bad_json (el harness arma el event; mandamos un body roto a mano).
    const ev = { httpMethod: 'POST', headers: { authorization: 'Bearer ' + TOKEN }, body: '{no es json' };
    const agent = await import('../agent.mjs');
    const r1 = await agent.handle(ev);
    const j1 = JSON.parse(r1.body);
    assert.equal(r1.statusCode, 400);
    assert.equal(j1.reason, 'bad_json');
    assert.equal(j1.ok, false);
    // send sin message → 400 no_message.
    const r2 = await call({ op: 'send', message: '   ' }, TOKEN);
    assert.equal(r2.status, 400);
    assert.equal(r2.json.reason, 'no_message');
  } finally { restore(); }
});

test('contrato — get de un hilo inexistente devuelve messages: [] (no rompe)', async () => {
  const { restore } = setupAgent({ initialDb: userDb() });
  try {
    const r = await call({ op: 'get', threadId: 't_no_existe' }, TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.ok(Array.isArray(r.json.messages));
    assert.equal(r.json.messages.length, 0);
    assert.equal(r.json.threadId, 't_no_existe');
  } finally { restore(); }
});

test('contrato — método GET (no POST) en handle() es 405 method', async () => {
  const { restore } = setupAgent({ initialDb: userDb() });
  try {
    const agent = await import('../agent.mjs');
    const r = await agent.handle({ httpMethod: 'GET', headers: {}, body: '' });
    assert.equal(r.statusCode, 405);
    assert.equal(JSON.parse(r.body).reason, 'method');
  } finally { restore(); }
});

test('op:send — merge anti-clobber: no pisa una venta que el cron agrega a mitad de turno', async () => {
  let fsRef = null;
  // El cerebro agrega una venta local Y simula que el cron escribió OTRA venta en el
  // doc remoto entre la carga del turno y el guardado (race real cron↔MIA).
  const brain = async (msg, byName) => {
    await byName.add_sale.invoke({ productId: 2, quantity: 1 });
    fsRef.db['crm_users/uid1'].sales = [
      ...fsRef.db['crm_users/uid1'].sales,
      { id: 999001, date: '2026-06-20', time: '11:30', productId: 1, productName: 'Audífonos Pro',
        quantity: 1, salePrice: 25000, costPrice: 10000, commission: 2500, shipping: 2000,
        totalPrice: 25000, profit: 10500, source: 'mercadolibre', item_id: 'MLC999', order_id: '999' }
    ];
    return { reply: 'venta agregada' };
  };
  const { fs, restore } = setupAgent({ initialDb: userDb(), brain });
  fsRef = fs;
  try {
    const r = await call({ op: 'send', message: 'agrega una venta del producto 2' }, TOKEN);
    assert.equal(r.status, 200);
    const st = fs.db['crm_users/uid1'];
    // 3 originales + 1 del cron concurrente + 1 de MIA = 5 (la del cron NO se pierde).
    assert.equal(st.sales.length, 5);
    assert.ok(st.sales.some(s => s.id === 999001), 'la venta del cron debe sobrevivir al guardado de MIA');
    assert.ok(st.sales.some(s => s.productId === 2 && s.source !== 'mercadolibre'), 'la venta de MIA también se guarda');
  } finally { restore(); }
});

test('op:send — merge anti-clobber: delete_sale NO resucita la venta borrada', async () => {
  let fsRef = null;
  // El usuario borra la venta 101 vía MIA; el doc remoto todavía la tiene (no debe volver).
  const brain = async (msg, byName) => {
    await byName.delete_sale.invoke({ id: 101 });
    return { reply: 'venta borrada' };
  };
  const { fs, restore } = setupAgent({ initialDb: userDb(), brain });
  fsRef = fs;
  try {
    const r = await call({ op: 'send', message: 'borra la venta 101' }, TOKEN);
    assert.equal(r.status, 200);
    const st = fs.db['crm_users/uid1'];
    assert.ok(!st.sales.some(s => s.id === 101), 'la venta borrada no debe reaparecer por el merge');
    assert.equal(st.sales.length, 2); // 3 - 1
  } finally { restore(); }
});

test('save_memory — se persiste y aparece en la siguiente apertura de perfil', async () => {
  const brain = async (msg, byName) => {
    await byName.save_memory.invoke({ note: 'Vende sobre todo en diciembre.' });
    return { reply: 'Anotado.' };
  };
  const { fs, restore } = setupAgent({ initialDb: userDb(), brain });
  try {
    await call({ op: 'send', message: 'recuerda que vendo más en diciembre' }, TOKEN);
    assert.equal(fs.db['crm_ai/uid1'].memory[0], 'Vende sobre todo en diciembre.');
  } finally { restore(); }
});
