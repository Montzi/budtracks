// v20: Pay later: cycle total on top, + icon, bank CSV import lives in Income, postpone a payment.
// Run: node tests/v20.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const SHOTS = process.argv[2] || '/tmp';
const BASE = process.env.BT_URL || 'http://localhost:8765/';
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n   ', String(e.message).split('\n').slice(0, 14).join('\n    ')); } };
const b = await pw.chromium.launch();
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const short = s => { const d = new Date(s + 'T12:00:00'); return ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getMonth()] + ' ' + d.getDate(); };
// Cycle = [day(-2), day(12)). Nike 2 of 4 on day(8), Afterpay 1 of 4 on day(0), Cap 3 of 4 on day(9) (paid).
const fixture = () => ({
  since: '2026-10-01', marks: { 'p:cap:3': true }, occ: {}, spends: [], unalloc: [], perPeriod: [],
  categories: ['Gas', 'Groceries', 'Other'], payVia: [],
  bank: { seen: {}, rules: {}, links: {}, lastSync: null, inbox: [], savingsAccts: {} },
  bills: [], cards: [],
  plans: [
    { id: 'nike', provider: 'Klarna', merchant: 'Nike', amount: 27.65, total: 4, paid: 1, freq: 'biweekly', lastDate: day(-6), category: 'Other', autopay: true },
    { id: 'shoe', provider: 'Afterpay', merchant: 'Shoes', amount: 40, total: 4, paid: 0, freq: 'biweekly', lastDate: day(-14), category: 'Other', autopay: true },
    { id: 'cap', provider: 'Klarna', merchant: 'Cap', amount: 30, total: 4, paid: 2, freq: 'biweekly', lastDate: day(-5), category: 'Other', autopay: true },
    { id: 'pp', provider: 'PayPal', merchant: 'Lamp', amount: 20, total: 4, paid: 1, freq: 'monthly', lastDate: day(-3), category: 'Other', autopay: true }
  ],
  income: [{ id: 'pay', name: 'Payroll', freq: 'biweekly', date: day(-2), amount: 1500, askFrom: day(-2), perCycle: {} }],
  account: { balance: 3000, asOf: '2026-10-01', adj: [], auto: true }
});
async function newPage(w, h, o) {
  o = o || {};
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: o.scheme || 'dark', deviceScaleFactor: 1 });
  const page = await ctx.newPage(); page.setDefaultTimeout(6000);
  await page.addInitScript(() => { if (!localStorage.getItem('budtrack.incopen')) localStorage.setItem('budtrack.incopen', '{"bank":true}'); }); // v46: Bank connections opens and closes
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(([fx, st, theme]) => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1') || '{}'), f = JSON.parse(fx);
    Object.assign(s, f); s.settings = Object.assign(s.settings || {}, { view: 'biweekly' }, st, theme ? { theme } : {});
    localStorage.setItem('budtrack.v1', JSON.stringify(s));
  }, [JSON.stringify(fixture()), o.settings || {}, o.theme || '']);
  await page.goto(BASE + '#plans', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  return { ctx, page, errs };
}
const getState = page => page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')));
const noHScroll = async (page, m) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 0.5), 'horizontal scroll ' + m);
const overlap = (a, c) => a.l < c.r - .01 && c.l < a.r - .01 && a.t < c.b - .01 && c.t < a.b - .01;
const text = (page, sel) => page.locator(sel).first().textContent().then(t => t.replace(/\s+/g, ' ').trim());
const cycleNums = async page => ({ big: await text(page, '.plan-sum .ps-v'), sub: await text(page, '.plan-sum .ps-s') });
const card = (page, name) => page.locator('.plan', { hasText: name }).first();
const openPostpone = async (page, id) => { await page.click(`[data-action="postpone"][data-id="${id}"]`); await page.waitForSelector('#postform'); };
const postpone = async (page, id, to, shift) => {
  await openPostpone(page, id);
  if (to) await page.fill('#pp-date', to);
  if (shift === false) await page.uncheck('#postform [name=shift]');
  await page.click('#postform button[type=submit]'); await page.waitForTimeout(250);
};
const planOf = async (page, id) => (await getState(page)).plans.find(p => p.id === id);

