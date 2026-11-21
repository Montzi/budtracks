import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { runAlerts, money, nyParts, encrypt, decrypt } from '../src/index.js';
import { tx, PLAID_ERR } from './fixtures.js';

// The recipient is assembled at runtime so no address is ever written in the repo.
const TO = ['owner', 'example.invalid'].join('@');
const RKEY = 're_test_' + 'k3y';
const ORIGIN = 'https://montzi.github.io';

// KV mock that records put options (TTL).
const kv = () => { const m = new Map(), opts = new Map(); return { m, opts,
  get: async (k) => m.get(k) ?? null, put: async (k, v, o) => { m.set(k, v); opts.set(k, o || null); }, delete: async (k) => void m.delete(k),
  list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) }; };
const mkEnv = (over = {}) => ({
  BT_KV: kv(), PLAID_ENV: 'production', PLAID_CLIENT_ID: 'cid_test', PLAID_SECRET: 'sec_test', ALLOWED_ORIGIN: ORIGIN,
  ENC_KEY: Buffer.alloc(32, 7).toString('base64'), RESEND_API_KEY: RKEY, ALERT_EMAIL: TO, ...over });

const acct = (id, type, subtype, mask, available, current = available) =>
  ({ account_id: id, name: subtype, official_name: null, mask, type, subtype, balances: { available, current, limit: null, iso_currency_code: 'USD' } });

// Mock Plaid + Resend. bank = { accounts, txns, error, txError, itemError }
function mockNet(bank) {
  const calls = [], emails = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url), body = JSON.parse(init.body || '{}');
    calls.push({ host: u.origin, path: u.pathname, body, headers: init.headers });
    const R = (s, b) => new Response(JSON.stringify(b), { status: s });
    if (u.origin === 'https://api.resend.com') {
      if (fn.throttle > 0) { fn.throttle--; fn.throttled = (fn.throttled || 0) + 1; return new Response('{}', { status: 429, headers: { 'retry-after': '0' } }); }
      if (fn.resendStatus) return R(fn.resendStatus, { message: 'rejected for ' + body.to?.[0] });
      emails.push({ ...body, auth: init.headers.Authorization });
      return R(200, { id: 'em_' + emails.length });
    }
    if (bank.error) return R(400, PLAID_ERR(bank.error));
    if (u.pathname === '/accounts/get') return R(200, { accounts: bank.accounts, item: { error: bank.itemError ? PLAID_ERR(bank.itemError) : null } });
    if (u.pathname === '/transactions/get') {
      if (bank.txError) return R(400, PLAID_ERR(bank.txError, 'ITEM_ERROR'));
      const list = bank.txns.filter((t) => t.date >= body.start_date && t.date <= body.end_date);
      const off = body.options?.offset || 0, n = body.options?.count || 100;
      return R(200, { accounts: bank.accounts, transactions: list.slice(off, off + n), total_transactions: list.length });
    }
    return R(404, PLAID_ERR('NOT_FOUND', 'API_ERROR'));
  };
  fn.calls = calls; fn.emails = emails;
  return fn;
}
async function withNet(net, fn) {
  const orig = globalThis.fetch; globalThis.fetch = net;
  const logs = [], o = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(o)) console[k] = (...a) => logs.push(a.map(String).join(' '));
  try { return await fn(logs); } finally { globalThis.fetch = orig; Object.assign(console, o); }
}
async function linkItem(env, id = 'item_1', institution = 'Santander') {
  await env.BT_KV.put('item:' + id, JSON.stringify({ token: await encrypt(env, 'tok_' + id), institution, cursor: 'c1' }));
}
const T = (iso) => new Date(iso);
const NOON = '2026-11-21T17:00:00Z';         // noon in New York: no recap

test('money and New York time helpers (both sides of DST)', () => {
  assert.equal(money(1234.5), '$1,234.50'); assert.equal(money(-8.15), '−$8.15'); assert.equal(money(1873.31), '$1,873.31');
  assert.equal(money(1234567.891), '$1,234,567.89'); assert.equal(money(-0.001), '$0.00');
  assert.deepEqual(nyParts(T('2026-11-23T12:00:00Z')), { date: '2026-11-23', hour: 7 });   // EST
  assert.deepEqual(nyParts(T('2026-07-15T11:00:00Z')), { date: '2026-07-15', hour: 7 });   // EDT
  assert.deepEqual(nyParts(T('2026-11-23T04:30:00Z')), { date: '2026-11-22', hour: 23 });
});

