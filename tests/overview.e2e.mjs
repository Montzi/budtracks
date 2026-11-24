// End-to-end checks for the bank-v8 changes: grouped chart legend, Electronics Repair, savings only when on,
// skip + one-time vs permanent amounts, bank card labels, Subscriptions nesting, Bills chips.
// Run: python3 -m http.server 8765 (repo root), then: node tests/overview.e2e.mjs [screenshotDir]
import assert from 'node:assert/strict';
import { chromium, SHOTS, BASE, iso, addD, step, finish, prep } from './lib.mjs';
const LSK = 'budtrack.v1';

const TODAY = iso(new Date());
const PAY = addD(TODAY, -2), dayOf = n => +addD(TODAY, n).slice(8);
const acct = { institution: 'Chime', name: 'Checking', last4: '1234' };
const tx = (id, desc, amount, date) => ({ id, date: date || TODAY, desc, rawDesc: desc, amount, status: 'posted', account: acct });

const fixture = () => ({
  since: addD(TODAY, -60), marks: {}, occ: {}, unalloc: [], payVia: [{ bank: 'Chime', last4: '1234', type: 'debit' }],
  categories: ['Gas', 'Repairs', 'Groceries', 'Takeout Food', 'Snacks & Drinks', 'Coffee', 'Food', 'Electronics', 'Other'],
  billCats: ['Housing', 'Utilities', 'Subscriptions', 'Transportation', 'Other'],
  income: [{ id: 'pay', name: 'Payroll', freq: 'biweekly', date: PAY, amount: 2000, askFrom: PAY, perCycle: { [PAY]: 2000 } }],
  bills: [
    { id: 'rent', name: 'Rent', amount: 1000, day: dayOf(1), group: 'Fixed', category: 'Housing' },
    { id: 'elec', name: 'Electric', amount: 100, day: dayOf(2), group: 'Fixed', category: 'Utilities' },
    { id: 'spot', name: 'Spotify', amount: 12, day: dayOf(3), group: 'Subscriptions', category: 'Subscriptions' },
    { id: 'icl', name: 'iCloud', amount: 3, day: dayOf(3), group: 'Apple Subscriptions', category: '' }],
  cards: [{ id: 'visa', name: 'Visa', day: dayOf(4), minPayment: 35, balance: 500, limit: 2000 }],
  plans: [],
  perPeriod: [{ id: 'groc', name: 'Groceries', amount: 150, category: 'Groceries' }, { id: 'gas', name: 'Gas', amount: 60, category: 'Gas' }],
  spends: [{ id: 'x1', category: 'Takeout Food', desc: 'Pizza', amount: 25, date: TODAY }, { id: 'x2', category: 'Coffee', desc: 'Latte', amount: 4, date: TODAY },
    { id: 'x3', category: 'Snacks & Drinks', desc: 'Chips', amount: 6, date: TODAY }, { id: 'x4', category: 'Food', desc: 'Misc food', amount: 10, date: TODAY }],
  account: { balance: 3000, asOf: PAY, adj: [], auto: false },
  savings: { on: false, bank: '', tx: [] },
  settings: { view: 'biweekly', anchor: PAY, legendOpen: {}, billsView: '' }
});
// Food = Groceries budget 150 (nothing spent in Groceries) + 25 + 4 + 6 + 10
const FOOD = 195;

const browser = await chromium.launch();
async function newPage(w, h, patch) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  const page = await ctx.newPage(); await prep(page);
  const errs = [], calls = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.route('**/worker.test/**', async route => {
    const u = new URL(route.request().url()), p = u.pathname, cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push(p + u.search);
    const json = o => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(o) });
    if (p === '/config') return json({ provider: 'plaid', env: 'sandbox', paired: true });
    if (p === '/accounts') return json({ enrollments: [{ id: 'enr_1', institution: 'Chime', accounts: [{ id: 'a1', name: 'Checking', type: 'depository', last_four: '1234', enabled: true }] }, { id: 'enr_2', institution: 'Citizens', accounts: [] }] });
    if (p === '/sync') return json({ txns: [], removed: [], errors: [], syncToken: 't', syncedAt: new Date().toISOString() });
    if (p === '/refresh') return json({ refreshed: true, notEnabled: false, results: [{ itemId: 'enr_1', refreshed: true }, { itemId: 'enr_2', refreshed: true }] });
    return json({ error: 'nope' });
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(([fx, bank]) => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1')); Object.assign(s, JSON.parse(fx));
    s.imports = (s.imports || []).filter(x => x !== 'cats-v3'); s.categories = s.categories.filter(c => c !== 'Electronics Repair'); delete s.catParents['Electronics Repair'];
    if (bank) { s.bank = Object.assign(s.bank || {}, { api: 'https://worker.test', txns: bank.txns }); localStorage.setItem('budtrack.bankkey', 'k'); }
    localStorage.setItem('budtrack.v1', JSON.stringify(s));
  }, [JSON.stringify(Object.assign(fixture(), patch && patch.fx)), patch && patch.bank]);
  await page.reload({ waitUntil: 'load' });
  return { page, errs, calls, ctx };
}
const getState = page => page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')));
const num = t => +String(t).replace(/[^0-9.\-]/g, '');
const noHScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'horizontal scroll at ' + label);
const heroNeeds = page => page.locator('.lad.l2 .v').innerText().then(num);

