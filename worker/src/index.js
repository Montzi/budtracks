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

// Plaid's cached balances (the same values /accounts/get returns; no extra cost). `available` is null for some accounts.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const shapeBalance = (a, off) => ({
  id: a.account_id, name: a.name || a.official_name || '', mask: a.mask || null, type: a.type, subtype: a.subtype || null,
  available: num(a.balances?.available), current: num(a.balances?.current), limit: num(a.balances?.limit),
  currency: a.balances?.iso_currency_code || a.balances?.unofficial_currency_code || 'USD', enabled: !off.has(a.account_id, a.type),
  // When the bank last updated this balance (Plaid sends it for some institutions only).
  ...(a.balances?.last_updated_datetime ? { lastUpdated: a.balances.last_updated_datetime } : {}),
});
const balanceItem = (it, accounts, off) => ({ itemId: it.id, institution: it.institution, accounts: accounts.map((a) => shapeBalance(a, off)) });

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

// `only` (an item id) limits the sync to that Item. Pending tokens live on each Item's own record, and an ack is applied to
// every Item that holds it, so a one-bank sync never loses the ack for a bank it skipped and never moves another bank's cursor.
async function sync(env, since, full, ack, only) {
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new HttpError(400, 'since must be YYYY-MM-DD');
  const off = await getOff(env);
  const txns = [], removed = new Set(), errors = [], balances = [];
  // Two-phase cursor: `cursor` is committed (the app confirmed it received that batch); `pending` is what the
  // last response handed out. Each sync reads from the committed cursor and parks its new cursor as pending
  // under `syncToken`; the app's NEXT sync acks that token, which commits it.
  const syncToken = randomToken();
  let issued = false;
  const items = await loadItems(env);
  if (only && !items.some((x) => x.id === only)) throw new HttpError(404, 'unknown item');
  for (const it of items) {
    if (ack && it.rec.pending && it.rec.pending.token === ack) {
      const { pending, ...rest } = it.rec;
      it.rec = { ...rest, cursor: pending.cursor }; it.cursor = pending.cursor;
      await env.BT_KV.put(itemKey(it.id), JSON.stringify(it.rec));
    }
    if (only && it.id !== only) continue;
    const err = (r, prefix = '') => errors.push({ enrollmentId: it.id, institution: it.institution, message: prefix + plaidMsg(r), needsReconnect: needsReconnect(r) });
    const ar = await plaid(env, '/accounts/get', { access_token: it.token });
    if (!ar.ok) { err(ar); balances.push({ itemId: it.id, institution: it.institution, accounts: [], needsReconnect: needsReconnect(ar) }); continue; }
    balances.push(balanceItem(it, ar.body.accounts || [], off));
    const accts = new Map((ar.body.accounts || []).map((a) => [a.account_id, a]));
    const res = await syncItem(env, it.token, full ? null : it.cursor);
    if (res.r) { if (res.r.code !== 'PRODUCT_NOT_READY') err(res.r); continue; }
    // `since` only trims the first (cursor-less) or a full pull. Deltas from a cursor are always new to the app: a pending
    // charge Plaid reports late can carry an older authorized_date, and dropping it would lose it for good once the cursor moves.
    const fresh = full || !it.cursor;
    const keep = (t) => !off.has(t.account_id, accts.get(t.account_id)?.type) && (!since || !fresh || (t.authorized_date || t.date) >= since);
    let newest = '';
    for (const t of [...res.added, ...res.modified]) if (keep(t)) { const n = normalizeTxn(t, accts.get(t.account_id), it.institution); txns.push(n); if (n.date > newest) newest = n.date; }
    for (const r of res.removed) if (r?.transaction_id) removed.add('pl:' + r.transaction_id);
    if (newest) await noteNewest(env, it.id, newest);
    // Park the new cursor as pending only now that every page succeeded; it is committed by a later ack.
    if (res.cursor && res.cursor !== it.cursor) {
      await env.BT_KV.put(itemKey(it.id), JSON.stringify({ ...it.rec, pending: { cursor: res.cursor, token: syncToken, at: new Date().toISOString() } }));
      issued = true;
    }
  }
  txns.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  return { txns, removed: [...removed], errors, syncToken: issued ? syncToken : null, syncedAt: new Date().toISOString(), balances };
}

