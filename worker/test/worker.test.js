import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { encrypt, decrypt, mapCategory } from '../src/index.js';
import { mockPlaid, checking, card, checkingTxns, cardTxns, tx } from './fixtures.js';

const ORIGIN = 'https://montzi.github.io';
const kv = () => { const m = new Map(); return { m,
  get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k),
  list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) }; };
const mkEnv = (over = {}) => ({
  BT_KV: kv(), PLAID_ENV: 'sandbox', PLAID_CLIENT_ID: 'cid_test', PLAID_SECRET: 'sec_test', ALLOWED_ORIGIN: ORIGIN,
  ENC_KEY: Buffer.alloc(32, 7).toString('base64'), ...over });
const call = (env, method, path, { key, body, origin = ORIGIN } = {}) => worker.fetch(new Request('https://w.test' + path, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { Origin: origin, ...(key ? { Authorization: 'Bearer ' + key } : {}) } }), env);

// Every test that touches Plaid installs a mock as global fetch and restores it afterwards.
async function withPlaid(plaid, fn) {
  const orig = globalThis.fetch; globalThis.fetch = plaid;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}
async function paired(env = mkEnv()) { const { key } = await (await call(env, 'POST', '/pair')).json(); return { env, key }; }
const enrollGood = (env, key, pub = 'public-good') => call(env, 'POST', '/enroll', { key, body: { publicToken: pub, institution: { name: 'Chase' } } });
const syncCalls = (p) => p.calls.filter((c) => c.path === '/transactions/sync');
const sync = async (env, key, q = '') => (await call(env, 'GET', '/sync' + q, { key })).json();
const getItem = (env, id = 'item_1') => JSON.parse(env.BT_KV.m.get('item:' + id));

test('encryption round trip; ciphertext differs and hides plaintext', async () => {
  const env = mkEnv(); const a = await encrypt(env, 'tok_secret'), b = await encrypt(env, 'tok_secret');
  assert.notEqual(a, b); assert.ok(!a.includes('tok_secret')); assert.equal(await decrypt(env, a), 'tok_secret');
  await assert.rejects(decrypt(mkEnv({ ENC_KEY: Buffer.alloc(32, 9).toString('base64') }), a));
});

test('config is public and reports provider, env and paired state', async () => {
  const env = mkEnv();
  assert.deepEqual(await (await call(env, 'GET', '/config')).json(), { provider: 'plaid', env: 'sandbox', paired: false });
  await paired(env);
  assert.equal((await (await call(env, 'GET', '/config')).json()).paired, true);
  assert.equal((await (await call(mkEnv({ PLAID_ENV: 'production' }), 'GET', '/config')).json()).env, 'production');
});

test('pair once, stores only a hash, second pair 409', async () => {
  const env = mkEnv(); const r = await call(env, 'POST', '/pair'); const { key } = await r.json();
  assert.equal(r.status, 200); assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(![...env.BT_KV.m.values()].some((v) => v.includes(key)));
  assert.equal((await call(env, 'POST', '/pair')).status, 409);
});

test('auth rejection: missing, wrong key, unpaired (including /link-token)', async () => {
  const { env, key } = await paired();
  for (const p of ['/accounts', '/sync', '/link-token']) {
    assert.equal((await call(env, 'GET', p)).status, 401);
    assert.equal((await call(env, 'GET', p, { key: 'x'.repeat(64) })).status, 401);
  }
  assert.equal((await call(mkEnv(), 'GET', '/accounts', { key })).status, 401);
  assert.equal((await call(env, 'GET', '/accounts', { key })).status, 200);
});

