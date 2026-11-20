// BudTracks bank-sync Worker: a thin, single-user proxy to the Plaid API.
// Access tokens are AES-GCM encrypted in KV; the phone authenticates with a device key.

const PLAID_HOSTS = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };
const MAX_PAGES = 50;      // safety cap on /transactions/sync pages per item
const PAGE_SIZE = 500;

// ---------- small helpers ----------
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const hex = (u8) => [...u8].map((x) => x.toString(16).padStart(2, '0')).join('');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Constant-time comparison of two equal-length byte arrays.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ---------- encryption at rest (AES-GCM, key from env.ENC_KEY) ----------
async function aesKey(env) {
  if (!env.ENC_KEY) throw new HttpError(500, 'server not configured (ENC_KEY missing)');
  const raw = unb64(env.ENC_KEY);
  if (raw.length !== 32) throw new HttpError(500, 'ENC_KEY must be 32 bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(text)));
  return b64(iv) + '.' + b64(ct);
}
export async function decrypt(env, blob) {
  const [iv, ct] = blob.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct));
  return dec.decode(pt);
}

// ---------- CORS ----------
function allowedOrigin(env, origin) {
  if (!origin) return null;
  if (origin === env.ALLOWED_ORIGIN) return origin;
  if (plaidEnv(env) === 'sandbox' && /^http:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  return null;
}
function corsHeaders(env, req) {
  const o = allowedOrigin(env, req.headers.get('Origin'));
  return o ? {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  } : {};
}
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });

// ---------- device-key auth ----------
async function requireAuth(env, req) {
  const stored = await env.BT_KV.get('key_hash');
  const m = /^Bearer (.+)$/.exec(req.headers.get('Authorization') || '');
  if (!stored || !m) throw new HttpError(401, 'unauthorized');
  if (!safeEqual(await sha256(m[1]), unb64(stored))) throw new HttpError(401, 'unauthorized');
}

// ---------- Plaid client ----------
const plaidEnv = (env) => (env.PLAID_ENV === 'production' ? 'production' : 'sandbox');
// Every Plaid call is a JSON POST carrying client_id and secret in the body.
async function plaid(env, path, body = {}) {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) throw new HttpError(500, 'server not configured (Plaid keys missing)');
  const res = await fetch(PLAID_HOSTS[plaidEnv(env)] + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty / non-JSON body */ }
  return { status: res.status, ok: res.ok, body: data, code: data?.error_code || '' };
}
// Errors that mean the user has to go through Link again (update mode).
const RECONNECT = new Set(['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'ITEM_LOCKED',
  'USER_PERMISSION_REVOKED', 'ITEM_NO_LONGER_AVAILABLE', 'ACCESS_NOT_GRANTED', 'INVALID_ACCESS_TOKEN']);
const needsReconnect = (r) => RECONNECT.has(r.code);
const plaidMsg = (r) => r.body?.error_message || `Plaid error ${r.status}`;

// ---------- KV storage of items ----------
// item:<item_id> -> { token (encrypted access token), institution, cursor (committed), pending: {cursor, token, at}, enrolledAt }
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const itemKey = (id) => 'item:' + id;
async function loadItems(env) {
  const list = await env.BT_KV.list({ prefix: 'item:' });
  const out = [];
  for (const k of list.keys) {
    const rec = JSON.parse(await env.BT_KV.get(k.name));
    out.push({ id: k.name.slice(5), institution: rec.institution || '', cursor: rec.cursor || null, token: await decrypt(env, rec.token), rec });
  }
  return out;
}
async function loadItem(env, id) {
  const raw = await env.BT_KV.get(itemKey(id));
  if (!raw) return null;
  const rec = JSON.parse(raw);
  return { id, institution: rec.institution || '', cursor: rec.cursor || null, token: await decrypt(env, rec.token), rec };
}
// Account on/off: an explicit off-list, plus an explicit on-list that overrides the default-off account types.
const DEFAULT_OFF_TYPES = new Set(['loan', 'investment']);
const getList = async (env, k) => new Set(JSON.parse((await env.BT_KV.get(k)) || '[]'));
const getOff = async (env) => {
  const [off, on] = [await getList(env, 'off'), await getList(env, 'on')];
  return { off, on, has: (id, type) => off.has(id) || (!on.has(id) && DEFAULT_OFF_TYPES.has(type)) };
};

const shapeAccount = (a, off) => ({
  id: a.account_id, name: a.name || a.official_name || '', type: a.type, subtype: a.subtype || null, last_four: a.mask || null,
  ...(off ? { enabled: !off.has(a.account_id, a.type) } : {}),
});

