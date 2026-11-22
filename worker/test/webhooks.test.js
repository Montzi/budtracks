import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { encrypt, decrypt } from '../src/index.js';
import { mockPlaid, checking, card, checkingTxns, cardTxns, tx } from './fixtures.js';
import { doNamespace } from './do-stub.js';

const ORIGIN = 'https://montzi.github.io';
const HOOK = 'https://budtracks-worker.atsdsc27.workers.dev/plaid/webhook';
const kv = () => { const m = new Map(), opts = new Map(); return { m, opts,
  get: async (k) => m.get(k) ?? null, put: async (k, v, o) => { m.set(k, v); opts.set(k, o || null); }, delete: async (k) => void m.delete(k),
  list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) }; };
// Env with the ItemSync Durable Object namespace bound (the stub shares this env with each object, like Cloudflare does).
const mkEnv = (over = {}) => {
  const env = { BT_KV: kv(), ITEM_SYNC: doNamespace(), PLAID_ENV: 'sandbox', PLAID_CLIENT_ID: 'cid_test', PLAID_SECRET: 'sec_test', ALLOWED_ORIGIN: ORIGIN,
    ENC_KEY: Buffer.alloc(32, 7).toString('base64'), PLAID_WEBHOOK_URL: HOOK, ...over };
  env.ITEM_SYNC.env = env;
  return env;
};
const mkCtx = () => { const p = []; return { waitUntil: (x) => p.push(x), done: () => Promise.all(p), p }; };
const call = (env, method, path, { key, body, origin = ORIGIN, ctx } = {}) => worker.fetch(new Request('https://w.test' + path, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { Origin: origin, ...(key ? { Authorization: 'Bearer ' + key } : {}) } }), env, ctx);
async function withPlaid(plaid, fn) {
  const orig = globalThis.fetch; globalThis.fetch = plaid;
  const logs = [], o = { log: console.log, error: console.error };
  console.log = (...a) => logs.push(a.map(String).join(' ')); console.error = (...a) => logs.push(a.map(String).join(' '));
  try { return await fn(logs); } finally { globalThis.fetch = orig; Object.assign(console, o); }
}
async function paired(env = mkEnv()) { const { key } = await (await call(env, 'POST', '/pair')).json(); return { env, key }; }
const enroll = (env, key, pub = 'public-good', name = 'Chase', ctx) => call(env, 'POST', '/enroll', { key, ctx, body: { publicToken: pub, institution: { name } } });
const syncCalls = (p) => p.calls.filter((c) => c.path === '/transactions/sync');
const sync = async (env, key, q = '') => (await call(env, 'GET', '/sync' + q, { key })).json();
const logRows = (env, id = 'item_1') => [...(env.ITEM_SYNC.storage(id) || new Map())].filter(([k]) => k.startsWith('log:')).map(([, v]) => v);
const doVal = (env, k, id = 'item_1') => env.ITEM_SYNC.storage(id)?.get(k);
const pg = (ids, date = '2026-11-10', acct = 'acc_chk') => ({ added: ids.map((i) => tx(i, acct, date, 'n' + i, 1)), modified: [], removed: [] });

// ---------- signing like Plaid: ES256 JWT over {iat, request_body_sha256} ----------
const b64u = (x) => Buffer.from(typeof x === 'string' ? x : new Uint8Array(x)).toString('base64url');
async function plaidSigner() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const kid = 'kid-' + Math.random().toString(16).slice(2);
  const key = { alg: 'ES256', created_at: 1700000000, crv: 'P-256', expired_at: null, kid, kty: 'EC', use: 'sig', x: jwk.x, y: jwk.y };
  const sign = async (body, o = {}) => {
    const sha = o.sha ?? Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))).toString('hex');
    const head = b64u(JSON.stringify({ alg: o.alg ?? 'ES256', kid: o.kid ?? kid, typ: 'JWT' }));
    const claims = b64u(JSON.stringify({ iat: o.iat ?? Math.floor(Date.now() / 1000), request_body_sha256: sha }));
    if (o.alg === 'none') return head + '.' + claims + '.';
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(head + '.' + claims));
    return head + '.' + claims + '.' + b64u(sig);
  };
  return { kid, key, sign };
}
const hookBody = (o = {}) => JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item_1', initial_update_complete: true, historical_update_complete: false, environment: 'sandbox', ...o });
const postHook = (env, body, jwt, ctx) => worker.fetch(new Request('https://w.test/plaid/webhook', { method: 'POST', body,
  headers: { 'Content-Type': 'application/json', ...(jwt ? { 'Plaid-Verification': jwt } : {}) } }), env, ctx);

async function setup(tokens, { second = false } = {}) {
  const s = await plaidSigner();
  const p = mockPlaid({ tokens, keys: { [s.kid]: s.key } });
  return { s, p };
}