test('link-token: new mode sends products and redirect uri; update mode sends access_token and no products', async () => {
  const p = mockPlaid();
  await withPlaid(p, async () => {
    const { env, key } = await paired(mkEnv({ PLAID_REDIRECT_URI: 'https://montzi.github.io/budtracks/' })); await enrollGood(env, key);
    p.calls.length = 0;
    const r = await call(env, 'GET', '/link-token', { key }); assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { link_token: 'link-new-token' });
    const b = p.calls[0].body;
    assert.equal(p.calls[0].host, 'https://sandbox.plaid.com');
    assert.equal(b.client_id, 'cid_test'); assert.equal(b.secret, 'sec_test'); assert.equal(b.client_name, 'BudTracks');
    assert.deepEqual(b.user, { client_user_id: 'budtracks-owner' }); assert.deepEqual(b.products, ['transactions']);
    assert.deepEqual(b.country_codes, ['US']); assert.equal(b.language, 'en'); assert.equal(b.transactions.days_requested, 90);
    assert.equal(b.redirect_uri, 'https://montzi.github.io/budtracks/'); assert.equal(b.access_token, undefined);
    p.calls.length = 0;
    const u = await call(env, 'GET', '/link-token?item=item_1', { key }); assert.deepEqual(await u.json(), { link_token: 'link-update-token' });
    assert.equal(p.calls[0].body.access_token, 'tok_good'); assert.equal(p.calls[0].body.products, undefined);
    assert.equal((await call(env, 'GET', '/link-token?item=nope', { key })).status, 404);
  });
  // no redirect_uri when unset; production host chosen by PLAID_ENV
  const p2 = mockPlaid();
  await withPlaid(p2, async () => {
    const { env, key } = await paired(mkEnv({ PLAID_ENV: 'production' }));
    await call(env, 'GET', '/link-token', { key });
    assert.equal(p2.calls[0].host, 'https://production.plaid.com'); assert.equal(p2.calls[0].body.redirect_uri, undefined);
  });
});

test('enroll exchanges the public token, stores an encrypted access token, returns accounts', async () => {
  const p = mockPlaid();
  await withPlaid(p, async () => {
    const { env, key } = await paired();
    const r = await enrollGood(env, key); const b = await r.json();
    assert.equal(r.status, 200); assert.equal(b.id, 'item_1'); assert.equal(b.institution, 'Chase'); assert.equal(b.accounts.length, 2);
    assert.deepEqual(b.accounts[0], { id: 'acc_chk', name: 'Everyday Checking', type: 'depository', subtype: 'checking', last_four: '1234', enabled: true });
    const raw = env.BT_KV.m.get('item:item_1'); assert.ok(!raw.includes('tok_good'));
    const rec = getItem(env); assert.equal(rec.institution, 'Chase'); assert.equal(rec.cursor, null); assert.equal(await decrypt(env, rec.token), 'tok_good');
    assert.ok(![...env.BT_KV.m.values()].some((v) => v.includes('sec_test')), 'secret never stored in KV');
    const bad = await call(env, 'POST', '/enroll', { key, body: { publicToken: 'public-bad' } });
    assert.equal(bad.status, 502); assert.equal([...env.BT_KV.m.keys()].filter((k) => k.startsWith('item:')).length, 1);
    assert.equal((await call(env, 'POST', '/enroll', { key, body: {} })).status, 400);
  });
});

test('missing Plaid keys give a clear 500 without leaking anything', async () => {
  const { env, key } = await paired(mkEnv({ PLAID_SECRET: undefined }));
  const r = await call(env, 'GET', '/link-token', { key }); assert.equal(r.status, 500); assert.match((await r.json()).error, /Plaid keys missing/);
});

test('accounts flags ITEM_LOGIN_REQUIRED (and item.error) as needsReconnect instead of throwing', async () => {
  const p = mockPlaid({ tokens: {
    tok_good: { item_id: 'item_1', accounts: [checking], batches: [] },
    tok_dead: { item_id: 'item_dead', accounts: [], batches: [], error: 'ITEM_LOGIN_REQUIRED' },
    tok_soft: { item_id: 'item_soft', accounts: [card], batches: [], itemError: { error_code: 'ITEM_LOGIN_REQUIRED' } } } });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enrollGood(env, key);
    await env.BT_KV.put('item:item_dead', JSON.stringify({ token: await encrypt(env, 'tok_dead'), institution: 'Dead Bank', cursor: null }));
    await env.BT_KV.put('item:item_soft', JSON.stringify({ token: await encrypt(env, 'tok_soft'), institution: 'Soft Bank', cursor: null }));
    const r = await call(env, 'GET', '/accounts', { key }); assert.equal(r.status, 200);
    const { enrollments } = await r.json(); const by = Object.fromEntries(enrollments.map((e) => [e.id, e]));
    assert.equal(by.item_dead.needsReconnect, true); assert.deepEqual(by.item_dead.accounts, []);
    assert.equal(by.item_soft.needsReconnect, true); assert.equal(by.item_soft.accounts.length, 1);
    assert.equal(by.item_1.needsReconnect, false); assert.equal(by.item_1.accounts[0].enabled, true);
  });
});

