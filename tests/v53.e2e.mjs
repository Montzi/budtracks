// v53: Match to a bill also lists bills already marked paid and older ones. Matching a paid one merges the two.
// Run: node tests/v53.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
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
const addSpend = async (page, desc, amt, cat) => {
  await page.click('.tx-hb [data-action="add"]'); await page.waitForSelector('#form');
  await page.selectOption('#form [name="category"]', cat);
  await page.fill('#form [name="desc"]', desc); await page.fill('#form [name="amount"]', String(amt));
  await page.click('#form button[type="submit"]'); await page.waitForSelector('#sheet', { state: 'hidden' });
};
for (const [w, h] of [[390, 844]]) {
  const fx = fixture({ income: [{ id: 'pay', name: 'Acme', freq: 'biweekly', date: PAY, amount: 2000, perCycle: { [PAY]: 2553.31 } }] });
  fx.bills.push({ id: 'loan', name: 'Loan bill', amount: 120, day: dayOf(TODAY), group: 'Fixed', category: 'Other', active: true });
  const { ctx, page, errs } = await newPage(w, h, { txns: TX(), hash: '#transactions', fixture: fx });
  await synced(page, true); await page.waitForSelector('.tx');
  await step('a bill you already marked paid is listed and merges with your entry', async () => {
    await addSpend(page, 'Sahomi Valdez', 120, 'Other');
    await page.click('.shot-w:has-text("Sahomi Valdez")'); await page.waitForSelector('#form');
    await page.click('[data-action="sp-match"]'); await page.waitForSelector('[data-action="spm-pick"]:has-text("Loan bill")');
    const key = await page.getAttribute('[data-action="spm-pick"]:has-text("Loan bill")', 'data-key');
    await page.click('#sheet .sheet-h [data-action="close"]'); await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.evaluate(k => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.marks[k] = true; localStorage.setItem('budtrack.v1', JSON.stringify(s)); }, key);
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.shot-w:has-text("Sahomi Valdez")');
    await page.click('.shot-w:has-text("Sahomi Valdez")'); await page.waitForSelector('#form');
    await page.click('[data-action="sp-match"]'); await page.waitForSelector('.pk-sec');
    const txt = await page.locator('#sheet .pk-list').innerText();
    assert.match(txt, /^Same amount\s+Loan bill/i, 'the paid Loan bill comes first: ' + txt.slice(0, 120));
    assert.match(txt, /Marked paid/i);
    await page.click('[data-action="spm-pick"]:has-text("Loan bill")'); await page.waitForSelector('#sheet', { state: 'hidden' });
    const s = await page.evaluate(k => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); return { n: s.spends.filter(x => x.desc === 'Sahomi Valdez').length, paid: s.marks[k] === true || !!(s.occ[k] && s.occ[k].checkedOn) }; }, key);
    assert.deepEqual(s, { n: 1, paid: true }); // v55: the entry stays
    assert.match(await page.locator('#toast').innerText(), /counts once/);
  });
  await step('no page errors', async () => { assert.deepEqual(errs, []); });
  await ctx.close();
}
await b.close();
finish();