// Live balances for every Item, disabled accounts included (flagged enabled: false).
async function getBalances(env) {
  const off = await getOff(env), items = [];
  for (const it of await loadItems(env)) {
    const r = await plaid(env, '/accounts/get', { access_token: it.token });
    if (r.ok) items.push(balanceItem(it, r.body.accounts || [], off));
    else items.push({ itemId: it.id, institution: it.institution, accounts: [], needsReconnect: needsReconnect(r), error: plaidMsg(r) });
  }
  return { balances: items, at: new Date().toISOString() };
}

// Ask Plaid to look for new activity now. /transactions/refresh needs the Transactions Refresh add-on; when Plaid says no,
// report it per Item instead of failing the request.
const NOT_ENABLED = new Set(['PRODUCT_NOT_ENABLED', 'INVALID_PRODUCT', 'PRODUCT_NOT_READY', 'ADDITIONAL_CONSENT_REQUIRED', 'UNAUTHORIZED_PRODUCT', 'API_NOT_ENABLED']);
const notEnabled = (r) => NOT_ENABLED.has(r.code) || r.status === 401 || r.status === 403 || /not (?:enabled|authorized|available)|not authorised/i.test(plaidMsg(r));
// A plain sentence for why a Plaid call did not do what was asked. `what` names the feature ("Transactions Refresh").
function whyNot(r, what, plan) {
  if (needsReconnect(r)) return 'This bank needs you to sign in again';
  if (r.code === 'PRODUCT_NOT_READY') return 'Plaid is still loading this bank for the first time';
  if (r.code === 'ADDITIONAL_CONSENT_REQUIRED') return `This bank connection hasn't been given consent for ${what}`;
  if (notEnabled(r)) return plan || `${what} isn't enabled for this Plaid account`;
  return plaidMsg(r);
}
// What Plaid allowed the last time each feature was asked for, per Item: { at, items: { [itemId]: { supported, reason, code } } }.
// /status reports it without calling the feature again (a refresh is not free on every plan).
async function noteSupport(env, k, list) {
  let cur = null; try { cur = JSON.parse((await env.BT_KV.get(k)) || 'null'); } catch { /* corrupt: start over */ }
  const items = { ...(cur?.items || {}) }, at = new Date().toISOString();
  for (const x of list) items[x.itemId] = x.refreshed ? { supported: true, at } : { supported: !x.notEnabled ? null : false, reason: x.reason, code: x.code || null, at };
  const vals = Object.values(items);
  const supported = vals.some((v) => v.supported === true) ? true : vals.length && vals.every((v) => v.supported === false) ? false : null;
  await env.BT_KV.put(k, JSON.stringify({ at, supported, reason: supported === false ? vals[0].reason : null, items }));
}
async function refresh(env, only) {
  const results = [], items = await loadItems(env);
  if (only && !items.some((x) => x.id === only)) throw new HttpError(404, 'unknown item');
  for (const it of items) {
    if (only && it.id !== only) continue;
    const r = await plaid(env, '/transactions/refresh', { access_token: it.token });
    if (r.ok) results.push({ itemId: it.id, institution: it.institution, refreshed: true });
    else results.push({ itemId: it.id, institution: it.institution, refreshed: false, reason: whyNot(r, 'Transactions Refresh'), message: plaidMsg(r), code: r.code || null, notEnabled: notEnabled(r), needsReconnect: needsReconnect(r) });
  }
  if (results.length) await noteSupport(env, 'refresh:supported', results);
  return { refreshed: results.some((x) => x.refreshed), notEnabled: results.length > 0 && results.every((x) => !x.refreshed && x.notEnabled), results };
}

