// v45: you can always rename the merchant of a bank line, whatever its status. Your name wins over the bank's and survives syncs.
// Run: node tests/v45.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const SHOTS = process.argv[2] || '/tmp';
const BASE = process.env.BT_URL || 'http://localhost:8765/';
const API = 'https://worker.test';
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n   ', String(e.message).split('\n').slice(0, 14).join('\n    ')); } };

const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const addD = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const TODAY = iso(new Date()), PAY = addD(TODAY, -4);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = s => MON[+s.slice(5, 7) - 1] + ' ' + +s.slice(8);
const dayOf = s => +s.slice(8);

const CO = { id: 'co1', name: 'Quicksilver', last4: '7777', institution: 'Capital One', type: 'credit' };
const CHI = { id: 'ch1', name: 'Checking', last4: '1111', institution: 'Chime', type: 'depository' };
const PPA = { id: 'pp1', name: 'PayPal Balance', last4: '', institution: 'PayPal', type: 'depository' };
const VNA = { id: 'vn1', name: 'Venmo', last4: '', institution: 'Venmo', type: 'depository' };
const T = (id, date, desc, amount, account, extra) => Object.assign({ id: 'pl:' + id, date, desc, rawDesc: desc, amount, account: account || CHI, status: 'posted', pendingOf: null, counterparty: null, providerCategory: null }, extra || {});

const CARDS = [{ id: 'visa', name: 'Visa', day: 12, minPayment: 35, balance: 500, limit: 2000 }, { id: 'amex', name: 'Amex', day: 20, minPayment: 60, balance: 1500, limit: 3000 }];
const DASH_DUE = addD(TODAY, -3), OLD_DUE = addD(TODAY, -50), LAMP_DUE = addD(TODAY, -6);
const KEY_DASH = 'b:dash:' + DASH_DUE, KEY_OLD = 'b:music:' + OLD_DUE;
const fixture = over => Object.assign({
  since: addD(TODAY, -1), marks: {}, occ: {}, unalloc: [], payVia: [], spends: [], cards: CARDS, plans: [{ id: 'lamp', provider: 'PayPal', merchant: 'Lamp', amount: 9.99, total: 4, paid: 1, freq: 'biweekly', lastDate: addD(TODAY, -20), dates: [addD(TODAY, -20), addD(TODAY, -6), addD(TODAY, 8), addD(TODAY, 22)], category: 'Other', autopay: true }],
  categories: ['Groceries', 'Gas', 'Takeout Food', 'Dining Out', 'Subscriptions', 'Other'], billCats: ['Housing', 'Subscriptions', 'Other'],
  income: [{ id: 'pay', name: 'Acme', freq: 'biweekly', date: PAY, amount: 2000 }],
  bills: [{ id: 'dash', name: 'DoorDash DashPass', amount: 9.99, day: dayOf(DASH_DUE), group: 'Subscriptions', category: 'Subscriptions', via: 'PayPal', active: true },
    { id: 'music', name: 'Music Club', amount: 9.99, day: dayOf(OLD_DUE), group: 'Subscriptions', category: 'Subscriptions', active: true },
    { id: 'rent', name: 'Rent', amount: 1050, day: dayOf(addD(TODAY, 6)), group: 'Fixed', category: 'Housing', active: true }],
  perPeriod: [{ id: 'groc', name: 'Groceries', amount: 150, category: 'Groceries' }],
  savings: { on: false, bank: '', tx: [] },
  bank: { seen: {}, rules: {}, links: {}, lastSync: null, inbox: [], api: API, autoFrom: addD(TODAY, -40), historyFrom: addD(TODAY, -90), txns: {} },
  settings: { view: 'biweekly', anchor: PAY, legendOpen: {}, billsView: '', chartRange: 'cycle' }
}, over || {});