// ---------- category mapping ----------
// Plaid personal_finance_category -> the lowercase vocabulary the app's classifier understands.
// Detailed codes win over primary ones.
const DETAILED = {
  FOOD_AND_DRINK_GROCERIES: 'groceries', FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: 'general', FOOD_AND_DRINK_VENDING_MACHINES: 'general',
  TRANSPORTATION_GAS: 'fuel', TRAVEL_RENTAL_CARS: 'transport',
  RENT_AND_UTILITIES_RENT: 'home', RENT_AND_UTILITIES_INTERNET_AND_CABLE: 'phone', RENT_AND_UTILITIES_TELEPHONE: 'phone',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'transfer',
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: 'clothing', GENERAL_MERCHANDISE_ELECTRONICS: 'electronics',
  GENERAL_MERCHANDISE_PHARMACIES_AND_SUPPLEMENTS: 'health', MEDICAL_PHARMACIES_AND_SUPPLEMENTS: 'health',
  GENERAL_SERVICES_INSURANCE: 'insurance', GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: 'tax',
};
const PRIMARY = {
  FOOD_AND_DRINK: 'dining', TRANSPORTATION: 'transport', TRAVEL: 'general', RENT_AND_UTILITIES: 'utilities',
  LOAN_PAYMENTS: 'loan', TRANSFER_IN: 'transfer', TRANSFER_OUT: 'transfer', INCOME: 'income',
  ENTERTAINMENT: 'entertainment', PERSONAL_CARE: 'health', MEDICAL: 'health', HOME_IMPROVEMENT: 'home',
  GENERAL_MERCHANDISE: 'shopping', GENERAL_SERVICES: 'service', GOVERNMENT_AND_NON_PROFIT: 'general', BANK_FEES: 'general', OTHER: null,
};
export function mapCategory(pfc) {
  if (!pfc) return null;
  return DETAILED[pfc.detailed] || PRIMARY[pfc.primary] || null;
}

// ---------- transaction normalization ----------
// Plaid sign convention: positive = money out, negative = money in, for every account type,
// which is exactly the app's convention. Posted amounts are rounded to cents.
export function normalizeTxn(t, acct, institution) {
  return {
    id: 'pl:' + t.transaction_id,
    date: t.authorized_date || t.date,
    desc: t.merchant_name || t.name,
    rawDesc: t.name,
    amount: Math.round(Number(t.amount) * 100) / 100 || 0, // avoid -0
    account: { id: t.account_id, name: acct?.name || '', last4: acct?.mask || '', institution: institution || '', type: acct?.type || '' },
    status: t.pending ? 'pending' : 'posted',
    pendingOf: t.pending_transaction_id ? 'pl:' + t.pending_transaction_id : null,
    counterparty: t.merchant_name || null,
    providerCategory: mapCategory(t.personal_finance_category),
  };
}

// Run /transactions/sync to completion from `cursor`. Restarts once from the same cursor if Plaid
// reports the data changed mid-pagination. Returns { added, modified, removed, cursor } or { r } on error.
async function syncItem(env, token, cursor) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = { added: [], modified: [], removed: [], cursor };
    let cur = cursor, restart = false;
    for (let p = 0; p < MAX_PAGES; p++) {
      const r = await plaid(env, '/transactions/sync', { access_token: token, count: PAGE_SIZE, ...(cur ? { cursor: cur } : {}) });
      if (!r.ok) {
        if (r.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt === 0) { restart = true; break; }
        return { r };
      }
      const b = r.body || {};
      out.added.push(...(b.added || [])); out.modified.push(...(b.modified || [])); out.removed.push(...(b.removed || []));
      cur = b.next_cursor || cur;
      if (!b.has_more) { out.cursor = cur; return out; }
    }
    if (!restart) return { r: { status: 502, ok: false, body: { error_message: 'too many pages from Plaid' }, code: 'TOO_MANY_PAGES' } };
  }
  return { r: { status: 502, ok: false, body: { error_message: 'Plaid data kept changing during sync, try again' }, code: 'MUTATION' } };
}

// ---------- route handlers ----------
async function pair(env) {
  if (await env.BT_KV.get('key_hash')) throw new HttpError(409, 'already paired');
  const key = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.BT_KV.put('key_hash', b64(await sha256(key)));
  return { key };
}