// ---------- signature verification ----------
test('webhook: a correctly signed request is accepted, the key is cached in KV for a day', async () => {
  const { s, p } = await setup();
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key);
    const body = hookBody(), ctx = mkCtx();
    const r = await postHook(env, body, await s.sign(body), ctx); await ctx.done();
    assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), null, 'no CORS on the webhook route');
    const kc = p.calls.filter((c) => c.path === '/webhook_verification_key/get');
    assert.equal(kc.length, 1); assert.equal(kc[0].body.key_id, s.kid); assert.equal(kc[0].body.client_id, 'cid_test'); assert.equal(kc[0].body.secret, 'sec_test');
    assert.equal(JSON.parse(env.BT_KV.m.get('wvk:' + s.kid)).x, s.key.x); assert.equal(env.BT_KV.opts.get('wvk:' + s.kid).expirationTtl, 86400);
    // Second webhook uses the cached key.
    const ctx2 = mkCtx(); assert.equal((await postHook(env, body, await s.sign(body), ctx2)).status, 200); await ctx2.done();
    assert.equal(p.calls.filter((c) => c.path === '/webhook_verification_key/get').length, 1);
  });
});

test('webhook: unsigned, tampered, wrong alg, stale/future iat, unknown kid, expired key, bad signature -> 401 and nothing happens', async () => {
  const { s, p } = await setup();
  const other = await plaidSigner();
  await withPlaid(p, async (logs) => {
    const { env, key } = await paired(); await enroll(env, key);
    p.calls.length = 0;
    const body = hookBody(), now = Math.floor(Date.now() / 1000);
    const bad = {
      missing: [body, null],
      garbage: [body, 'not.a.jwt'],
      tamperedBody: [hookBody({ item_id: 'item_1', webhook_code: 'DEFAULT_UPDATE' }), await s.sign(body)],
      wrongSha: [body, await s.sign(body, { sha: 'ab'.repeat(32) })],
      hs256: [body, await s.sign(body, { alg: 'HS256' })],
      none: [body, await s.sign(body, { alg: 'none' })],
      oldIat: [body, await s.sign(body, { iat: now - 6 * 60 })],
      futureIat: [body, await s.sign(body, { iat: now + 5 * 60 })],
      unknownKid: [body, await other.sign(body)],
      wrongKeyForKid: [body, await other.sign(body, { kid: s.kid })],
    };
    for (const [name, [b, jwt]] of Object.entries(bad)) {
      const ctx = mkCtx();
      const r = await postHook(env, b, jwt, ctx);
      assert.equal(r.status, 401, name); assert.equal(ctx.p.length, 0, name + ': no background work');
    }
    assert.equal(syncCalls(p).length, 0, 'no pull for rejected webhooks');
    assert.equal(env.BT_KV.m.has('hookat:item_1'), false);
    // An unknown kid is asked about once, then remembered for a few minutes (no KV write for it).
    assert.equal(p.calls.filter((c) => c.path === '/webhook_verification_key/get' && c.body.key_id === other.kid).length, 1);
    assert.ok(![...env.BT_KV.m.keys()].some((k) => k === 'wvk:' + other.kid));
    // Expired key: rejected even though the signature is good.
    const exp = await plaidSigner(); exp.key.expired_at = Math.floor(Date.now() / 1000) - 10;
    const p2 = mockPlaid({ keys: { [exp.kid]: exp.key } }); globalThis.fetch = p2;
    assert.equal((await postHook(env, body, await exp.sign(body))).status, 401);
    // Logs carry a short reason only: never the body, the JWT or secrets.
    const all = logs.join('\n');
    assert.match(all, /webhook: rejected/); assert.ok(!all.includes('SYNC_UPDATES_AVAILABLE') && !all.includes('sec_test') && !all.includes(s.kid));
  });
});

test('webhook: bodies over 64KB are refused before verification', async () => {
  const { s, p } = await setup();
  await withPlaid(p, async () => {
    const env = mkEnv(); const big = hookBody({ pad: 'x'.repeat(70 * 1024) });
    assert.equal((await postHook(env, big, await s.sign(big))).status, 413);
    assert.equal(p.calls.length, 0);
  });
});