test('sync normalizes sign (positive = out), fields, since filter and category mapping', async () => {
  const p = mockPlaid();
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enrollGood(env, key);
    const r = await call(env, 'GET', '/sync?since=2026-11-01', { key }); const b = await r.json();
    assert.equal(r.status, 200); assert.deepEqual(b.errors, []); assert.deepEqual(b.removed, []); assert.ok(b.syncedAt);
    const by = Object.fromEntries(b.txns.map((t) => [t.id, t]));
    assert.equal(by['pl:t_old'], undefined, 'older than since is dropped');
    assert.equal(by['pl:t_pay'].amount, -2450);   // money in => negative
    assert.equal(by['pl:t_pp'].amount, 11.99);    // money out => positive
    assert.equal(by['pl:t_kl'].amount, 45);       // credit purchase => positive
    assert.equal(by['pl:t_ccpay'].amount, -300);  // card payment => money in => negative
    assert.deepEqual(by['pl:t_pp'], { id: 'pl:t_pp', date: '2026-11-12', desc: 'Spotify', rawDesc: 'PAYPAL *SPOTIFY', amount: 11.99,
      account: { id: 'acc_chk', name: 'Everyday Checking', last4: '1234', institution: 'Chase', type: 'depository' },
      status: 'posted', pendingOf: null, counterparty: 'Spotify', providerCategory: 'entertainment' });
    assert.equal(by['pl:t_pend'].status, 'pending'); assert.equal(by['pl:t_pend'].date, '2026-11-10', 'authorized_date preferred');
    assert.equal(by['pl:t_pend'].providerCategory, 'groceries'); assert.equal(by['pl:t_kl'].desc, 'KLARNA*PAYMENT'); assert.equal(by['pl:t_kl'].counterparty, null);
    assert.equal(by['pl:t_pay'].providerCategory, 'income'); assert.equal(by['pl:t_ccpay'].providerCategory, 'transfer');
    assert.equal(by['pl:t_kl'].account.type, 'credit');
    assert.equal(b.txns[0].date >= b.txns.at(-1).date, true);
    assert.equal((await call(env, 'GET', '/sync?since=bogus', { key })).status, 400);
  });
});

test('amounts are rounded to cents and never -0', async () => {
  const p = mockPlaid({ tokens: { tok_good: { item_id: 'item_1', accounts: [checking], batches: [[{ added: [
    tx('a', 'acc_chk', '2026-11-10', 'x', 12.3400000001), tx('b', 'acc_chk', '2026-11-10', 'y', -0)], modified: [], removed: [] }]] } } });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enrollGood(env, key);
    const b = await (await call(env, 'GET', '/sync', { key })).json();
    assert.equal(b.txns.find((t) => t.id === 'pl:a').amount, 12.34); assert.ok(Object.is(b.txns.find((t) => t.id === 'pl:b').amount, 0));
  });
});

