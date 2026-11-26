// Checks for v13: "Bills & Finance" split into its own groups, sub-categories you add yourself (manager "+ Add", "Under" on new
// categories, any category moved under any group) followed by pickers and the chart; Plaid status on the bank card and in a
// "Plaid status" sheet; honest toasts for Refresh balances (real-time or not in the plan) and Sync now (refresh not available);
// and matching a late bank line to a past, assumed-paid bill from the picker's Earlier / Best match lists.
// Run: node tests/v13.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import assert from 'node:assert/strict';
import { pw, SHOTS, BASE, API, iso, addD, step, finish, prep, synced } from './lib.mjs';

const TODAY = iso(new Date()), PAY = addD(TODAY, -1), dayOf = n => +addD(TODAY, n).slice(8);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = s => MON[+s.slice(5, 7) - 1] + ' ' + +s.slice(8);
// Plaid's update times, a few hours back (local time), and how the app writes them: "9:12 AM", or "Nov 21, 6:40 PM" on another day.
const ago = mins => { const d = new Date(Date.now() - mins * 60000); d.setSeconds(0, 0); return d.toISOString(); };
const clock = s => new Date(s).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const when = s => (iso(new Date(s)) === TODAY ? '' : md(iso(new Date(s))) + ', ') + clock(s);
const T912 = ago(5 * 60 + 3), CHIME_OK = ago(26 * 60), CHIME_FAIL = ago(47);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SAN = { id: 'sa1', name: 'Checking', last4: '6429', institution: 'Santander', type: 'depository' };
const CHI = { id: 'ch1', name: 'Checking', last4: '1111', institution: 'Chime', type: 'depository' };
const T = (id, date, desc, amount, account, extra) => Object.assign({ id: 'pl:' + id, date, desc, rawDesc: desc, amount, account, status: 'posted', pendingOf: null, counterparty: null, providerCategory: null }, extra || {});
const UHF_DUE = addD(TODAY, -5), NFX_DUE = addD(TODAY, -6);
const TXNS = () => [
  T('pay', PAY, 'ACME PAYROLL', -2000, SAN),
  T('apple', PAY, 'APPLE.COM/BILL', 1.99, SAN),                 // late: the UHF bill was due 4 days before
  T('nfx', PAY, 'NETFLIX.COM', 15.49, CHI),                     // the Netflix bill was already marked paid
  T('shell', TODAY, 'SHELL OIL 5521', 38, SAN, { status: 'pending' }),
  T('g1', TODAY, 'SHOPRITE 123', 41.2, SAN)
];
const A = (id, name, mask, available, extra) => Object.assign({ id, name, mask, type: 'depository', subtype: 'checking', available, current: available, limit: null, currency: 'USD', enabled: true }, extra || {});
const BAL = () => [{ itemId: 'enr_s', institution: 'Santander', accounts: [A('sa1', 'Checking', '6429', 1200)] }, { itemId: 'enr_c', institution: 'Chime', accounts: [A('ch1', 'Checking', '1111', 300)] }];
const NOREF = "Transactions Refresh isn't enabled for this Plaid account", NOBAL = "Real-time refresh isn't included in your Plaid plan";
const STATUS = () => ({
  items: [
    { itemId: 'enr_s', institution: 'Santander', lastSuccessfulUpdate: T912, lastFailedUpdate: null, error: null, needsReconnect: false, products: ['transactions'], consentExpiration: null, webhook: null,
      refresh: { supported: false, reason: NOREF, code: 'PRODUCT_NOT_ENABLED' }, balance: { supported: false, reason: NOBAL, code: 'INVALID_PRODUCT' }, newestTxn: TODAY },
    { itemId: 'enr_c', institution: 'Chime', lastSuccessfulUpdate: CHIME_OK, lastFailedUpdate: CHIME_FAIL, error: { code: 'ITEM_LOGIN_REQUIRED', message: 'the login details of this item have changed', type: 'ITEM_ERROR' },
      needsReconnect: true, products: ['transactions'], consentExpiration: null, webhook: null, refresh: null, balance: null }
  ],
  refresh: { supported: false, reason: NOREF }, balance: { supported: false, reason: NOBAL }, env: 'production', at: new Date().toISOString()
});
const fixture = () => ({
  since: addD(TODAY, -4), marks: { ['b:nfx:' + NFX_DUE]: true }, occ: { ['b:nfx:' + NFX_DUE]: { paidOn: NFX_DUE } }, unalloc: [], payVia: [], spends: [], cards: [], plans: [],
  categories: ['Groceries', 'Gas', 'Takeout Food', 'Fees', 'Bills & Finance', 'Other'], billCats: ['Housing', 'Subscriptions', 'Phone & Internet', 'Loans', 'Taxes', 'Other'],
  catParents: { Groceries: 'Food', Gas: 'Transportation', 'Takeout Food': 'Food', 'Phone & Internet': 'Bills & Finance', Loans: 'Bills & Finance', Taxes: 'Bills & Finance', Fees: 'Bills & Finance' },
  income: [{ id: 'pay', name: 'Acme', freq: 'biweekly', date: PAY, amount: 2000 }],
  bills: [{ id: 'rent', name: 'Rent', amount: 1050, day: dayOf(3), group: 'Fixed', category: 'Housing', active: true },
    { id: 'uhf', name: 'UHF IPVT Player', amount: 1.99, day: +UHF_DUE.slice(8), group: 'Apple Subscriptions', category: '', active: true },
    { id: 'nfx', name: 'Netflix', amount: 15.49, day: +NFX_DUE.slice(8), group: 'Subscriptions', category: 'Subscriptions', active: true },
    { id: 'ph', name: 'Phone', amount: 60, day: dayOf(6), group: 'Fixed', category: 'Phone & Internet', active: true }],
  perPeriod: [{ id: 'groc', name: 'Groceries', amount: 150, category: 'Groceries' }],
  savings: { on: false, bank: '', tx: [] },
  bank: { seen: {}, rules: {}, links: {}, lastSync: null, inbox: [], api: API, autoFrom: addD(TODAY, -30), historyFrom: addD(TODAY, -60), txns: {} },
  settings: { view: 'biweekly', anchor: PAY, legendOpen: {}, billsView: '', chartRange: 'cycle' }
});