async function newPage(w, h, o) {
  o = o || {};
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: o.dark ? 'dark' : 'light', deviceScaleFactor: 1 });
  const page = await ctx.newPage(); page.setDefaultTimeout(6000);
  const errs = [], calls = [], mock = { txns: o.txns || [], offline: false };
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  await page.route(u => !/localhost|worker\.test/.test(u.host), route => route.abort());
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ m, p });
    const json = (x, status) => route.fulfill({ status: status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(x) });
    if (p === '/config') return json({ provider: 'plaid', env: 'production', paired: true, ai: mock.ai || { claude: true, gemini: true } });
    if (p === '/accounts') return json({ enrollments: [{ id: 'enr_c', institution: 'Chime', accounts: [{ id: 'ch1', name: 'Checking', type: 'depository', subtype: 'checking', last_four: '1111', enabled: true }] }] });
    if (p === '/sync') return json({ txns: mock.txns, removed: mock.removed || [], errors: [], syncToken: 'tok', syncedAt: new Date().toISOString() });
    if (p === '/status') return json({ items: [], refresh: { supported: false, reason: 'no' }, balance: { supported: false, reason: 'no' }, env: 'production', at: new Date().toISOString() });
    if (p === '/snapshot') return json({ ok: true });
    if (p === '/ai') return json(mock.aiSt || { claude: { from: 'secret', length: 108, ends: 'wxyz' }, gemini: { from: 'secret', length: 53, ends: 'zRQQ' } });
    if (p === '/ai/key') { if (m === 'DELETE') return json({ ok: true }); const bd = JSON.parse(req.postData() || '{}'); mock.savedKey = bd; const k = bd.key.trim().replace('\u2014', '--'); return json({ ok: true, provider: bd.provider, length: k.length, ends: k.slice(-4) }); }
    if (p === '/ai/test') return json(mock.aiTest || { ok: true, from: 'app', length: 54, ends: 'zRQQ' });
    if (p === '/ask') { mock.asks = mock.asks || []; mock.asks.push(JSON.parse(req.postData() || '{}')); if (mock.askDelay) await new Promise(ok => setTimeout(ok, mock.askDelay)); return mock.askErr ? json({ error: mock.askErr[1] }, mock.askErr[0]) : json(mock.ask || { bubbles: ['You have $412 left this cycle after bills.', 'Groceries are $40 higher than last cycle, mostly Shoprite.', 'Rent is due in 6 days.'] }); }
    return json({ error: 'nope' }, 404);
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(([fx, extra]) => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1'));
    const f = JSON.parse(fx); Object.assign(s, f); Object.assign(s.settings, f.settings, extra || {});
    localStorage.setItem('budtrack.v1', JSON.stringify(s)); localStorage.setItem('budtrack.bankkey', 'secret-device-key-123');
  }, [JSON.stringify(o.fixture || fixture()), o.settings]);
  await page.goto(BASE + (o.hash || '#overview'), { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  if (!o.noSync) await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.lastSync);
  await page.waitForTimeout(500);
  return { ctx, page, errs, mock, calls };
}
const TX = () => [T('g1', TODAY, 'SHOPRITE 123', 41.2), T('g2', addD(TODAY, -1), 'KROGER 55', 55.1), T('sh', addD(TODAY, -3), 'SHELL OIL 5521', 38.4)];
const b = await pw.chromium.launch();
const { ctx, page, errs, mock } = await newPage(390, 844, { txns: TX(), hash: '#transactions' });
const row = id => `.tx[data-id="pl:${id}"]`;
const names = () => page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.names);
const rename = async (id, name) => {
  if (!(await page.$(row(id) + ' [data-action="tx-name"]'))) await page.click(row(id) + ' .tx-main');
  await page.click(row(id) + ' [data-action="tx-name"]');
  await page.fill('#txname', name);
  await page.click('[data-action="tx-name-save"]');
  await page.waitForTimeout(400);
};
const shown = id => page.$eval(row(id) + ' .tx-l b', e => e.textContent);
await step('Rename is offered on every bank line, whatever its status', async () => {
  const ids = await page.$$eval('.tx', l => l.map(e => e.dataset.id));
  assert.ok(ids.length >= 3, 'rows: ' + ids);
  for (const id of ids) {
    await page.click(`.tx[data-id="${id}"] .tx-main`);
    assert.ok(await page.$(`.tx[data-id="${id}"] [data-action="tx-name"]`), 'Rename missing on ' + id);
    await page.click(`.tx[data-id="${id}"] .tx-main`);
  }
});
await step('typing a name changes the row and is saved', async () => {
  await rename('g1', 'My Grocer');
  assert.equal(await shown('g1'), 'My Grocer');
  assert.equal((await names())['pl:g1'], 'My Grocer');
});
await step('the name survives a sync', async () => {
  await page.click('[data-action="bk-sync"]'); await page.waitForTimeout(1200);
  assert.equal(await shown('g1'), 'My Grocer');
});
await step('the name survives a reload', async () => {
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(600);
  assert.equal(await shown('g1'), 'My Grocer');
});
await step('a line you accepted keeps your name on its spending entry', async () => {
  await page.click(row('g2') + ' .tx-main');
  await page.click(row('g2') + ' [data-action="tx-cats"]');
  await page.click('[data-action="tx-cat"][data-cat="Groceries"]'); await page.waitForTimeout(400);
  await rename('g2', 'Corner Market');
  assert.equal(await shown('g2'), 'Corner Market');
  const d = await page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')).spends.map(s => s.desc));
  assert.ok(d.includes('Corner Market'), 'spend names: ' + d);
});
await step('a name typed in the spending form wins too', async () => {
  if (!(await page.$(row('g2') + ' [data-action="tx-edit"]'))) await page.click(row('g2') + ' .tx-main');
  await page.click(row('g2') + ' [data-action="tx-edit"]');
  await page.fill('#form [name="desc"]', 'Corner Deli');
  await page.click('#form button[type="submit"]'); await page.waitForTimeout(400);
  assert.equal(await shown('g2'), 'Corner Deli');
});
await step('Use bank name restores the bank name', async () => {
  await page.click(row('g1') + ' .tx-main');
  await page.click(row('g1') + ' [data-action="tx-name"]');
  await page.click('[data-action="tx-name-reset"]'); await page.waitForTimeout(400);
  assert.notEqual(await shown('g1'), 'My Grocer');
  assert.equal((await names())['pl:g1'], undefined);
});
await step('search finds the new name', async () => {
  await page.fill('#txq', 'corner deli'); await page.waitForTimeout(300);
  assert.equal((await page.$$('.tx')).length, 1);
});
await step('no page errors', async () => { assert.deepEqual(errs, []); });
await ctx.close(); await b.close();
if (failed) { console.log(failed + ' step(s) failed'); process.exit(1); }
console.log('all ok');