// ---------- pulls into the per-Item change log ----------
test('SYNC_UPDATES_AVAILABLE pulls once in the background and stores encrypted changes; a duplicate adds nothing', async () => {
  const { s, p } = await setup();
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key);
    p.calls.length = 0;
    const body = hookBody(), ctx = mkCtx();
    const r = await postHook(env, body, await s.sign(body), ctx);
    assert.equal(r.status, 200); assert.equal(ctx.p.length, 1, 'pull runs in waitUntil'); await ctx.done();
    assert.equal(syncCalls(p).length, 1); assert.equal(p.calls.filter((c) => c.path === '/accounts/get').length, 1);
    const rows = logRows(env); assert.equal(rows.length, 6);
    assert.ok(rows.every((x) => x.kind === 'upsert' && x.initial === true && typeof x.txn === 'string' && !x.txn.includes('PAYROLL')), 'encrypted at rest');
    assert.equal(JSON.parse(await decrypt(env, rows.find((x) => x.id === 'pl:t_pp').txn)).desc, 'Spotify');
    assert.equal(doVal(env, 'cursor'), 'b1'); assert.equal(doVal(env, 'seq'), 6); assert.equal(doVal(env, 'lastPull').ok, true);
    assert.ok(JSON.parse(env.BT_KV.m.get('hookat:item_1')).at);
    // Plaid delivers the same webhook again: pull from the stored cursor finds nothing new.
    const ctx2 = mkCtx(); await postHook(env, body, await s.sign(body), ctx2); await ctx2.done();
    assert.equal(logRows(env).length, 6); assert.equal(doVal(env, 'seq'), 6);
    assert.equal(syncCalls(p)[1].body.cursor, 'b1');
    // Nothing secret or plaintext in the object's storage.
    const dump = JSON.stringify([...env.ITEM_SYNC.storage('item_1')]);
    assert.ok(!dump.includes('tok_good') && !dump.includes('sec_test') && !dump.includes('Spotify'));
  });
});

test('webhook for an unknown Item or another Plaid environment: 200, ignored, no pull', async () => {
  const { s, p } = await setup();
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key);
    p.calls.length = 0;
    for (const body of [hookBody({ item_id: 'item_nope' }), hookBody({ environment: 'production' })]) {
      const ctx = mkCtx(); const r = await postHook(env, body, await s.sign(body), ctx);
      assert.equal(r.status, 200); assert.ok((await r.json()).ignored); assert.equal(ctx.p.length, 0);
    }
    assert.equal(syncCalls(p).length, 0);
  });
});

test('legacy TRANSACTIONS codes also pull; ITEM codes are stored for /status and LOGIN_REPAIRED clears them', async () => {
  const { s, p } = await setup();
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key);
    p.calls.length = 0;
    const d = hookBody({ webhook_code: 'DEFAULT_UPDATE', new_transactions: 6 }); const c1 = mkCtx();
    await postHook(env, d, await s.sign(d), c1); await c1.done(); assert.equal(syncCalls(p).length, 1);
    const e = JSON.stringify({ webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'item_1', environment: 'sandbox', error: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed' } });
    assert.equal((await postHook(env, e, await s.sign(e))).status, 200);
    let ev = JSON.parse(env.BT_KV.m.get('itemhook:item_1')); assert.equal(ev.code, 'ERROR'); assert.equal(ev.error.code, 'ITEM_LOGIN_REQUIRED'); assert.ok(ev.at);
    const ack = JSON.stringify({ webhook_type: 'ITEM', webhook_code: 'WEBHOOK_UPDATE_ACKNOWLEDGED', item_id: 'item_1', new_webhook_url: HOOK, environment: 'sandbox' });
    await postHook(env, ack, await s.sign(ack));
    assert.equal(JSON.parse(env.BT_KV.m.get('itemhook:item_1')).code, 'ERROR', 'an acknowledgement never hides an open problem');
    const st = await (await call(env, 'GET', '/status', { key })).json();
    assert.equal(st.items[0].itemEvent.code, 'ERROR'); assert.ok(st.items[0].lastWebhook.at); assert.equal(st.items[0].lastWebhook.code, 'WEBHOOK_UPDATE_ACKNOWLEDGED');
    const fix = JSON.stringify({ webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED', item_id: 'item_1', environment: 'sandbox' });
    await postHook(env, fix, await s.sign(fix));
    assert.equal(env.BT_KV.m.has('itemhook:item_1'), false);
    const pe = JSON.stringify({ webhook_type: 'ITEM', webhook_code: 'PENDING_EXPIRATION', item_id: 'item_1', consent_expiration_time: '2027-01-01T00:00:00Z', environment: 'sandbox' });
    await postHook(env, pe, await s.sign(pe));
    ev = JSON.parse(env.BT_KV.m.get('itemhook:item_1')); assert.equal(ev.code, 'PENDING_EXPIRATION'); assert.equal(ev.consentExpiration, '2027-01-01T00:00:00Z');
  });
});

test('pull paginates through has_more; a failure mid-pagination stores nothing and keeps the cursor; mutation restarts once', async () => {
  const tok = { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1', 'a2']), pg(['a3']), pg(['a4'])], [pg(['b1'])]], failAtPage: 2 };
  const { s, p } = await setup({ tok_good: tok });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key);
    const body = hookBody();
    let ctx = mkCtx(); await postHook(env, body, await s.sign(body), ctx); await ctx.done();
    assert.equal(logRows(env).length, 0, 'earlier pages were not stored'); assert.equal(doVal(env, 'cursor'), null);
    assert.equal(doVal(env, 'lastPull').ok, false); assert.equal(doVal(env, 'lastPull').code, 'INTERNAL_SERVER_ERROR');
    tok.failAtPage = null; tok.mutateOnce = true; p.calls.length = 0;
    ctx = mkCtx(); await postHook(env, body, await s.sign(body), ctx); await ctx.done();
    const sc = syncCalls(p);
    assert.deepEqual(sc.map((c) => c.body.cursor), [undefined, 'p0.1', undefined, 'p0.1', 'p0.2'], 'restarted from the old cursor after the mutation error');
    assert.deepEqual(logRows(env).map((x) => x.id).sort(), ['pl:a1', 'pl:a2', 'pl:a3', 'pl:a4']); assert.equal(doVal(env, 'cursor'), 'b1');
  });
});