const b = await pw.chromium.launch();
async function newPage(w, h, o) {
  o = o || {};
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: o.dark ? 'dark' : 'light', deviceScaleFactor: 1 });
  const page = await ctx.newPage(); await prep(page);
  const errs = [], calls = [];
  const mock = { txns: TXNS(), balances: BAL(), status: STATUS(), refreshResp: { refreshed: false, notEnabled: true, results: [{ itemId: 'enr_s', institution: 'Santander', refreshed: false, reason: NOREF, code: 'PRODUCT_NOT_ENABLED', notEnabled: true }, { itemId: 'enr_c', institution: 'Chime', refreshed: false, reason: NOREF, code: 'PRODUCT_NOT_ENABLED', notEnabled: true }] }, balResp: null };
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ m, p, q: u.search });
    const json = (x, status) => route.fulfill({ status: status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(x) });
    if (p === '/config') return json({ provider: 'plaid', env: 'production', paired: true });
    if (p === '/accounts') return json({ enrollments: [{ id: 'enr_s', institution: 'Santander', accounts: [{ id: 'sa1', name: 'Checking', type: 'depository', subtype: 'checking', last_four: '6429', enabled: true }] },
      { id: 'enr_c', institution: 'Chime', accounts: [{ id: 'ch1', name: 'Checking', type: 'depository', subtype: 'checking', last_four: '1111', enabled: true }] }] });
    if (p === '/sync') return json({ txns: mock.txns, removed: [], errors: [], syncToken: 'tok', syncedAt: new Date().toISOString(), balances: mock.balances });
    if (p === '/refresh') return json(mock.refreshResp);
    if (p === '/status') return json(mock.status);
    if (p === '/balances/refresh' && m === 'POST') return mock.balResp ? json(mock.balResp) : json({ error: 'nope' }, 404);
    if (p === '/snapshot') return json({ ok: true });
    return json({ error: 'nope' }, 404);
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(([fx, extra]) => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1'));
    const f = JSON.parse(fx); Object.assign(s, f); Object.assign(s.settings, f.settings, extra || {});
    s.imports = (s.imports || []).filter(k => k !== 'cats-v5');   // an older user: the split has not run yet
    localStorage.setItem('budtrack.v1', JSON.stringify(s)); localStorage.setItem('budtrack.bankkey', 'secret-device-key-123');
  }, [JSON.stringify(fixture()), o.settings]);
  await page.evaluate(h => history.replaceState(null, '', location.pathname + h), o.hash || ''); await page.reload({ waitUntil: 'load' }); // one load: see v12
  await synced(page, true);
  await page.waitForTimeout(250);
  return { ctx, page, errs, mock, calls };
}
const noHScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'horizontal scroll at ' + label);
const sheetNoHScroll = async (page, label) => assert.ok(await page.evaluate(() => { const s = document.querySelector('#sheet .sheet'); return s && s.scrollWidth <= s.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; }), 'sheet scrolls sideways at ' + label);
const quiet = page => page.evaluate(() => { const t = document.querySelector('#toast'); t.style.transition = 'none'; t.classList.remove('on'); const bud = document.querySelector('#bud'); if (bud) bud.style.display = 'none'; });
const getState = page => page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')));
const toastText = page => page.locator('#toast').innerText();
const waitToast = (page, rx) => page.waitForFunction(r => new RegExp(r).test(document.querySelector('#toast').innerText), rx.source, { timeout: 8000 });
const clearToast = page => page.evaluate(() => { const t = document.querySelector('#toast'); t.textContent = ''; t.classList.remove('on'); });
const openCats = async page => { await page.goto(BASE + '#income'); await page.waitForSelector('[data-k="cat"]'); if (await page.getAttribute('[data-k="cat"]', 'aria-expanded') !== 'true') await page.click('[data-k="cat"]'); await page.waitForSelector('.cat-list'); };