test('low balance: one email, no repeat, hysteresis reset, emails again on the next drop', async () => {
  const chk = acct('acc_s', 'depository', 'checking', '6429', 12.4, 15);
  const net = mockNet({ accounts: [chk], txns: [] }), env = mkEnv();
  await linkItem(env);
  await withNet(net, async () => {
    await runAlerts(env, T(NOON));
    assert.equal(net.emails.length, 1);
    const e = net.emails[0];
    assert.equal(e.subject, 'BudTracks: Santander ••6429 is below $20 ($12.40)');
    assert.deepEqual(e.to, [TO]); assert.equal(e.from, 'BudTracks <onboarding@resend.dev>'); assert.equal(e.auth, 'Bearer ' + RKEY);
    assert.ok(e.html.includes('$12.40') && e.text.includes('$12.40'));
    assert.equal(JSON.parse(env.BT_KV.m.get('alert:acc_s')).level, 'low');

    await runAlerts(env, T('2026-11-21T18:00:00Z')); assert.equal(net.emails.length, 1, 'still low: no email');
    chk.balances.available = 22;                                                  // between 20 and 25: still low
    await runAlerts(env, T('2026-11-21T19:00:00Z')); assert.equal(JSON.parse(env.BT_KV.m.get('alert:acc_s')).level, 'low');
    chk.balances.available = 30;
    await runAlerts(env, T('2026-11-21T20:00:00Z'));
    assert.equal(net.emails.length, 1); assert.equal(JSON.parse(env.BT_KV.m.get('alert:acc_s')).level, 'ok');
    chk.balances.available = 5;
    await runAlerts(env, T('2026-11-21T21:00:00Z'));
    assert.equal(net.emails.length, 2); assert.match(net.emails[1].subject, /below \$20 \(\$5\.00\)/);
  });
});

test('overdrawn escalation, fallback to current, credit/off accounts ignored', async () => {
  const chk = acct('acc_s', 'depository', 'checking', '6429', 30);
  const sav = acct('acc_sv', 'depository', 'savings', '1111', null, 3);           // available null -> current
  const offAcct = acct('acc_off', 'depository', 'checking', '2222', 1);
  const cc = acct('acc_cc', 'credit', 'credit card', '9876', -50, 500);
  const net = mockNet({ accounts: [chk, sav, offAcct, cc], txns: [] }), env = mkEnv();
  await linkItem(env); await env.BT_KV.put('off', JSON.stringify(['acc_off']));
  await withNet(net, async () => {
    await runAlerts(env, T(NOON));
    assert.deepEqual(net.emails.map((e) => e.subject), ['BudTracks: Santander ••1111 is below $20 ($3.00)']);
    chk.balances.available = 12;
    await runAlerts(env, T('2026-11-21T18:00:00Z'));
    chk.balances.available = -8.15;
    await runAlerts(env, T('2026-11-21T19:00:00Z'));
    assert.equal(net.emails.at(-1).subject, 'BudTracks: Santander ••6429 is overdrawn (−$8.15)');
    assert.equal(net.emails.length, 3);
    chk.balances.available = 10;                                                  // overdrawn -> low: no email
    await runAlerts(env, T('2026-11-21T20:00:00Z'));
    assert.equal(net.emails.length, 3); assert.equal(JSON.parse(env.BT_KV.m.get('alert:acc_s')).level, 'low');
    chk.balances.available = -1;                                                  // low -> overdrawn again: email
    await runAlerts(env, T('2026-11-21T21:00:00Z'));
    assert.equal(net.emails.length, 4);
    // ok -> overdrawn directly
    sav.balances.current = 100; await runAlerts(env, T('2026-11-21T22:00:00Z'));
    sav.balances.current = -2; await runAlerts(env, T('2026-11-21T23:00:00Z'));
    assert.match(net.emails.at(-1).subject, /••1111 is overdrawn/);
    assert.ok(!env.BT_KV.m.has('alert:acc_off') && !env.BT_KV.m.has('alert:acc_cc'));
  });
});

