// Checks for: Insurance under Transportation, Subscriptions as its own chart slice (Apple inside),
// the Cycle | Month chart switch, and "Spent so far" counting every expense incl. bank lines to review.
// Run: node tests/v9.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import assert from 'node:assert/strict';
import { pw, SHOTS, BASE, iso, step, finish } from './lib.mjs';

const b = await pw.chromium.launch();
for (const [w, h] of [[390, 844], [951, 669]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(BASE + '?v9=' + Date.now(), { waitUntil: 'networkidle' });
  // A cycle that starts today with: rent, car insurance, Spotify, iCloud (Apple), a $40 Groceries spend,
  // a $12 DoorDash spend, a $70 paid electric bill, and bank lines: one waiting for review, one card payment.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1'));
    const d = new Date(), iso = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    const today = iso(d), plus = n => { const x = new Date(d); x.setDate(x.getDate() + n); return iso(x); };
    const day = n => new Date(plus(n) + 'T12:00').getDate();
    s.since = today; s.settings.anchor = today;
    s.income = [{ id: 'i1', name: 'Paycheck', amount: 2000, freq: 'biweekly', date: today }];
    s.bills = [
      { id: 'b1', day: day(3), name: 'Rent', amount: 1000, group: 'Fixed', category: 'Housing', active: true, note: '' },
      { id: 'b2', day: day(4), name: 'Car insurance', amount: 80, group: 'Fixed', category: 'Insurance', active: true, note: '' },
      { id: 'b3', day: day(5), name: 'Spotify', amount: 12, group: 'Subscriptions', active: true, note: '' },
      { id: 'b4', day: day(5), name: 'iCloud', amount: 3, group: 'Apple Subscriptions', active: true, note: '' },
      { id: 'b5', day: day(0), name: 'Electric', amount: 70, group: 'Fixed', category: 'Utilities', active: true, note: '' }];
    s.marks['b:b5:' + today] = true; s.occ['b:b5:' + today] = { checkedOn: today };
    s.perPeriod = [{ id: 'pp1', name: 'Groceries', amount: 150, category: 'Groceries' }];
    s.spends = [{ id: 'x1', category: 'Groceries', desc: 'Shoprite', amount: 40, date: today, via: '', note: '' },
                { id: 'x2', category: 'Takeout Food', desc: 'DoorDash', amount: 12, date: today, via: '', note: '' }];
    s.plans = []; s.cards = []; s.unalloc = [];
    const acct = { id: 'a1', name: 'Checking', last4: '6429', institution: 'Santander', type: 'depository' };
    const t = (id, amount, desc) => ({ id, date: today, desc, rawDesc: desc, amount, account: acct, status: 'posted', pendingOf: null, counterparty: null, providerCategory: null });
    s.bank = Object.assign(s.bank || {}, { txns: { 'pl:r1': t('pl:r1', 9.5, 'CPI*CANTEEN'), 'pl:c1': t('pl:c1', 35, 'CAPITAL ONE CREDIT CARD PAYMENT') },
      inbox: [{ txn: t('pl:r1', 9.5, 'CPI*CANTEEN'), kind: 'spend', confidence: 'medium', cands: [], pick: null, category: 'Snacks & Drinks' },
              { txn: t('pl:c1', 35, 'CAPITAL ONE CREDIT CARD PAYMENT'), kind: 'transfer', confidence: 'medium', cands: [], pick: null }], seen: {}, history: [] });
    s.imports = (s.imports || []).filter(k => k !== 'cats-v4');
    s.catParents = Object.assign(s.catParents || {}, { Insurance: 'Bills & Finance' });
    s.settings.chartRange = 'cycle'; s.settings.legendOpen = { Subscriptions: true, Transportation: true };
    localStorage.setItem('budtrack.v1', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(300);

  await step(`${w}: Insurance moved under Transportation (migration)`, async () => {
    const par = await page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')).catParents.Insurance);
    assert.equal(par, 'Transportation');
    const kids = await page.locator('.cat-legend li[data-g="Transportation"] .lg-kids').innerText();
    assert.match(kids, /Insurance/);
  });
  await step(`${w}: Subscriptions is its own slice with Apple inside`, async () => {
    const groups = await page.$$eval('.cat-legend > li', ls => ls.map(l => l.dataset.g));
    assert.ok(groups.includes('Subscriptions'), 'Subscriptions group: ' + groups.join(','));
    assert.ok(!groups.includes('Entertainment'), 'subscriptions no longer roll into Entertainment');
    const kids = await page.locator('.cat-legend li[data-g="Subscriptions"] .lg-kids').innerText();
    assert.match(kids, /Subscriptions[\s\S]*\$12\.00/); assert.match(kids, /Apple Subscriptions[\s\S]*\$3\.00/);
  });
  await step(`${w}: Spent so far = paid bill + every spend + bank line to review (card payment left out)`, async () => {
    const t = await page.locator('.hero-stats > div').first().innerText();
    // 70 electric + 40 groceries + 12 DoorDash + 9.50 vending to review = 131.50
    assert.match(t, /\$131\.50/, t); assert.match(t, /incl\. \$9\.50 to review/, t);
  });
  await step(`${w}: Cycle | Month switch changes the chart and is remembered`, async () => {
    await page.click('[data-action="chart-range"][data-r="month"]');
    assert.match(await page.locator('.ov-donut h2').innerText(), /^Where \w+ goes$/);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('[data-action="chart-range"][data-r="month"]').getAttribute('aria-pressed'), 'true');
    if (w === 390) await page.locator('.ov-donut').screenshot({ path: SHOTS + '/chart-month-390.png' });
    await page.click('[data-action="chart-range"][data-r="cycle"]');
    assert.match(await page.locator('.ov-donut h2').innerText(), /this pay cycle/);
  });
  await step(`${w}: no horizontal scroll, no page errors`, async () => {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errs, []);
  });
  if (w === 390) await page.locator('.ov > .hero').screenshot({ path: SHOTS + '/spent-390.png' });
  await ctx.close();
}
await b.close();
finish();