// Real-time balances: /accounts/balance/get asks each bank right now (the Balance product; often not on the Trial plan).
// When Plaid says no, fall back to the cached /accounts/get balances and say why, per Item. Never silent.
const BAL_PLAN = "Real-time refresh isn't included in your Plaid plan";
const newestStamp = (accounts) => accounts.map((a) => a.balances?.last_updated_datetime).filter(Boolean).sort().pop() || null;
async function balancesRefresh(env) {
  const off = await getOff(env), out = [], results = [], at = new Date().toISOString();
  for (const it of await loadItems(env)) {
    const r = await plaid(env, '/accounts/balance/get', { access_token: it.token });
    if (r.ok) {
      const accts = r.body?.accounts || [];
      out.push({ ...balanceItem(it, accts, off), refreshed: true, at });
      results.push({ itemId: it.id, institution: it.institution, refreshed: true });
      await env.BT_KV.put('bal:' + it.id, await encrypt(env, JSON.stringify({ at, accounts: out.at(-1).accounts })));
      continue;
    }
    const res = { itemId: it.id, institution: it.institution, refreshed: false, reason: whyNot(r, 'Real-time balance', BAL_PLAN), message: plaidMsg(r), code: r.code || null, notEnabled: notEnabled(r), needsReconnect: needsReconnect(r) };
    const ar = await plaid(env, '/accounts/get', { access_token: it.token });
    if (ar.ok) {
      const accts = ar.body?.accounts || [];
      res.lastUpdated = newestStamp(accts);
      out.push({ ...balanceItem(it, accts, off), refreshed: false, cached: true, lastUpdated: res.lastUpdated });
    } else {
      res.needsReconnect = res.needsReconnect || needsReconnect(ar);
      out.push({ itemId: it.id, institution: it.institution, accounts: [], needsReconnect: res.needsReconnect, error: plaidMsg(ar) });
    }
    results.push(res);
  }
  if (results.length) await noteSupport(env, 'balance:supported', results);
  return { refreshed: results.some((x) => x.refreshed), notEnabled: results.length > 0 && results.every((x) => !x.refreshed && x.notEnabled), balances: out, results, at };
}

// Newest transaction date the Worker has handed out per Item (one small KV write, only when it moves forward).
async function noteNewest(env, id, date) {
  const k = 'stats:' + id;
  let cur = null; try { cur = JSON.parse((await env.BT_KV.get(k)) || 'null'); } catch { /* corrupt */ }
  if (cur?.newest && cur.newest >= date) return;
  await env.BT_KV.put(k, JSON.stringify({ ...(cur || {}), newest: date, at: new Date().toISOString() }));
}