test('deposits: emailed once, pending skipped, several summarized, TTL 10 days, no sync cursor change', async () => {
  const chk = acct('acc_c', 'depository', 'checking', '4417', 2000);
  const cc = acct('acc_cc', 'credit', 'credit card', '9876', null, 100);
  const bank = { accounts: [chk, cc], txns: [
    tx('d1', 'acc_c', '2026-11-20', 'ACME PAYROLL', -1873.31, { merchant_name: 'Acme Corp' }),
    tx('d_pend', 'acc_c', '2026-11-21', 'VENMO CASHOUT', -50, { pending: true }),
    tx('cc_pay', 'acc_cc', '2026-11-20', 'PAYMENT THANK YOU', -300),               // card credit: not a deposit
    tx('spend', 'acc_c', '2026-11-20', 'SHOP', 20),
  ] };
  const net = mockNet(bank), env = mkEnv();
  await linkItem(env, 'item_1', 'Citizens');
  await withNet(net, async () => {
    await runAlerts(env, T(NOON));
    assert.equal(net.emails.length, 1);
    assert.equal(net.emails[0].subject, 'BudTracks: deposit $1,873.31 to Citizens ••4417');
    assert.ok(net.emails[0].html.includes('Acme Corp') && net.emails[0].text.includes('Acme Corp'));
    assert.equal(env.BT_KV.opts.get('dep:d1').expirationTtl, 864000);
    assert.ok(!env.BT_KV.m.has('dep:d_pend'));
    const tg = net.calls.find((c) => c.path === '/transactions/get');
    assert.deepEqual([tg.body.start_date, tg.body.end_date, tg.body.options.count], ['2026-11-18', '2026-11-21', 100]);
    assert.ok(!net.calls.some((c) => c.path === '/transactions/sync'));
    assert.equal(JSON.parse(env.BT_KV.m.get('item:item_1')).cursor, 'c1');

    await runAlerts(env, T('2026-11-21T18:00:00Z'));
    assert.equal(net.emails.length, 1, 'same deposit not emailed again');

    // pending posts, plus another deposit: one summary email
    bank.txns[1] = tx('d_post', 'acc_c', '2026-11-21', 'VENMO CASHOUT', -50);
    bank.txns.push(tx('d3', 'acc_c', '2026-11-21', 'REFUND', -350));
    await runAlerts(env, T('2026-11-21T19:00:00Z'));
    assert.equal(net.emails.length, 2);
    assert.equal(net.emails[1].subject, 'BudTracks: 2 deposits · $400.00');
  });
});

test('failed email send does not mark state; retried next hour', async () => {
  const chk = acct('acc_s', 'depository', 'checking', '6429', 5);
  const net = mockNet({ accounts: [chk], txns: [tx('d1', 'acc_s', '2026-11-20', 'PAY', -10)] }), env = mkEnv();
  await linkItem(env);
  await withNet(net, async (logs) => {
    net.resendStatus = 422;
    await runAlerts(env, T(NOON));
    assert.ok(!env.BT_KV.m.has('alert:acc_s') && !env.BT_KV.m.has('dep:d1'));
    assert.ok(!logs.join('\n').includes(TO), 'provider error body is not logged');
    net.resendStatus = 0;
    await runAlerts(env, T('2026-11-21T18:00:00Z'));
    assert.equal(net.emails.length, 2);
  });
});

