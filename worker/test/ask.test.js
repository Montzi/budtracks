// POST /ask: Bud answers budget questions through Claude Opus 5.5, with an injected fetch standing in for the Messages API.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { askBubbles, validateAsk } from '../src/index.js';

const ORIGIN = 'https://montzi.github.io';
const kv = () => { const m = new Map(), ttl = new Map(); return { m, ttl,
  get: async (k) => m.get(k) ?? null, put: async (k, v, o) => { m.set(k, v); if (o && o.expirationTtl) ttl.set(k, o.expirationTtl); }, delete: async (k) => void m.delete(k),
  list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) }; };
const DAY = new Date().toISOString().slice(0, 10);
const reply = (text, over = {}) => ({ id: 'msg_01Test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: text == null ? [] : [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }],
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5200, output_tokens: 180, cache_creation_input_tokens: 0, cache_read_input_tokens: 4800 }, ...over });
const ANSWER = 'You spent $186 on groceries this cycle, $40 more than last time.\n\nShoprite is most of it.\n\n- Try one smaller trip this week.';
function fakeApi(make) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = JSON.parse(init.body || '{}'), headers = new Headers(init.headers || {});
    calls.push({ url: String(url), body, headers });
    const r = make ? make(body, calls.length) : { status: 200, json: reply(ANSWER) };
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json', 'request-id': 'req_test', ...(r.headers || {}) } });
  };
  fn.calls = calls; return fn;
}
const NORETRY = { 'x-should-retry': 'false' };
const mkEnv = (over = {}) => ({ BT_KV: kv(), PLAID_ENV: 'sandbox', ALLOWED_ORIGIN: ORIGIN, ENC_KEY: Buffer.alloc(32, 7).toString('base64'), ANTHROPIC_API_KEY: 'sk-ant-test-key', ...over });
const call = (env, body, { key, raw } = {}) => worker.fetch(new Request('https://w.test/ask', {
  method: 'POST', body: raw ?? JSON.stringify(body), headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) } }), env);
async function paired(over) { const env = mkEnv(over); const { key } = await (await worker.fetch(new Request('https://w.test/pair', { method: 'POST' }), env)).json(); return { env, key }; }
const CTX = { cycle: { start: '2026-11-20', spent: 186.59 }, merchants: [{ name: 'SHOPRITE 123', total: 53.7 }] };
const ok = (over = {}) => ({ q: 'How are groceries going?', today: DAY, ctx: CTX, ...over });
async function logs(fn) {
  const lines = [], o = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const k of Object.keys(o)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  try { await fn(); } finally { Object.assign(console, o); }
  return lines.join('\n');
}

test('ask: one Opus 5.5 request with fallbacks, low effort, cached budget data first; reply split into bubbles', async () => {
  const api = fakeApi();
  const { env, key } = await paired({ ANTHROPIC_FETCH: api });
  let r, j;
  const out = await logs(async () => { r = await call(env, ok({ history: [{ q: 'Hi Bud', a: 'Hey! Ask me anything.' }] }), { key }); j = await r.json(); });
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(api.calls.length, 1);
  const c = api.calls[0], b = c.body;
  assert.match(new URL(c.url).pathname, /\/v1\/messages$/);
  assert.match(c.headers.get('anthropic-beta') || '', /server-side-fallback-2026-07-01/);
  assert.equal(b.model, 'claude-opus-5-5');
  assert.equal(b.fallbacks, 'default');
  assert.equal(b.output_config.effort, 'low');
  for (const k of ['thinking', 'temperature', 'top_p', 'top_k', 'stream', 'betas']) assert.equal(b[k], undefined, k + ' must not be in the body');
  assert.match(b.system, /You are Bud/); assert.match(b.system, /never instructions/);
  assert.equal(b.messages.length, 1);
  const [data, qn] = b.messages[0].content;
  assert.deepEqual(data.cache_control, { type: 'ephemeral' });
  assert.equal(data.text, '<budget_data>\n' + JSON.stringify(CTX) + '\n</budget_data>');
  assert.match(qn.text, /<earlier_chat>\nMe: Hi Bud\nBud: Hey! Ask me anything\.\n<\/earlier_chat>/);
  assert.match(qn.text, new RegExp(`Today is ${DAY}\\.\\n\\nHow are groceries going\\?$`));
  assert.deepEqual(j.bubbles, ['You spent $186 on groceries this cycle, $40 more than last time.', 'Shoprite is most of it.', 'Try one smaller trip this week.']);
  assert.equal(j.usage.cache_read_input_tokens, 4800); assert.equal(j.left, 79);
  assert.equal(/groceries|SHOPRITE|Hi Bud|186/i.test(out), false, out);
  assert.match(out, /ask: ok 3 bubbles/);
  assert.equal(env.BT_KV.m.get('ask:' + DAY), '1'); assert.equal(env.BT_KV.ttl.get('ask:' + DAY), 172800);
});