test('removed: a removal replaces the unacked upsert for that id; an upsert after it replaces the removal', async () => {
  const batches = [[{ added: [tx('pend1', 'acc_chk', '2026-11-18', 'COFFEE', 4, { pending: true }), tx('keep', 'acc_chk', '2026-11-18', 'KEEP', 2)], modified: [], removed: [] }],
    [{ added: [tx('post1', 'acc_chk', '2026-11-18', 'COFFEE SHOP', 4, { pending_transaction_id: 'pend1' })], modified: [tx('keep', 'acc_chk', '2026-11-18', 'KEEP EDITED', 3)], removed: [{ transaction_id: 'pend1' }, { transaction_id: 'gone' }] }]];
  const { p } = await setup({ tok_good: { item_id: 'item_1', accounts: [checking], batches } });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key);
    await call(env, 'GET', '/sync?acks=', { key });        // pulls batch 0 (not acked)
    const b = await sync(env, key, '?acks=');               // pulls batch 1; nothing acked yet, so the log holds one row per id
    const rows = logRows(env);
    assert.deepEqual(rows.map((x) => [x.id, x.kind]).sort(), [['pl:gone', 'remove'], ['pl:keep', 'upsert'], ['pl:pend1', 'remove'], ['pl:post1', 'upsert']]);
    assert.deepEqual(b.removed.sort(), ['pl:gone', 'pl:pend1']); assert.deepEqual(b.txns.map((t) => t.id).sort(), ['pl:keep', 'pl:post1']);
    assert.equal(b.txns.find((t) => t.id === 'pl:keep').desc, 'KEEP EDITED'); assert.equal(b.txns.find((t) => t.id === 'pl:post1').pendingOf, 'pl:pend1');
    assert.equal(new Set(env.ITEM_SYNC.storage('item_1').keys()).has('idx:pl:pend1'), true);
  });
});

test('concurrent webhook + manual sync are serialized: no overlapping Plaid pulls, no double append', async () => {
  const tok = { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1']), pg(['a2'])]] };
  const { s, p } = await setup({ tok_good: tok });
  // Slow Plaid so the two runs really overlap in time.
  const slow = async (u, i) => { await new Promise((r) => setTimeout(r, 5)); return p(u, i); };
  await withPlaid(slow, async () => {
    const { env, key } = await paired(); await enroll(env, key);
    p.calls.length = 0;
    const body = hookBody(), ctx = mkCtx();
    const [hook, app, app2] = await Promise.all([postHook(env, body, await s.sign(body), ctx), sync(env, key, '?acks='), sync(env, key, '?acks=')]);
    await ctx.done();
    assert.equal(hook.status, 200);
    const sc = syncCalls(p);
    // One run read pages from the empty cursor; the requests that arrived during it caused exactly one follow-up run from b1.
    assert.deepEqual(sc.map((c) => c.body.cursor), [undefined, 'p0.1', 'b1']);
    assert.equal(logRows(env).length, 2); assert.equal(doVal(env, 'seq'), 2);
    for (const r of [app, app2]) assert.deepEqual(r.txns.map((t) => t.id).sort(), ['pl:a1', 'pl:a2']);
  });
});

// ---------- the app protocol ----------
test('/sync with acks: changes after the acked seq, cursors per Item; acking prunes the log', async () => {
  const tok = { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1', 'a2'])], [pg(['b1'])]] };
  const { p } = await setup({ tok_good: tok });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key);
    const a = await sync(env, key, '?acks=');
    assert.deepEqual(a.txns.map((t) => t.id).sort(), ['pl:a1', 'pl:a2']); assert.deepEqual(a.cursors, { item_1: 2 }); assert.equal(a.syncToken, null);
    assert.equal(a.balances[0].itemId, 'item_1'); assert.equal(p.calls.filter((c) => c.path === '/accounts/get').length, 2, 'enroll + one per sync, not two');
    // Response lost: same rows again (nothing was acked), plus the next batch.
    const again = await sync(env, key, '?acks=');
    assert.deepEqual(again.txns.map((t) => t.id).sort(), ['pl:a1', 'pl:a2', 'pl:b1']); assert.deepEqual(again.cursors, { item_1: 3 });
    // The app saved the first response and acks seq 2: only b1 is left.
    const b = await sync(env, key, '?acks=item_1:2');
    assert.deepEqual(b.txns.map((t) => t.id), ['pl:b1']); assert.equal(logRows(env).length, 1); assert.equal(doVal(env, 'acked'), 2);
    assert.ok(!env.ITEM_SYNC.storage('item_1').has('idx:pl:a1'), 'index entries go with their rows');
    const c = await sync(env, key, '?acks=item_1:3');
    assert.deepEqual(c.txns, []); assert.equal(logRows(env).length, 0); assert.deepEqual(c.cursors, { item_1: 3 });
    // Bogus or stale acks are ignored or clamped; junk is not an error.
    assert.equal((await call(env, 'GET', '/sync?acks=item_1:999,junk,::,item_x:5', { key })).status, 200);
    assert.equal(doVal(env, 'acked'), 3);
  });
});