test('reconnect: one email per item per day; PRODUCT_NOT_READY is silent', async () => {
  const bank = { accounts: [], txns: [], error: 'ITEM_LOGIN_REQUIRED' };
  const net = mockNet(bank), env = mkEnv();
  await linkItem(env, 'item_1', 'Chase');
  await withNet(net, async () => {
    await runAlerts(env, T(NOON));
    await runAlerts(env, T('2026-11-21T18:00:00Z'));
    assert.equal(net.emails.length, 1); assert.equal(net.emails[0].subject, 'BudTracks: reconnect Chase');
    assert.equal(env.BT_KV.opts.get('reauth:item_1').expirationTtl, 86400);
    // item error reported on a 200 /accounts/get also counts
    const env2 = mkEnv(), net2 = mockNet({ accounts: [], txns: [], itemError: 'PENDING_EXPIRATION' });
    await linkItem(env2);
    globalThis.fetch = net2; await runAlerts(env2, T(NOON));
    assert.equal(net2.emails.length, 1);
    // product not ready: balances still checked, no email about it
    const env3 = mkEnv(), net3 = mockNet({ accounts: [acct('a', 'depository', 'checking', '1', 100)], txns: [], txError: 'PRODUCT_NOT_READY' });
    await linkItem(env3);
    globalThis.fetch = net3; await runAlerts(env3, T(NOON));
    assert.equal(net3.emails.length, 0);
  });
});

function recapBank() {
  return { accounts: [acct('acc_c', 'depository', 'checking', '4417', 1500.25), acct('acc_sv', 'depository', 'savings', '0001', 500),
    acct('acc_cc', 'credit', 'credit card', '9876', null, 640.1), acct('acc_inv', 'investment', 'brokerage', '7777', 9999)],
  txns: [
    tx('y1', 'acc_c', '2026-11-22', 'WHOLEFDS', 82.4, { merchant_name: 'Whole Foods' }),
    tx('y2', 'acc_cc', '2026-11-22', 'SHELL OIL', 45, { merchant_name: 'Shell' }),
    tx('y3', 'acc_c', '2026-11-22', 'ONLINE TRANSFER TO SAVINGS', 200),
    tx('y4', 'acc_c', '2026-11-22', 'CHASE CREDIT CRD AUTOPAY', 300),
    tx('y5', 'acc_c', '2026-11-22', 'PAYROLL', -1200, { merchant_name: 'Acme <Corp>' }),
    tx('y6', 'acc_c', '2026-11-21', 'OLDER', 999),
    tx('p1', 'acc_c', '2026-11-23', 'STARBUCKS', 6.5, { pending: true, merchant_name: 'Starbucks' }),
  ] };
}

test('recap: only in the 7am New York hour (EST and EDT), once per day', async () => {
  const net = mockNet(recapBank()), env = mkEnv();
  await linkItem(env, 'item_1', 'Citizens');
  await env.BT_KV.put('dep:y5', '1');                                             // already notified
  await withNet(net, async () => {
    await runAlerts(env, T('2026-11-23T11:00:00Z'));                              // 6am EST
    assert.equal(net.emails.length, 0);
    await runAlerts(env, T('2026-11-23T12:00:00Z'));                              // 7am EST
    assert.equal(net.emails.length, 1);
    const r = net.emails[0];
    assert.match(r.subject, /^BudTracks: Mon, Nov 23 · \$2,000\.25 in the bank$/);
    for (const s of ['$2,000.25', '$1,500.25', '$500.00', '$640.10', 'Whole Foods', 'Shell', '$127.40', 'Starbucks']) {
      assert.ok(r.html.includes(s), 'html has ' + s); assert.ok(r.text.includes(s), 'text has ' + s);
    }
    assert.ok(r.text.includes('2 purchases'));
    assert.ok(!r.text.includes('9,999') && !r.text.includes('OLDER') && !r.text.includes('$999'), 'investment off by default, older days excluded');
    assert.ok(r.html.includes('Acme &lt;Corp&gt;') && !r.html.includes('Acme <Corp>'), 'escaped');
    assert.equal(env.BT_KV.opts.get('recap:2026-11-23').expirationTtl, 172800);
    await runAlerts(env, T('2026-11-23T12:30:00Z'));
    assert.equal(net.emails.length, 1, 'once per day');
    await runAlerts(env, T('2026-11-23T13:00:00Z'));
    assert.equal(net.emails.length, 1);
  });
  // Summer (EDT): 11:00Z is 7am
  const net2 = mockNet(recapBank()), env2 = mkEnv();
  await linkItem(env2);
  await env2.BT_KV.put('dep:y5', '1');
  await withNet(net2, async () => {
    await runAlerts(env2, T('2026-07-15T12:00:00Z')); assert.equal(net2.emails.length, 0);
    await runAlerts(env2, T('2026-07-15T11:00:00Z')); assert.equal(net2.emails.length, 1);
    assert.ok(env2.BT_KV.m.has('recap:2026-07-15'));
  });
});