// What Plaid says about each Item: when it last got new data from the bank, the last failure, any error, products,
// plus what we learned about on-demand refresh and real-time balances (cached, never probed here).
async function status(env) {
  const readJ = async (k) => { try { return JSON.parse((await env.BT_KV.get(k)) || 'null'); } catch { return null; } };
  const rs = await readJ('refresh:supported'), bs = await readJ('balance:supported'), items = [];
  for (const it of await loadItems(env)) {
    const st = await readJ('stats:' + it.id);
    const base = { itemId: it.id, institution: it.institution, refresh: rs?.items?.[it.id] || null, balance: bs?.items?.[it.id] || null, ...(st?.newest ? { newestTxn: st.newest } : {}) };
    const r = await plaid(env, '/item/get', { access_token: it.token });
    if (!r.ok) { items.push({ ...base, error: { code: r.code || null, message: plaidMsg(r) }, needsReconnect: needsReconnect(r), statusUnavailable: true }); continue; }
    const item = r.body?.item || {};
    // Plaid returns `status` next to `item`; read it from inside `item` too in case that ever changes.
    const tx = r.body?.status?.transactions || item.status?.transactions || {};
    const e = item.error && item.error.error_code ? { code: item.error.error_code, message: item.error.error_message || item.error.display_message || '', type: item.error.error_type || null } : null;
    items.push({
      ...base, institutionId: item.institution_id || null,
      lastSuccessfulUpdate: tx.last_successful_update || null, lastFailedUpdate: tx.last_failed_update || null,
      error: e, needsReconnect: !!(e && RECONNECT.has(e.code)),
      products: item.products || [], billedProducts: item.billed_products || [], availableProducts: item.available_products || [],
      consentExpiration: item.consent_expiration_time || null, webhook: item.webhook || null,
    });
  }
  return { items, refresh: rs ? { supported: rs.supported, reason: rs.reason, at: rs.at } : null, balance: bs ? { supported: bs.supported, reason: bs.reason, at: bs.at } : null, env: plaidEnv(env), at: new Date().toISOString() };
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

// ---------- email alerts (Resend) ----------
// The recipient comes only from the ALERT_EMAIL secret; neither it nor the API key is ever logged or stored.
const RESEND_URL = 'https://api.resend.com/emails';
const ALERT_FROM = 'BudTracks <onboarding@resend.dev>';
const TZ = 'America/New_York';
const LOW = 20, RECOVER = 25;                  // alert below $20, reset at $25 or more (hysteresis)
const RANK = { ok: 0, low: 1, overdrawn: 2 };
const ALERT_SUBTYPES = new Set(['checking', 'savings', 'cash management']);   // low-balance alerts only; not HSA, CD, prepaid, PayPal
const DEP_TTL = 10 * 86400, REAUTH_TTL = 86400, RECAP_TTL = 2 * 86400;
const SNAPSHOT_MAX_AGE = 36 * 3600 * 1000;
const TXN_PAGES = 5;                           // /transactions/get pages of 100 per item per run
// Obvious transfers and card payments, excluded from "spent".
const TRANSFER = /\b(transfer|xfer|payment thank you|autopay|auto pay|credit card payment|card payment|online payment|epay|to savings|from savings|to checking|from checking)\b/i;

const emailConfigured = (env) => !!(env.RESEND_API_KEY && env.ALERT_EMAIL);
async function sendEmail(env, { subject, html, text }) {
  if (!emailConfigured(env)) { console.log('alerts: email not configured, skipping send'); return { sent: false, reason: 'email not configured' }; }
  let res;
  // Resend rate-limits per second; several alerts plus the recap can go out in one run, so retry a 429 once.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: ALERT_FROM, to: [env.ALERT_EMAIL], subject, html, text }),
      });
    } catch (e) {
      console.error('alerts: email request failed', e?.name);
      return { sent: false, reason: 'email request failed' };
    }
    if (res.status !== 429 || attempt) break;
    const wait = Math.min(2, Math.max(0, Number(res.headers.get('retry-after') ?? 1) || 0));
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  // Resend error bodies can echo the recipient, so only the status is reported.
  if (!res.ok) { console.error('alerts: email provider status', res.status); return { sent: false, reason: `email provider returned ${res.status}` }; }
  return { sent: true };
}

// $1,234.56 with a real minus sign for negatives.
export function money(n) {
  const r = Math.round(Number(n) * 100) / 100 || 0;
  return (r < 0 ? '−' : '') + '$' + Math.abs(r).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Local calendar date and hour in New York for an instant.
export function nyParts(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const prettyDate = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }); };
const acctLabel = (inst, a) => `${inst || a.name || 'Account'}${a.mask ? ' ••' + a.mask : ''}`;
const balOf = (a) => num(a.balances?.available) ?? num(a.balances?.current);
const isTransfer = (t) => mapCategory(t.personal_finance_category) === 'transfer' || TRANSFER.test(`${t.name || ''} ${t.merchant_name || ''}`);
const txDate = (t) => t.authorized_date || t.date;
const txDesc = (t) => t.merchant_name || t.name || 'Transaction';

// Mobile-friendly inline-styled email shell.
function emailHtml(title, inner) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;">`
    + `<div style="max-width:560px;margin:0 auto;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2328;">`
    + `<div style="background:#ffffff;border-radius:12px;padding:20px;">`
    + `<div style="font-size:13px;color:#6a737d;margin-bottom:4px;">BudTracks</div>`
    + `<h1 style="font-size:20px;line-height:1.3;margin:0 0 12px 0;">${esc(title)}</h1>${inner}</div>`
    + `<div style="font-size:12px;color:#8b949e;text-align:center;margin-top:12px;">Sent by your BudTracks worker.</div></div></body></html>`;
}
const hSection = (t) => `<h2 style="font-size:15px;margin:18px 0 6px 0;color:#1f2328;">${esc(t)}</h2>`;
const hRows = (rows) => `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;">${rows.map(([l, r, sub]) =>
  `<tr><td style="padding:6px 0;border-bottom:1px solid #eaecef;">${esc(l)}${sub ? `<div style="font-size:12px;color:#6a737d;">${esc(sub)}</div>` : ''}</td>`
  + `<td style="padding:6px 0;border-bottom:1px solid #eaecef;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">${esc(r)}</td></tr>`).join('')}</table>`;