test('/sync?item= pulls and reads one Item but still applies acks for the others', async () => {
  const tokens = { tok_good: { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1'])], [pg(['a2'])]] },
    tok_two: { item_id: 'item_2', accounts: [card], batches: [[pg(['c1'], '2026-11-10', 'acc_cc')], [pg(['c2'], '2026-11-10', 'acc_cc')]] } };
  const { p } = await setup(tokens);
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key); await enroll(env, key, 'public-two', 'Citizens');
    const all = await sync(env, key, '?acks=');
    assert.deepEqual(all.txns.map((t) => t.id).sort(), ['pl:a1', 'pl:c1']); assert.deepEqual(all.cursors, { item_1: 1, item_2: 1 });
    p.calls.length = 0;
    const one = await sync(env, key, '?acks=item_1:1,item_2:1&item=item_1');
    assert.deepEqual(one.txns.map((t) => t.id), ['pl:a2']); assert.deepEqual(Object.keys(one.cursors), ['item_1']);
    assert.deepEqual(syncCalls(p).map((c) => c.body.access_token), ['tok_good']);
    assert.equal(doVal(env, 'acked', 'item_2'), 1, 'item_2 ack honoured though it was not synced');
    const rest = await sync(env, key, '?acks=item_1:2,item_2:1');
    assert.deepEqual(rest.txns.map((t) => t.id), ['pl:c2']);
  });
});

test('/sync: `since` trims only the initial history; account on/off applies at read time', async () => {
  const late = tx('t_late', 'acc_chk', '2026-11-12', 'SHELL OIL 5521', 38, { pending: true, authorized_date: '2026-11-03' });
  const tok = { item_id: 'item_1', accounts: [checking, card], batches: [[{ added: [...checkingTxns, ...cardTxns], modified: [], removed: [] }], [{ added: [late], modified: [], removed: [] }]] };
  const { p } = await setup({ tok_good: tok });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key);
    await call(env, 'POST', '/accounts/acc_cc/toggle', { key, body: { enabled: false } });
    const a = await sync(env, key, '?since=2026-11-11&acks=');
    assert.ok(!a.txns.some((t) => t.account.id === 'acc_cc'), 'card is off'); assert.ok(!a.txns.some((t) => t.id === 'pl:t_pend'), 'older than since in the initial pull');
    assert.equal(logRows(env).length, 6, 'all accounts are stored');
    // Turning the card back on before acking: its stored rows come through.
    await call(env, 'POST', '/accounts/acc_cc/toggle', { key, body: { enabled: true } });
    const b = await sync(env, key, '?since=2026-11-11&acks=');
    assert.ok(b.txns.some((t) => t.id === 'pl:t_kl'));
    // That sync also pulled the next batch: a delta from a cursor passes even when its date is before since.
    assert.deepEqual(b.txns.filter((t) => t.id === 'pl:t_late').map((t) => [t.id, t.status, t.date]), [['pl:t_late', 'pending', '2026-11-03']]);
    assert.ok(!b.txns.some((t) => t.id === 'pl:t_pend'), 'initial rows are still trimmed');
    const c = await sync(env, key, '?since=2026-11-11&acks=item_1:' + b.cursors.item_1);
    assert.deepEqual(c.txns, []); assert.equal(logRows(env).length, 0);
  });
});