test('a 429 from Resend is retried once, so the 7am recap still goes out; HSA/prepaid do not get low alerts', async () => {
  const bank = recapBank();
  bank.accounts.push(acct('acc_hsa', 'depository', 'hsa', '5555', 0), acct('acc_pp', 'depository', 'paypal', '6666', 0));
  const net = mockNet(bank), env = mkEnv();
  await linkItem(env, 'item_1', 'Citizens');
  await env.BT_KV.put('dep:y5', '1');
  await withNet(net, async () => {
    net.throttle = 1;
    await runAlerts(env, T('2026-11-23T12:00:00Z'));
    assert.equal(net.throttled, 1);
    assert.ok(env.BT_KV.m.has('recap:2026-11-23'));
    assert.equal(net.emails.length, 1);
    assert.ok(!env.BT_KV.m.has('alert:acc_hsa') && !env.BT_KV.m.has('alert:acc_pp'));
  });
});

const SNAP = { cycle: { start: '2026-11-14', end: '2026-11-27', left: 412.5, needed: 300, spent: 900, due: 275, income: 2450 },
  upcoming: [{ name: 'Rent', date: '2026-11-25', amount: 1200 }, { name: 'Gym', date: '2026-12-10', amount: 30 }],
  budgets: [{ name: 'Groceries', spent: 320, budget: 400 }, { name: 'Dining', spent: 180, budget: 150 }], review: 3 };
const call = (env, method, path, { key, body, raw } = {}) => worker.fetch(new Request('https://w.test' + path, {
  method, body: raw ?? (body ? JSON.stringify(body) : undefined), headers: { Origin: ORIGIN, ...(key ? { Authorization: 'Bearer ' + key } : {}) } }), env);
const pair = async (env) => (await (await call(env, 'POST', '/pair')).json()).key;

