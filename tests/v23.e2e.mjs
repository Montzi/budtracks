// v23: landscape layout: Overview chart card level with the brand bar, Income in two balanced columns, full-width brand bar on the other tabs.
// Run: node tests/v23.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
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

const TXS = () => [T('g1', TODAY, 'SHOPRITE 123', 41.2), T('g2', addD(TODAY, -1), 'KROGER 55', 55.1), T('dd', addD(TODAY, -2), 'DOORDASH*CHICK FIL A', 24.5, CHI, { providerCategory: 'dining' }), T('sh', addD(TODAY, -3), 'SHELL OIL 5521', 38)];
const noHScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'horizontal scroll at ' + label);
const go = async (page, tab) => { await page.evaluate(t => { location.hash = '#' + t; }, tab); await page.waitForFunction(t => document.querySelector('.app').dataset.tab === t, tab); await page.waitForTimeout(400); };
const R = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top + scrollY, b: r.bottom + scrollY, w: r.width, h: r.height }; }, sel);
const near = (a, b, d, msg) => assert.ok(Math.abs(a - b) <= d, msg + ': ' + a + ' vs ' + b);
const SIZES = [[1000, 703], [951, 669], [1366, 1024], [844, 390], [763, 390]];
const TABS = ['overview', 'transactions', 'bills', 'plans', 'income'];