test('category mapping: detailed beats primary, unknown is null', () => {
  const m = (primary, detailed) => mapCategory({ primary, detailed });
  assert.equal(m('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES'), 'groceries');
  assert.equal(m('FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT'), 'dining');
  assert.equal(m('FOOD_AND_DRINK', 'FOOD_AND_DRINK_FAST_FOOD'), 'dining');
  assert.equal(m('TRANSPORTATION', 'TRANSPORTATION_GAS'), 'fuel');
  assert.equal(m('TRANSPORTATION', 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES'), 'transport');
  assert.equal(m('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_WATER'), 'utilities');
  assert.equal(m('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_TELEPHONE'), 'phone');
  assert.equal(m('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CAR_PAYMENT'), 'loan');
  assert.equal(m('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'), 'transfer');
  assert.equal(m('TRANSFER_IN', 'TRANSFER_IN_DEPOSIT'), 'transfer'); assert.equal(m('TRANSFER_OUT', 'TRANSFER_OUT_WITHDRAWAL'), 'transfer');
  assert.equal(m('INCOME', 'INCOME_WAGES'), 'income');
  assert.equal(m('ENTERTAINMENT', 'ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS'), 'entertainment');
  assert.equal(m('PERSONAL_CARE', 'PERSONAL_CARE_HAIR_AND_BEAUTY'), 'health');
  assert.equal(m('MEDICAL', 'MEDICAL_PHARMACIES_AND_SUPPLEMENTS'), 'health');
  assert.equal(m('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES'), 'clothing');
  assert.equal(m('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ELECTRONICS'), 'electronics');
  assert.equal(m('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_DEPARTMENT_STORES'), 'shopping');
  assert.equal(m('GENERAL_SERVICES', 'GENERAL_SERVICES_INSURANCE'), 'insurance');
  assert.equal(m('GENERAL_SERVICES', 'GENERAL_SERVICES_CONSULTING_AND_LEGAL'), 'service');
  assert.equal(m('GOVERNMENT_AND_NON_PROFIT', 'GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT'), 'tax');
  assert.equal(m('HOME_IMPROVEMENT', 'HOME_IMPROVEMENT_FURNITURE'), 'home');
  assert.equal(m('SOMETHING_NEW', 'SOMETHING_NEW_X'), null); assert.equal(mapCategory(null), null);
});

test('sync paginates via has_more, persists cursor only after the full loop, then resumes from it', async () => {
  const pg = (ids, date = '2026-11-10') => ({ added: ids.map((i) => tx(i, 'acc_chk', date, 'n' + i, 1)), modified: [], removed: [] });
  const tok = { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1', 'a2']), pg(['a3']), pg(['a4'])], [pg(['b1'])]], failAtPage: 2 };
  const p = mockPlaid({ tokens: { tok_good: tok } });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enrollGood(env, key);
    // Page 3 fails: txns from earlier pages are NOT returned and the cursor is NOT stored.
    const bad = await (await call(env, 'GET', '/sync', { key })).json();
    assert.equal(bad.txns.length, 0); assert.equal(bad.errors.length, 1); assert.equal(getItem(env).cursor, null);
    tok.failAtPage = null; p.calls.length = 0;
    const ok = await (await call(env, 'GET', '/sync', { key })).json();
    assert.deepEqual(ok.txns.map((t) => t.id).sort(), ['pl:a1', 'pl:a2', 'pl:a3', 'pl:a4']); assert.deepEqual(ok.errors, []);
    assert.equal(syncCalls(p).length, 3); assert.equal(syncCalls(p)[0].body.cursor, undefined); assert.equal(syncCalls(p)[1].body.cursor, 'p0.1');
    assert.ok(ok.syncToken);
    assert.ok(syncCalls(p).every((c) => c.body.count === 500));
    assert.equal(getItem(env).cursor, null); assert.equal(getItem(env).pending.cursor, 'b1'); assert.equal(getItem(env).pending.token, ok.syncToken);
    // Next sync (acking the previous token) resumes from the committed cursor and only sees the new batch.
    p.calls.length = 0;
    const next = await sync(env, key, '?ack=' + ok.syncToken);
    assert.equal(syncCalls(p)[0].body.cursor, 'b1'); assert.deepEqual(next.txns.map((t) => t.id), ['pl:b1']); assert.equal(getItem(env).cursor, 'b1'); assert.equal(getItem(env).pending.cursor, 'b2');
    // Nothing new: empty result, no new pending, committed cursor advanced by the ack.
    const none = await sync(env, key, '?ack=' + next.syncToken); assert.deepEqual(none.txns, []); assert.equal(getItem(env).cursor, 'b2'); assert.equal(getItem(env).pending, undefined); assert.equal(none.syncToken, null);
  });
});

test('mutation during pagination restarts once from the old cursor', async () => {
  const pg = (ids) => ({ added: ids.map((i) => tx(i, 'acc_chk', '2026-11-10', 'n' + i, 1)), modified: [], removed: [] });
  const p = mockPlaid({ tokens: { tok_good: { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1']), pg(['a2'])]], mutateOnce: true } } });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enrollGood(env, key);
    const b = await (await call(env, 'GET', '/sync', { key })).json();
    assert.deepEqual(b.errors, []); assert.deepEqual(b.txns.map((t) => t.id).sort(), ['pl:a1', 'pl:a2'], 'no duplicates after restart');
    const calls = syncCalls(p); assert.equal(calls.length, 4); assert.equal(calls[2].body.cursor, undefined, 'restart uses the old (empty) cursor');
    assert.equal(getItem(env).pending.cursor, 'b1'); assert.equal(getItem(env).cursor, null);
  });
});

test('sync returns removed ids with pl: prefix, modified txns, and pendingOf', async () => {
  const batches = [[{ added: [tx('pend1', 'acc_chk', '2026-11-18', 'COFFEE', 4, { pending: true })], modified: [], removed: [] }],
    [{ added: [tx('post1', 'acc_chk', '2026-11-18', 'COFFEE SHOP', 4, { pending_transaction_id: 'pend1' })], modified: [tx('m1', 'acc_chk', '2026-11-17', 'EDITED', 9)], removed: [{ transaction_id: 'pend1' }, { transaction_id: 'gone' }] }]];
  const p = mockPlaid({ tokens: { tok_good: { item_id: 'item_1', accounts: [checking], batches } } });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enrollGood(env, key);
    const first = await sync(env, key);
    const b = await sync(env, key, '?ack=' + first.syncToken);
    assert.deepEqual(b.removed.sort(), ['pl:gone', 'pl:pend1']);
    assert.deepEqual(b.txns.map((t) => t.id).sort(), ['pl:m1', 'pl:post1']);
    assert.equal(b.txns.find((t) => t.id === 'pl:post1').pendingOf, 'pl:pend1'); assert.equal(b.txns.find((t) => t.id === 'pl:post1').status, 'posted');
  });
});

test('full=1 restarts from an empty cursor and stores the new one; failure keeps the old cursor', async () => {
  const pg = (ids) => ({ added: ids.map((i) => tx(i, 'acc_chk', '2026-11-10', 'n' + i, 1)), modified: [], removed: [] });
  const tok = { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1', 'a2'])], [pg(['b1'])]] };
  const p = mockPlaid({ tokens: { tok_good: tok } });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enrollGood(env, key);
    const s1 = await sync(env, key); const s2 = await sync(env, key, '?ack=' + s1.syncToken); await sync(env, key, '?ack=' + s2.syncToken); assert.equal(getItem(env).cursor, 'b2');
    p.calls.length = 0;
    const f = await sync(env, key, '?full=1');
    assert.equal(syncCalls(p)[0].body.cursor, undefined); assert.deepEqual(f.txns.map((t) => t.id).sort(), ['pl:a1', 'pl:a2']);
    assert.equal(getItem(env).cursor, 'b2', 'committed cursor untouched until acked'); assert.equal(getItem(env).pending.cursor, 'b1');
    tok.error = 'INTERNAL_SERVER_ERROR';
    const e = await sync(env, key, '?full=1'); assert.equal(e.errors.length, 1); assert.equal(getItem(env).cursor, 'b2');
  });
});