test('snapshot: auth, validation, size cap, encrypted round trip, appears in recap when fresh', async () => {
  const env = mkEnv(), key = await pair(env);
  assert.equal((await call(env, 'POST', '/snapshot', { body: SNAP })).status, 401);
  assert.equal((await call(env, 'POST', '/snapshot', { key: 'x'.repeat(64), body: SNAP })).status, 401);
  assert.equal((await call(env, 'POST', '/snapshot', { key, raw: '{nope' })).status, 400);
  for (const bad of [{}, { ...SNAP, cycle: { ...SNAP.cycle, left: '5' } }, { ...SNAP, cycle: { ...SNAP.cycle, start: 'Nov 1' } },
    { ...SNAP, upcoming: [{ name: 'x', date: '2026-11-25' }] }, { ...SNAP, budgets: 'all' }, { ...SNAP, review: -1 }, { ...SNAP, review: 1.5 },
    { ...SNAP, upcoming: Array.from({ length: 51 }, () => ({ name: 'a', date: '2026-11-25', amount: 1 })) }, { ...SNAP, budgets: [{ name: 'x'.repeat(81), spent: 1, budget: 2 }] }]) {
    assert.equal((await call(env, 'POST', '/snapshot', { key, body: bad })).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal((await call(env, 'POST', '/snapshot', { key, raw: JSON.stringify({ ...SNAP, pad: 'x'.repeat(11000) }) })).status, 413);
  const r = await call(env, 'POST', '/snapshot', { key, body: { ...SNAP, extra: 'dropped' } });
  assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
  const stored = env.BT_KV.m.get('snapshot');
  assert.ok(!stored.includes('Groceries') && !stored.includes('Rent'));
  const dec = JSON.parse(await decrypt(env, stored));
  assert.deepEqual(dec.data, SNAP);
  // Recap: snapshot stored "now"; pretend the recap runs at 7am the next local morning (< 36h later).
  dec.at = '2026-11-22T20:00:00Z'; await env.BT_KV.put('snapshot', await encrypt(env, JSON.stringify(dec)));
  const net = mockNet(recapBank());
  await linkItem(env, 'item_1', 'Citizens');
  await withNet(net, async () => {
    await runAlerts(env, T('2026-11-23T12:00:00Z'));
    const recap = net.emails.find((e) => e.subject.includes('in the bank'));
    for (const s of ['Left in paycheck', '$412.50', 'Still due', '$275.00', 'Rent', '$1,200.00', 'Groceries', 'Dining', 'Over by $30.00', '3 transactions to review']) {
      assert.ok(recap.html.includes(s), 'html has ' + s); assert.ok(recap.text.includes(s), 'text has ' + s);
    }
    assert.ok(!recap.text.includes('Gym'), 'bills beyond 3 days are left out');
  });
  // stale snapshot (> 36h) is ignored
  dec.at = '2026-11-21T20:00:00Z'; await env.BT_KV.put('snapshot', await encrypt(env, JSON.stringify(dec)));
  env.BT_KV.m.delete('recap:2026-11-23');
  const net2 = mockNet(recapBank());
  await withNet(net2, async () => {
    await runAlerts(env, T('2026-11-23T12:00:00Z'));
    const recap = net2.emails.find((e) => e.subject.includes('in the bank'));
    assert.ok(recap && !recap.text.includes('Left in paycheck'));
  });
});

test('no items: run does nothing; missing Resend config: no fetch to Resend or Plaid', async () => {
  const net = mockNet({ accounts: [acct('a', 'depository', 'checking', '1', 1)], txns: [] });
  await withNet(net, async (logs) => {
    await runAlerts(mkEnv(), T('2026-11-23T12:00:00Z'));
    assert.equal(net.calls.length, 0);
    for (const over of [{ RESEND_API_KEY: undefined }, { ALERT_EMAIL: undefined }]) {
      const env = mkEnv(over); await linkItem(env);
      await runAlerts(env, T('2026-11-23T12:00:00Z'));
      assert.ok(!net.calls.some((c) => c.host === 'https://api.resend.com'));
      assert.ok(!env.BT_KV.m.has('recap:2026-11-23'));
    }
    assert.ok(logs.some((l) => l.includes('not configured')));
  });
});

test('scheduled handler runs via waitUntil; no address or key in logs or KV', async () => {
  const net = mockNet(recapBank()), env = mkEnv();
  await linkItem(env, 'item_1', 'Citizens');
  await withNet(net, async (logs) => {
    const pending = [];
    await worker.scheduled({ scheduledTime: Date.parse('2026-11-23T12:00:00Z'), cron: '0 * * * *' }, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    assert.equal(pending.length, 1);
    assert.ok(net.emails.length >= 2, 'deposit + recap');
    net.resendStatus = 500; env.BT_KV.m.delete('recap:2026-11-23');
    await worker.scheduled({ scheduledTime: Date.parse('2026-11-23T12:10:00Z') }, env, {});
    const all = logs.join('\n') + [...env.BT_KV.m.keys(), ...env.BT_KV.m.values()].join('\n');
    for (const secret of [TO, RKEY, 'tok_item_1', 'sec_test']) assert.ok(!all.includes(secret), 'leaked ' + secret);
  });
});

test('GET /alerts/test: auth, sends test email, reports reason when not configured', async () => {
  const env = mkEnv(), key = await pair(env);
  const net = mockNet({ accounts: [], txns: [] });
  await withNet(net, async (logs) => {
    assert.equal((await call(env, 'GET', '/alerts/test')).status, 401);
    const r = await call(env, 'GET', '/alerts/test', { key });
    assert.deepEqual(await r.json(), { sent: true });
    assert.equal(net.emails[0].subject, 'BudTracks alerts are on'); assert.deepEqual(net.emails[0].to, [TO]);
    net.resendStatus = 403;
    const f = await (await call(env, 'GET', '/alerts/test', { key })).json();
    assert.equal(f.sent, false); assert.ok(!JSON.stringify(f).includes(TO));
    const env2 = mkEnv({ RESEND_API_KEY: '' }); const k2 = await pair(env2);
    const before = net.calls.length;
    assert.deepEqual(await (await call(env2, 'GET', '/alerts/test', { key: k2 })).json(), { sent: false, reason: 'email not configured' });
    assert.equal(net.calls.length, before);
    assert.ok(!logs.join('\n').includes(TO) && !logs.join('\n').includes(RKEY));
  });
});