/* ---------- 1. Categories: the split, sub-items, pickers, chart ---------- */
{
  const { ctx, page, errs } = await newPage(390, 844, { dark: true, hash: '#income' });
  await step('cats-v5: Phone & Internet, Loans, Taxes, Fees are groups; unused "Bills & Finance" is gone', async () => {
    const s = await getState(page);
    assert.ok(s.imports.includes('cats-v5'));
    assert.ok(!Object.values(s.catParents).includes('Bills & Finance'), JSON.stringify(s.catParents));
    assert.ok(!s.categories.includes('Bills & Finance') && !s.billCats.includes('Bills & Finance'));
    await openCats(page);
    const heads = await page.locator('.cat-gh > span').allInnerTexts();
    ['Phone & Internet', 'Loans', 'Taxes', 'Fees'].forEach(g => assert.ok(heads.some(h => h.toLowerCase() === g.toLowerCase()), g + ' in ' + heads));
    assert.ok(!heads.some(h => /bills & finance/i.test(h)));
    // An empty group can be moved; its select says "Own group".
    assert.equal(await page.locator('select.cat-par[data-cat="Fees"]').inputValue(), 'Fees');
  });
  await step('"+ Add" under Transportation adds "Toll tags"; a new group "Pets" (Under: none) gets "Vet" through its own "+ Add"', async () => {
    await page.locator('.cat-gh', { hasText: 'Transportation' }).locator('[data-action="cat-sub"]').first().click();
    await page.waitForSelector('.cat-subf input[name="nc"]'); await page.waitForFunction(() => document.activeElement && document.activeElement.matches('.cat-subf input[name="nc"]'));
    await page.fill('.cat-subf input[name="nc"]', 'Toll tags'); await page.click('.cat-subf button[type=submit]');
    let s = await getState(page); assert.equal(s.catParents['Toll tags'], 'Transportation'); assert.ok(s.billCats.includes('Toll tags') || s.categories.includes('Toll tags'));
    assert.equal(await page.locator('.cat-subf').count(), 0, 'inline form closes');
    await page.fill('#nc-s', 'Pets'); assert.equal(await page.locator('#np-s').inputValue(), '', 'defaults to its own group');
    await page.click('.cat-add[data-list="categories"]:not(.cat-subf) button[type=submit]');
    s = await getState(page); assert.equal(s.catParents.Pets, 'Pets');
    await page.locator('.cat-gh', { hasText: 'Pets' }).locator('[data-action="cat-sub"]').last().click();
    await page.fill('.cat-subf input[name="nc"]', 'Vet'); await page.keyboard.press('Enter');
    s = await getState(page); assert.equal(s.catParents.Vet, 'Pets');
    const pets = await page.locator('.cat-gh', { hasText: 'Pets' }).last().evaluate(h => [...h.nextElementSibling.querySelectorAll('.cn')].map(e => e.textContent));
    assert.deepEqual(pets, ['Pets', 'Vet']);
    const petsRow = await page.evaluate(() => { const li = [...document.querySelectorAll('.cat-list li')].find(l => l.querySelector('.cn').textContent === 'Pets'); return { grp: !!li.querySelector('.cat-grp'), sel: !!li.querySelector('select') }; });
    assert.deepEqual(petsRow, { grp: true, sel: false }, 'a group with children stays a group');
  });
  await step('any category can be moved under any group, user groups included; and back to its own group', async () => {
    const opts = await page.locator('select.cat-par[data-cat="Gas"] option').allInnerTexts();
    ['Pets', 'Phone & Internet', 'Loans', 'Taxes', 'Fees', 'Food', 'Other'].forEach(g => assert.ok(opts.includes(g), g + ' in ' + opts));
    await page.selectOption('select.cat-par[data-cat="Fees"]', 'Home');
    let s = await getState(page); assert.equal(s.catParents.Fees, 'Home');
    assert.ok(!(await page.locator('.cat-gh > span').allInnerTexts()).some(h => h.toLowerCase() === 'fees'), 'Fees no longer a group');
    await page.selectOption('select.cat-par[data-cat="Fees"]', 'Fees');
    s = await getState(page); assert.equal(s.catParents.Fees, 'Fees');
    await noHScroll(page, '390 cat manager');
    await page.evaluate(() => { const s = document.querySelector('.cat-gh'); [...document.querySelectorAll('.cat-gh')].find(h => /Transportation/i.test(h.textContent)).scrollIntoView({ block: 'start' }); window.scrollBy(0, -60); });
    await quiet(page); await page.waitForTimeout(250); await page.screenshot({ path: SHOTS + '/catmgr-v13-390.png' });
  });
  await step('spending form: "Or new category" shows "Under"; "Dog food" under Pets; select groups follow catParents', async () => {
    await page.goto(BASE + '#overview'); await page.waitForSelector('.ov-bills');
    await page.click('.ov-bills [data-action="add"]'); await page.waitForSelector('#form');
    if (await page.locator('#f-newcat').count() === 0) { await page.click('.kind-seg [data-type="extra"]'); await page.waitForSelector('#f-newcat'); }
    const groups = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#f-category optgroup')].map(g => [g.label, [...g.children].map(o => o.value)])));
    assert.deepEqual(groups.Pets, ['Pets', 'Vet']); assert.ok(groups.Transportation.includes('Toll tags')); assert.ok(!('Bills & Finance' in groups));
    assert.deepEqual(groups['Phone & Internet'], ['Phone & Internet']);
    assert.ok(await page.locator('.nc-under').isHidden(), 'hidden until a name is typed');
    await page.fill('#f-newcat', 'Dog food'); assert.ok(await page.locator('.nc-under').isVisible());
    const underOpts = await page.locator('#f-newpar option').allInnerTexts(); assert.equal(underOpts[0], 'None (own group)'); assert.ok(underOpts.includes('Pets'));
    await page.selectOption('#f-newpar', 'Pets'); await page.fill('#f-amount', '23'); await page.fill('#f-desc', 'Chewy');
    const bx = await page.evaluate(() => { const r = id => document.querySelector(id).closest('label').getBoundingClientRect(); return [r('#f-newcat').top, r('#f-note').top]; });
    assert.ok(Math.abs(bx[0] - bx[1]) < 2, 'Note still beside "Or new category"');
    await sheetNoHScroll(page, '390 spend form');
    await page.click('#form button[type=submit]');
    const s = await getState(page); assert.equal(s.catParents['Dog food'], 'Pets'); assert.ok(s.spends.some(x => x.category === 'Dog food' && x.amount === 23));
  });
  await step('the chart legend groups by catParents: Pets holds Dog food and Vet; Transportation holds Toll tags', async () => {
    await page.evaluate(([d]) => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.spends.push({ id: 'v1', category: 'Vet', desc: 'Vet visit', amount: 80, date: d, via: '', note: '' }, { id: 't1', category: 'Toll tags', desc: 'E-ZPass', amount: 25, date: d, via: '', note: '' });
      s.settings.legendOpen = { Pets: true, Transportation: true }; localStorage.setItem('budtrack.v1', JSON.stringify(s)); }, [TODAY]);
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.cat-legend');
    assert.match(await page.locator('.cat-legend li[data-g="Pets"] .lg-kids').innerText(), /Vet[\s\S]*Dog food|Dog food[\s\S]*Vet/);
    assert.match(await page.locator('.cat-legend li[data-g="Transportation"] .lg-kids').innerText(), /Toll tags/);
    assert.equal(await page.locator('.cat-legend li[data-g="Bills & Finance"]').count(), 0);
    assert.equal(await page.locator('.cat-legend li[data-g="Phone & Internet"]').count(), 1, 'Phone bill rolls up to its own group');
  });
  assert.deepEqual(errs, [], 'page errors (categories)');
  await ctx.close();
}
{
  // Bills & Finance still used by a bill: kept, as its own group.
  const { ctx, page, errs } = await newPage(669, 951, { dark: false, hash: '#income' });
  await step('669: category manager fits; in light mode too', async () => {
    await openCats(page); await noHScroll(page, '669 cat manager');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 2. Plaid status on the bank card and in the sheet ---------- */
for (const [w, h, dark] of [[390, 844, true], [669, 951, false], [951, 669, true]]) {
  const { ctx, page, errs, calls } = await newPage(w, h, { dark, hash: '#income' });
  await step(`${w}x${h}: bank card shows when Plaid last got data per bank, and an error badge for Chime`, async () => {
    await page.waitForSelector('#bankcard .bk-plaid');
    assert.ok(calls.some(c => c.p === '/status'), 'status loaded when the card renders');
    const san = await page.locator('.bk-enr', { hasText: 'Santander' }).locator('.bk-plaid').innerText();
    assert.equal(san, 'Plaid last got new data: ' + when(T912) + ' (5 h ago)');
    const chi = await page.locator('.bk-enr', { hasText: 'Chime' }).locator('.bk-plaid').innerText();
    assert.match(chi, new RegExp('Plaid last got new data: ' + esc(when(CHIME_OK)) + ' \\(1 d ago\\)')); assert.match(chi, /Plaid error · ITEM_LOGIN_REQUIRED/i);
    // Within 5 minutes the card does not ask again.
    const n = calls.filter(c => c.p === '/status').length;
    await page.goto(BASE + '#overview'); await page.goto(BASE + '#income'); await page.waitForSelector('#bankcard .bk-plaid');
    assert.equal(calls.filter(c => c.p === '/status').length, n, 'cached for 5 minutes');
    await noHScroll(page, w + ' bank card');
  });
  await step(`${w}x${h}: "Details" opens the Plaid status sheet with every field and the not-enabled reasons`, async () => {
    const n = calls.filter(c => c.p === '/status').length;
    await page.click('#bankcard [data-action="bk-status"]'); await page.waitForSelector('#pstatus');
    await page.waitForFunction(k => true, n); await page.waitForTimeout(150);
    assert.equal(calls.filter(c => c.p === '/status').length, n + 1, 'opening the sheet asks again');
    const sh = await page.locator('#sheet').innerText();
    assert.match(sh, /Plaid status/);
    const san = await page.locator('.ps-bank[data-item="enr_s"]').innerText(), chi = await page.locator('.ps-bank[data-item="enr_c"]').innerText();
    const field = (t, k) => { const m = t.split('\n').map(x => x.trim()).filter(Boolean); const i = m.findIndex(x => x.toLowerCase() === k.toLowerCase()); return i < 0 ? null : m.slice(i + 1, i + 3).join(' | '); };
    assert.equal(field(san, 'Last successful update').split(' | ')[0], when(T912) + ' (5 h ago)');
    assert.match(field(san, 'Last failed update'), /^None/);
    assert.match(field(san, 'Error'), /^None/);
    assert.match(field(san, 'On-demand refresh'), /^Not available \| Transactions Refresh isn't enabled for this Plaid account/);
    assert.match(field(san, 'Real-time balance'), /^Not available \| Real-time refresh isn't included in your Plaid plan/);
    assert.match(field(san, 'Received in the last 24 h'), /^4 transactions/);
    assert.match(field(san, 'Newest transaction'), new RegExp('^[A-Z][a-z]{2}, ' + md(TODAY)));
    assert.match(field(san, 'Pending'), /^1 transaction/);
    assert.match(field(chi, 'Last failed update').split(' | ')[0], new RegExp('^' + esc(when(CHIME_FAIL)) + ' \\(4[6-9] min ago\\)$'));
    assert.match(field(chi, 'Error'), /^ITEM_LOGIN_REQUIRED \| the login details of this item have changed/);
    assert.match(field(chi, 'On-demand refresh'), /^Not checked yet/);
    assert.match(field(chi, 'Real-time balance'), /^Not checked yet \| Tap Refresh balances once/);
    assert.match(field(chi, 'Received in the last 24 h'), /^1 transaction/); assert.match(field(chi, 'Pending'), /^0 transactions/);
    assert.match(chi, /Plaid error/i);
    assert.match(sh, /Some banks don't share pending card purchases until they post\./);
    await sheetNoHScroll(page, w + ' status sheet');
    if (w === 390) { await quiet(page); await page.waitForTimeout(350); await page.screenshot({ path: SHOTS + '/plaid-status-390.png' }); }
    await page.keyboard.press('Escape');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 3. Refresh balances and Sync now: always say what happened ---------- */
{
  const { ctx, page, errs, calls, mock } = await newPage(390, 844, { dark: true });
  await page.evaluate(() => { window.BT_FOLLOWUP_MS = 600000; });
  await step('Refresh balances, real-time available: POST /balances/refresh, new totals, "Balances updated from your banks"', async () => {
    mock.balResp = { refreshed: true, notEnabled: false, at: new Date().toISOString(),
      balances: [{ itemId: 'enr_s', institution: 'Santander', refreshed: true, accounts: [A('sa1', 'Checking', '6429', 1500.25)] }, { itemId: 'enr_c', institution: 'Chime', refreshed: true, accounts: [A('ch1', 'Checking', '1111', 300)] }],
      results: [{ itemId: 'enr_s', institution: 'Santander', refreshed: true }, { itemId: 'enr_c', institution: 'Chime', refreshed: true }] };
    await page.click('[data-action="account"]'); await page.waitForSelector('.bal-total');
    const n = calls.length; await clearToast(page);
    await page.click('[aria-label="Refresh balances"]');
    await waitToast(page, /Balances updated from your banks/);
    const after = calls.slice(n);
    assert.ok(after.some(c => c.p === '/balances/refresh' && c.m === 'POST')); assert.ok(!after.some(c => c.p === '/refresh'), 'not the transactions refresh');
    assert.equal((await getState(page)).bank.balances.items.find(i => i.itemId === 'enr_s').accounts[0].available, 1500.25);
    assert.match(await page.locator('.bal-total').innerText(), /\$1,800\.25/);
  });
  await step('Refresh balances, not in the plan: cached balances and the honest reason with Plaid\'s last update time', async () => {
    mock.balResp = { refreshed: false, notEnabled: true, at: new Date().toISOString(),
      balances: [{ itemId: 'enr_s', institution: 'Santander', refreshed: false, cached: true, lastUpdated: T912, accounts: [A('sa1', 'Checking', '6429', 1200)] }, { itemId: 'enr_c', institution: 'Chime', refreshed: false, cached: true, lastUpdated: null, accounts: [A('ch1', 'Checking', '1111', 300)] }],
      results: [{ itemId: 'enr_s', institution: 'Santander', refreshed: false, notEnabled: true, reason: NOBAL, code: 'INVALID_PRODUCT', lastUpdated: T912 }, { itemId: 'enr_c', institution: 'Chime', refreshed: false, notEnabled: true, reason: NOBAL, code: 'INVALID_PRODUCT', lastUpdated: null }] };
    await clearToast(page); await page.click('[aria-label="Refresh balances"]');
    await waitToast(page, /haven't sent/);
    assert.equal(await toastText(page), `Your banks haven't sent new balances (Plaid last updated ${when(T912)}). Real-time refresh isn't included in your Plaid plan.`);
    assert.match(await page.locator('.bal-total').innerText(), /\$1,500\.00/);
    assert.match(await page.locator('#sheet .lede').innerText(), new RegExp('Updated ' + esc(clock(T912)) + '\\.'), 'the sheet shows Plaid\'s time, not now');
    await sheetNoHScroll(page, '390 balance sheet');
  });
  await step('Sync now with on-demand refresh not available: "Plaid refreshes on its own schedule. Last update from Santander: <time>"', async () => {
    await clearToast(page);
    await page.click('[data-action="bal-sync"]');
    await waitToast(page, /Plaid refreshes on its own schedule/);
    const t = await toastText(page);
    assert.ok(t.includes('Plaid refreshes on its own schedule. Last update from Santander: ' + when(T912)), t);
    assert.ok(!/Asked your banks/.test(t));
    const s = await getState(page); assert.equal(s.bank.refreshOK.ok, false); assert.equal(s.bank.refreshOK.reason, NOREF);
    // Next tap within a day: /refresh is not asked again, the toast still says so.
    const n = calls.filter(c => c.p === '/refresh').length; await clearToast(page);
    await page.waitForFunction(() => !document.querySelector('[data-action="bal-sync"][aria-busy]'));
    await page.click('[data-action="bal-sync"]'); await waitToast(page, /Plaid refreshes on its own schedule/);
    assert.equal(calls.filter(c => c.p === '/refresh').length, n);
  });
  assert.deepEqual(errs, [], 'page errors (refresh)');
  await ctx.close();
}

/* ---------- 4. Match a late $1.99 Apple line to the past, assumed-paid UHF bill ---------- */
for (const [w, h, dark] of [[390, 844, false], [951, 669, true]]) {
  const { ctx, page, errs } = await newPage(w, h, { dark, hash: '#transactions' });
  const openPicker = async id => {
    await page.goto(BASE + '#transactions'); await page.waitForSelector(`.tx[data-id="${id}"]`);
    const row = page.locator(`.tx[data-id="${id}"]`); if (!(await row.evaluate(e => e.classList.contains('open')))) await row.locator('.tx-main').click();
    await row.locator('[data-action="tx-match"]').click(); await page.waitForSelector('.pk-opt');
  };
  const KEY = 'b:uhf:' + UHF_DUE;
  await step(`${w}x${h}: the $1.99 Apple line offers "UHF IPVT Player · due ${md(UHF_DUE)} · 4 days late · Assumed paid" as Best match, and lists Earlier`, async () => {
    await openPicker('pl:apple');
    const secs = (await page.locator('.pk-sec').allInnerTexts()).map(x => x.toLowerCase());
    assert.equal(secs[0], 'best match'); assert.ok(secs.includes('earlier'), secs.join());
    const first = page.locator('.pk-grp').first().locator('.pk-opt').first();
    assert.equal(await first.getAttribute('data-key'), KEY);
    const t = await first.innerText();
    assert.match(t, /UHF IPVT Player/); assert.match(t, /\$1\.99/); assert.match(t, new RegExp('due ' + md(UHF_DUE))); assert.match(t, /4 days late/); assert.match(t, /Assumed paid/);
    const early = await page.locator('.pk-sec', { hasText: /earlier/i }).evaluate(s => s.nextElementSibling.innerText);
    assert.match(early, /Netflix/); assert.match(early, /Marked paid/);
    await sheetNoHScroll(page, w + ' picker');
    if (w === 390) { await quiet(page); await page.waitForTimeout(400); await page.screenshot({ path: SHOTS + '/match-past-390.png' }); }
  });
  await step(`${w}x${h}: matching it only links: occ.txn and paid date set, mark untouched, no spending added`, async () => {
    const before = await getState(page);
    await page.click(`.pk-opt[data-key="${KEY}"]`);
    // 4 days late is more than the 3-day tolerance: the existing confirm step comes first.
    await page.waitForSelector('[data-action="cf-yes"]'); assert.match(await page.locator('#sheet').innerText(), /4 days after the due date/);
    await page.click('[data-action="cf-yes"]');
    await page.waitForFunction(k => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); return s.occ[k] && s.occ[k].txn === 'pl:apple'; }, KEY);
    const s = await getState(page);
    assert.equal(s.occ[KEY].paidOn, PAY, 'paid on the bank date'); assert.ok(!('checkedOn' in s.occ[KEY]));
    assert.ok(!(KEY in s.marks), 'still assumed paid, not re-marked');
    assert.equal(s.spends.length, before.spends.filter(x => x.bank !== 'pl:apple').length, 'no spending for the line'); assert.ok(!s.spends.some(x => x.bank === 'pl:apple'));
    assert.equal(s.bank.seen['pl:apple'].res, 'bill');
    assert.match(await toastText(page), /Matched to UHF IPVT Player/);
  });
  await step(`${w}x${h}: a line for an explicitly marked-paid bill asks "Already marked paid on ${md(NFX_DUE)}. Link this transaction to it?"`, async () => {
    await openPicker('pl:nfx');
    await page.click(`.pk-opt[data-key="b:nfx:${NFX_DUE}"]`); await page.waitForSelector('.pk-warn');
    assert.match(await page.locator('.pk-warn').innerText(), new RegExp('Already marked paid on ' + md(NFX_DUE) + '\\. Link this transaction to it\\?'));
    await page.click('[data-action="cf-yes"]');
    await page.waitForFunction(k => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); return s.occ[k] && s.occ[k].txn === 'pl:nfx'; }, 'b:nfx:' + NFX_DUE);
    const s = await getState(page); assert.equal(s.occ['b:nfx:' + NFX_DUE].paidOn, NFX_DUE, 'the paid date the user set stays'); assert.equal(s.marks['b:nfx:' + NFX_DUE], true);
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

await b.close();
finish();