test('/sync full=1 is a throwaway cursor-less pull: no cursor or log change, incoming acks echoed', async () => {
  const tok = { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1', 'a2'])], [pg(['b1'])]] };
  const { p } = await setup({ tok_good: tok });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key);
    const a = await sync(env, key, '?acks=');
    p.calls.length = 0;
    const f = await sync(env, key, '?full=1&acks=item_1:' + a.cursors.item_1);
    assert.equal(syncCalls(p)[0].body.cursor, undefined); assert.deepEqual(f.txns.map((t) => t.id).sort(), ['pl:a1', 'pl:a2']);
    assert.deepEqual(f.cursors, { item_1: 2 }); assert.equal(doVal(env, 'cursor'), 'b1'); assert.equal(doVal(env, 'seq'), 2); assert.equal(doVal(env, 'acked'), 2);
  });
});

test('old cached app: no acks -> syncToken mapped to per-Item seqs in KV for 2 days; ack=<token> acks them', async () => {
  const tok = { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1', 'a2'])], [pg(['b1'])]] };
  const { p } = await setup({ tok_good: tok });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key);
    const a = await sync(env, key);
    assert.match(a.syncToken, /^[0-9a-f]{32}$/); assert.deepEqual(JSON.parse(env.BT_KV.m.get('synctok:' + a.syncToken)), { item_1: 2 });
    assert.equal(env.BT_KV.opts.get('synctok:' + a.syncToken).expirationTtl, 172800);
    const b = await sync(env, key, '?ack=' + a.syncToken);
    assert.deepEqual(b.txns.map((t) => t.id), ['pl:b1']); assert.equal(doVal(env, 'acked'), 2); assert.ok(b.syncToken && b.syncToken !== a.syncToken);
    await sync(env, key, '?ack=not-a-token');            // wrong token acks nothing
    assert.equal(doVal(env, 'acked'), 2);
    const c = await sync(env, key, '?ack=' + b.syncToken);
    assert.deepEqual(c.txns, []); assert.equal(c.syncToken, null, 'nothing delivered, no token'); assert.equal(doVal(env, 'acked'), 3);
    // KV cursor fields are never written in this mode.
    const rec = JSON.parse(env.BT_KV.m.get('item:item_1')); assert.equal(rec.cursor, null); assert.equal(rec.pending, undefined);
  });
});

test('migrate: an existing Item adopts its committed KV cursor (not the pending one) on first contact', async () => {
  const tok = { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1'])], [pg(['b1'])], [pg(['c1'])]] };
  const { s, p } = await setup({ tok_good: tok });
  await withPlaid(p, async () => {
    const { env, key } = await paired();
    // As left by the previous Worker: committed b1, pending b2 handed out but not acked.
    await env.BT_KV.put('item:item_1', JSON.stringify({ token: await encrypt(env, 'tok_good'), institution: 'Chase', cursor: 'b1', pending: { cursor: 'b2', token: 'x'.repeat(32), at: 'x' } }));
    const body = hookBody(), ctx = mkCtx();
    await postHook(env, body, await s.sign(body), ctx); await ctx.done();      // a webhook can be the first contact
    assert.equal(syncCalls(p)[0].body.cursor, 'b1', 'resumed from the committed cursor: nothing refetched from scratch');
    assert.ok(doVal(env, 'migrated')); assert.equal(doVal(env, 'cursor'), 'b2');
    const r = await sync(env, key, '?acks=');
    assert.deepEqual(r.txns.map((t) => t.id).sort(), ['pl:b1', 'pl:c1'], 're-delivers the unacked batch (the app dedupes), then the new one');
    // Migration happens once: a later KV cursor is ignored.
    const out = await (await env.ITEM_SYNC.get(env.ITEM_SYNC.idFromName('item_1')).fetch('https://item-sync/migrate', { method: 'POST', body: JSON.stringify({ kvCursor: 'zzz' }) })).json();
    assert.equal(out.adopted, false); assert.equal(doVal(env, 'cursor'), 'b3');
  });
});

test('enroll: new Item gets a migrated object with no cursor and an initial background pull; disconnect wipes it', async () => {
  const { p } = await setup();
  await withPlaid(p, async () => {
    const { env, key } = await paired(); const ctx = mkCtx();
    assert.equal((await enroll(env, key, 'public-good', 'Chase', ctx)).status, 200);
    assert.equal(ctx.p.length, 1); await ctx.done();
    assert.ok(doVal(env, 'migrated')); assert.equal(doVal(env, 'cursor'), 'b1'); assert.equal(logRows(env).length, 6);
    assert.equal(syncCalls(p)[0].body.cursor, undefined);
    const s = await sync(env, key, '?since=2026-11-01&acks=');
    assert.equal(s.txns.length, 5, 'initial rows trimmed by since');
    assert.equal((await call(env, 'DELETE', '/enroll/item_1', { key })).status, 200);
    assert.equal(env.ITEM_SYNC.storage('item_1').size, 0);
  });
});

test('PRODUCT_NOT_READY is quiet: no error, no cursor, and stored changes are still delivered when a pull fails', async () => {
  const tok = { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1'])]] };
  const { p } = await setup({ tok_good: tok });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key);
    tok.syncError = 'PRODUCT_NOT_READY';
    let r = await sync(env, key, '?acks=');
    assert.deepEqual(r.errors, []); assert.equal(doVal(env, 'cursor'), null); assert.equal(r.balances[0].accounts.length, 1);
    assert.equal(doVal(env, 'lastPull').quiet, true);
    tok.syncError = null;
    r = await sync(env, key, '?acks=');
    assert.deepEqual(r.txns.map((t) => t.id), ['pl:a1']);
    tok.error = 'ITEM_LOGIN_REQUIRED';
    r = await sync(env, key, '?acks=');
    assert.deepEqual(r.txns.map((t) => t.id), ['pl:a1'], 'stored but unacked rows still arrive');
    assert.equal(r.errors[0].needsReconnect, true); assert.deepEqual(r.cursors, { item_1: 1 });
  });
});

