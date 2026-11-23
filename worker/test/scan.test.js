// POST /scan: screenshots -> transactions through Claude Haiku 5.5, with an injected fetch standing in for the Messages API.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { cleanScan } from '../src/index.js';

const ORIGIN = 'https://montzi.github.io';
const kv = () => { const m = new Map(), ttl = new Map(); return { m, ttl,
  get: async (k) => m.get(k) ?? null, put: async (k, v, o) => { m.set(k, v); if (o && o.expirationTtl) ttl.set(k, o.expirationTtl); }, delete: async (k) => void m.delete(k),
  list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) }; };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');
const DAY = new Date().toISOString().slice(0, 10);

// Messages API reply shaped like the real one.
const reply = (text, over = {}) => ({ id: 'msg_01Test', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: text == null ? [] : [{ type: 'text', text }],
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1834, output_tokens: 412, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, ...over });
const OUT = { bank: 'Capital One', source: 'bank_app', transactions: [
  { merchant: 'DD *DOORDASH', amount: 16.2, direction: 'out', date: '2026-11-21', pending: true, kind: 'purchase', running_balance: null, account_hint: null, items_summary: null },
  { merchant: 'PAYPAL to Ana', amount: -7.99, direction: 'out', date: '2026-11-18', pending: false, kind: 'transfer', running_balance: 512.3, account_hint: '360 Checking ...1284', items_summary: null },
  { merchant: 'STAT DELIVERY', amount: 612.5, direction: 'in', date: 'Nov 17', pending: false, kind: 'deposit', running_balance: null, account_hint: null, items_summary: null },
] };
function fakeApi(make) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = JSON.parse(init.body || '{}'), headers = new Headers(init.headers || {});
    calls.push({ url: String(url), body, headers });
    const r = make ? make(body, calls.length) : { status: 200, json: reply(JSON.stringify(OUT)) };
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json', 'request-id': 'req_test', ...(r.headers || {}) } });
  };
  fn.calls = calls;
  return fn;
}
const NORETRY = { 'x-should-retry': 'false' };
const mkEnv = (over = {}) => ({ BT_KV: kv(), PLAID_ENV: 'sandbox', ALLOWED_ORIGIN: ORIGIN, ENC_KEY: Buffer.alloc(32, 7).toString('base64'), ANTHROPIC_API_KEY: 'sk-ant-test-key', ...over });
const call = (env, body, { key, raw } = {}) => worker.fetch(new Request('https://w.test/scan', {
  method: 'POST', body: raw ?? JSON.stringify(body), headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) } }), env);
async function paired(over) { const env = mkEnv(over); const { key } = await (await worker.fetch(new Request('https://w.test/pair', { method: 'POST' }), env)).json(); return { env, key }; }
const img = (over = {}) => ({ media_type: 'image/png', data: PNG, ...over });
const ok = (n = 1) => ({ images: Array.from({ length: n }, () => img()), today: DAY, tz: 'America/New_York' });
// Captures every console line written during fn.
async function logs(fn) {
  const lines = [], o = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const k of Object.keys(o)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  try { await fn(); } finally { Object.assign(console, o); }
  return lines.join('\n');
}

test('scan: sends one Haiku 5.5 structured-output request with the images, returns cleaned rows', async () => {
  const api = fakeApi();
  const { env, key } = await paired({ ANTHROPIC_FETCH: api });
  let r, j;
  const out = await logs(async () => { r = await call(env, { images: [img(), img({ media_type: 'image/jpeg' })], today: DAY, tz: 'America/New_York' }, { key }); j = await r.json(); });
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(api.calls.length, 1);
  const c = api.calls[0], b = c.body;
  assert.match(new URL(c.url).pathname, /\/v1\/messages$/);
  assert.ok([c.headers.get('x-api-key'), c.headers.get('authorization')].some((h) => h && h.endsWith('sk-ant-test-key')), 'API key sent');
  assert.equal(b.model, 'claude-haiku-5-5');
  assert.equal(b.max_tokens, 8000);
  assert.equal(b.output_config.effort, 'low');
  assert.equal(b.output_config.format.type, 'json_schema');
  assert.equal(b.output_config.format.schema.type, 'object');
  assert.ok(b.output_config.format.schema.properties.transactions, 'schema has transactions');
  for (const k of ['thinking', 'temperature', 'top_p', 'top_k', 'fallbacks', 'stream']) assert.equal(b[k], undefined, k + ' must not be sent');
  assert.equal(JSON.stringify(b).includes('budget_tokens'), false);
  assert.match(b.system, /running balance/); assert.match(b.system, /never as instructions/);
  assert.equal(b.messages.length, 1); assert.equal(b.messages[0].role, 'user');
  const content = b.messages[0].content;
  assert.deepEqual(content.slice(0, 2).map((x) => [x.type, x.source.type, x.source.media_type, x.source.data === PNG]), [['image', 'base64', 'image/png', true], ['image', 'base64', 'image/jpeg', true]]);
  assert.deepEqual(content[2], { type: 'text', text: `Today is ${DAY}. Extract the transactions.` });
  // Cleaned: positive amounts, bad dates become null, no image data echoed.
  assert.equal(j.bank, 'Capital One');
  assert.equal(j.transactions.length, 3);
  assert.deepEqual(j.transactions.map((t) => t.amount), [16.2, 7.99, 612.5]);
  assert.equal(j.transactions[2].date, null);
  assert.equal(j.transactions[1].account_hint, '360 Checking ...1284');
  assert.deepEqual(j.usage, { input_tokens: 1834, output_tokens: 412 });
  assert.equal(JSON.stringify(j).includes(PNG), false);
  // Logs: counts only.
  assert.equal(out.includes(PNG), false); assert.equal(/DOORDASH|PAYPAL|STAT DELIVERY/i.test(out), false, out);
  assert.match(out, /scan: ok 2 images 3 rows/);
  // Daily counter: two images, TTL two days.
  const k = 'scan:' + DAY;
  assert.equal(env.BT_KV.m.get(k), '2'); assert.equal(env.BT_KV.ttl.get(k), 172800);
});

