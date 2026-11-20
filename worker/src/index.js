// BudTracks bank-sync Worker: a thin, single-user proxy to the Teller API.
// Tokens are AES-GCM encrypted in KV; the phone authenticates with a device key.

const TELLER = 'https://api.teller.io';
const MAX_PAGES = 10;      // safety cap on transaction pagination per account
const PAGE_SIZE = 100;

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
  if (env.TELLER_ENV === 'sandbox' && /^http:\/\/localhost(:\d+)?$/.test(origin)) return origin;
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

// ---------- Teller client ----------
// Basic auth: access token as username, empty password. mTLS via binding when present.
async function teller(env, token, path, init = {}) {
  const headers = { Authorization: 'Basic ' + btoa(token + ':'), Accept: 'application/json', ...(init.headers || {}) };
  const f = env.TELLER_CERT ? (u, i) => env.TELLER_CERT.fetch(u, i) : fetch;
  const res = await f(TELLER + path, { ...init, headers });
  let body = null;
  try { body = await res.json(); } catch { /* empty body (e.g. 204) */ }
  return { status: res.status, ok: res.ok, body };
}
// Disconnected / revoked enrollments surface as 401/403 or an enrollment.* error code.
const needsReconnect = (r) =>
  r.status === 401 || r.status === 403 || /^enrollment\./.test(r.body?.error?.code || '');
const tellerMsg = (r) => r.body?.error?.message || `Teller error ${r.status}`;

// ---------- KV storage of enrollments ----------
const enrKey = (id) => 'enr:' + id;
async function loadEnrollments(env) {
  const list = await env.BT_KV.list({ prefix: 'enr:' });
  const out = [];
  for (const k of list.keys) {
    const rec = JSON.parse(await env.BT_KV.get(k.name));
    out.push({ id: k.name.slice(4), institution: rec.institution, token: await decrypt(env, rec.token) });
  }
  return out;
}
const getOff = async (env) => new Set(JSON.parse((await env.BT_KV.get('off')) || '[]'));

const shapeAccount = (a) => ({
  id: a.id, name: a.name, type: a.type, subtype: a.subtype, last_four: a.last_four,
  institution: a.institution?.name || '',
});

// ---------- transaction normalization ----------
// Teller sign convention (verify against docs): depository debits are negative;
// credit-card purchases are positive. We output positive = money out for both.
export function normalizeTxn(t, acct) {
  const raw = parseFloat(t.amount);
  const amount = acct.type === 'credit' ? raw : -raw;
  return {
    id: 'tl:' + t.id,
    date: t.date,
    desc: t.description,
    amount: Math.round(amount * 100) / 100 || 0, // avoid -0
    account: { id: acct.id, name: acct.name, last4: acct.last_four, institution: acct.institution?.name || '', type: acct.type },
    status: t.status,
    counterparty: t.details?.counterparty?.name || null,
    tellerCategory: t.details?.category || null,
  };
}

// Fetch transactions newest-first, paging with from_id until older than `since`.
async function fetchTxns(env, token, acct, since) {
  const txns = [];
  let from = null;
  for (let p = 0; p < MAX_PAGES; p++) {
    const r = await teller(env, token, `/accounts/${acct.id}/transactions?count=${PAGE_SIZE}` + (from ? `&from_id=${from}` : ''));
    if (!r.ok) return { r };
    const page = r.body || [];
    for (const t of page) if (!since || t.date >= since) txns.push(normalizeTxn(t, acct));
    if (page.length < PAGE_SIZE || (since && page[page.length - 1].date < since)) break;
    from = page[page.length - 1].id;
  }
  return { txns };
}

// ---------- route handlers ----------
async function pair(env) {
  if (await env.BT_KV.get('key_hash')) throw new HttpError(409, 'already paired');
  const key = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.BT_KV.put('key_hash', b64(await sha256(key)));
  return { key };
}

async function enroll(env, body) {
  const { accessToken, enrollmentId, institution } = body || {};
  if (!accessToken || !enrollmentId) throw new HttpError(400, 'accessToken and enrollmentId required');
  const r = await teller(env, accessToken, '/accounts');
  if (!r.ok) throw new HttpError(502, tellerMsg(r)); // don't store a token that doesn't work
  await env.BT_KV.put(enrKey(enrollmentId), JSON.stringify({
    token: await encrypt(env, accessToken),
    institution: institution?.name || institution || r.body?.[0]?.institution?.name || '',
    enrolledAt: new Date().toISOString(),
  }));
  return { enrollmentId, accounts: r.body.map(shapeAccount) };
}

async function accounts(env) {
  const off = await getOff(env);
  const enrollments = [];
  for (const e of await loadEnrollments(env)) {
    const r = await teller(env, e.token, '/accounts');
    if (r.ok) enrollments.push({ id: e.id, institution: e.institution, accounts: r.body.map((a) => ({ ...shapeAccount(a), enabled: !off.has(a.id) })) });
    else enrollments.push({ id: e.id, institution: e.institution, accounts: [], needsReconnect: needsReconnect(r), error: tellerMsg(r) });
  }
  return { enrollments };
}

async function sync(env, since) {
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new HttpError(400, 'since must be YYYY-MM-DD');
  const off = await getOff(env);
  const txns = [], errors = [];
  for (const e of await loadEnrollments(env)) {
    const ar = await teller(env, e.token, '/accounts');
    if (!ar.ok) { errors.push({ enrollmentId: e.id, institution: e.institution, message: tellerMsg(ar), needsReconnect: needsReconnect(ar) }); continue; }
    for (const a of ar.body.filter((x) => !off.has(x.id))) {
      const res = await fetchTxns(env, e.token, a, since);
      if (res.txns) txns.push(...res.txns);
      else errors.push({ enrollmentId: e.id, institution: e.institution, message: `${a.name}: ${tellerMsg(res.r)}`, needsReconnect: needsReconnect(res.r) });
    }
  }
  txns.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  return { txns, errors, syncedAt: new Date().toISOString() };
}

async function toggle(env, accountId, body) {
  if (typeof body?.enabled !== 'boolean') throw new HttpError(400, 'enabled (boolean) required');
  const off = await getOff(env);
  body.enabled ? off.delete(accountId) : off.add(accountId);
  await env.BT_KV.put('off', JSON.stringify([...off]));
  return { id: accountId, enabled: body.enabled };
}

async function disconnect(env, id) {
  const raw = await env.BT_KV.get(enrKey(id));
  if (!raw) throw new HttpError(404, 'unknown enrollment');
  const token = await decrypt(env, JSON.parse(raw).token);
  const r = await teller(env, token, '/accounts');
  if (r.ok) for (const a of r.body) await teller(env, token, `/accounts/${a.id}`, { method: 'DELETE' }); // best effort
  await env.BT_KV.delete(enrKey(id));
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
        out = { tellerAppId: env.TELLER_APP_ID, tellerEnv: env.TELLER_ENV, paired: !!(await env.BT_KV.get('key_hash')) };
      } else if (m === 'POST' && path === '/pair') {
        out = await pair(env);
      } else {
        await requireAuth(env, req);
        let mt;
        if (m === 'POST' && path === '/enroll') out = await enroll(env, await readJson(req));
        else if (m === 'GET' && path === '/accounts') out = await accounts(env);
        else if (m === 'GET' && path === '/sync') out = await sync(env, url.searchParams.get('since'));
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