// ---------- configuration, status, cron ----------
test('link token for a new Item carries the webhook; update mode does not', async () => {
  const p = mockPlaid();
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key);
    p.calls.length = 0;
    await call(env, 'GET', '/link-token', { key }); assert.equal(p.calls[0].body.webhook, HOOK);
    p.calls.length = 0;
    await call(env, 'GET', '/link-token?item=item_1', { key }); assert.equal(p.calls[0].body.webhook, undefined);
    const env2 = mkEnv({ PLAID_WEBHOOK_URL: undefined }); const k2 = (await paired(env2)).key; p.calls.length = 0;
    await call(env2, 'GET', '/link-token', { key: k2 }); assert.equal(p.calls[0].body.webhook, undefined);
  });
});

test('POST /webhook/configure: needs auth, updates every Item, reports per Item; /status shows instant updates', async () => {
  const tokens = { tok_good: { item_id: 'item_1', accounts: [checking], batches: [] }, tok_two: { item_id: 'item_2', accounts: [card], batches: [] },
    tok_bad: { item_id: 'item_3', accounts: [card], batches: [], webhookError: 'ITEM_LOGIN_REQUIRED' } };
  const p = mockPlaid({ tokens });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key); await enroll(env, key, 'public-two', 'Citizens'); await enroll(env, key, 'public-bad2', 'x');
    await env.BT_KV.put('item:item_3', JSON.stringify({ token: await encrypt(env, 'tok_bad'), institution: 'Santander', cursor: null }));
    let st = await (await call(env, 'GET', '/status', { key })).json();
    assert.deepEqual(st.webhook, { available: true, configuredAt: null }); assert.ok(st.items.every((x) => x.instant === false && x.lastWebhook === null));
    assert.equal((await call(env, 'POST', '/webhook/configure')).status, 401);
    p.calls.length = 0;
    const r = await (await call(env, 'POST', '/webhook/configure', { key })).json();
    const up = p.calls.filter((c) => c.path === '/item/webhook/update');
    assert.deepEqual(up.map((c) => c.body.access_token).sort(), ['tok_bad', 'tok_good', 'tok_two']); assert.ok(up.every((c) => c.body.webhook === HOOK));
    assert.equal(r.ok, false); assert.equal(r.configured, 2);
    const bad = r.results.find((x) => x.itemId === 'item_3'); assert.equal(bad.ok, false); assert.equal(bad.needsReconnect, true);
    assert.ok(JSON.parse(env.BT_KV.m.get('webhook:configured')).items.item_1.ok);
    st = await (await call(env, 'GET', '/status', { key })).json();
    const by = Object.fromEntries(st.items.map((x) => [x.itemId, x]));
    assert.equal(by.item_1.instant, true); assert.equal(by.item_1.webhook, HOOK); assert.equal(by.item_3.instant, false); assert.ok(st.webhook.configuredAt);
    const env2 = mkEnv({ PLAID_WEBHOOK_URL: '' }); const k2 = (await paired(env2)).key;
    assert.equal((await call(env2, 'POST', '/webhook/configure', { key: k2 })).status, 400);
  });
});

test('cron: pulls every Item before the alerts pass, in one waitUntil', async () => {
  const tokens = { tok_good: { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1'])]] }, tok_two: { item_id: 'item_2', accounts: [card], batches: [[pg(['c1'], '2026-11-10', 'acc_cc')]] } };
  const p = mockPlaid({ tokens });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key); await enroll(env, key, 'public-two', 'Citizens');
    p.calls.length = 0; const ctx = mkCtx();
    await worker.scheduled({ scheduledTime: Date.parse('2026-11-21T17:00:00Z') }, env, ctx);
    assert.equal(ctx.p.length, 1); await ctx.done();
    assert.deepEqual(syncCalls(p).map((c) => c.body.access_token).sort(), ['tok_good', 'tok_two']);
    assert.equal(logRows(env, 'item_1').length, 1); assert.equal(logRows(env, 'item_2').length, 1);
    const r = await sync(env, key, '?acks=');
    assert.deepEqual(r.txns.map((t) => t.id).sort(), ['pl:a1', 'pl:c1']);
  });
});

