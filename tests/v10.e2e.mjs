// Checks for: Pay later and Credit cards groups in the Overview chart, tappable "Spent so far" and "Still due" lists,
// the income trend chart (last 2, this, next 3 with deltas and estimates), the snapshot POST after a sync for the
// morning email, and the "Send test email" button.
// Run: node tests/v10.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const SHOTS = process.argv[2] || '/tmp';
const BASE = process.env.BT_URL || 'http://localhost:8765/';
// v19: the period switcher is a button + menu inside the header
const pickView = async (page, v) => { await page.click('#periodBtn'); await page.click('#periodMenu [data-view="' + v + '"]'); };
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n   ', String(e.message).split('\n').slice(0, 14).join('\n    ')); } };

const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const addD = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const TODAY = iso(new Date()), PAY = addD(TODAY, -2), dayOf = n => +addD(TODAY, n).slice(8);
const num = t => +String(t).replace(/[^0-9.\-]/g, '');
const acct = { id: 'a1', name: 'Checking', last4: '6429', institution: 'Santander', type: 'depository' };
const tx = (id, amount, desc) => ({ id, date: TODAY, desc, rawDesc: desc, amount, account: acct, status: 'posted', pendingOf: null, counterparty: null, providerCategory: null });
const plan = (id, provider, merchant, category, paid, dates, amount) => ({ id, provider, merchant, amount, total: dates.length, paid, freq: 'biweekly', lastDate: dates[Math.max(0, paid - 1)], dates, amounts: dates.map(() => amount), category, autopay: true, purchased: dates[0], via: '' });
const fixture = cards => ({
  since: addD(TODAY, -60), marks: { ['b:elec:' + addD(TODAY, 0)]: true }, occ: { ['b:elec:' + addD(TODAY, 0)]: { checkedOn: TODAY } }, unalloc: [], payVia: [],
  categories: ['Groceries', 'Takeout Food', 'Clothing', 'Electronics', 'Other'], billCats: ['Housing', 'Utilities', 'Other'],
  // Paychecks: usual 1800 before askFrom, then 1900, 2200, 2100 (this cycle); the next three are estimates (2100).
  income: [{ id: 'pay', name: 'Payroll', freq: 'biweekly', date: PAY, amount: 1800, askFrom: addD(PAY, -28), perCycle: { [addD(PAY, -28)]: 1900, [addD(PAY, -14)]: 2200, [PAY]: 2100 } }],
  bills: [{ id: 'rent', name: 'Rent', amount: 1000, day: dayOf(3), group: 'Fixed', category: 'Housing', active: true },
    { id: 'elec', name: 'Electric', amount: 70, day: dayOf(0), group: 'Fixed', category: 'Utilities', active: true }],
  cards: cards ? [{ id: 'visa', name: 'Visa', day: dayOf(5), minPayment: 35, balance: 500, limit: 2000 }, { id: 'amex', name: 'Amex', day: dayOf(6), minPayment: 40, balance: 900, limit: 3000 }] : [],
  plans: [
    plan('zara', 'Klarna', 'Zara', 'Clothing', 0, [TODAY, addD(TODAY, 14), addD(TODAY, 28), addD(TODAY, 42)], 30), // new purchase: 1 of 4
    plan('nike', 'Klarna', 'Nike', 'Clothing', 2, [addD(TODAY, -27), addD(TODAY, -13), addD(TODAY, 1), addD(TODAY, 15)], 27.65), // 3 of 4 due tomorrow
    plan('bb', 'Afterpay', 'Best Buy', 'Electronics', 1, [addD(TODAY, -15), addD(TODAY, -1), addD(TODAY, 13), addD(TODAY, 27)], 50)], // 2 of 4 paid yesterday (autopay)
  perPeriod: [{ id: 'groc', name: 'Groceries', amount: 150, category: 'Groceries' }],
  spends: [{ id: 'x1', category: 'Groceries', desc: 'Shoprite', amount: 40, date: TODAY, via: '', note: '' }, { id: 'x2', category: 'Takeout Food', desc: 'DoorDash', amount: 12, date: TODAY, via: '', note: '' }],
  account: { balance: 3000, asOf: PAY, adj: [], auto: false },
  savings: { on: false, bank: '', tx: [] },
  settings: { view: 'biweekly', anchor: PAY, legendOpen: {}, billsView: '', chartRange: 'cycle' }
});