test('sync skips toggled-off accounts', async () => {
  const p = mockPlaid();
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enrollGood(env, key);
    assert.equal((await call(env, 'POST', '/accounts/acc_chk/toggle', { key, body: { enabled: 'yes' } })).status, 400);
    await call(env, 'POST', '/accounts/acc_chk/toggle', { key, body: { enabled: false } });
    const b = await (await call(env, 'GET', '/sync?full=1', { key })).json();
    assert.ok(b.txns.length > 0 && b.txns.every((t) => t.account.id === 'acc_cc'));
    assert.equal((await (await call(env, 'GET', '/accounts', { key })).json()).enrollments[0].accounts[0].enabled, false);
    await call(env, 'POST', '/accounts/acc_chk/toggle', { key, body: { enabled: true } });
    assert.ok((await (await call(env, 'GET', '/sync?full=1', { key })).json()).txns.some((t) => t.account.id === 'acc_chk'));
  });
});

test('sync reports per-item errors with needsReconnect, without failing and without moving the cursor', async () => {
  const p = mockPlaid({ tokens: { tok_good: { item_id: 'item_1', accounts: [checking], batches: [[{ added: [], modified: [], removed: [] }]] },
    tok_dead: { item_id: 'item_dead', accounts: [], batches: [], error: 'ITEM_LOGIN_REQUIRED' } } });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enrollGood(env, key);
    await env.BT_KV.put('item:item_dead', JSON.stringify({ token: await encrypt(env, 'tok_dead'), institution: 'Dead Bank', cursor: 'b5' }));
    const r = await call(env, 'GET', '/sync', { key }); assert.equal(r.status, 200); const b = await r.json();
    assert.equal(b.errors.length, 1); assert.equal(b.errors[0].enrollmentId, 'item_dead'); assert.equal(b.errors[0].institution, 'Dead Bank'); assert.equal(b.errors[0].needsReconnect, true);
    assert.equal(getItem(env, 'item_dead').cursor, 'b5');
  });
});

test('DELETE /enroll/:id calls /item/remove with the access token and removes the KV record', async () => {
  const p = mockPlaid();
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enrollGood(env, key);
    const r = await call(env, 'DELETE', '/enroll/item_1', { key }); assert.equal(r.status, 200);
    assert.equal(env.BT_KV.m.has('item:item_1'), false);
    const rm = p.calls.filter((c) => c.path === '/item/remove'); assert.equal(rm.length, 1); assert.equal(rm[0].body.access_token, 'tok_good');
    assert.equal((await call(env, 'DELETE', '/enroll/item_1', { key })).status, 404);
  });
});