const hNote = (t) => `<p style="font-size:14px;color:#6a737d;margin:6px 0;">${esc(t)}</p>`;

// Plaid /transactions/get (date range; does not touch the app's /transactions/sync cursor).
async function getTxns(env, token, start, end) {
  const out = [];
  for (let p = 0; p < TXN_PAGES; p++) {
    const r = await plaid(env, '/transactions/get', { access_token: token, start_date: start, end_date: end, options: { count: 100, offset: out.length } });
    if (!r.ok) return { r };
    const list = r.body?.transactions || [];
    out.push(...list);
    if (!list.length || out.length >= (r.body?.total_transactions ?? 0)) break;
  }
  return { txns: out };
}

async function balanceAlert(env, inst, a, now) {
  const bal = balOf(a);
  if (bal === null) return;
  const key = 'alert:' + a.account_id;
  let prev = 'ok';
  try { prev = JSON.parse((await env.BT_KV.get(key)) || 'null')?.level || 'ok'; } catch { /* corrupt: treat as ok */ }
  if (!(prev in RANK)) prev = 'ok';
  let level = bal < 0 ? 'overdrawn' : bal < LOW ? 'low' : 'ok';
  if (level === 'ok' && prev !== 'ok' && bal < RECOVER) level = 'low';         // not recovered until $25
  if (level === prev) return;
  if (RANK[level] > RANK[prev]) {
    const label = acctLabel(inst, a);
    const subject = level === 'overdrawn' ? `BudTracks: ${label} is overdrawn (${money(bal)})` : `BudTracks: ${label} is below $20 (${money(bal)})`;
    const avail = num(a.balances?.available), cur = num(a.balances?.current);
    const rows = [['Available', avail === null ? 'n/a' : money(avail)], ['Current', cur === null ? 'n/a' : money(cur)]];
    const html = emailHtml(level === 'overdrawn' ? `${label} is overdrawn` : `${label} is below $20`, hRows(rows) + hNote(`Balance as of ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC.`));
    const text = `${subject}\n\nAvailable: ${rows[0][1]}\nCurrent: ${rows[1][1]}\n`;
    if (!(await sendEmail(env, { subject, html, text })).sent) return;       // retry next hour
  }
  await env.BT_KV.put(key, JSON.stringify({ level, at: now.toISOString() }));
}

async function depositAlert(env, deposits) {
  const fresh = [];
  for (const d of deposits) if (!(await env.BT_KV.get('dep:' + d.t.transaction_id))) fresh.push(d);
  if (!fresh.length) return;
  const total = fresh.reduce((s, d) => s - d.t.amount, 0);
  const subject = fresh.length === 1 ? `BudTracks: deposit ${money(-fresh[0].t.amount)} to ${fresh[0].label}` : `BudTracks: ${fresh.length} deposits · ${money(total)}`;
  const rows = fresh.map((d) => [txDesc(d.t), money(-d.t.amount), `${d.label} · ${prettyDate(txDate(d.t))}`]);
  const html = emailHtml(fresh.length === 1 ? `Deposit of ${money(-fresh[0].t.amount)}` : `${fresh.length} deposits, ${money(total)}`, hRows(rows));
  const text = `${subject}\n\n${rows.map(([a, b, c]) => `${a}  ${b}  (${c})`).join('\n')}\n`;
  if (!(await sendEmail(env, { subject, html, text })).sent) return;
  for (const d of fresh) await env.BT_KV.put('dep:' + d.t.transaction_id, '1', { expirationTtl: DEP_TTL });
}

async function reauthAlert(env, it) {
  const key = 'reauth:' + it.id;
  if (await env.BT_KV.get(key)) return;
  const name = it.institution || 'a bank';
  const subject = `BudTracks: reconnect ${name}`;
  const html = emailHtml(`Reconnect ${name}`, hNote(`${name} needs you to sign in again. Open BudTracks and reconnect the bank so balances and alerts stay current.`));
  if ((await sendEmail(env, { subject, html, text: `${subject}\n\n${name} needs you to sign in again. Open BudTracks and reconnect it.\n` })).sent) {
    await env.BT_KV.put(key, '1', { expirationTtl: REAUTH_TTL });
  }
}