const b = await pw.chromium.launch();
async function newPage(w, h, o) {
  o = o || {};
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: o.dark ? 'dark' : 'light' });
  const page = await ctx.newPage(); page.setDefaultTimeout(6000);
  await page.addInitScript(() => { if (!localStorage.getItem('budtrack.incopen')) localStorage.setItem('budtrack.incopen', '{"bank":true}'); }); // v46: Bank connections opens and closes
  const errs = [], calls = [], mock = { alerts: 404 };
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ m, p, auth: req.headers()['authorization'] || '', body: req.postData() || '' });
    const json = (x, status) => route.fulfill({ status: status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(x) });
    if (p === '/config') return json({ provider: 'plaid', env: 'sandbox', paired: true });
    if (p === '/accounts') return json({ enrollments: [{ id: 'enr_1', institution: 'Santander', accounts: [{ id: 'a1', name: 'Checking', type: 'depository', last_four: '6429', enabled: true }] }] });
    if (p === '/sync') return json({ txns: [], removed: [], errors: [], syncToken: 't', syncedAt: new Date().toISOString() });
    if (p === '/refresh') return json({ refreshed: false, notEnabled: true });
    if (p === '/snapshot' && m === 'POST') return json({ ok: true });
    if (p === '/alerts/test') return mock.alerts === 404 ? json({ error: 'not found' }, 404) : json({ ok: true, sent: true });
    return json({ error: 'nope' }, 404);
  });
  await page.goto(BASE + '?v10=' + Date.now(), { waitUntil: 'load' });
  await page.evaluate(([fx, cards]) => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1')); Object.assign(s, JSON.parse(fx));
    const t = (id, amount, desc) => Object.assign(JSON.parse(cards.tx), { id, amount, desc, rawDesc: desc });
    s.bank = Object.assign(s.bank || {}, { api: 'https://worker.test', lastSync: new Date().toISOString(), txns: { 'pl:r1': t('pl:r1', 9.5, 'CPI*CANTEEN') },
      inbox: [{ txn: t('pl:r1', 9.5, 'CPI*CANTEEN'), kind: 'spend', confidence: 'medium', cands: [], pick: null, category: 'Snacks & Drinks' }], seen: {}, history: [] });
    localStorage.setItem('budtrack.bankkey', 'k-123');
    localStorage.setItem('budtrack.v1', JSON.stringify(s));
  }, [JSON.stringify(fixture(o.cards)), { tx: JSON.stringify(tx('x', 0, '')) }]); // tx() is the template for the bank line
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.cat-legend');
  return { ctx, page, errs, calls, mock };
}
const legend = page => page.locator('.cat-legend > li').evaluateAll(l => l.map(li => ({ g: li.dataset.g, open: li.classList.contains('open'), v: +li.querySelector(':scope > .lv').textContent.replace(/[$,]/g, ''), kids: Object.fromEntries([...li.querySelectorAll('.lg-k')].map(k => [k.querySelector('.kn').textContent.trim(), +k.querySelector('.lv').textContent.replace(/[$,]/g, '')])) })));
const noHScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'horizontal scroll at ' + label);
// Element screenshot without the fixed tab bar or a toast on top of it.
const shot = async (page, sel, file) => {
  await page.evaluate(() => { const st = document.createElement('style'); st.id = 'shot-css'; st.textContent = 'nav.tabs,#toast{visibility:hidden!important}'; document.head.append(st); });
  await page.locator(sel).first().evaluate(e => e.scrollIntoView({ block: 'start' }));
  await page.locator(sel).first().screenshot({ path: SHOTS + '/' + file });
  await page.evaluate(() => document.getElementById('shot-css')?.remove());
};
const closeSheet = async page => { await page.keyboard.press('Escape'); await page.waitForSelector('#sheet', { state: 'hidden' }); };