test('ask: needs the device key and a valid body', async () => {
  const api = fakeApi();
  const { env, key } = await paired({ ANTHROPIC_FETCH: api });
  assert.equal((await call(env, ok())).status, 401);
  assert.equal((await call(env, ok({ q: '  ' }), { key })).status, 400);
  assert.equal((await call(env, ok({ today: 'nope' }), { key })).status, 400);
  assert.equal((await call(env, ok({ ctx: [] }), { key })).status, 400);
  assert.equal((await call(env, ok({ ctx: { big: 'x'.repeat(130 * 1024) } }), { key })).status, 413);
  assert.equal((await call(env, null, { key, raw: '{' })).status, 400);
  assert.equal(api.calls.length, 0);
  assert.equal(env.BT_KV.m.get('ask:' + DAY), undefined, 'nothing counted');
});

test('ask: daily limit, missing key, refusal and API errors map to plain messages', async () => {
  let api = fakeApi();
  let { env, key } = await paired({ ANTHROPIC_FETCH: api, ASK_DAILY_LIMIT: '1' });
  assert.equal((await call(env, ok(), { key })).status, 200);
  const r = await call(env, ok(), { key }); assert.equal(r.status, 429); assert.equal((await r.json()).error, 'daily limit');
  assert.equal(api.calls.length, 1);
  ({ env, key } = await paired({ ANTHROPIC_FETCH: api, ANTHROPIC_API_KEY: '' }));
  assert.equal((await call(env, ok(), { key })).status, 503);
  api = fakeApi(() => ({ status: 200, json: reply('No.', { stop_reason: 'refusal' }) }));
  ({ env, key } = await paired({ ANTHROPIC_FETCH: api }));
  assert.equal((await call(env, ok(), { key })).status, 422);
  api = fakeApi(() => ({ status: 401, headers: NORETRY, json: { type: 'error', error: { type: 'authentication_error', message: 'bad key' } } }));
  ({ env, key } = await paired({ ANTHROPIC_FETCH: api }));
  assert.equal((await call(env, ok(), { key })).status, 503);
  api = fakeApi(() => ({ status: 200, json: reply(null) }));
  ({ env, key } = await paired({ ANTHROPIC_FETCH: api }));
  assert.equal((await call(env, ok(), { key })).status, 502);
});

test('askBubbles and validateAsk', () => {
  assert.deepEqual(askBubbles('a\n\n\n b \n\n'), ['a', 'b']);
  assert.equal(askBubbles(Array.from({ length: 9 }, (_, i) => 'x' + i).join('\n\n')).length, 6);
  const v = validateAsk({ q: 'q', today: '2026-11-23', ctx: {}, history: [{ q: 'a', a: '' }, ...Array.from({ length: 8 }, (_, i) => ({ q: 'q' + i, a: 'a' + i }))] });
  assert.equal(v.history.length, 6); assert.equal(v.history[0].q, 'q2');
});