async function loadSnapshot(env, now) {
  const raw = await env.BT_KV.get('snapshot');
  if (!raw) return null;
  try {
    const s = JSON.parse(await decrypt(env, raw));
    return now - new Date(s.at) < SNAPSHOT_MAX_AGE ? s.data : null;
  } catch { return null; }
}

function buildRecap(today, data, snap) {
  const yesterday = addDays(today, -1), soon = addDays(today, 3);
  const deps = [], cards = [], spend = [], depIn = [], pending = [];
  for (const { it, accounts, txns } of data) {
    const byId = new Map(accounts.map((a) => [a.account_id, a]));
    for (const a of accounts) {
      if (a.type === 'depository') deps.push({ label: acctLabel(it.institution, a), name: a.name || '', bal: balOf(a) });
      else if (a.type === 'credit') cards.push({ label: acctLabel(it.institution, a), owed: num(a.balances?.current) });
    }
    for (const t of txns || []) {
      const a = byId.get(t.account_id);
      if (!a) continue;                                             // account toggled off or excluded
      const label = acctLabel(it.institution, a);
      if (t.pending) { pending.push({ t, label }); continue; }
      if (txDate(t) !== yesterday) continue;
      if (t.amount > 0 && !isTransfer(t)) spend.push({ t, label });
      else if (t.amount < 0 && a.type === 'depository') depIn.push({ t, label });
    }
  }
  const cash = deps.reduce((s, d) => s + (d.bal ?? 0), 0);
  const owed = cards.reduce((s, c) => s + (c.owed ?? 0), 0);
  const spent = spend.reduce((s, x) => s + x.t.amount, 0);
  const top = [...spend].sort((x, y) => y.t.amount - x.t.amount).slice(0, 5);
  const title = `Good morning · ${prettyDate(today)}`;
  const subject = `BudTracks: ${prettyDate(today)} · ${money(cash)} in the bank`;
  let h = `<div style="font-size:28px;font-weight:600;margin:4px 0;">${esc(money(cash))}</div>` + hNote('Across your checking and savings accounts');
  const t = [title, '', `Cash: ${money(cash)}`];
  if (deps.length) { h += hRows(deps.map((d) => [d.label, d.bal === null ? 'n/a' : money(d.bal), d.name])); t.push(...deps.map((d) => `  ${d.label}: ${d.bal === null ? 'n/a' : money(d.bal)}`)); }
  if (cards.length) {
    h += hSection(`Credit cards owed · ${money(owed)}`) + hRows(cards.map((c) => [c.label, c.owed === null ? 'n/a' : money(c.owed)]));
    t.push('', `Credit cards owed: ${money(owed)}`, ...cards.map((c) => `  ${c.label}: ${c.owed === null ? 'n/a' : money(c.owed)}`));
  }
  if (snap) {
    const c = snap.cycle || {};
    const rows = [];
    if (num(c.left) !== null) rows.push(['Left in paycheck', money(c.left)]);
    if (num(c.due) !== null) rows.push(['Still due', money(c.due)]);
    if (num(c.spent) !== null) rows.push(['Spent this cycle', money(c.spent)]);
    if (num(c.income) !== null) rows.push(['Income this cycle', money(c.income)]);
    if (rows.length) { h += hSection(c.start && c.end ? `Paycheck ${prettyDate(c.start)} – ${prettyDate(c.end)}` : 'Paycheck') + hRows(rows); t.push('', ...rows.map((r) => `${r[0]}: ${r[1]}`)); }
    const bills = (snap.upcoming || []).filter((u) => u.date >= today && u.date <= soon).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (bills.length) { h += hSection('Bills in the next 3 days') + hRows(bills.map((u) => [u.name, money(u.amount), prettyDate(u.date)])); t.push('', 'Bills in the next 3 days:', ...bills.map((u) => `  ${u.name} ${money(u.amount)} (${prettyDate(u.date)})`)); }
    if ((snap.budgets || []).length) {
      const br = snap.budgets.map((b) => [b.name, `${money(b.spent)} of ${money(b.budget)}`, b.spent > b.budget ? `Over by ${money(b.spent - b.budget)}` : `${money(b.budget - b.spent)} left`]);
      h += hSection('Budgets') + hRows(br); t.push('', 'Budgets:', ...br.map((b) => `  ${b[0]}: ${b[1]} (${b[2]})`));
    }
    if (snap.review > 0) { const s = `${snap.review} transaction${snap.review === 1 ? '' : 's'} to review`; h += hNote(s); t.push('', s); }
  }
  h += hSection(`Yesterday · ${money(spent)} spent · ${spend.length} purchase${spend.length === 1 ? '' : 's'}`);
  t.push('', `Yesterday: ${money(spent)} spent, ${spend.length} purchase${spend.length === 1 ? '' : 's'}`);
  if (top.length) { h += hRows(top.map((x) => [txDesc(x.t), money(x.t.amount), x.label])); t.push(...top.map((x) => `  ${txDesc(x.t)} ${money(x.t.amount)} (${x.label})`)); }
  else h += hNote('No purchases.');
  if (depIn.length) { h += hSection('Deposits yesterday') + hRows(depIn.map((x) => [txDesc(x.t), money(-x.t.amount), x.label])); t.push('', 'Deposits yesterday:', ...depIn.map((x) => `  ${txDesc(x.t)} ${money(-x.t.amount)} (${x.label})`)); }
  if (pending.length) { h += hSection(`Pending · ${pending.length}`) + hRows(pending.map((x) => [txDesc(x.t), money(-x.t.amount), x.label])); t.push('', 'Pending:', ...pending.map((x) => `  ${txDesc(x.t)} ${money(-x.t.amount)} (${x.label})`)); }
  return { subject, html: emailHtml(title, h), text: t.join('\n') + '\n' };
}

