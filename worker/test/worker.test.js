import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { encrypt, decrypt } from '../src/index.js';
import { mockTeller, checking } from './fixtures.js';

const ORIGIN = 'https://montzi.github.io';
const kv = () => { const m = new Map(); return { m,
  get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k),
  list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) }; };
const mkEnv = (over = {}, teller = mockTeller()) => ({
  BT_KV: kv(), TELLER_ENV: 'sandbox', TELLER_APP_ID: 'app_test', ALLOWED_ORIGIN: ORIGIN,
  ENC_KEY: Buffer.alloc(32, 7).toString('base64'), TELLER_CERT: { fetch: teller }, _teller: teller, ...over });
const call = (env, method, path, { key, body, origin = ORIGIN } = {}) => worker.fetch(new Request('https://w.test' + path, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { Origin: origin, ...(key ? { Authorization: 'Bearer ' + key } : {}) } }), env);
async function paired(env = mkEnv()) { const { key } = await (await call(env, 'POST', '/pair')).json(); return { env, key }; }
const enrollGood = (env, key) => call(env, 'POST', '/enroll', { key, body: { accessToken: 'tok_good', enrollmentId: 'enr_1', institution: { name: 'Chase' } } });

test('encryption round trip; ciphertext differs and hides plaintext', async () => {
  const env = mkEnv(); const a = await encrypt(env, 'tok_secret'), b = await encrypt(env, 'tok_secret');
  assert.notEqual(a, b); assert.ok(!a.includes('tok_secret')); assert.equal(await decrypt(env, a), 'tok_secret');
  await assert.rejects(decrypt(mkEnv({ ENC_KEY: Buffer.alloc(32, 9).toString('base64') }), a));
});

test('config is public and reports paired state', async () => {
  const env = mkEnv();
  assert.deepEqual(await (await call(env, 'GET', '/config')).json(), { tellerAppId: 'app_test', tellerEnv: 'sandbox', paired: false });
  await paired(env);
  assert.equal((await (await call(env, 'GET', '/config')).json()).paired, true);
});

test('pair once, stores only a hash, second pair 409', async () => {
  const env = mkEnv(); const r = await call(env, 'POST', '/pair'); const { key } = await r.json();
  assert.equal(r.status, 200); assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(![...env.BT_KV.m.values()].some((v) => v.includes(key)));
  assert.equal((await call(env, 'POST', '/pair')).status, 409);
});

test('auth rejection: missing, wrong key, unpaired', async () => {
  const { env, key } = await paired();
  for (const p of ['/accounts', '/sync']) {
    assert.equal((await call(env, 'GET', p)).status, 401);
    assert.equal((await call(env, 'GET', p, { key: 'x'.repeat(64) })).status, 401);
  }
  assert.equal((await call(mkEnv(), 'GET', '/accounts', { key })).status, 401);
  assert.equal((await call(env, 'GET', '/accounts', { key })).status, 200);
});

test('enroll stores encrypted token and returns accounts; bad token rejected', async () => {
  const { env, key } = await paired();
  const r = await enrollGood(env, key); const b = await r.json();
  assert.equal(r.status, 200); assert.equal(b.accounts.length, 2);
  assert.deepEqual(b.accounts[0], { id: 'acc_chk', name: 'Everyday Checking', type: 'depository', subtype: 'checking', last_four: '1234', institution: 'Chase' });
  assert.ok(!env.BT_KV.m.get('enr:enr_1').includes('tok_good'));
  const bad = await call(env, 'POST', '/enroll', { key, body: { accessToken: 'nope', enrollmentId: 'enr_2' } });
  assert.equal(bad.status, 502); assert.equal(env.BT_KV.m.has('enr:enr_2'), false);
  assert.equal((await call(env, 'POST', '/enroll', { key, body: {} })).status, 400);
});

test('accounts flags disconnected enrollments instead of throwing', async () => {
  const t = mockTeller({ tokens: { tok_good: { accounts: [checking], txns: {} }, tok_dead: { disconnected: true } } });
  const { env, key } = await paired(mkEnv({}, t));
  await enrollGood(env, key);
  await env.BT_KV.put('enr:enr_dead', JSON.stringify({ token: await encrypt(env, 'tok_dead'), institution: 'Dead Bank' }));
  const r = await call(env, 'GET', '/accounts', { key }); assert.equal(r.status, 200);
  const { enrollments } = await r.json(); const dead = enrollments.find((e) => e.id === 'enr_dead');
  assert.equal(dead.needsReconnect, true); assert.equal(enrollments.find((e) => e.id === 'enr_1').accounts[0].enabled, true);
});

