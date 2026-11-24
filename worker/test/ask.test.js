// POST /ask: Bud answers budget questions through Claude Haiku 5.5 or Gemini 3.8 Flash, with an injected fetch standing in for the Messages API.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { askBubbles, validateAsk } from '../src/index.js';

const ORIGIN = 'https://montzi.github.io';
const kv = () => { const m = new Map(), ttl = new Map(); return { m, ttl,
  get: async (k) => m.get(k) ?? null, put: async (k, v, o) => { m.set(k, v); if (o && o.expirationTtl) ttl.set(k, o.expirationTtl); }, delete: async (k) => void m.delete(k),
  list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) }; };
const DAY = new Date().toISOString().slice(0, 10);
const reply = (text, over = {}) => ({ id: 'msg_01Test', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: text == null ? [] : [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }],
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

test('ask: one Haiku 5.5 request, low effort, cached budget data first; reply split into bubbles', async () => {
  const api = fakeApi();
  const { env, key } = await paired({ ANTHROPIC_FETCH: api });
  let r, j;
  const out = await logs(async () => { r = await call(env, ok({ history: [{ q: 'Hi Bud', a: 'Hey! Ask me anything.' }] }), { key }); j = await r.json(); });
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(api.calls.length, 1);
  const c = api.calls[0], b = c.body;
  assert.match(new URL(c.url).pathname, /\/v1\/messages$/);
  assert.equal(c.headers.get('anthropic-beta'), null);
  assert.equal(b.model, 'claude-haiku-5-5');
  assert.equal(b.fallbacks, undefined);
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
  assert.equal(j.usage.cache_read_input_tokens, 4800); assert.equal(j.left, 79); assert.equal(j.provider, 'claude');
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

// Gemini Interactions API reply shaped like the documented one.
const gReply = (texts, over = {}) => ({ id: 'v1_x', model: 'gemini-3.8-flash', object: 'interaction', status: 'completed',
  steps: [{ type: 'thought', signature: 'sig' }, { type: 'model_output', content: texts.map((text) => ({ type: 'text', text })) }],
  usage: { total_input_tokens: 5100, total_output_tokens: 90, total_thought_tokens: 40, total_cached_tokens: 0 }, ...over });
function fakeGemini(make) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(init.body || '{}'), headers: new Headers(init.headers || {}) });
    const r = make ? make(calls.length) : { status: 200, json: gReply(['Groceries are up $40.\n\nMostly Shoprite.']) };
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls; return fn;
}

test('ask gemini: one stateless Interactions call to gemini-3.8-flash with the same prompt and data; bubbles back', async () => {
  const api = fakeApi(), g = fakeGemini();
  const { env, key } = await paired({ ANTHROPIC_FETCH: api, GEMINI_FETCH: g, GEMINI_API_KEY: 'gm-test-key' });
  let r, j;
  const out = await logs(async () => { r = await call(env, ok({ provider: 'gemini', history: [{ q: 'Hi', a: 'Hey!' }] }), { key }); j = await r.json(); });
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(api.calls.length, 0); assert.equal(g.calls.length, 1);
  const c = g.calls[0], b = c.body;
  assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(c.headers.get('x-goog-api-key'), 'gm-test-key'); assert.equal(c.headers.get('api-revision'), '2026-05-20');
  assert.equal(b.model, 'gemini-3.8-flash'); assert.equal(b.store, false);
  assert.deepEqual(b.generation_config, { thinking_level: 'low', max_output_tokens: 8000 });
  assert.match(b.system_instruction, /You are Bud/);
  assert.ok(b.input.startsWith('<budget_data>\n' + JSON.stringify(CTX) + '\n</budget_data>'));
  assert.match(b.input, /<earlier_chat>\nMe: Hi\nBud: Hey!\n<\/earlier_chat>/); assert.match(b.input, /How are groceries going\?$/);
  assert.deepEqual(j.bubbles, ['Groceries are up $40.', 'Mostly Shoprite.']);
  assert.equal(j.provider, 'gemini'); assert.equal(j.usage.input_tokens, 5100); assert.equal(j.usage.output_tokens, 130);
  assert.equal(/groceries|shoprite|gm-test-key/i.test(out), false, out);
  assert.equal(env.BT_KV.m.get('ask:' + DAY), '1');
});

test('ask gemini: not set up, rate limit (after one retry), bad key, rejected request, empty reply', async () => {
  let g = fakeGemini();
  let { env, key } = await paired({ GEMINI_FETCH: g });
  let r = await call(env, ok({ provider: 'gemini' }), { key }); assert.equal(r.status, 503); assert.match((await r.json()).error, /Gemini isn't set up/);
  assert.equal(g.calls.length, 0);
  const cases = [[429, 429, 2], [403, 503, 1], [400, 502, 1], [500, 502, 2]];
  for (const [st, want, n] of cases) {
    g = fakeGemini(() => ({ status: st, json: { error: { code: st, message: 'quoted input SHOPRITE' } } }));
    ({ env, key } = await paired({ GEMINI_FETCH: g, GEMINI_API_KEY: 'k' }));
    let out; await logs(async () => { r = await call(env, ok({ provider: 'gemini' }), { key }); });
    assert.equal(r.status, want, 'status ' + st); assert.equal(g.calls.length, n, 'calls for ' + st);
  }
  g = fakeGemini(() => ({ status: 200, json: gReply([], { status: 'failed' }) }));
  ({ env, key } = await paired({ GEMINI_FETCH: g, GEMINI_API_KEY: 'k' }));
  assert.equal((await call(env, ok({ provider: 'gemini' }), { key })).status, 502);
});

test('config reports which AI providers are set up', async () => {
  const env = mkEnv({ GEMINI_API_KEY: 'k' });
  const j = await (await worker.fetch(new Request('https://w.test/config', { headers: { Origin: ORIGIN } }), env)).json();
  assert.deepEqual(j.ai, { claude: true, gemini: true });
});

test('ask gemini: an invalid key (Google answers 400 API_KEY_INVALID) says so, with codes only', async () => {
  const g = fakeGemini(() => ({ status: 400, json: { error: { code: 400, message: 'API key not valid. SHOPRITE', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } } }));
  const { env, key } = await paired({ GEMINI_FETCH: g, GEMINI_API_KEY: 'bad' });
  let r, j; const out = await logs(async () => { r = await call(env, ok({ provider: 'gemini' }), { key }); j = await r.json(); });
  assert.equal(r.status, 503); assert.equal(j.error, "Gemini's key is invalid (400 INVALID_ARGUMENT API_KEY_INVALID)");
  assert.match(out, /ask: gemini error 400 INVALID_ARGUMENT API_KEY_INVALID/); assert.equal(/SHOPRITE|not valid/.test(out), false);
});