// One hourly pass: balance alerts, new deposits, reconnect notices, and the 7am New York recap.
export async function runAlerts(env, now = new Date()) {
  const keys = (await env.BT_KV.list({ prefix: 'item:' })).keys;
  if (!keys.length) return { skipped: 'no items' };
  if (!emailConfigured(env)) { console.log('alerts: email not configured, skipping run'); return { skipped: 'email not configured' }; }
  const off = await getOff(env), items = await loadItems(env);
  const { date: today, hour } = nyParts(now);
  const recapDue = hour === 7 && !(await env.BT_KV.get('recap:' + today));
  const data = [], deposits = [];
  for (const it of items) {
    try {
      const ar = await plaid(env, '/accounts/get', { access_token: it.token });
      const code = ar.ok ? ar.body?.item?.error?.error_code || '' : ar.code;
      if (RECONNECT.has(code)) await reauthAlert(env, it);
      if (!ar.ok) { console.log('alerts: accounts unavailable', code || ar.status); continue; }
      // Counted accounts only: toggled-off accounts are dropped; loan/investment are off by default.
      const accounts = (ar.body.accounts || []).filter((a) => !off.has(a.account_id, a.type));
      for (const a of accounts) if (a.type === 'depository' && ALERT_SUBTYPES.has(a.subtype || '')) await balanceAlert(env, it.institution, a, now);
      const tr = await getTxns(env, it.token, addDays(today, -3), today);
      if (tr.r) {
        if (RECONNECT.has(tr.r.code) && !RECONNECT.has(code)) await reauthAlert(env, it);
        if (tr.r.code !== 'PRODUCT_NOT_READY') console.log('alerts: transactions unavailable', tr.r.code || tr.r.status);
      }
      const byId = new Map(accounts.map((a) => [a.account_id, a]));
      for (const t of tr.txns || []) {
        const a = byId.get(t.account_id);
        if (a?.type === 'depository' && t.amount < 0 && !t.pending && t.transaction_id) deposits.push({ t, label: acctLabel(it.institution, a) });
      }
      data.push({ it, accounts, txns: tr.txns || [] });
    } catch (e) { console.error('alerts: item failed', e?.name); }
  }
  await depositAlert(env, deposits);
  if (recapDue) {
    const recap = buildRecap(today, data, await loadSnapshot(env, now));
    if ((await sendEmail(env, recap)).sent) await env.BT_KV.put('recap:' + today, '1', { expirationTtl: RECAP_TTL });
  }
  return { items: items.length, recap: recapDue };
}

