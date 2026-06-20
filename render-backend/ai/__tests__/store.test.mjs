import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goldenState } from './fixtures.mjs';
import { makeFirestore, FAKE_SVC, installFetch } from './fsmock.mjs';
import * as store from '../store.mjs';

const GT = 'gtoken-test';

test('selectStatePath — dueño vs usuario', () => {
  assert.equal(store.selectStatePath('uid1', true), 'crm/state');
  assert.equal(store.selectStatePath('uid1', false), 'crm_users/uid1');
});

test('resolveOwner — por email y por crm_accounts', async () => {
  const fs = makeFirestore({
    'crm_accounts/futuretech_cl_668_gmail_com': { uid: 'OWNER_UID', email: 'futuretech.cl.668@gmail.com' }
  });
  const restore = installFetch(fs.fetchStub);
  try {
    assert.equal(await store.resolveOwner(FAKE_SVC, GT, 'whatever', 'futuretech.cl.668@gmail.com'), true);
    assert.equal(await store.resolveOwner(FAKE_SVC, GT, 'OWNER_UID', 'other@x.com'), true);
    assert.equal(await store.resolveOwner(FAKE_SVC, GT, 'someoneelse', 'other@x.com'), false);
  } finally { restore(); }
});

test('loadState — devuelve el doc decodificado', async () => {
  const fs = makeFirestore({ 'crm_users/uid1': goldenState() });
  const restore = installFetch(fs.fetchStub);
  try {
    const st = await store.loadState(FAKE_SVC, GT, 'crm_users/uid1');
    assert.equal(st.sales.length, 3);
    assert.equal(st.products[0].name, 'Audífonos Pro');
  } finally { restore(); }
});

test('saveStateFields — PATCH con máscara no clobberea otros campos', async () => {
  const fs = makeFirestore({ 'crm_users/uid1': goldenState() });
  const restore = installFetch(fs.fetchStub);
  try {
    const st = await store.loadState(FAKE_SVC, GT, 'crm_users/uid1');
    st.sales.push({ id: 999, date: '2026-06-21', quantity: 1, totalPrice: 1000, profit: 500 });
    await store.saveStateFields(FAKE_SVC, GT, 'crm_users/uid1', st, ['sales']);
    // products/goals siguen intactos; sales creció.
    assert.equal(fs.db['crm_users/uid1'].sales.length, 4);
    assert.equal(fs.db['crm_users/uid1'].products.length, 3);
    assert.ok(fs.db['crm_users/uid1'].goals);
    // Se usó updateMask para 'sales'.
    const patch = fs.calls.find(c => c.method === 'PATCH');
    assert.ok(patch.url.includes('updateMask.fieldPaths=sales'));
  } finally { restore(); }
});

test('loadAiDoc — normaliza doc vacío', async () => {
  const fs = makeFirestore({});
  const restore = installFetch(fs.fetchStub);
  try {
    const doc = await store.loadAiDoc(FAKE_SVC, GT, 'uid1');
    assert.deepEqual(doc.memory, []);
    assert.deepEqual(doc.threadIndex, []);
    assert.deepEqual(doc.threads, {});
    assert.equal(doc.businessProfile, null);
  } finally { restore(); }
});

test('saveAiDoc + loadAiDoc — round-trip de memoria e hilos', async () => {
  const fs = makeFirestore({});
  const restore = installFetch(fs.fetchStub);
  try {
    const doc = store.emptyAiDoc();
    doc.memory.push('Vende principalmente audífonos.');
    doc.businessProfile = { text: 'Perfil', updatedAt: '2026-06-20T00:00:00Z' };
    const tid = store.newThreadId(1750000000000, 'abcd');
    doc.threads[tid] = { messages: [{ role: 'user', content: 'hola' }], pendingConfirms: [], briefingAt: null };
    doc.threadIndex.push({ id: tid, title: 'hola', createdAt: 'x', updatedAt: 'x', preview: 'hola' });
    await store.saveAiDoc(FAKE_SVC, GT, 'uid1', doc);

    const loaded = await store.loadAiDoc(FAKE_SVC, GT, 'uid1');
    assert.equal(loaded.memory[0], 'Vende principalmente audífonos.');
    assert.equal(loaded.businessProfile.text, 'Perfil');
    assert.equal(loaded.threads[tid].messages[0].content, 'hola');
    assert.equal(loaded.threadIndex[0].id, 't_1750000000000_abcd');
  } finally { restore(); }
});

test('loadMlToken — null si no hay token válido', async () => {
  const fs = makeFirestore({ 'crm_ml_tokens/uid1': { access_token: '', ml_user_id: '' } });
  const restore = installFetch(fs.fetchStub);
  try {
    assert.equal(await store.loadMlToken(FAKE_SVC, GT, 'uid1'), null);
  } finally { restore(); }
});

test('saveMlToken — solo toca campos del token, no processedOrders', async () => {
  const fs = makeFirestore({ 'crm_ml_tokens/uid1': { access_token: 'old', refresh_token: 'r', expires_at: 1, ml_user_id: '123', processedOrders: ['a', 'b'] } });
  const restore = installFetch(fs.fetchStub);
  try {
    await store.saveMlToken(FAKE_SVC, GT, 'uid1', { access: 'new', refresh: 'r2', expiresAt: 999 }, 1750000000000);
    const tk = fs.db['crm_ml_tokens/uid1'];
    assert.equal(tk.access_token, 'new');
    assert.equal(tk.refresh_token, 'r2');
    assert.equal(tk.expires_at, 999);
    assert.deepEqual(tk.processedOrders, ['a', 'b']); // intacto
    assert.equal(tk.ml_user_id, '123'); // intacto
  } finally { restore(); }
});
