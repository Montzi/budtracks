// v70, v71: Bud's face and glasses are lit by his laptop screen. v72: each tab has its own page. The page scrolls down and up with 10 s rests.
// Run: node tests/v64.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import assert from 'node:assert/strict';
import { pw, SHOTS, BASE, API, iso, addD, step, finish, prep, synced, near } from './lib.mjs';

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
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true, serviceWorkers: 'block', colorScheme: o.dark ? 'dark' : 'light', deviceScaleFactor: 1 });
  const page = await ctx.newPage(); await prep(page);
  const errs = [], calls = [], mock = { txns: o.txns || [], offline: false };
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.route(u => !/localhost|worker\.test/.test(u.host), route => route.abort());
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ m, p });
    const json = (x, status) => route.fulfill({ status: status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(x) });
    if (p === '/config') return json({ provider: 'plaid', env: 'production', paired: true, ai: mock.ai || { claude: true, gemini: true } });
    if (p === '/accounts') return json({ enrollments: ENR });
    if (p === '/sync') return json({ txns: mock.txns, removed: mock.removed || [], errors: [], syncToken: 'tok', syncedAt: new Date().toISOString(), balances: BAL });
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
  if (!o.noSync) await synced(page);
  await page.waitForTimeout(500);
  return { ctx, page, errs, mock, calls };
}
const noHScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'horizontal scroll at ' + label);
const R = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top + scrollY, b: r.bottom + scrollY, w: r.width, h: r.height }; }, sel);
const ACC = (id, name, four, type) => ({ id, name, type: type || 'depository', subtype: 'checking', last_four: four, enabled: true });
const ENR = [{ id: 'enr_c', institution: 'Chime', accounts: [ACC('ch1', 'Checking', '1111')] },
  { id: 'enr_s', institution: 'Santander - Personal', accounts: [ACC('sa1', 'SIMPLY RIGHT CHECKING - *6429', '6429')] },
  { id: 'enr_p', institution: 'PNC', accounts: [ACC('pn1', 'Spend', '3941'), ACC('pnc', 'Visa', '4242', 'credit')] }];
const BA = (id, name, mask, v, x) => Object.assign({ id, name, mask, type: 'depository', subtype: 'checking', available: v, current: v }, x || {});
const BAL = [{ itemId: 'enr_c', institution: 'Chime', accounts: [BA('ch1', 'Checking', '1111', 1200.5)] },
  { itemId: 'enr_s', institution: 'Santander - Personal', accounts: [BA('sa1', 'SIMPLY RIGHT CHECKING - *6429', '6429', 300)] },
  { itemId: 'enr_p', institution: 'PNC', accounts: [BA('pn1', 'Spend', '3941', -20.25), BA('pnc', 'Visa', '4242', 1500, { type: 'credit', subtype: 'credit card', current: 500 })] }];