for (const [w, h] of [[390, 844], [669, 951], [951, 669]]) {
  const { page, errs, ctx } = await newPage(w, h);
  const tag = `${w}x${h}`;
  await step(`${tag}: Plans header has only the + icon, which opens Log purchase`, async () => {
    const head = page.locator('.card-h', { has: page.locator('h2', { hasText: 'Active plans' }) });
    assert.equal(await head.locator('button').count(), 1);
    assert.equal(await head.locator('button:has-text("Import bank CSV"), button:has-text("Log purchase")').count(), 0);
    const plus = head.locator('button[aria-label="Log a purchase"]');
    assert.equal(await plus.count(), 1);
    const bb = await plus.boundingBox(); assert.ok(Math.abs(bb.width - bb.height) < 1 && bb.width >= 28);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[aria-label="Log a purchase"]')).borderRadius), '50%');
    await plus.click();
    await page.waitForSelector('#form[data-type="plan"]');
    assert.match(await text(page, '#sheetBody h3'), /log a purchase/i);
    await page.click('#sheetBody [data-action="close"]');
    assert.equal(await page.locator('[data-action="bank-import"]').count(), 0, 'no import button on Plans');
    await noHScroll(page, 'plans');
  });
  await step(`${tag}: Income "Your data" ends with Import bank CSV`, async () => {
    await page.evaluate(() => { location.hash = 'income'; }); await page.waitForTimeout(300);
    const card = page.locator('section.card', { has: page.locator('h2', { hasText: 'Your data' }) });
    assert.equal(await card.locator('[data-action="bank-import"]').count(), 1);
    assert.equal((await card.locator('button').last().textContent()).trim(), 'Import bank CSV');
    assert.equal(await page.locator('[data-action="bank-import"]').count(), 1);
    await card.locator('[data-action="bank-import"]').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#sheet').isVisible(), true, 'import flow opens');
    await page.keyboard.press('Escape');
    await noHScroll(page, 'income');
    await page.evaluate(() => { location.hash = 'plans'; }); await page.waitForTimeout(300);
  });
  await step(`${tag}: "Plans this pay cycle" total, subline and list sheet agree`, async () => {
    assert.match(await text(page, '.plan-sum .ps-k'), /^Plans this pay cycle$/);
    const n = await cycleNums(page);
    assert.equal(n.big, '$97.65');
    assert.equal(n.sub, '3 payments · $30.00 paid · $67.65 left');
    const top = await page.evaluate(() => { const a = document.querySelector('.plan-sum').getBoundingClientRect(), p = document.querySelector('.prov').getBoundingClientRect(); return a.bottom <= p.top; });
    assert.ok(top, 'above the provider tiles');
    await page.click('.plan-sum'); await page.waitForSelector('.pcs-list');
    assert.equal(await text(page, '#pcs-sum'), '$97.65');
    const rows = await page.locator('.pcs-row').evaluateAll(es => es.map(e => ({ t: e.textContent.replace(/\s+/g, ' ').trim(), logo: !!e.querySelector('.slogo, svg, img'), ck: e.querySelector('.pcs-ck').classList.contains('on') })));
    assert.equal(rows.length, 3);
    const amt = rows.map(r => +r.t.match(/\$([\d.]+)/)[1]).reduce((a, c) => a + c, 0);
    assert.ok(Math.abs(amt - 97.65) < .005);
    const cap = rows.find(r => /Cap/.test(r.t)); assert.ok(cap.ck); assert.match(cap.t, /3 of 4/); assert.ok(cap.t.includes(short(day(9))));
    assert.ok(rows.every(r => r.logo));
    assert.equal(rows.filter(r => r.ck).length, 1);
    await noHScroll(page, 'cycle sheet');
    await page.keyboard.press('Escape');
  });
  await step(`${tag}: balances hidden masks the cycle total`, async () => {
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.settings.hideBalances = true; localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(400);
    const n = await cycleNums(page); assert.ok(!/\d/.test(n.big.replace(/ /g, '')), n.big); assert.ok(!/\$\d/.test(n.sub), n.sub);
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.settings.hideBalances = false; localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
  });
  assert.deepEqual(errs, []);
  await ctx.close();
}