const b = await pw.chromium.launch();
if (process.env.BT_SHOTS) for (const [w, h] of [[1000, 703], [951, 669], [1366, 1024], [844, 390], [390, 844]]) for (const dark of [true, false]) {
  const { ctx, page } = await newPage(w, h, { txns: TXS(), dark });
  for (const t of TABS) { await go(page, t); await page.screenshot({ path: `${SHOTS}/${t}-${w}x${h}-${dark ? 'd' : 'l'}.png`, fullPage: true }); }
  await ctx.close();
}
for (const [w, h] of [[1000, 703], [951, 669], [1366, 1024], [1180, 820]]) {
  const { ctx, page, errs } = await newPage(w, h, { txns: TXS() });
  await step(`${w}x${h} overview: chart card level with the brand bar and the cycle card`, async () => {
    await go(page, 'overview');
    const bb = await R(page, '#brandbar'), dn = await R(page, '.ov-donut'), hero = await R(page, '.ov > .hero');
    near(dn.t, bb.t, 2, 'donut top vs brandbar top'); near(dn.b, hero.b, 2, 'donut bottom vs hero bottom');
    assert.ok(dn.l >= bb.r, 'donut right of brandbar'); near(bb.l, hero.l, 1, 'brandbar over hero');
    const bills = await R(page, '.ov-bills'), bars = await R(page, '.ov-bars');
    assert.ok(bills.t >= hero.b + 8 && bars.t >= dn.b + 8, 'second row below first');
  });
  await step(`${w}x${h} income: two balanced columns, no gap`, async () => {
    await go(page, 'income');
    const cols = await page.evaluate(() => [...document.querySelectorAll('.inc-grid > .inc-col')].map(c => { const k = [...c.children].filter(e => e.getBoundingClientRect().height > 0); const r = k[0].getBoundingClientRect(); const rs = k.map(e => e.getBoundingClientRect()); let gap = 0; for (let i = 1; i < rs.length; i++) gap = Math.max(gap, rs[i].top - rs[i - 1].bottom); return { top: r.top + scrollY, gap, bottom: rs[rs.length - 1].bottom + scrollY, left: r.left }; }));
    assert.equal(cols.length, 2); near(cols[0].top, cols[1].top, 2, 'first card tops');
    cols.forEach(c => assert.ok(c.gap <= 18, 'gap inside column ' + c.gap));
    const lo = Math.min(cols[0].bottom, cols[1].bottom), hi = Math.max(cols[0].bottom, cols[1].bottom);
    assert.ok(lo / hi > .5, 'columns balanced: ' + lo + ' / ' + hi);
    assert.equal(await page.evaluate(() => document.querySelector('#settings').getBoundingClientRect().height), 0);
  });
  for (const tab of ['transactions', 'bills', 'plans', 'income']) await step(`${w}x${h} ${tab}: brand bar full width, logo centered`, async () => {
    await go(page, tab);
    const bb = await R(page, '#brandbar'), mn = await R(page, '#main'), wm = await R(page, '#brandbar .wm');
    near(bb.w, mn.w, 2, 'brandbar width vs main'); near((wm.l + wm.r) / 2, (bb.l + bb.r) / 2, 2, 'wm center');
    assert.ok(await page.evaluate(() => { const s = document.querySelector('.wm svg.arms'); return s && s.getBoundingClientRect().width > 100; }), 'arms drawn');
  });
  await step(`${w}x${h} no horizontal scroll on any tab, no page errors`, async () => {
    for (const tab of TABS) { await go(page, tab); await noHScroll(page, `${w}x${h} ${tab}`); }
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}
for (const [w, h] of [[844, 390], [763, 390]]) {
  const { ctx, page, errs } = await newPage(w, h, { txns: TXS() });
  await step(`${w}x${h} short landscape: no horizontal scroll, no overlap, no errors`, async () => {
    for (const tab of TABS) { await go(page, tab); await noHScroll(page, `${w}x${h} ${tab}`); }
    await go(page, 'overview');
    const dn = await R(page, '.ov-donut'), hero = await R(page, '.ov > .hero'), bb = await R(page, '#brandbar');
    near(dn.t, bb.t, 2, 'donut top'); near(dn.b, hero.b, 2, 'donut bottom');
    await go(page, 'income');
    const bb2 = await R(page, '#brandbar'), mn = await R(page, '#main'); near(bb2.w, mn.w, 2, 'full width');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}
{
  const { ctx, page, errs } = await newPage(1000, 703, { txns: TXS(), dark: true });
  await step('tab switch keeps the same brandbar element and redraws the logo', async () => {
    await page.evaluate(() => { window.__bb = document.getElementById('brandbar'); window.__wm = document.querySelector('#brandbar .wm'); });
    for (const t of ['bills', 'overview', 'income', 'overview']) await go(page, t);
    assert.ok(await page.evaluate(() => window.__bb === document.getElementById('brandbar') && window.__wm === document.querySelector('#brandbar .wm')));
    assert.equal(await page.evaluate(() => document.querySelectorAll('#brandbar svg.arms').length), 1);
  });
  await step('chat panel stays on screen on every tab', async () => {
    await go(page, 'overview');
    await page.evaluate(() => { document.querySelector('.wm svg.hd').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await page.waitForTimeout(300);
    for (const t of ['overview', 'bills', 'income']) {
      await go(page, t);
      if (await page.evaluate(() => document.getElementById('budchat').hidden)) await page.evaluate(() => document.querySelector('.wm svg.hd').dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await page.waitForTimeout(250);
      const r = await R(page, '#budchat .bc');
      assert.ok(r && r.l >= 8 && r.r <= 1000 - 8 && r.w <= 600, t + ' chat panel ' + JSON.stringify(r));
      if (t === 'overview') { const bb = await R(page, '#brandbar'); assert.ok(r.l >= bb.r, 'beside logo column'); }
    }
  });
  await step('goSettings (chat Settings button) scrolls the settings area to the top, landscape and portrait', async () => {
    await go(page, 'bills');
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('[data-action="settings"]').click(); });
    await page.waitForFunction(() => document.querySelector('.app').dataset.tab === 'income');
    await page.waitForTimeout(500);
    const y = await page.evaluate(() => document.querySelector('#settings').getBoundingClientRect().top);
    assert.ok(y >= -2 && y <= 40, 'anchor top ' + y);
  });
  await ctx.close();
}
for (const [w, h] of [[390, 844], [430, 932]]) {
  const { ctx, page, errs } = await newPage(w, h, { txns: TXS() });
  await step(`${w}x${h} portrait: brandbar, hero, donut stacked full width; income order unchanged`, async () => {
    await go(page, 'overview');
    const bb = await R(page, '#brandbar'), hero = await R(page, '.ov > .hero'), dn = await R(page, '.ov-donut'), mn = await R(page, '#main');
    near(bb.w, mn.w, 2, 'brandbar full'); near(hero.w, mn.w, 1, 'hero full'); near(dn.w, mn.w, 1, 'donut full');
    assert.ok(hero.t >= bb.b - 18 && hero.t <= bb.b + 2, 'hero joins bar'); assert.ok(dn.t > hero.b, 'donut below hero');
    await go(page, 'income');
    const ys = await page.evaluate(() => { const g = s => { const e = [...document.querySelectorAll('#main h2')].find(h => h.textContent.trim().startsWith(s)); return e ? e.getBoundingClientRect().top + scrollY : -1; }; return ['Latest paycheck', 'Categories', 'Paid via', 'Bank connections', 'Service logos', 'Ask Bud', 'Appearance', 'Your data'].map(g); });
    assert.ok(ys.every(y => y > 0), JSON.stringify(ys)); assert.deepEqual([...ys].sort((a, b) => a - b), ys, 'order ' + JSON.stringify(ys));
    await noHScroll(page, `${w}x${h} income`);
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}
await b.close();
if (failed) { console.log(failed + ' step(s) failed'); process.exit(1); }
console.log('all ok');
