// v48: bank cards show each account's balance, Sync and Disconnect sit in the same spot on every bank,
// Current balance beside Latest paycheck, colored category icons in Transactions.
// Run: node tests/v48.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
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
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: o.dark ? 'dark' : 'light', deviceScaleFactor: 1 });
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
for (const [w, h] of [[390, 844], [1000, 703]]) {
  const fx = fixture({ income: [{ id: 'pay', name: 'Acme', freq: 'biweekly', date: PAY, amount: 2000, perCycle: { [PAY]: 2553.31 } }] });
  const { ctx, page, errs } = await newPage(w, h, { txns: TX(), hash: '#income', fixture: fx });
  await synced(page, true); await page.waitForSelector('#bankcard .bk-enr');
  await step(`${w}x${h} bank cards show each account's balance`, async () => {
    const bal = await page.$$eval('#bankcard .bk-acc li', l => l.map(e => e.querySelector('.bk-bal') ? e.querySelector('.bk-bal').textContent : ''));
    assert.deepEqual(bal, ['$1,200.50', '$300.00', '-$20.25', 'Owed$500.00']);
  });
  await step(`${w}x${h} Sync and Disconnect line up on every bank`, async () => {
    const xs = await page.$$eval('#bankcard .bk-eh', l => l.map(e => ['bk-item-sync', 'bk-disc'].map(a => { const r = e.querySelector(`[data-action="${a}"]`).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.top - e.getBoundingClientRect().top)]; })));
    for (const x of xs) assert.deepEqual(x.map(v => v.slice(0, 2)), xs[0].map(v => v.slice(0, 2)), JSON.stringify(xs));
    for (const x of xs) assert.equal(x[0][2], x[1][2], 'same row ' + JSON.stringify(x));
    assert.equal(await page.locator('#bankcard .bk-eh b.long').count(), 1);
  });
  await step(`${w}x${h} Current balance sits beside Latest paycheck and matches In account`, async () => {
    const p = await R(page, '#latestpay .coll-h[data-k="pay"]'), c = await R(page, '#latestpay .coll-h[data-k="bal"]');
    near(p.t, c.t, 1, 'same row'); assert.ok(c.l >= p.r - 1, 'balance on the right');
    const v = await page.locator('#latestpay .pc-bal .pc-big').innerText();
    assert.equal(v, '$1,480.25');
    assert.equal(await page.locator('#latestpay .pill').count(), 0, 'no From your bank pill');
  });
  await step(`${w}x${h} each half opens and closes on its own`, async () => {
    await page.click('#latestpay .coll-h[data-k="bal"]');
    assert.ok(await page.locator('#coll-bal').isVisible()); assert.ok(await page.locator('#coll-pay').isHidden());
    assert.equal(await page.locator('#coll-bal .bk-acc li').count(), 3);
    await page.click('#latestpay .coll-h[data-k="pay"]');
    assert.ok(await page.locator('#coll-pay').isVisible()); assert.ok(await page.locator('#coll-bal').isVisible());
    await page.click('#latestpay .coll-h[data-k="bal"]'); assert.ok(await page.locator('#coll-bal').isHidden());
    await page.click('#latestpay .coll-h[data-k="pay"]');
    await page.screenshot({ path: `${SHOTS}/v48-income-${w}.png`, fullPage: true });
  });
  await step(`${w}x${h} category icons have a solid color, logos stay as they are`, async () => {
    await page.evaluate(() => { location.hash = '#transactions'; }); await page.waitForSelector('.tx');
    const bg = id => page.$eval(`.tx[data-id="pl:${id}"] .slogo`, e => [e.classList.contains('slogo-cat'), getComputedStyle(e).backgroundColor]);
    const [l1, l2, ue] = [await bg('l1'), await bg('l2'), await bg('ue')];
    assert.ok(l1[0] && l2[0], 'category icons'); assert.ok(!ue[0], 'Uber Eats keeps its logo');
    const surf = await page.evaluate(() => { const d = document.createElement('div'); d.style.background = 'var(--surface-2)'; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; });
    assert.notEqual(l1[1], surf); assert.notEqual(l2[1], surf);
    await page.screenshot({ path: `${SHOTS}/v48-tx-${w}.png` });
  });
  await step(`${w}x${h} no horizontal scroll, no page errors`, async () => { await noHScroll(page, 'tx'); assert.deepEqual(errs, []); });
  await ctx.close();
}
await b.close();
finish();