// Postpone scenarios (one fresh page each).
{
  const { page, errs, ctx } = await newPage(390, 844);
  await step('Postpone Klarna 2 of 4 by 7 days, rest follow: Ends moves, payment leaves the cycle, toast Undo restores', async () => {
    const before = await planOf(page, 'nike');
    assert.equal(before.dates, undefined);
    assert.match(await text(page, '.plan:has-text("Nike") .pc-dd'), new RegExp(short(day(8))));
    await openPostpone(page, 'nike');
    assert.match(await text(page, '#postform .pp-next'), /Payment 2 of 4/);
    assert.equal(await page.inputValue('#pp-date'), day(15), 'default +7');
    assert.ok(await page.locator('#postform [name=shift]').isChecked(), 'toggle on by default');
    assert.match(await text(page, '#postform .pp-guide'), /Klarna lets you extend a payment up to 7 days, once per purchase, in the Klarna app\./);
    assert.equal(await page.locator('.pp-w').count(), 0, 'no warning at 7 days');
    await page.click('#postform button[type=submit]'); await page.waitForTimeout(250);
    const p = await planOf(page, 'nike');
    assert.deepEqual(p.dates.slice(1), [day(15), day(29), day(43)]);
    assert.equal(p.postponed.length, 1); assert.equal(p.postponed[0].n, 2); assert.equal(p.postponed[0].from, day(8)); assert.equal(p.postponed[0].to, day(15));
    assert.match(await text(page, '.plan:has-text("Nike") .pc-dd'), new RegExp(short(day(15))));
    assert.ok((await text(page, '.plan:has-text("Nike") .pc-r4')).includes('Ends'));
    assert.match(await text(page, '.plan:has-text("Nike") .pc-r4'), new RegExp('Ends \\w+ ' + day(43).slice(5, 7) + '/' + day(43).slice(8)));
    const n = await cycleNums(page); assert.equal(n.big, '$70.00'); assert.equal(n.sub, '2 payments · $30.00 paid · $40.00 left');
    // Overview "this pay cycle" list: the payment is out of this cycle
    await page.evaluate(() => { location.hash = 'overview'; }); await page.waitForTimeout(300);
    const bt = await page.locator('body').innerText(); assert.ok(/Shoes/.test(bt) && !/Nike/.test(bt), 'Overview cycle list: Nike left, Shoes stays: ' + bt.replace(/\s+/g, ' ').slice(0, 700));
    await page.evaluate(() => { location.hash = 'plans'; }); await page.waitForTimeout(300);
    await page.click('#toast .toast-undo'); await page.waitForTimeout(250);
    const q = await planOf(page, 'nike');
    assert.equal(q.postponed, undefined); assert.equal(q.dates, undefined);
    assert.equal((await cycleNums(page)).big, '$97.65');
  });
  await step('Undo postpone from the plan card', async () => {
    await postpone(page, 'nike', day(14), true);
    assert.equal((await planOf(page, 'nike')).dates[1], day(14));
    await page.click('[data-action="undo-postpone"][data-id="nike"]'); await page.waitForTimeout(250);
    const q = await planOf(page, 'nike');
    assert.equal(q.postponed, undefined);
    assert.equal(await page.locator('[data-action="undo-postpone"]').count(), 0);
    assert.match(await text(page, '.plan:has-text("Nike") .pc-dd'), new RegExp(short(day(8))));
  });
  await step('Toggle off: only that payment moves', async () => {
    await postpone(page, 'nike', day(15), false);
    const p = await planOf(page, 'nike');
    assert.deepEqual(p.dates.slice(1), [day(15), day(22), day(36)]);
    assert.equal(p.postponed[0].shift, false);
    assert.equal((await cycleNums(page)).big, '$70.00');
    await page.click('[data-action="undo-postpone"][data-id="nike"]'); await page.waitForTimeout(200);
  });
  await step('Warnings: over 7 days; Afterpay first payment; PayPal guidance; already postponed', async () => {
    await openPostpone(page, 'nike');
    await page.fill('#pp-date', day(16));
    assert.match(await text(page, '.pp-warn'), /8 days later/);
    await page.fill('#pp-date', day(15));
    assert.equal(await page.locator('.pp-w').count(), 0);
    await page.keyboard.press('Escape');
    await openPostpone(page, 'shoe');
    assert.match(await text(page, '#postform .pp-next'), /Payment 1 of 4/);
    assert.match(await text(page, '#postform .pp-guide'), /Afterpay lets you move a payment up to 7 days, once per order\. The first and last payments can't be moved in the app \(returns: up to 14 days\)\./);
    assert.match(await text(page, '.pp-warn'), /first or last payment/);
    await page.click('#postform button[type=submit]'); await page.waitForTimeout(250);
    assert.equal((await planOf(page, 'shoe')).postponed.length, 1, 'warnings never block');
    await openPostpone(page, 'shoe');
    assert.match(await text(page, '.pp-warn'), /already postponed/);
    await page.keyboard.press('Escape');
    await openPostpone(page, 'pp');
    assert.match(await text(page, '#postform .pp-guide'), /Check your provider's app for what's allowed\./);
    await page.keyboard.press('Escape');
  });
  await step('A payment linked to a bank line cannot be postponed', async () => {
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.occ['p:cap:3'] = { txn: 'tx1' }; s.marks = {}; s.plans.find(p => p.id === 'cap').paid = 2; s.occ['p:pp:2'] = { txn: 'tx2' }; localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(400);
    await openPostpone(page, 'pp');
    assert.match(await text(page, '#sheetBody'), /already paid/);
    assert.equal(await page.locator('#postform button[type=submit]').isDisabled(), true);
    await page.keyboard.press('Escape');
  });
  assert.deepEqual(errs, []);
  await ctx.close();
}

for (const scheme of ['dark', 'light']) {
  const { page, errs, ctx } = await newPage(390, 844, { scheme, theme: scheme });
  await step(`390 ${scheme}: Plans page, cycle sheet and postpone sheet do not overlap or scroll sideways`, async () => {
    const boxes = await page.evaluate(() => [...document.querySelectorAll('.plan-sum, .prov .tile, .plan, .card-h')].map(e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, c: e.className }; }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      if (/card-h/.test(boxes[i].c) && /plan/.test(boxes[j].c)) continue;
      assert.ok(!overlap(boxes[i], boxes[j]) || boxes[i].c.includes('card-h') || boxes[j].c.includes('card-h'), `overlap ${boxes[i].c} / ${boxes[j].c}`);
    }
    await noHScroll(page, 'plans ' + scheme);
    await page.screenshot({ path: `${SHOTS}/${scheme === 'light' ? 'v20-plans-light-390' : 'v20-plans-390'}.png` });
    await page.click('.plan-sum'); await page.waitForSelector('.pcs-list'); await noHScroll(page, 'cycle sheet'); 
    await page.keyboard.press('Escape');
    await openPostpone(page, 'nike'); await page.fill('#pp-date', day(17)); await page.waitForTimeout(500);
    await noHScroll(page, 'postpone sheet');
    const over = await page.evaluate(() => { const sb = document.querySelector('#sheetBody'), r = sb.getBoundingClientRect(); return [...sb.querySelectorAll('*')].filter(e => { const x = e.getBoundingClientRect(); return x.width && (x.right > r.right + 1 || x.left < r.left - 1); }).map(e => e.className || e.tagName); });
    assert.deepEqual(over, []);
    if (scheme === 'dark') await page.screenshot({ path: `${SHOTS}/v20-postpone-390.png` });
    await page.keyboard.press('Escape');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}
await b.close();
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);