const TX = () => [T('l1', TODAY, 'DURAN LAUNDROMAT', 23.98), T('l2', TODAY, 'EL MESON', 31.5), T('ue', TODAY, 'UBER EATS', 18.2)];
const b = await pw.chromium.launch();
const tabsBox = page => page.evaluate(() => { const n = document.querySelector('.tabs').getBoundingClientRect(), a = [...document.querySelectorAll('.tabs a')].map(e => e.getBoundingClientRect()); return { n: { l: n.left, r: n.right, t: n.top, b: n.bottom, w: n.width }, xs: a.map(r => Math.round(r.left)), ys: a.map(r => Math.round(r.top)) }; });
const isRail = page => page.evaluate(() => document.documentElement.classList.contains('rail'));
const fakeColumn = (page, px) => page.addStyleTag({ content: `#railprobe { padding-right: ${px}px !important; }` }).then(() => page.evaluate(() => dispatchEvent(new Event('resize'))));
{
  const { ctx, page, errs } = await newPage(390, 844, { txns: TX(), hash: '#overview', fixture: fixture() });
  await page.waitForSelector('.wm svg.hd');
  const shown = () => page.evaluate(() => { const h = document.querySelector('.wm svg.hd'); return { pages: [...h.querySelectorAll('.scr-lens > g')[0].children].map(g => getComputedStyle(g).display !== 'none'), color: getComputedStyle(h).color, scr: document.documentElement.dataset.scr }; });
  await step('Bud is lit by his screen, with one scrolling page in each lens', async () => {
    const m = await page.evaluate(() => { const h = document.querySelector('.wm svg.hd'); const ids = [...document.querySelectorAll('svg [id^="bs"]')].map(e => e.id);
      return { pages: h.querySelectorAll('.scr-pg').length, glow: !!h.querySelector('.scr-glow'), sc: getComputedStyle(h.querySelector('.scr-sc')).animationName, unique: new Set(ids).size === ids.length }; });
    assert.equal(m.pages, 10); assert.ok(m.glow); assert.equal(m.sc, 'budScroll', 'the page scrolls'); assert.ok(m.unique);
    const s = await shown(); assert.equal(s.pages.filter(Boolean).length, 1, 'one page at a time');
  });
  await step('each tab has its own page, and it holds', async () => {
    assert.equal((await shown()).scr, '0', 'Overview');
    await page.waitForTimeout(3500); assert.equal((await shown()).scr, '0', 'still the same after 3 s');
    for (const [tab, i] of [['transactions', '1'], ['bills', '2'], ['plans', '3'], ['income', '4'], ['overview', '0']]) {
      const t0 = Date.now(); await page.evaluate(h => { location.hash = '#' + h; }, tab);
      await page.waitForFunction(v => document.documentElement.dataset.scr === v, i, { timeout: 1000 }); assert.ok(Date.now() - t0 < 1000, tab);
      const s = await shown(); assert.equal(s.pages.filter(Boolean).length, 1);
    }
  });
  await step('the page scrolls down and back up, with rests', async () => {
    const d = await page.evaluate(() => getComputedStyle(document.querySelector('.scr-sc')).animationDuration); assert.equal(d, '30s');
    const ys = await page.evaluate(() => { const e = document.querySelector('.wm svg.hd .scr-sc'), a = e.getAnimations()[0]; a.pause();
      return [1500, 3000, 12000, 16000, 25000, 29999].map(ms => { a.currentTime = ms; return Math.round(new DOMMatrix(getComputedStyle(e).transform).f); }); });
    assert.deepEqual([ys[1], ys[2]], [-14, -14], 'rests 10 s down'); assert.deepEqual([ys[3], ys[4]], [-6, -6], 'scrolled back up, rests');
    assert.ok(ys[0] < 0 && ys[0] > -14 && ys[5] > -6, 'moves between rests ' + ys);
    await page.locator('.wm').first().screenshot({ path: `${SHOTS}/v72-bud.png` });
  });
  await step('an open sheet covers Bud\'s bubble', async () => {
    await page.evaluate(() => { location.hash = '#transactions'; }); await page.waitForFunction(() => document.querySelector('#bud.on'));
    await page.evaluate(() => { location.hash = '#overview'; }); await page.waitForSelector('[data-action="account"]');
    await page.click('[data-action="account"]'); await page.waitForSelector('#sheet:not([hidden])');
    await page.evaluate(() => { location.hash = '#transactions'; }); await page.evaluate(() => { location.hash = '#overview'; });
    const m = await page.evaluate(() => { const b = document.querySelector('#bud'), r = b.getBoundingClientRect();
      return { on: b.classList.contains('on') && r.width > 0, top: r.width ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('#bud') !== null : false, z: getComputedStyle(b).zIndex }; });
    assert.equal(m.z, '30', 'below the sheet'); if (m.on) assert.equal(m.top, false, 'the sheet is on top');
    await page.screenshot({ path: `${SHOTS}/v73-sheet.png` });
  });
  await step('no page errors', async () => { assert.deepEqual(errs, []); });
  await ctx.close();
}
await b.close();
finish();