test('the sync object is not reachable over HTTP and secrets never appear in responses or logs', async () => {
  const { s, p } = await setup();
  await withPlaid(p, async (logs) => {
    const { env, key } = await paired(); await enroll(env, key);
    for (const path of ['/pull', '/read', '/ack', '/reset', '/item-sync/pull']) assert.equal((await call(env, 'POST', path)).status, 401);
    const body = hookBody(), ctx = mkCtx(); await postHook(env, body, await s.sign(body), ctx); await ctx.done();
    for (const q of ['?acks=', '', '?full=1&acks=']) { const t = await (await call(env, 'GET', '/sync' + q, { key })).text(); assert.ok(!/tok_good|sec_test/.test(t), q); }
    const st = await (await call(env, 'GET', '/status', { key })).text(); assert.ok(!/tok_good|sec_test/.test(st));
    assert.ok(!/tok_good|sec_test|PAYROLL|Spotify/.test(logs.join('\n')));
  });
});

test('a verified webhook still gets 200 when processing fails afterwards (Plaid must not retry); cron catches up', async () => {
  const { s, p } = await setup();
  await withPlaid(p, async (logs) => {
    const { env, key } = await paired(); await enroll(env, key);
    const put = env.BT_KV.put; env.BT_KV.put = async (k, v, o) => { if (k.startsWith('hookat:')) throw new Error('kv down'); return put(k, v, o); };
    const body = hookBody(), ctx = mkCtx();
    const r = await postHook(env, body, await s.sign(body), ctx); await ctx.done();
    assert.equal(r.status, 200); assert.ok(logs.some((l) => l.includes('webhook: processing failed')));
    env.BT_KV.put = put;
    const c2 = mkCtx(); await worker.scheduled({ scheduledTime: Date.now() }, env, c2); await c2.done();
    assert.equal(logRows(env).length, 6);
  });
});

test('one failing sync object does not fail /sync for the other banks', async () => {
  const tokens = { tok_good: { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1'])]] }, tok_two: { item_id: 'item_2', accounts: [card], batches: [[pg(['c1'], '2026-11-10', 'acc_cc')]] } };
  const p = mockPlaid({ tokens });
  await withPlaid(p, async () => {
    const { env, key } = await paired(); await enroll(env, key); await enroll(env, key, 'public-two', 'Citizens');
    const ns = env.ITEM_SYNC, get = ns.get.bind(ns);
    ns.get = (id) => { const stub = get(id); return id.name !== 'item_2' ? stub : { fetch: async () => new Response('{"error":"internal error"}', { status: 500 }) }; };
    const r = await call(env, 'GET', '/sync?acks=item_1:0,item_2:4', { key }); assert.equal(r.status, 200);
    const b = await r.json();
    assert.deepEqual(b.txns.map((t) => t.id), ['pl:a1']); assert.deepEqual(b.cursors, { item_1: 1 });
    assert.ok(b.errors.some((e) => e.enrollmentId === 'item_2'));
  });
});

test('a pull asked for while one runs is never dropped, even after the loop limit', async () => {
  const tok = { item_id: 'item_1', accounts: [checking], batches: [[pg(['a1'])], [pg(['b1'])], [pg(['c1'])], [pg(['d1'])], [pg(['e1'])]] };
  const p = mockPlaid({ tokens: { tok_good: tok } });
  const slow = async (u, i) => { await new Promise((r) => setTimeout(r, 3)); return p(u, i); };
  await withPlaid(slow, async () => {
    const { env, key } = await paired(); await enroll(env, key);
    const stub = env.ITEM_SYNC.get(env.ITEM_SYNC.idFromName('item_1'));
    const pull = () => stub.fetch('https://item-sync/pull', { method: 'POST', body: JSON.stringify({ token: 'tok_good', institution: 'Chase', kvCursor: null }) });
    // Keep asking while runs are going: 5 batches need 5 runs, more than one loop's limit of 3.
    const asks = [];
    for (let i = 0; i < 5; i++) { asks.push(pull()); await new Promise((r) => setTimeout(r, 8)); }
    await Promise.all(asks);
    for (let i = 0; i < 50 && env.ITEM_SYNC.objs.get('item_1').inst.running; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(doVal(env, 'cursor'), 'b5'); assert.equal(logRows(env).length, 5);
    void key;
  });
});