for (const [w, h] of [[390, 844], [951, 669]]) {
  const { ctx, page, errs, calls, mock } = await newPage(w, h);
  await step(`${w}: legend has Pay later (collapsed) with Klarna and Afterpay children and the right sums`, async () => {
    const g = await legend(page), pl = g.find(x => x.g === 'Pay later');
    assert.ok(pl, 'Pay later group: ' + g.map(x => x.g).join(','));
    assert.equal(pl.v, 77.65); assert.deepEqual(pl.kids, { Afterpay: 50, Klarna: 27.65 }); assert.equal(pl.open, false, 'collapsed by default');
    assert.ok(!g.some(x => x.g === 'Credit cards'), 'no cards, no Credit cards group');
    const total = num(await page.locator('.ov-donut .card-h .meta').innerText());
    assert.ok(Math.abs(g.reduce((a, x) => a + x.v, 0) - total) < 0.011, 'groups add up to the chart total');
    assert.equal(total, num(await page.locator('.lad.l2 .v').innerText()), 'chart total = cycle needs');
    assert.ok(await page.locator('.cat-legend > li[data-g="Pay later"] .lg-kids').isHidden());
    const sw = await page.locator('.cat-legend > li[data-g="Pay later"] .sw').evaluate(e => e.style.getPropertyValue('--c'));
    assert.equal(sw, 'var(--s7)', 'Pay later has its own color');
  });
  await step(`${w}: the first payment of a new plan counts under Clothing (Shopping); Electronics payment 2 does not`, async () => {
    const g = await legend(page), shop = g.find(x => x.g === 'Shopping');
    assert.ok(shop, 'Shopping group'); assert.deepEqual(shop.kids, { Clothing: 30 });
  });
  await step(`${w}: tapping Pay later and a provider opens the detail with each payment line (Cycle and Month)`, async () => {
    await page.locator('.cat-legend > li[data-g="Pay later"] .sw-btn').click();
    await page.locator('.cat-legend > li[data-g="Pay later"] .kn', { hasText: 'Klarna' }).click(); await page.waitForSelector('#sheet:not([hidden]) .sheet-h');
    let t = await page.locator('#sheet').innerText();
    assert.match(t, /Klarna/); assert.match(t, /Nike/); assert.match(t, /3 of 4/); assert.match(t, /Not paid yet/); assert.match(t, /\$27\.65/);
    assert.doesNotMatch(t, /Best Buy|Zara/);
    await page.click('#sheet [data-action="cat-mode"][data-mode="month"]');
    t = await page.locator('#sheet').innerText(); assert.match(t, /Nike/); assert.doesNotMatch(t, /Best Buy|Zara/, 'month mode keeps the provider filter');
    await closeSheet(page);
    await page.locator('.cat-legend > li[data-g="Pay later"] .lc').click(); await page.waitForFunction(() => document.querySelector('.cat-legend > li[data-g="Pay later"]').classList.contains('sel') && /PAY LATER/.test(document.querySelector('#dn-lbl').textContent)); await page.waitForTimeout(700); await page.waitForFunction(() => document.querySelector('.cat-legend > li[data-g="Pay later"]').classList.contains('sel')); /* let the chip scroller settle */ await page.locator('.cat-legend > li[data-g="Pay later"] .lc').click();
    await page.waitForSelector('#sheet:not([hidden]) .sheet-h');
    t = await page.locator('#sheet').innerText();
    assert.match(t, /Pay later/); assert.match(t, /Nike/); assert.match(t, /Best Buy/); assert.match(t, /Afterpay · 2 of 4/); assert.match(t, /Paid/); assert.match(t, /\$77\.65/);
    assert.doesNotMatch(t, /Zara/, 'the new purchase is not a Pay later line');
    if (w === 390) await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/paylater-sheet-390.png' });
    await page.click('#sheet [data-action="cat-mode"][data-mode="month"]'); t = await page.locator('#sheet').innerText(); assert.match(t, /Nike/); assert.match(t, /Best Buy/);
    await closeSheet(page);
    if (w === 390) await shot(page, '.ov-donut', 'paylater-390.png');
  });
  await step(`${w}: chart in Month mode: Pay later sums the month and the tap opens the detail on the whole month`, async () => {
    await page.click('[data-action="chart-range"][data-r="month"]'); await page.waitForSelector('.cat-legend > li[data-g="Pay later"]');
    const g = await legend(page), pl = g.find(x => x.g === 'Pay later');
    assert.ok(pl.v > 0); assert.ok(Math.abs(Object.values(pl.kids).reduce((a, v) => a + v, 0) - pl.v) < 0.011, 'providers add up to the group');
    // The group stays selected across the re-render, so one tap may already open it.
    const tap = async () => { if (!(await page.locator('.cat-legend > li[data-g="Pay later"]').evaluate(e => e.classList.contains('sel')))) await page.locator('.cat-legend > li[data-g="Pay later"] .lc').click(); await page.waitForTimeout(700); await page.waitForFunction(() => document.querySelector('.cat-legend > li[data-g="Pay later"]').classList.contains('sel')); await page.locator('.cat-legend > li[data-g="Pay later"] .lc').click(); await page.waitForSelector('#sheet:not([hidden]) .sheet-h'); };
    await tap();
    assert.equal(await page.locator('#sheet [data-action="cat-mode"][data-mode="month"]').getAttribute('aria-pressed'), 'true', 'Whole month pressed');
    assert.equal(num(await page.locator('#sheet .strip .tile .v').first().innerText()), pl.v, 'sheet total = legend value');
    await closeSheet(page);
    await page.locator('.cat-legend > li[data-g="Pay later"] .kn', { hasText: 'Klarna' }).click(); await page.waitForSelector('#sheet:not([hidden]) .sheet-h');
    assert.equal(await page.locator('#sheet [data-action="cat-mode"][data-mode="month"]').getAttribute('aria-pressed'), 'true');
    assert.equal(num(await page.locator('#sheet .strip .tile .v').first().innerText()), pl.kids.Klarna);
    await closeSheet(page);
    await page.click('[data-action="chart-range"][data-r="cycle"]');
  });
  await step(`${w}: Pay later open state is remembered`, async () => {
    const lo = await page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')).settings.legendOpen);
    assert.equal(lo['Pay later'], true);
  });
  await step(`${w}: Spent so far opens a list whose total equals the hero and includes the line to review`, async () => {
    const hero = await page.locator('.hero-stats > div').first().locator('dd').innerText();
    assert.equal(hero, '$181.50', 'hero: 70 electric + 40 + 12 + 50 Afterpay + 9.50 to review');
    await page.click('[data-action="spent-list"]'); await page.waitForSelector('#hl-sum');
    assert.equal(await page.locator('#hl-sum').innerText(), hero);
    const t = await page.locator('#sheet').innerText();
    assert.match(t, /Cpi\*canteen|CPI\*CANTEEN|Canteen/i); assert.match(t, /Santander ••6429/); assert.match(t, /To review/i);
    assert.match(t, /Shoprite[\s\S]*counted in Groceries budget/); assert.match(t, /DoorDash/); assert.match(t, /Electric/); assert.match(t, /Best Buy/);
    const rows = await page.locator('#sheet .hl-list .row .amt').allInnerTexts();
    assert.equal(rows.length, 5); assert.ok(Math.abs(rows.reduce((a, x) => a + num(x), 0) - 181.5) < 0.001);
    const days = await page.locator('#sheet .hl-day').count(); assert.equal(days, 2, 'grouped by date: today and yesterday');
    assert.ok(await page.evaluate(() => { const s = document.querySelector('#sheet .sheet'); return s.scrollWidth <= s.clientWidth + 1; }), 'no horizontal scroll in the sheet');
    if (w === 390) await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/spent-list-390.png' });
    await closeSheet(page);
  });
  await step(`${w}: Still due opens a list sorted by due date whose total equals the hero; a row opens the item`, async () => {
    const hero = await page.locator('.hero-stats > div').nth(1).locator('dd').innerText();
    await page.click('[data-action="due-list"]'); await page.waitForSelector('#hl-sum');
    assert.equal(await page.locator('#hl-sum').innerText(), hero);
    const names = await page.locator('#sheet .hl-list .row .nm').allInnerTexts();
    assert.deepEqual(names.map(n => n.trim()), ['Zara', 'Nike', 'Rent', 'Groceries budget']);
    const t = await page.locator('#sheet').innerText(); assert.match(t, /Pay later · Klarna · 3 of 4/); assert.match(t, /Pay plan · Klarna · 1 of 4/); assert.match(t, /\$40\.00 of \$150\.00 spent/);
    if (w === 390) await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/due-list-390.png' });
    await page.locator('#sheet .hl-list .row', { hasText: 'Rent' }).click();
    await page.waitForFunction(() => /Rent/.test(document.querySelector('#sheet h3')?.textContent || ''));
    await closeSheet(page);
  });
  await step(`${w}: hidden balances mask the list amounts`, async () => {
    await page.click('.lad-tools [data-action="hide-bal"]');
    await page.click('[data-action="spent-list"]'); await page.waitForSelector('#hl-sum');
    assert.equal(await page.locator('#hl-sum').innerText(), '••••');
    assert.ok((await page.locator('#sheet .hl-list .row .amt').allInnerTexts()).every(x => x === '••••'));
    await closeSheet(page); await page.click('.lad-tools [data-action="hide-bal"]');
  });
  await step(`${w}: income chart has 6 points with amounts and deltas, estimates dashed, this cycle highlighted`, async () => {
    assert.match(await page.locator('.ov-bars h2').innerText(), /^Income and needs · 6 pay cycles$/);
    const pts = page.locator('.ov-bars .ib-pt'); assert.equal(await pts.count(), 6);
    assert.deepEqual(await page.locator('.ov-bars .ib-v').allTextContents(), ['$1,900', '$2,200', '$2,100', '$2,100', '$2,100', '$2,100']);
    assert.deepEqual(await page.locator('.ov-bars .ib-d').allTextContents(), ['▲$100', '▲$300', '▼$100', '—', '—', '—']);
    assert.deepEqual(await page.locator('.ov-bars .ib-d').evaluateAll(l => l.map(e => e.classList[1])), ['up', 'up', 'down', 'eq', 'eq', 'eq']);
    assert.notEqual(await page.locator('.ov-bars .ib-d.up').first().evaluate(e => getComputedStyle(e).fill), await page.locator('.ov-bars .ib-d.down').evaluate(e => getComputedStyle(e).fill));
    assert.equal(await page.locator('.ov-bars .ib-pt.est').count(), 3); assert.equal(await page.locator('.ov-bars .ib-est').count(), 3);
    assert.ok(await page.locator('.ov-bars .ib-line.est').count() >= 2);
    assert.equal(await page.locator('.ov-bars .ib-line.est').first().evaluate(e => getComputedStyle(e).strokeDasharray), '4px, 3px');
    assert.equal(await page.locator('.ov-bars g.ib-slot.cur').count(), 1);
    assert.equal(await page.locator('.ov-bars .ib-slot').nth(2).evaluate(e => e.classList.contains('cur')), true);
    const tip = await page.locator('.ov-bars g.cur[data-tip]').getAttribute('data-tip');
    assert.match(tip, /Income \$2,100\.00\nNeeded \$[\d,.]+\nLeft \$[\d,.]+\nChange ▼ \$100\.00 vs previous/);
    const etip = await page.locator('.ov-bars g.ib-slot.est').first().getAttribute('data-tip'); assert.match(etip, /\(est\.\)/); assert.match(etip, /No change/);
    // Labels stay readable: rendered font at least 9px
    const fs = await page.locator('.ov-bars .ib-v').first().evaluate(e => e.getBoundingClientRect().height);
    assert.ok(fs >= 8, 'label height ' + fs);
    await noHScroll(page, w + ' overview');
    await shot(page, '.ov-bars', `income-chart-${w}.png`);
  });
  await step(`${w}: a sync POSTs the snapshot with the right shape`, async () => {
    const n = calls.length;
    await page.evaluate(() => { location.hash = '#income'; }); await page.waitForSelector('#bankcard [data-action="bk-sync"]');
    await page.click('#bankcard [data-action="bk-sync"]');
    for (let i = 0; i < 40 && !calls.slice(n).some(c => c.p === '/snapshot'); i++) await page.waitForTimeout(100);
    const after = calls.slice(n).map(c => c.p);
    assert.ok(after.indexOf('/snapshot') > after.indexOf('/sync') && after.indexOf('/sync') >= 0, 'order: ' + after.join(','));
    const c = calls.slice(n).find(x => x.p === '/snapshot');
    assert.equal(c.m, 'POST'); assert.equal(c.auth, 'Bearer k-123');
    const body = JSON.parse(c.body);
    assert.deepEqual(Object.keys(body).sort(), ['budgets', 'cycle', 'review', 'upcoming']);
    assert.deepEqual(Object.keys(body.cycle).sort(), ['due', 'end', 'income', 'left', 'needed', 'spent', 'start']);
    assert.equal(body.cycle.start, PAY); assert.equal(body.cycle.end, addD(PAY, 14));
    assert.equal(body.cycle.spent, 181.5); assert.equal(body.cycle.income, 2100); assert.equal(body.cycle.left, 2100 - 181.5);
    assert.equal(body.review, 1);
    assert.deepEqual(body.budgets, [{ name: 'Groceries', spent: 40, budget: 150 }]);
    assert.deepEqual(body.upcoming.map(u => u.name), ['Zara', 'Nike', 'Rent']);
    assert.deepEqual(body.upcoming[1], { name: 'Nike', date: addD(TODAY, 1), amount: 27.65 });
  });
  await step(`${w}: Email alerts row: Send test email toasts the reason, then success`, async () => {
    const row = page.locator('#bankcard .bk-alerts'); assert.match(await row.innerText(), /Email alerts/);
    await row.locator('[data-action="alerts-test"]').click();
    await page.waitForFunction(() => /Email isn't set up yet/.test(document.querySelector('#toast').textContent));
    mock.alerts = 200; await page.waitForTimeout(100);
    await row.locator('[data-action="alerts-test"]').click();
    await page.waitForFunction(() => /Test email sent/.test(document.querySelector('#toast').textContent));
    assert.ok(calls.some(c => c.p === '/alerts/test' && c.m === 'GET' && c.auth === 'Bearer k-123'));
    await noHScroll(page, w + ' income');
  });
  await step(`${w}: weekly view with a biweekly paycheck: weeks without pay get no point, deltas skip them`, async () => {
    await page.evaluate(() => { location.hash = '#overview'; }); await page.waitForSelector('.ov-bars');
    await pickView(page, 'weekly'); await page.waitForSelector('.ov-bars .ib');
    assert.match(await page.locator('.ov-bars h2').innerText(), /^Income and needs · 6 weeks$/);
    const n = await page.locator('.ov-bars .ib-pt').count(); assert.ok(n >= 2 && n <= 4, 'one point per week with a paycheck: ' + n);
    const ds = await page.locator('.ov-bars .ib-d').allTextContents();
    assert.ok(!ds.some(d => /2,1|2\.1k/.test(d)), 'no zigzag to $0 and back: ' + ds.join(','));
    const tips = await page.locator('.ov-bars g.ib-slot').evaluateAll(l => l.map(e => e.dataset.tip));
    assert.ok(tips.some(t => /No paycheck this week/.test(t)));
    assert.equal(await page.locator('.ov-bars .ib-line').count(), n - 1, 'the line bridges weeks without pay');
    if (w === 390) await shot(page, '.ov-bars', 'income-chart-weekly-390.png');
    await pickView(page, 'monthly'); await page.waitForSelector('.ov-bars .ib');
    assert.match(await page.locator('.ov-bars h2').innerText(), /^Income and needs · 6 months$/);
    await pickView(page, 'biweekly'); await noHScroll(page, w + ' views');
  });
  await step(`${w}: no page errors`, async () => { assert.deepEqual(errs, []); });
  await ctx.close();
}

// With cards: a Credit cards group with a child per card, detail lists the payments. Dark theme at 390.
{
  const { ctx, page, errs } = await newPage(390, 844, { cards: true, dark: true });
  await step('cards: Credit cards group (collapsed) with Visa and Amex; detail lists the payments', async () => {
    const g = await legend(page), cc = g.find(x => x.g === 'Credit cards');
    assert.ok(cc, 'Credit cards group'); assert.equal(cc.v, 75); assert.deepEqual(cc.kids, { Amex: 40, Visa: 35 }); assert.equal(cc.open, false);
    assert.ok(g.find(x => x.g === 'Pay later'), 'Pay later still there');
    await page.locator('.cat-legend > li[data-g="Credit cards"] .lc').click(); await page.waitForFunction(() => document.querySelector('.cat-legend > li[data-g="Credit cards"]').classList.contains('sel')); await page.waitForTimeout(700); await page.waitForFunction(() => document.querySelector('.cat-legend > li[data-g="Credit cards"]').classList.contains('sel')); /* let the chip scroller settle */ await page.locator('.cat-legend > li[data-g="Credit cards"] .lc').click();
    await page.waitForSelector('#sheet:not([hidden]) .sheet-h');
    const t = await page.locator('#sheet').innerText(); assert.match(t, /Visa/); assert.match(t, /Amex/); assert.match(t, /Minimum payment/); assert.match(t, /\$75\.00/);
    await closeSheet(page);
    await noHScroll(page, '390 dark cards');
    await shot(page, '.ov-bars', 'income-chart-390-dark.png');
  });
  await step('cards: no page errors', async () => { assert.deepEqual(errs, []); });
  await ctx.close();
}
await b.close();
console.log(failed ? failed + ' step(s) FAILED' : 'all steps passed');
process.exit(failed ? 1 : 0);