test('CORS: allowed origin, preflight, foreign origin, localhost only in sandbox', async () => {
  const env = mkEnv();
  const ok = await call(env, 'GET', '/config'); assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const pre = await call(env, 'OPTIONS', '/sync'); assert.equal(pre.status, 204);
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.equal((await call(env, 'OPTIONS', '/sync', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(env, 'GET', '/config', { origin: 'https://evil.example' })).headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await call(env, 'GET', '/config', { origin: 'http://localhost:8080' })).headers.get('Access-Control-Allow-Origin'), 'http://localhost:8080');
  const prod = mkEnv({ PLAID_ENV: 'production' });
  assert.equal((await call(prod, 'GET', '/config', { origin: 'http://localhost:8080' })).headers.get('Access-Control-Allow-Origin'), null);
});

test('secrets never appear in responses or logs', async () => {
  const p = mockPlaid(), logs = [], orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  try {
    await withPlaid(p, async () => {
      const { env, key } = await paired(); await enrollGood(env, key);
      for (const path of ['/accounts', '/sync', '/link-token']) { const t = await (await call(env, 'GET', path, { key })).text(); assert.ok(!/tok_good|sec_test/.test(t), path); }
    });
  } finally { console.error = orig; }
  assert.deepEqual(logs, []);
});

test('two-phase cursor: a lost response is re-sent on the next sync without ack', async () => {
  const pg = (ids) => ({ added: ids.map((i) => tx(i, 'acc_chk', '2026-11-10', 'n' + i, 1)), modified: [], removed: [] });
  const p = mockPlaid({ tokens: { tok_good: { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1', 'a2'])], [pg(['b1'])]] } } });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enrollGood(env, key);
    const lost = await sync(env, key); assert.deepEqual(lost.txns.map((t) => t.id).sort(), ['pl:a1', 'pl:a2']); assert.ok(lost.syncToken);
    // The response never reached the phone, so no ack: same txns come back and the committed cursor never moved.
    p.calls.length = 0;
    const again = await sync(env, key); assert.deepEqual(again.txns.map((t) => t.id).sort(), ['pl:a1', 'pl:a2']);
    assert.equal(syncCalls(p)[0].body.cursor, undefined); assert.equal(getItem(env).cursor, null);
    assert.notEqual(again.syncToken, lost.syncToken); assert.equal(getItem(env).pending.token, again.syncToken);
    // The stale token from the lost response no longer commits anything.
    await sync(env, key, '?ack=' + lost.syncToken); assert.equal(getItem(env).cursor, null);
  });
});

test('two-phase cursor: ack commits the pending cursor and the next sync returns only new txns', async () => {
  const pg = (ids) => ({ added: ids.map((i) => tx(i, 'acc_chk', '2026-11-10', 'n' + i, 1)), modified: [], removed: [] });
  const p = mockPlaid({ tokens: { tok_good: { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1'])], [pg(['b1'])]] } } });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enrollGood(env, key);
    const a = await sync(env, key); assert.deepEqual(a.txns.map((t) => t.id), ['pl:a1']);
    p.calls.length = 0;
    const b = await sync(env, key, '?ack=' + a.syncToken);
    assert.deepEqual(b.txns.map((t) => t.id), ['pl:b1']); assert.equal(syncCalls(p)[0].body.cursor, 'b1');
    assert.equal(getItem(env).cursor, 'b1'); assert.equal(getItem(env).pending.cursor, 'b2');
  });
});

test('two-phase cursor: ack with the wrong token commits nothing', async () => {
  const pg = (ids) => ({ added: ids.map((i) => tx(i, 'acc_chk', '2026-11-10', 'n' + i, 1)), modified: [], removed: [] });
  const p = mockPlaid({ tokens: { tok_good: { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1'])], [pg(['b1'])]] } } });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enrollGood(env, key);
    await sync(env, key); p.calls.length = 0;
    const r = await sync(env, key, '?ack=not-the-token');
    assert.equal(getItem(env).cursor, null); assert.equal(syncCalls(p)[0].body.cursor, undefined);
    assert.deepEqual(r.txns.map((t) => t.id), ['pl:a1'], 're-fetched from the committed cursor');
  });
});