async function linkToken(env, itemId) {
  const base = { client_name: 'BudTracks', user: { client_user_id: 'budtracks-owner' }, country_codes: ['US'], language: 'en' };
  if (env.PLAID_REDIRECT_URI) base.redirect_uri = env.PLAID_REDIRECT_URI;
  let body;
  if (itemId) {
    const item = await loadItem(env, itemId);
    if (!item) throw new HttpError(404, 'unknown item');
    body = { ...base, access_token: item.token };            // update mode: no products
  } else {
    body = { ...base, products: ['transactions'], transactions: { days_requested: 90 } };
  }
  const r = await plaid(env, '/link/token/create', body);
  if (!r.ok || !r.body?.link_token) throw new HttpError(502, plaidMsg(r));
  return { link_token: r.body.link_token };
}

async function enroll(env, body) {
  const { publicToken, institution } = body || {};
  if (!publicToken || typeof publicToken !== 'string') throw new HttpError(400, 'publicToken required');
  const name = (typeof institution === 'string' ? institution : institution?.name) || '';
  return exchangeAndStore(env, publicToken, name);
}

// Shared by /enroll and /sandbox/item: exchange the public token, verify accounts, store the encrypted Item.
async function exchangeAndStore(env, publicToken, name) {
  const x = await plaid(env, '/item/public_token/exchange', { public_token: publicToken });
  if (!x.ok || !x.body?.access_token || !x.body?.item_id) throw new HttpError(502, plaidMsg(x));
  const { access_token: token, item_id: id } = x.body;
  const ar = await plaid(env, '/accounts/get', { access_token: token });
  if (!ar.ok) { await plaid(env, '/item/remove', { access_token: token }); throw new HttpError(502, plaidMsg(ar)); } // don't store an unusable token
  await env.BT_KV.put(itemKey(id), JSON.stringify({ token: await encrypt(env, token), institution: name, cursor: null, enrolledAt: new Date().toISOString() }));
  const off = await getOff(env);
  return { id, institution: name, accounts: (ar.body.accounts || []).map((a) => shapeAccount(a, off)) };
}

// Sandbox only: mint a test Item without going through Link.
async function sandboxItem(env, body) {
  if (env.PLAID_ENV !== 'sandbox') throw new HttpError(404, 'not found');
  const { institution_id, dynamic } = body || {};
  const req = { institution_id: (typeof institution_id === 'string' && institution_id) || 'ins_109508', initial_products: ['transactions'] };
  if (dynamic === true) req.options = { override_username: 'user_transactions_dynamic', override_password: 'pass_good' };
  const r = await plaid(env, '/sandbox/public_token/create', req);
  if (!r.ok || !r.body?.public_token) throw new HttpError(502, plaidMsg(r));
  return exchangeAndStore(env, r.body.public_token, 'Sandbox bank');
}

async function unpair(env) {
  await env.BT_KV.delete('key_hash');
  return { ok: true };
}

async function accounts(env) {
  const off = await getOff(env);
  const enrollments = [];
  for (const it of await loadItems(env)) {
    const r = await plaid(env, '/accounts/get', { access_token: it.token });
    if (r.ok) {
      const itemErr = r.body?.item?.error;
      enrollments.push({ id: it.id, institution: it.institution, needsReconnect: RECONNECT.has(itemErr?.error_code || ''), accounts: (r.body.accounts || []).map((a) => shapeAccount(a, off)) });
    } else enrollments.push({ id: it.id, institution: it.institution, accounts: [], needsReconnect: needsReconnect(r), error: plaidMsg(r) });
  }
  return { enrollments };
}