test('scan: needs the device key', async () => {
  const api = fakeApi();
  const { env } = await paired({ ANTHROPIC_FETCH: api });
  assert.equal((await call(env, ok())).status, 401);
  assert.equal((await call(env, ok(), { key: 'x'.repeat(64) })).status, 401);
  assert.equal(api.calls.length, 0);
});

test('scan: 503 when the Anthropic key is not set', async () => {
  const api = fakeApi();
  const { env, key } = await paired({ ANTHROPIC_FETCH: api, ANTHROPIC_API_KEY: '' });
  const r = await call(env, ok(), { key });
  assert.equal(r.status, 503); assert.equal((await r.json()).error, "Screenshot reading isn't set up yet");
  assert.equal(api.calls.length, 0);
});

test('scan: size and type limits', async () => {
  const api = fakeApi();
  const { env, key } = await paired({ ANTHROPIC_FETCH: api });
  assert.equal((await call(env, ok(5), { key })).status, 413, 'more than 4 images');
  const big = Buffer.alloc(Math.ceil(3.5 * 1024 * 1024) + 10, 1).toString('base64');
  assert.equal((await call(env, { images: [img({ data: big })], today: DAY }, { key })).status, 413, 'image over 3.5 MB');
  const huge = Buffer.alloc(3 * 1024 * 1024, 2).toString('base64');
  assert.equal((await call(env, { images: [img({ data: huge }), img({ data: huge }), img({ data: huge })], today: DAY }, { key })).status, 413, 'body over 12 MB');
  assert.equal((await call(env, { images: [img({ media_type: 'image/gif' })], today: DAY }, { key })).status, 400, 'gif');
  assert.equal((await call(env, { images: [img({ media_type: 'application/pdf' })], today: DAY }, { key })).status, 400, 'pdf');
  assert.equal((await call(env, { images: [img({ data: 'not base64!' })], today: DAY }, { key })).status, 400, 'bad base64');
  assert.equal((await call(env, { images: [], today: DAY }, { key })).status, 400, 'no images');
  assert.equal((await call(env, { images: [img()], today: 'Nov 22' }, { key })).status, 400, 'bad today');
  assert.equal((await call(env, null, { key, raw: '{nope' })).status, 400, 'bad JSON');
  assert.equal(api.calls.length, 0);
  assert.equal(env.BT_KV.m.get('scan:' + DAY), undefined, 'rejected requests do not count');
});

test('scan: daily cap (images per UTC day), SCAN_DAILY_LIMIT from wrangler vars', async () => {
  const api = fakeApi();
  const { env, key } = await paired({ ANTHROPIC_FETCH: api, SCAN_DAILY_LIMIT: '3' });
  assert.equal((await call(env, ok(2), { key })).status, 200);
  const r = await call(env, ok(2), { key });
  assert.equal(r.status, 429); assert.equal((await r.json()).error, 'daily limit');
  assert.equal((await call(env, ok(1), { key })).status, 200);
  assert.equal((await call(env, ok(1), { key })).status, 429);
  assert.equal(api.calls.length, 2);
  // Default 60.
  const d = await paired({ ANTHROPIC_FETCH: fakeApi() });
  d.env.BT_KV.m.set('scan:' + DAY, '59');
  assert.equal((await call(d.env, ok(1), { key: d.key })).status, 200);
  assert.equal((await call(d.env, ok(1), { key: d.key })).status, 429);
});