/* ---------- Overview legend: grouped, Food open, persistence ---------- */
{
  const { page, errs, ctx } = await newPage(390, 844);
  await page.waitForSelector('.cat-legend');
  await step('legend is grouped by parent; Food (Groceries, Takeout, Coffee, Snacks, Food) is open by default and totals match', async () => {
    const groups = await page.locator('.cat-legend > li').evaluateAll(l => l.map(li => ({ g: li.dataset.g, open: li.classList.contains('open'), v: +li.querySelector(':scope > .lv').textContent.replace(/[$,]/g, ''), kids: [...li.querySelectorAll('.lg-k')].map(k => k.querySelector('.kn').textContent.trim()) })));
    const food = groups.find(g => g.g === 'Food'); assert.ok(food, 'Food group');
    assert.equal(food.v, FOOD); assert.ok(food.open); assert.deepEqual(food.kids.slice().sort(), ['Coffee', 'Food', 'Groceries', 'Snacks & Drinks', 'Takeout Food']);
    assert.ok(groups.filter(g => g.g !== 'Food').every(g => !g.open), 'other groups collapsed');
    assert.ok(groups.some(g => g.g === 'Home' && g.kids.includes('Housing') && g.kids.includes('Utilities')), 'bills roll up under Home');
    assert.ok(groups.some(g => g.g === 'Subscriptions' && g.kids.includes('Subscriptions')), 'subscriptions are their own chart group');
    // The Visa minimum used to be the only "Other" item; card payments now have their own Credit cards group.
    assert.ok(groups.some(g => g.g === 'Credit cards' && g.kids.includes('Visa') && !g.open), 'card payments under Credit cards (collapsed)');
    assert.ok(!groups.some(g => g.g === 'Other'), 'nothing left under Other');
    const total = num(await page.locator('.ov-donut .card-h .meta').innerText());
    assert.ok(Math.abs(groups.reduce((a, g) => a + g.v, 0) - total) < 0.011, 'group totals add up to the chart total');
    assert.equal(num(await page.locator('.lad.l2 .v').innerText()), total, 'chart total = cycle needs (no savings yet)');
    assert.equal(await page.locator('.donut-wrap .slice').count(), groups.length, 'one slice per group');
    assert.equal(await page.locator('.cs-chip[data-copy="1"]').count(), groups.length + 1, 'scroller has a chip per group (+All)');
    const kid = await page.locator('.cat-legend > li[data-g="Food"] .lg-k').first().innerText(); assert.match(kid, /\$150\.00\s+\d+%/);
    assert.ok(await page.locator('.cat-legend > li[data-g="Home"] .lg-kids').isHidden(), 'collapsed children are hidden');
    await noHScroll(page, '390 overview'); await page.locator('.ov-donut').screenshot({ path: SHOTS + '/legend-390.png' });
  });
  await step('tapping a group selects its slice; second tap opens the group detail', async () => {
    await page.locator('.cat-legend > li[data-g="Food"] .lc').click();
    await page.waitForFunction(() => document.querySelector('.cat-legend > li[data-g="Food"]').classList.contains('sel') && /FOOD/.test(document.querySelector('#dn-lbl').textContent));
    assert.match(await page.locator('#dn-amt').textContent(), /195/); await page.waitForTimeout(700); // let the scroller settle
    await page.locator('.cat-legend > li[data-g="Food"] .lc').click(); await page.waitForSelector('#sheet:not([hidden]) .sheet-h');
    assert.match(await page.locator('#sheet').innerText(), /Food[\s\S]*\$195\.00/); assert.match(await page.locator('#sheet').innerText(), /Pizza/);
    await page.keyboard.press('Escape');
    await page.locator('.cat-legend > li[data-g="Food"] .kn', { hasText: 'Takeout Food' }).click(); await page.waitForSelector('#sheet:not([hidden]) .sheet-h');
    assert.match(await page.locator('#sheet').innerText(), /Takeout Food[\s\S]*Pizza/); assert.doesNotMatch(await page.locator('#sheet').innerText(), /Latte/);
    await page.keyboard.press('Escape');
  });
  await step('collapse Food, open Home: remembered per group in settings.legendOpen, after reload and in a backup', async () => {
    await page.locator('.cat-legend > li[data-g="Food"] .sw-btn').click(); await page.locator('.cat-legend > li[data-g="Home"] .sw-btn').click();
    assert.ok(await page.locator('.cat-legend > li[data-g="Food"] .lg-kids').isHidden()); assert.ok(await page.locator('.cat-legend > li[data-g="Home"] .lg-kids').isVisible());
    const s = await getState(page); assert.deepEqual(s.settings.legendOpen, { Food: false, Home: true });
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.cat-legend');
    assert.ok(await page.locator('.cat-legend > li[data-g="Food"] .lg-kids').isHidden(), 'Food stays collapsed'); assert.ok(await page.locator('.cat-legend > li[data-g="Home"] .lg-kids').isVisible(), 'Home stays open');
    await page.goto(BASE + '#income', { waitUntil: 'load' }); await page.click('[data-action="copy-backup"]'); await page.waitForSelector('#bk');
    assert.match(await page.inputValue('#bk'), /"legendOpen": \{\s+"Food": false,\s+"Home": true/); await page.keyboard.press('Escape');
    await page.locator('.ov-donut').first().evaluate(() => 0).catch(() => 0);
    await page.goto(BASE + '#overview', { waitUntil: 'load' });
    await page.locator('.cat-legend > li[data-g="Food"] .sw-btn').click(); // leave Food open for the screenshots
  });
  await step('951x669 landscape: legend names are not cut, no horizontal scroll, dark and light', async () => {
    await page.setViewportSize({ width: 951, height: 669 }); await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(250);
    const cut = await page.evaluate(() => [...document.querySelectorAll('.ov-donut .cat-legend .lc, .ov-donut .cat-legend .kn')].filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map(e => e.textContent));
    assert.deepEqual(cut, []); await noHScroll(page, '951 overview dark'); await page.locator('.ov-donut').screenshot({ path: SHOTS + '/legend-951.png' });
    await page.emulateMedia({ colorScheme: 'light' }); await noHScroll(page, '951 overview light'); await page.setViewportSize({ width: 390, height: 844 });
  });
  assert.deepEqual(errs, [], 'page errors'); await ctx.close();
}

/* ---------- Electronics Repair ---------- */
{
  const { page, errs, ctx } = await newPage(390, 844);
  await step('cats-v3 adds Electronics Repair right after Electronics, under Shopping, once; Home > Repairs kept', async () => {
    let s = await getState(page);
    assert.ok(s.imports.includes('cats-v3')); assert.equal(s.categories.filter(c => c === 'Electronics Repair').length, 1);
    assert.equal(s.categories.indexOf('Electronics Repair'), s.categories.indexOf('Electronics') + 1); assert.equal(s.catParents['Electronics Repair'], 'Shopping');
    await page.reload({ waitUntil: 'load' }); s = await getState(page); assert.equal(s.categories.filter(c => c === 'Electronics Repair').length, 1, 'no duplicate on reload');
    await page.click('[data-type="extra"][data-action="add"]'); await page.waitForSelector('#form');
    const opts = await page.locator('#form select[name="category"] optgroup[label="Shopping"] option').allInnerTexts();
    assert.deepEqual(opts.slice(0, 3).filter(Boolean), ['Clothing', 'Electronics', 'Electronics Repair'].filter(c => opts.includes(c)));
    assert.ok(opts.indexOf('Electronics Repair') === opts.indexOf('Electronics') + 1, 'placed right after Electronics: ' + opts.join());
    assert.ok((await page.locator('#form select[name="category"] optgroup[label="Home"] option').allInnerTexts()).includes('Repairs'), 'Home > Repairs stays under Home');
    assert.ok(!(await page.locator('#form select[name="category"] optgroup[label="Shopping"] option').allInnerTexts()).includes('Repairs'));
    await page.keyboard.press('Escape');
  });
  assert.deepEqual(errs, [], 'page errors'); await ctx.close();
}

/* ---------- Savings only when on; To savings from a transaction ---------- */
{
  const { page, errs, ctx } = await newPage(390, 844, { bank: { txns: { 'pl:tr1': tx('pl:tr1', 'TRANSFER TO SAVINGS', 200), 'pl:cof': tx('pl:cof', 'BLUE BOTTLE', 6.5) } } });
  await page.waitForSelector('.ov-donut');
  await step('savings is invisible while off: no chip, no cycle line, no chart group, no savings section', async () => {
    assert.equal(await page.locator('.sv-chip, .hero-saved, .cat-legend [data-g="Savings"]').count(), 0);
    await page.click('.lad.l3'); await page.waitForSelector('#acctform');
    assert.equal(await page.locator('#sheet .sv-box').count(), 0); assert.equal(await page.locator('#sheet [data-action="sv-on"]').count(), 0);
    assert.equal(await page.locator('#sheet [data-action="sv-add"]').count(), 1);
    await page.keyboard.press('Escape');
    await page.goto(BASE + '#income', { waitUntil: 'load' }); assert.equal(await page.locator('[data-action="sv-add"]:visible').count(), 1, 'Income tab has Add to savings'); assert.equal(await page.locator('.sv-box').count(), 0);
  });
  await step('Add to savings records a move, turns savings on; chip, "Saved this cycle" and the chart group appear; checking drops', async () => {
    const before = await page.evaluate(([t]) => BT.accountBalance(JSON.parse(localStorage.getItem('budtrack.v1')), t), [TODAY]); const needed0 = await (async () => { await page.goto(BASE + '#overview', { waitUntil: 'load' }); return heroNeeds(page); })();
    await page.click('.lad.l3'); await page.waitForSelector('#acctform'); await page.click('#sheet [data-action="sv-add"]'); await page.waitForSelector('#svadd');
    await page.fill('#sa-amt', '100'); await page.selectOption('#sa-from', { index: 1 }); await page.fill('#sa-note', 'Rainy day');
    await page.click('#svadd button[type="submit"]'); await page.waitForSelector('.sv-chip');
    const s = await getState(page); assert.equal(s.savings.on, true); assert.equal(s.savings.tx.length, 1);
    assert.equal(s.savings.tx[0].type, 'in'); assert.equal(s.savings.tx[0].amount, 100); assert.equal(s.savings.tx[0].note, 'Rainy day'); assert.equal(s.savings.tx[0].date, TODAY); assert.ok(s.savings.tx[0].from);
    assert.match(await page.locator('.hero-saved').innerText(), /Saved this cycle\s*\$100\.00/);
    assert.equal(await page.locator('.cat-legend > li[data-g="Savings"]').count(), 1); assert.equal(await page.locator('.donut-wrap .slice').count(), await page.locator('.cat-legend > li').count());
    assert.equal(await heroNeeds(page), needed0, 'savings is not spending: cycle needs unchanged');
    const after = await page.evaluate(([t]) => BT.accountBalance(JSON.parse(localStorage.getItem('budtrack.v1')), t), [TODAY]); assert.equal(Math.round((before - after) * 100), 10000, 'checking drops by the move');
    await noHScroll(page, '390 savings'); await page.evaluate(() => { const x = document.querySelector('#toast.on .toast-x'); if (x) x.click(); }); await page.waitForTimeout(600); await page.screenshot({ path: SHOTS + '/savings-390.png' });
  });
  await step('live bank balances on: savings does not change In account (no double count)', async () => {
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.bank.balances = { at: new Date().toISOString(), items: [{ itemId: 'enr_1', institution: 'Chime', accounts: [{ id: 'a1', name: 'Checking', type: 'depository', current: 1234.5, available: 1234.5 }] }] }; localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.lad.l3');
    assert.match(await page.locator('.lad.l3 .v').innerText(), /1,234/); assert.equal(await page.locator('.sv-chip').count(), 0, 'no stale savings chip beside a live balance');
    await page.click('.lad.l3'); await page.waitForSelector('.bal-total'); assert.equal(await page.locator('#sheet [data-action="sv-add"]').count(), 1);
    assert.ok(await page.evaluate(() => { const s = document.querySelector('#sheet .sheet'); return s.scrollWidth <= s.clientWidth + 1; }), 'live-balance sheet has no horizontal scroll'); await page.keyboard.press('Escape');
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.bank.balances = null; localStorage.setItem('budtrack.v1', JSON.stringify(s)); }); await page.reload({ waitUntil: 'load' });
  });
  await step('"To savings" on a Transactions row records a savings in, marks it Transfer; Undo removes it', async () => {
    const bal = () => page.evaluate(([d]) => BT.accountBalance(JSON.parse(localStorage.getItem('budtrack.v1')), d), [TODAY]);
    const n0 = (await getState(page)).savings.tx.length, b0 = await bal();
    await page.goto(BASE + '#transactions', { waitUntil: 'load' }); await page.waitForSelector('.tx[data-id="pl:tr1"]');
    await page.locator('.tx[data-id="pl:tr1"] .tx-main').click(); await page.locator('.tx[data-id="pl:tr1"] [data-action="tx-sv"]').click();
    await page.waitForFunction(n => JSON.parse(localStorage.getItem('budtrack.v1')).savings.tx.length === n + 1, n0);
    let s = await getState(page), r = s.bank.seen['pl:tr1']; assert.equal(r.res, 'transfer'); const sv = s.savings.tx.find(t => t.id === r.sv);
    assert.ok(sv && sv.type === 'in' && sv.amount === 200 && sv.txn === 'pl:tr1' && sv.date === TODAY);
    assert.equal(await bal(), b0, 'the bank balance you typed already reflects the move: In account does not change');
    assert.match(await page.locator('.tx[data-id="pl:tr1"] .txc').innerText(), /Transfer/); assert.equal(await page.locator('.tx[data-id="pl:tr1"] [data-action="tx-sv"]').count(), 0);
    await page.locator('.tx[data-id="pl:tr1"] [data-action="tx-undo"]').click();
    await page.waitForFunction(n => JSON.parse(localStorage.getItem('budtrack.v1')).savings.tx.length === n, n0);
    s = await getState(page); assert.ok(!s.bank.seen['pl:tr1'] || s.bank.seen['pl:tr1'].res !== 'transfer'); assert.ok(!s.savings.tx.some(t => t.txn === 'pl:tr1'));
    assert.equal(await bal(), b0, 'Undo gives back exactly what the move took (no leftover adjustment)'); assert.ok(!s.account.adj.some(x => x.sv));
    await noHScroll(page, '390 transactions');
    // v21: only transfers, person-to-person lines and money in offer it; a purchase never does
    await page.locator('.tx[data-id="pl:cof"] .tx-main').click(); assert.equal(await page.locator('.tx[data-id="pl:cof"] [data-action="tx-sv"]').count(), 0, 'a purchase has no To savings');
    await page.locator('.tx[data-id="pl:tr1"] .tx-main').click(); assert.equal(await page.locator('.tx[data-id="pl:tr1"] [data-action="tx-sv"]').count(), 1);
    await page.locator('.tx[data-id="pl:tr1"] [data-action="tx-sv"]').click(); await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).savings.tx.some(t => t.txn === 'pl:tr1'));
    assert.equal(await bal(), b0); await noHScroll(page, '390 transactions expanded');
    await page.click('#toast .toast-undo'); await page.waitForFunction(() => !JSON.parse(localStorage.getItem('budtrack.v1')).savings.tx.some(t => t.txn === 'pl:tr1'));
    assert.equal(await bal(), b0, 'undo from the toast too');
    await page.setViewportSize({ width: 951, height: 669 }); await page.locator('.tx[data-id="pl:tr1"] .tx-main').click(); await noHScroll(page, '951 transactions expanded'); await page.setViewportSize({ width: 390, height: 844 });
  });
  assert.deepEqual(errs, [], 'page errors'); await ctx.close();
}