async function sync(env, since, full, ack) {
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new HttpError(400, 'since must be YYYY-MM-DD');
  const off = await getOff(env);
  const txns = [], removed = new Set(), errors = [];
  // Two-phase cursor: `cursor` is committed (the app confirmed it received that batch); `pending` is what the
  // last response handed out. Each sync reads from the committed cursor and parks its new cursor as pending
  // under `syncToken`; the app's NEXT sync acks that token, which commits it.
  const syncToken = randomToken();
  let issued = false;
  for (const it of await loadItems(env)) {
    if (ack && it.rec.pending && it.rec.pending.token === ack) {
      const { pending, ...rest } = it.rec;
      it.rec = { ...rest, cursor: pending.cursor }; it.cursor = pending.cursor;
      await env.BT_KV.put(itemKey(it.id), JSON.stringify(it.rec));
    }
    const err = (r, prefix = '') => errors.push({ enrollmentId: it.id, institution: it.institution, message: prefix + plaidMsg(r), needsReconnect: needsReconnect(r) });
    const ar = await plaid(env, '/accounts/get', { access_token: it.token });
    if (!ar.ok) { err(ar); continue; }
    const accts = new Map((ar.body.accounts || []).map((a) => [a.account_id, a]));
    const res = await syncItem(env, it.token, full ? null : it.cursor);
    if (res.r) { if (res.r.code !== 'PRODUCT_NOT_READY') err(res.r); continue; }
    const keep = (t) => !off.has(t.account_id, accts.get(t.account_id)?.type) && (!since || (t.authorized_date || t.date) >= since);
    for (const t of [...res.added, ...res.modified]) if (keep(t)) txns.push(normalizeTxn(t, accts.get(t.account_id), it.institution));
    for (const r of res.removed) if (r?.transaction_id) removed.add('pl:' + r.transaction_id);
    // Park the new cursor as pending only now that every page succeeded; it is committed by a later ack.
    if (res.cursor && res.cursor !== it.cursor) {
      await env.BT_KV.put(itemKey(it.id), JSON.stringify({ ...it.rec, pending: { cursor: res.cursor, token: syncToken, at: new Date().toISOString() } }));
      issued = true;
    }
  }
  txns.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  return { txns, removed: [...removed], errors, syncToken: issued ? syncToken : null, syncedAt: new Date().toISOString() };
}

async function toggle(env, accountId, body) {
  if (typeof body?.enabled !== 'boolean') throw new HttpError(400, 'enabled (boolean) required');
  const { off, on } = await getOff(env);
  if (body.enabled) { off.delete(accountId); on.add(accountId); } else { on.delete(accountId); off.add(accountId); }
  await env.BT_KV.put('off', JSON.stringify([...off]));
  await env.BT_KV.put('on', JSON.stringify([...on]));
  return { id: accountId, enabled: body.enabled };
}

async function disconnect(env, id) {
  const item = await loadItem(env, id);
  if (!item) throw new HttpError(404, 'unknown item');
  await plaid(env, '/item/remove', { access_token: item.token }); // best effort: a dead Item may already be gone
  await env.BT_KV.delete(itemKey(id));
  return { removed: id };
}

// ---------- entry point ----------
export default {
  async fetch(req, env) {
    const cors = corsHeaders(env, req);
    try {
      if (req.method === 'OPTIONS') {
        return cors['Access-Control-Allow-Origin'] ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });
      }
      const url = new URL(req.url), path = url.pathname, m = req.method;
      let out;
      if (m === 'GET' && path === '/config') {
        out = { provider: 'plaid', env: plaidEnv(env), paired: !!(await env.BT_KV.get('key_hash')) };
      } else if (m === 'POST' && path === '/pair') {
        out = await pair(env);
      } else {
        await requireAuth(env, req);
        let mt;
        if (m === 'GET' && path === '/link-token') out = await linkToken(env, url.searchParams.get('item'));
        else if (m === 'POST' && path === '/enroll') out = await enroll(env, await readJson(req));
        else if (m === 'DELETE' && path === '/pair') out = await unpair(env);
        else if (m === 'POST' && path === '/sandbox/item') out = env.PLAID_ENV === 'sandbox' ? await sandboxItem(env, await readJsonOpt(req)) : (() => { throw new HttpError(404, 'not found'); })();
        else if (m === 'GET' && path === '/accounts') out = await accounts(env);
        else if (m === 'GET' && path === '/sync') out = await sync(env, url.searchParams.get('since'), url.searchParams.get('full') === '1', url.searchParams.get('ack') || '');
        else if (m === 'POST' && (mt = /^\/accounts\/([\w-]+)\/toggle$/.exec(path))) out = await toggle(env, mt[1], await readJson(req));
        else if (m === 'DELETE' && (mt = /^\/enroll\/([\w-]+)$/.exec(path))) out = await disconnect(env, mt[1]);
        else throw new HttpError(404, 'not found');
      }
      return json(out, 200, cors);
    } catch (e) {
      // Never log request bodies/tokens; only a generic message for unexpected errors.
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) console.error('unhandled', e?.name);
      return json({ error: e instanceof HttpError ? e.message : 'internal error' }, status, cors);
    }
  },
};

async function readJson(req) {
  try { return await req.json(); } catch { throw new HttpError(400, 'invalid JSON'); }
}

// Optional JSON body: empty is fine, malformed is a 400.
async function readJsonOpt(req) {
  const t = await req.text();
  if (!t.trim()) return {};
  try { return JSON.parse(t); } catch { throw new HttpError(400, 'invalid JSON'); }
}