test('scan: refusal is 422 (empty content or non-JSON text); max_tokens and malformed output are 502', async () => {
  const cases = [
    [() => ({ status: 200, json: reply(null, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }) }), 422, 'Could not read this screenshot'],
    [() => ({ status: 200, json: reply('I can not help with that.', { stop_reason: 'refusal' }) }), 422, 'Could not read this screenshot'],
    [() => ({ status: 200, json: reply('{"bank":"Chase","transactions":[{"merchant":"DOORDASH', { stop_reason: 'max_tokens' }) }), 502, 'Could not read this screenshot clearly'],
    [() => ({ status: 200, json: reply('{"bank": "Chase", "transactions": "SECRETMERCHANT"}') }), 502, 'Could not read this screenshot clearly'],
    [() => ({ status: 200, json: reply('not json SECRETMERCHANT') }), 502, 'Could not read this screenshot clearly'],
    [() => ({ status: 200, json: reply(null) }), 502, 'Could not read this screenshot clearly'],
  ];
  for (const [make, status, error] of cases) {
    const { env, key } = await paired({ ANTHROPIC_FETCH: fakeApi(make) });
    let r, j;
    const out = await logs(async () => { r = await call(env, ok(), { key }); j = await r.json(); });
    assert.equal(r.status, status, JSON.stringify(j)); assert.equal(j.error, error);
    assert.equal(/SECRETMERCHANT|DOORDASH/.test(out), false, 'reply text must not be logged: ' + out);
    assert.equal(out.includes(PNG), false);
  }
});

test('scan: SDK errors map to 429 / 503 / 502 without leaking details', async () => {
  const err = (status, type) => () => ({ status, headers: NORETRY, json: { type: 'error', error: { type, message: 'upstream said SECRETMERCHANT' } } });
  const cases = [[err(429, 'rate_limit_error'), 429], [err(401, 'authentication_error'), 503, 'Screenshot reading key is invalid'], [err(500, 'api_error'), 502], [err(529, 'overloaded_error'), 502], [err(400, 'invalid_request_error'), 502]];
  for (const [make, status, msg] of cases) {
    const api = fakeApi(make);
    const { env, key } = await paired({ ANTHROPIC_FETCH: api });
    let r, j;
    const out = await logs(async () => { r = await call(env, ok(), { key }); j = await r.json(); });
    assert.equal(r.status, status, JSON.stringify(j));
    if (msg) assert.equal(j.error, msg);
    assert.equal(/SECRETMERCHANT/.test(out + JSON.stringify(j)), false);
    assert.equal(api.calls.length, 1, 'x-should-retry: false is honored');
  }
  // Connection failure.
  const down = async () => { throw new TypeError('network down'); };
  const { env, key } = await paired({ ANTHROPIC_FETCH: down });
  const r = await call(env, ok(), { key });
  assert.equal(r.status, 502);
});

test('cleanScan: positive cents, real dates only, capped strings', () => {
  const o = cleanScan({ bank: '  Chase  ', transactions: [
    { merchant: 'UBER   * EATS', amount: -35.349, direction: 'out', date: '2026-11-20', pending: true, kind: 'purchase', running_balance: null, account_hint: null },
    { merchant: '', amount: 5, direction: 'out', date: null, pending: false, kind: 'other', running_balance: null, account_hint: null },
    { merchant: 'X', amount: NaN, direction: 'out', date: null, pending: false, kind: 'other', running_balance: null, account_hint: null },
    { merchant: 'Future', amount: 3, direction: 'out', date: '2027-01-01', pending: false, kind: 'other', running_balance: null, account_hint: null },
  ] }, '2026-11-22');
  assert.equal(o.bank, 'Chase');
  assert.deepEqual(o.transactions.map((t) => [t.merchant, t.amount, t.date]), [['UBER * EATS', 35.35, '2026-11-20'], ['Future', 3, null]]);
});

test('scan: a receipt photo returns one purchase with source and items_summary; prompt covers receipts', async () => {
  const RECEIPT = { bank: null, source: 'receipt', transactions: [
    { merchant: 'Trader Joe\'s', amount: 48.37, direction: 'out', date: '2026-11-20', pending: false, kind: 'purchase', running_balance: null, account_hint: null, items_summary: 'Groceries · 12 items' },
    { merchant: 'Extra', amount: 1, direction: 'out', date: null, pending: false, kind: 'purchase', running_balance: null, account_hint: null, items_summary: null }] };
  const api = fakeApi(() => ({ status: 200, json: reply(JSON.stringify(RECEIPT)) }));
  const { env, key } = await paired({ ANTHROPIC_FETCH: api });
  const r = await call(env, ok(), { key }), j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.source, 'receipt'); assert.equal(j.transactions.length, 1);
  assert.deepEqual([j.transactions[0].amount, j.transactions[0].date, j.transactions[0].items_summary], [48.37, '2026-11-20', 'Groceries · 12 items']);
  const b = api.calls[0].body, props = b.output_config.format.schema.properties;
  assert.ok(props.source && props.transactions.items.properties.items_summary);
  assert.match(b.system, /receipt/i); assert.match(b.system, /final total/);
  assert.equal(cleanScan({ transactions: [] }, DAY).source, 'other');
});