/* ---------- Skip this cycle; one-time vs permanent amounts ---------- */
{
  const { page, errs, ctx } = await newPage(390, 844);
  await page.waitForSelector('.ov-bills');
  await step('Skip this cycle on a bill: out of the list and of needed, shown under a collapsed Skipped list; Unskip restores it', async () => {
    const n0 = await heroNeeds(page);
    await page.locator('.ov-bills .row', { hasText: 'Electric' }).locator('.tapzone').click(); await page.waitForSelector('#occform');
    await page.click('#occ-actions [data-action="skip-cycle"]');
    await page.waitForFunction(() => !/Electric/.test(document.querySelector('.ov-bills .rows').innerText));
    assert.equal(await heroNeeds(page), n0 - 100);
    const s = await getState(page), k = Object.keys(s.occ).find(k => /^b:elec:/.test(k)); assert.ok(s.occ[k].skip && s.occ[k].skipped);
    assert.equal(await page.locator('details.skipped[open]').count(), 0, 'collapsed by default');
    await page.locator('details.skipped summary').click(); assert.match(await page.locator('details.skipped').innerText(), /Electric/);
    await page.locator('details.skipped [data-action="unskip"]').click(); await page.waitForFunction(() => /Electric/.test(document.querySelector('.ov-bills .rows').innerText));
    assert.equal(await heroNeeds(page), n0); assert.equal(await page.locator('details.skipped').count(), 0);
  });
  await step('Skip this cycle works for a card minimum and a budget; undo from the toast', async () => {
    const n0 = await heroNeeds(page);
    await page.locator('.ov-bills .row', { hasText: 'Visa' }).locator('.tapzone').click(); await page.click('#occ-actions [data-action="skip-cycle"]');
    await page.waitForFunction(() => !/Visa/.test(document.querySelector('.ov-bills .rows').innerText)); assert.equal(await heroNeeds(page), n0 - 35);
    await page.click('#toast .toast-undo'); await page.waitForFunction(() => /Visa/.test(document.querySelector('.ov-bills .rows').innerText)); assert.equal(await heroNeeds(page), n0);
    await page.locator('.row.bgt', { hasText: 'Gas' }).click(); await page.waitForSelector('.bud-strip'); await page.click('#sheet [data-action="skip-cycle"]');
    await page.waitForFunction(() => !document.querySelector('.row.bgt[data-id="gas"]')); assert.equal(await heroNeeds(page), n0 - 60);
    await page.locator('details.skipped summary').click(); await page.locator('details.skipped [data-action="unskip"]').click(); await page.waitForSelector('.row.bgt[data-id="gas"]'); assert.equal(await heroNeeds(page), n0);
  });
  await step('editing a bill amount asks "Just this cycle" / "From now on"; default is this cycle', async () => {
    await page.locator('.ov-bills .row', { hasText: 'Rent' }).locator('.amt-btn').click(); await page.waitForSelector('#occform');
    assert.ok(await page.locator('#o-scope').isHidden(), 'no question until the amount changes');
    await page.fill('#o-amount', '900'); assert.ok(await page.locator('#o-scope').isVisible());
    assert.equal(await page.locator('#o-scope input[value="once"]').isChecked(), true); assert.match(await page.locator('#o-scope').innerText(), /Just this cycle[\s\S]*From now on/);
    await page.evaluate(() => { const x = document.querySelector('#toast.on .toast-x'); if (x) x.click(); }); await page.waitForTimeout(600); await sheetShot(page, 'amount-ask-390.png'); await noHScroll(page, '390 amount ask');
    await page.click('#occform button[type="submit"]'); await page.waitForFunction(() => /\$900\.00/.test(document.querySelector('.ov-bills .rows').innerText));
    let s = await getState(page), rk = Object.keys(s.occ).find(k => /^b:rent:/.test(k) && s.occ[k].amount === 900);
    assert.ok(rk, 'cycle override stored'); assert.equal(s.bills.find(b => b.id === 'rent').amount, 1000, 'bill unchanged');
    await page.locator('.ov-bills .row', { hasText: 'Rent' }).locator('.amt-btn').click(); await page.fill('#o-amount', '850'); await page.check('#o-scope input[value="forever"]');
    await page.click('#occform button[type="submit"]'); await page.waitForFunction(() => /\$850\.00/.test(document.querySelector('.ov-bills .rows').innerText));
    s = await getState(page); assert.equal(s.bills.find(b => b.id === 'rent').amount, 850); assert.equal(s.occ[rk] && s.occ[rk].amount, undefined, 'this cycle follows the new amount');
    const past = Object.keys(s.occ).filter(k => /^b:rent:/.test(k) && s.occ[k].amount === 1000); assert.ok(past.length >= 1, 'past cycles keep the old amount');
    assert.ok(past.every(k => k.split(':')[2] < TODAY));
  });
  await step('budget amount: Just this cycle overrides, From now on changes the base', async () => {
    await page.locator('.row.bgt', { hasText: 'Groceries' }).click(); await page.waitForSelector('.bud-strip'); await page.click('#sheet [data-action="bud-amt"]'); await page.waitForSelector('#budamt');
    assert.ok(await page.locator('#o-scope input[value="once"]').isChecked()); await page.fill('#ba-amt', '200'); await page.click('#budamt button[type="submit"]');
    await page.waitForFunction(() => /\$200\.00/.test(document.querySelector('.row.bgt[data-id="groc"]').innerText));
    let s = await getState(page); assert.equal(s.perPeriod.find(p => p.id === 'groc').amount, 150); assert.ok(Object.keys(s.occ).some(k => /^s:groc:/.test(k) && s.occ[k].amount === 200));
    await page.locator('.row.bgt', { hasText: 'Groceries' }).click(); await page.click('#sheet [data-action="bud-amt"]'); await page.fill('#ba-amt', '175'); await page.check('#o-scope input[value="forever"]'); await page.click('#budamt button[type="submit"]');
    await page.waitForFunction(() => /\$175\.00/.test(document.querySelector('.row.bgt[data-id="groc"]').innerText));
    s = await getState(page); assert.equal(s.perPeriod.find(p => p.id === 'groc').amount, 175); assert.ok(!Object.keys(s.occ).some(k => /^s:groc:/.test(k) && s.occ[k].amount === 200));
  });
  await step('bill edit form with history asks the same question', async () => {
    await page.goto(BASE + '#bills', { waitUntil: 'load' }); await page.locator('#bs-fixed .row', { hasText: 'Electric' }).click(); await page.waitForSelector('#form');
    assert.ok(await page.locator('#o-scope').isHidden()); await page.fill('#f-amount', '120'); assert.ok(await page.locator('#o-scope').isVisible());
    await page.click('#form button[type="submit"]'); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
    let s = await getState(page); assert.equal(s.bills.find(b => b.id === 'elec').amount, 100, 'default is just this cycle'); assert.ok(Object.keys(s.occ).some(k => /^b:elec:/.test(k) && s.occ[k].amount === 120));
    await page.locator('#bs-fixed .row', { hasText: 'Electric' }).click(); await page.fill('#f-amount', '130'); await page.check('#o-scope input[value="forever"]'); await page.click('#form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#sheet').hidden); s = await getState(page); assert.equal(s.bills.find(b => b.id === 'elec').amount, 130);
  });
  assert.deepEqual(errs, [], 'page errors'); await ctx.close();
}
async function sheetShot(page, f) { await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/' + f }); }

/* ---------- Bank connections labels ---------- */
{
  const { page, errs, calls, ctx } = await newPage(390, 844, { bank: { txns: {} } });
  await page.goto(BASE + '#income', { waitUntil: 'load' }); await page.waitForSelector('.bk-enr');
  await step('Bank card: header says "Refresh all", each bank says "Sync"; behaviors unchanged', async () => {
    assert.equal((await page.locator('#bankcard .card-h [data-action="bk-sync"]').innerText()).trim(), 'Refresh all');
    const per = await page.locator('.bk-enr [data-action="bk-item-sync"]').allInnerTexts(); assert.deepEqual(per.map(t => t.trim()), ['Sync', 'Sync']);
    assert.equal(await page.locator('#bankcard').getByRole('button', { name: 'Sync Chime' }).count(), 1);
    calls.length = 0; await page.click('#bankcard .card-h [data-action="bk-sync"]'); await page.waitForFunction(() => !document.querySelector('#bankcard [data-action="bk-sync"]').disabled);
    assert.ok(calls.includes('/refresh') && calls.some(c => c.startsWith('/sync')) && !calls.some(c => c.includes('item=')), 'all banks: ' + calls.join());
    calls.length = 0; await page.locator('.bk-enr').nth(1).locator('[data-action="bk-item-sync"]').click(); await page.waitForFunction(() => !document.querySelector('.bk-enr .spin'));
    assert.ok(calls.includes('/refresh?item=enr_2') && calls.some(c => /^\/sync\?.*item=enr_2/.test(c)), 'one bank: ' + calls.join());
    await noHScroll(page, '390 bank card');
  });
  assert.deepEqual(errs, [], 'page errors'); await ctx.close();
}

/* ---------- Bills tab: Apple nested in Subscriptions, chips ---------- */
{
  const { page, errs, ctx } = await newPage(390, 844);
  await page.goto(BASE + '#bills', { waitUntil: 'load' }); await page.waitForSelector('#bs-subs');
  await step('Subscriptions is one section with an Apple sub-section (subtotal); no separate Apple Subscriptions card', async () => {
    const heads = await page.locator('.card-h h2').allInnerTexts(); assert.ok(!heads.some(h => /Apple/.test(h)), heads.join()); assert.equal(heads.filter(h => /Subscriptions/.test(h)).length, 1);
    const t = await page.locator('#bs-subs').innerText(); assert.match(t, /\$15\.00\/mo/); assert.match(t, /Spotify[\s\S]*apple · 1[\s\S]*\$3\.00\/mo[\s\S]*iCloud/i);
    assert.equal(await page.locator('#bs-subs .apple-h').count(), 1); assert.equal(await page.locator('#bs-subs .apple-rows .row').count(), 1);
    assert.equal(await page.locator('#bs-fixed .row', { hasText: 'iCloud' }).count(), 0);
    const s = await getState(page); assert.equal(s.bills.find(b => b.id === 'icl').group, 'Apple Subscriptions', 'stored group untouched');
    await page.click('#bs-subs [data-action="add"]'); await page.waitForSelector('#form'); const o = await page.locator('#form select[name="group"] option').allInnerTexts();
    assert.deepEqual(o, ['Fixed', 'Subscriptions', 'Subscriptions › Apple', 'Other bills']); await page.keyboard.press('Escape');
    await noHScroll(page, '390 subs'); await page.locator('#bs-subs').screenshot({ path: SHOTS + '/subs-390.png' });
  });
  await step('a Fixed bill with category Subscriptions is listed under Subscriptions', async () => {
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.bills.push({ id: 'zz', name: 'Gym app', amount: 9, day: 9, group: 'Fixed', category: 'Subscriptions' }); localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' }); assert.equal(await page.locator('#bs-subs .row', { hasText: 'Gym app' }).count(), 1); assert.equal(await page.locator('#bs-fixed .row', { hasText: 'Gym app' }).count(), 0);
  });
  await step('chips highlight, remember the choice, and scroll to their section', async () => {
    assert.equal(await page.locator('.bs-chip[aria-pressed="true"]').count(), 0);
    await page.evaluate(() => scrollTo(0, 0));
    await page.click('.bs-chip[data-v="budgets"]'); assert.equal(await page.locator('.bs-chip[data-v="budgets"]').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => { const t = document.getElementById('bs-budgets').getBoundingClientRect().top; return t >= 0 && t < innerHeight * 0.9; });
    assert.equal(await page.locator('.bs-chip[aria-pressed="true"]').count(), 1); assert.equal((await getState(page)).settings.billsView, 'budgets');
    await page.click('.bs-chip[data-v="subs"]'); await page.waitForFunction(() => { const t = document.getElementById('bs-subs').getBoundingClientRect().top; return t >= 0 && t < innerHeight * 0.9; });
    assert.equal(await page.locator('.bs-chip[aria-pressed="true"]').getAttribute('data-v'), 'subs');
    await page.reload({ waitUntil: 'load' }); assert.equal(await page.locator('.bs-chip[aria-pressed="true"]').getAttribute('data-v'), 'subs', 'remembered');
  });
  await step('All recurring renders every bill, subscription (Apple too), card minimum and budget, sorted by day', async () => {
    await page.evaluate(() => scrollTo(0, 0)); await page.click('.bs-chip[data-v="all"]'); await page.waitForSelector('#bs-all');
    const names = await page.locator('#bs-all .rows .row .nm').allInnerTexts(); const want = ['Gym app', 'Rent', 'Electric', 'Spotify', 'iCloud', 'Visa', 'Groceries', 'Gas'];
    want.forEach(n => assert.ok(names.some(x => x.trim().startsWith(n)), n + ' in ' + names.join()));
    const days = await page.locator('#bs-all .rows .row .daybadge').allInnerTexts(); const nums = days.filter(d => /^\d+(st|nd|rd|th)$/.test(d.trim())).map(num); assert.deepEqual(nums, nums.slice().sort((a, b) => a - b), 'sorted by day');
    assert.ok(names.findIndex(n => /Groceries/.test(n)) > names.findIndex(n => /Visa/.test(n)), 'budgets last');
    assert.equal(await page.locator('.bs-chip[aria-pressed="true"]').getAttribute('data-v'), 'all'); assert.equal((await getState(page)).settings.billsView, 'all');
    await noHScroll(page, '390 all recurring'); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: SHOTS + '/bills-chips-390.png' });
    await page.click('.bs-chip[data-v="fixed"]'); await page.waitForFunction(() => !document.getElementById('bs-all'));
  });
  await step('951x669 landscape, dark: bills tab has no horizontal scroll', async () => {
    await page.setViewportSize({ width: 951, height: 669 }); await page.emulateMedia({ colorScheme: 'dark' }); await page.click('.bs-chip[data-v="all"]'); await page.waitForTimeout(250); await noHScroll(page, '951 bills dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });
  assert.deepEqual(errs, [], 'page errors'); await ctx.close();
}

await browser.close();
finish();