test('sync normalizes sign conventions and fields', async () => {
  const { env, key } = await paired(); await enrollGood(env, key);
  const r = await call(env, 'GET', '/sync?since=2026-11-01', { key }); const b = await r.json();
  assert.equal(r.status, 200); assert.deepEqual(b.errors, []); assert.ok(b.syncedAt);
  const by = Object.fromEntries(b.txns.map((t) => [t.id, t]));
  assert.equal(by['tl:txn_old'], undefined, 'older than since is dropped');
  assert.equal(by['tl:txn_pay'].amount, -2450);          // payroll deposit: money in => negative
  assert.equal(by['tl:txn_pp'].amount, 11.99);           // PayPal debit on checking => positive
  assert.equal(by['tl:txn_pend'].amount, 52.1); assert.equal(by['tl:txn_pend'].status, 'pending');
  assert.equal(by['tl:txn_kl'].amount, 45);              // credit purchase (positive in Teller) => positive
  assert.equal(by['tl:txn_ccpay'].amount, -300);         // card payment => money in => negative
  assert.deepEqual(by['tl:txn_kl'], { id: 'tl:txn_kl', date: '2026-11-13', desc: 'KLARNA*PAYMENT', amount: 45,
    account: { id: 'acc_cc', name: 'Sapphire Card', last4: '9876', institution: 'Chase', type: 'credit' },
    status: 'posted', counterparty: 'Klarna', tellerCategory: 'shopping' });
  assert.equal(b.txns[0].date >= b.txns.at(-1).date, true);
});

test('sync paginates with from_id and stops at since; skips toggled-off accounts', async () => {
  const many = Array.from({ length: 130 }, (_, i) => ({ id: 'n' + i, account_id: 'acc_chk', date: i < 120 ? '2026-11-10' : '2026-01-01',
    description: 'x' + i, amount: '-1.00', status: 'posted', type: 'card_payment', details: {} }));
  const t = mockTeller({ tokens: { tok_good: { accounts: [checking], txns: { acc_chk: many } } } });
  const { env, key } = await paired(mkEnv({}, t)); await enrollGood(env, key);
  const all = await (await call(env, 'GET', '/sync?since=2026-01-01', { key })).json(); assert.equal(all.txns.length, 130);
  assert.ok(t.calls.some((c) => c.path.includes('from_id=n99')));
  const some = await (await call(env, 'GET', '/sync?since=2026-11-01', { key })).json(); assert.equal(some.txns.length, 120);
  assert.equal((await call(env, 'GET', '/sync?since=bogus', { key })).status, 400);
  await call(env, 'POST', '/accounts/acc_chk/toggle', { key, body: { enabled: false } });
  assert.equal((await (await call(env, 'GET', '/sync', { key })).json()).txns.length, 0);
});

test('sync reports per-enrollment errors without failing', async () => {
  const t2 = mockTeller({ tokens: { tok_good: { accounts: [checking], txns: { acc_chk: [] } }, tok_dead: { disconnected: true } } });
  const { env, key } = await paired(mkEnv({}, t2)); await enrollGood(env, key);
  await env.BT_KV.put('enr:enr_dead', JSON.stringify({ token: await encrypt(env, 'tok_dead'), institution: 'Dead Bank' }));
  const b = await (await call(env, 'GET', '/sync', { key })).json();
  assert.equal(b.errors.length, 1); assert.equal(b.errors[0].enrollmentId, 'enr_dead'); assert.equal(b.errors[0].institution, 'Dead Bank');
});

test('DELETE /enroll calls Teller delete and removes KV record', async () => {
  const { env, key } = await paired(); await enrollGood(env, key);
  const r = await call(env, 'DELETE', '/enroll/enr_1', { key }); assert.equal(r.status, 200);
  assert.equal(env.BT_KV.m.has('enr:enr_1'), false);
  assert.equal(env._teller.calls.filter((c) => c.method === 'DELETE').length, 2);
  assert.equal((await call(env, 'DELETE', '/enroll/enr_1', { key })).status, 404);
});

test('CORS: allowed origin, preflight, foreign origin, localhost only in sandbox', async () => {
  const env = mkEnv();
  const ok = await call(env, 'GET', '/config'); assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const pre = await call(env, 'OPTIONS', '/sync'); assert.equal(pre.status, 204);
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.equal((await call(env, 'OPTIONS', '/sync', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(env, 'GET', '/config', { origin: 'https://evil.example' })).headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await call(env, 'GET', '/config', { origin: 'http://localhost:8080' })).headers.get('Access-Control-Allow-Origin'), 'http://localhost:8080');
  const prod = mkEnv({ TELLER_ENV: 'production' });
  assert.equal((await call(prod, 'GET', '/config', { origin: 'http://localhost:8080' })).headers.get('Access-Control-Allow-Origin'), null);
});

test('falls back to global fetch when TELLER_CERT binding is absent; basic auth header shape', async () => {
  const t = mockTeller(); const orig = globalThis.fetch; globalThis.fetch = t;
  try {
    const { env, key } = await paired(mkEnv({ TELLER_CERT: undefined }));
    assert.equal((await enrollGood(env, key)).status, 200);
    assert.equal(t.calls[0].tok, 'tok_good');
  } finally { globalThis.fetch = orig; }
});