// ---------- app snapshot (budget data for the recap) ----------
const SNAPSHOT_MAX_BYTES = 10 * 1024;
const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (s, max = 80) => typeof s === 'string' && s.length <= max;
export function validateSnapshot(b) {
  const bad = (m) => { throw new HttpError(400, 'invalid snapshot: ' + m); };
  if (!b || typeof b !== 'object' || Array.isArray(b)) bad('object required');
  const c = b.cycle;
  if (!c || typeof c !== 'object' || Array.isArray(c)) bad('cycle required');
  if (!isYmd(c.start) || !isYmd(c.end)) bad('cycle.start/end must be YYYY-MM-DD');
  const cycle = { start: c.start, end: c.end };
  for (const k of ['left', 'needed', 'spent', 'due', 'income']) { if (!isNum(c[k])) bad(`cycle.${k} must be a number`); cycle[k] = c[k]; }
  const list = (v, name) => { if (v === undefined) return []; if (!Array.isArray(v) || v.length > 50) bad(`${name} must be an array of at most 50`); return v; };
  const upcoming = list(b.upcoming, 'upcoming').map((u) => {
    if (!u || !isStr(u.name) || !isYmd(u.date) || !isNum(u.amount)) bad('upcoming items need {name, date, amount}');
    return { name: u.name, date: u.date, amount: u.amount };
  });
  const budgets = list(b.budgets, 'budgets').map((x) => {
    if (!x || !isStr(x.name) || !isNum(x.spent) || !isNum(x.budget)) bad('budgets need {name, spent, budget}');
    return { name: x.name, spent: x.spent, budget: x.budget };
  });
  const review = b.review === undefined ? 0 : b.review;
  if (!Number.isInteger(review) || review < 0 || review > 100000) bad('review must be a non-negative integer');
  return { cycle, upcoming, budgets, review };
}
async function putSnapshot(env, req) {
  const raw = await req.text();
  if (enc.encode(raw).length > SNAPSHOT_MAX_BYTES) throw new HttpError(413, 'snapshot too large');
  let body;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid JSON'); }
  const data = validateSnapshot(body), at = new Date().toISOString();
  await env.BT_KV.put('snapshot', await encrypt(env, JSON.stringify({ data, at })));
  return { ok: true, at };
}

async function alertsTest(env) {
  const html = emailHtml('BudTracks alerts are on', hNote('You will get an email when a checking or savings balance drops below $20 or goes negative, when a deposit posts, and a recap every morning at 7am New York time.'));
  const r = await sendEmail(env, { subject: 'BudTracks alerts are on', html, text: 'BudTracks alerts are on.\n\nYou will get low-balance, overdraft and deposit alerts, plus a 7am recap.\n' });
  return r.sent ? { sent: true } : { sent: false, reason: r.reason };
}

// ---------- entry point ----------
export default {
  async scheduled(event, env, ctx) {
    const run = runAlerts(env, new Date(event?.scheduledTime || Date.now())).catch((e) => console.error('alerts: run failed', e?.name));
    if (ctx?.waitUntil) ctx.waitUntil(run);
    return run;
  },

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
        else if (m === 'GET' && path === '/balances') out = await getBalances(env);
        else if (m === 'GET' && path === '/status') out = await status(env);
        else if (m === 'POST' && path === '/balances/refresh') out = await balancesRefresh(env);
        else if (m === 'POST' && path === '/refresh') out = await refresh(env, url.searchParams.get('item') || '');
        else if (m === 'GET' && path === '/sync') out = await sync(env, url.searchParams.get('since'), url.searchParams.get('full') === '1', url.searchParams.get('ack') || '', url.searchParams.get('item') || '');
        else if (m === 'POST' && (mt = /^\/accounts\/([\w-]+)\/toggle$/.exec(path))) out = await toggle(env, mt[1], await readJson(req));
        else if (m === 'DELETE' && (mt = /^\/enroll\/([\w-]+)$/.exec(path))) out = await disconnect(env, mt[1]);
        else if (m === 'POST' && path === '/snapshot') out = await putSnapshot(env, req);
        else if (m === 'GET' && path === '/alerts/test') out = await alertsTest(env);
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
