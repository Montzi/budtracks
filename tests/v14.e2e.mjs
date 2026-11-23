// v14: Sync chip in the Transactions filter row, short "Updated … ago" line, "Spent this pay cycle" summary with Cycle | Month,
// screenshot notes shown under rows (before and after the bank copy links), and the Appearance control in the hat sheet.
// Run: node tests/v14.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
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
const TODAY = iso(new Date()), PAY = addD(TODAY, -6), MSTART = TODAY.slice(0, 8) + '01';
const CYCLE_START = PAY;
const CHASE = { id: 'chk', name: 'Checking', last4: '1284', institution: 'Chase', type: 'depository' };
const T = (id, date, desc, amount, extra) => Object.assign({ id: 'pl:' + id, date, desc, rawDesc: desc, amount, account: CHASE, status: 'posted', pendingOf: null, counterparty: null, providerCategory: null }, extra || {});
// Spends: one today (in cycle and month), one on the 1st of the month (month only when it is before the cycle), a screenshot entry with a note.
const fixture = () => ({
  since: addD(MSTART, -1), marks: {}, occ: {}, unalloc: [], payVia: [], cards: [], plans: [], bills: [], perPeriod: [],
  spends: [
    { id: 'e1', category: 'Groceries', desc: 'Market', amount: 40.1, date: TODAY, via: '', note: '' },
    { id: 'e2', category: 'Gas', desc: 'Fuel', amount: 25.25, date: MSTART < CYCLE_START ? MSTART : TODAY, via: '', note: '' },
    { id: 'e3', category: 'Takeout Food', desc: 'Doordash', amount: 16.2, date: TODAY, via: '', note: 'Birthday dinner', shot: { at: new Date().toISOString(), bank: 'Chase', pending: false, rawMerchant: 'DD *DOORDASH', accountHint: '' } }
  ],
  categories: ['Groceries', 'Gas', 'Takeout Food', 'Dining Out', 'Other'], billCats: ['Housing', 'Other'],
  catParents: { Groceries: 'Food', Gas: 'Transportation', 'Takeout Food': 'Food', 'Dining Out': 'Food' },
  income: [{ id: 'pay', name: 'Stat Delivery', freq: 'biweekly', date: PAY, amount: 1200 }],
  savings: { on: false, bank: '', tx: [] },
  bank: { seen: {}, rules: {}, links: {}, lastSync: new Date(Date.now() - 5 * 60e3).toISOString(), inbox: [], api: API, autoFrom: addD(TODAY, -30), historyFrom: addD(TODAY, -60), txns: {}, notes: {}, notShot: {} },
  settings: { view: 'biweekly', anchor: PAY, legendOpen: {}, billsView: '', chartRange: 'cycle' }
});
const b = await pw.chromium.launch();
async function newPage(w, h, o) {
  o = o || {};
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: o.dark ? 'dark' : 'light', deviceScaleFactor: 1 });
  const page = await ctx.newPage(); page.setDefaultTimeout(6000);
  const errs = [];
  const mock = { txns: [], syncDelay: 0, scan: null };
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = x => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(x) });
    if (p === '/config') return json({ provider: 'plaid', env: 'production', paired: true });
    if (p === '/accounts') return json({ enrollments: [{ id: 'enr_c', institution: 'Chase', accounts: [{ id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', last_four: '1284', enabled: true }] }] });
    if (p === '/sync') { if (mock.syncDelay) await new Promise(r => setTimeout(r, mock.syncDelay)); return json({ txns: mock.txns, removed: [], errors: [], cursors: {}, syncedAt: new Date().toISOString(), balances: [] }); }
    if (p === '/scan') return json(mock.scan);
    if (p === '/status') return json({ items: [], refresh: { supported: null }, balance: { supported: null } });
    if (p === '/refresh') return json({ refreshed: false, notEnabled: true, results: [] });
    if (p === '/snapshot') return json({ ok: true });
    return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{"error":"nope"}' });
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(fx => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1')), f = JSON.parse(fx);
    Object.assign(s, f); Object.assign(s.settings, f.settings);
    s.bank.txns = {}; localStorage.setItem('budtrack.v1', JSON.stringify(s)); localStorage.setItem('budtrack.bankkey', 'secret-device-key-123');
  }, JSON.stringify(fixture()));
  await page.goto(BASE + (o.hash || ''), { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  return { ctx, page, errs, mock };
}
const noHScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'horizontal scroll at ' + label);
const quiet = page => page.evaluate(() => { const t = document.querySelector('#toast'); t.style.transition = 'none'; t.classList.remove('on'); const bud = document.querySelector('#bud'); if (bud) bud.style.display = 'none'; });
const getState = page => page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')));
const money = s => +String(s).replace(/[^0-9.-]/g, '');
const heroSpent = async page => { await page.goto(BASE + '#overview'); await page.waitForSelector('.hs-tap dd'); return money(await page.locator('.hs-tap dd').first().innerText()); };

for (const [w, h, dark] of [[390, 844, true], [390, 844, false], [669, 951, true], [951, 669, false]]) {
  const tag = `${w}${dark ? ' dark' : ' light'}`;
  const { ctx, page, errs, mock } = await newPage(w, h, { dark, hash: '#transactions' });
  // A bank line out today that nothing decided yet (counts as "to review"), and the screenshot entry's bank copy for later.
  mock.txns = [T('rev', TODAY, 'Corner Cafe', 12.34)];
  await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx-card');
  await page.click('.tx-card [data-action="bk-sync"]');
  await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('budtrack.v1')).bank.txns).length >= 1, null, { timeout: 8000 });
  await page.waitForTimeout(300);
  await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx-card');

  await step(`Header icons (camera, +, sync) and five equal filter chips, one line (${tag})`, async () => {
    const labels = (await page.locator('.tx-chips > button').allInnerTexts()).map(t => t.trim().toLowerCase());
    assert.deepEqual(labels.map(l => l.replace(/ \d+$/, '')), ['all', 'review', 'added', 'matched', 'skipped']);
    assert.equal(await page.locator('.tx-chips [data-action="bk-sync"], .tx-chips .chip-sync').count(), 0, 'no Sync chip');
    const hdr = page.locator('.tx-card .card-h .tx-hb > button');
    assert.deepEqual(await hdr.evaluateAll(bs => bs.map(b => b.dataset.action)), ['shot-open', 'add', 'bk-sync']);
    const hb = await hdr.evaluateAll(bs => bs.map(b => { const r = b.getBoundingClientRect(); return [r.x, r.width, r.height]; }));
    hb.forEach(x => assert.ok(x[1] >= 40 && x[2] >= 40, 'tap target ' + x));
    assert.ok(hb[0][0] + hb[0][1] <= hb[1][0] && hb[1][0] + hb[1][1] <= hb[2][0], 'no overlap');
    const cs = await page.$$eval('.tx-chips > button', bs => bs.map(x => { const r = x.getBoundingClientRect(); return [Math.round(r.top), r.width, r.height]; }));
    assert.ok(cs.every(c => c[0] === cs[0][0] && Math.abs(c[1] - cs[0][1]) <= 1 && Math.abs(c[2] - cs[0][2]) <= 1), 'equal chips ' + JSON.stringify(cs));
    const fits = await page.$eval('.tx-chips', el => el.scrollWidth <= el.clientWidth + 1);
    assert.ok(fits, 'chips fit without internal scroll at ' + tag);
    await noHScroll(page, 'transactions ' + tag);
    assert.match((await page.locator('.tx-card .card-h .meta').innerText()), /^Updated (5 min ago|just now|6 min ago)$/i);
    const mh = await page.locator('.tx-card .card-h .meta').evaluate(el => [el.getBoundingClientRect().height, parseFloat(getComputedStyle(el).lineHeight) || 20]);
    assert.ok(mh[0] <= mh[1] * 1.6, 'subline on one line');
  });

  if (w === 390) await step(`Sync icon: spins and is disabled while syncing, then toast (${tag})`, async () => {
    mock.syncDelay = 1200; mock.txns = [T('rev', TODAY, 'Corner Cafe', 12.34), T('new1', TODAY, 'Bakery', 4.5)];
    await page.click('.tx-card .card-h [data-action="bk-sync"]');
    await page.waitForSelector('.tx-card .card-h [data-action="bk-sync"][disabled].spinning', { timeout: 500 });
    await noHScroll(page, 'syncing ' + tag);
    await page.waitForFunction(() => /new transaction/i.test(document.querySelector('#toast').textContent), null, { timeout: 6000 });
    await page.waitForSelector('.tx-card .card-h [data-action="bk-sync"]:not([disabled])');
    assert.match(await page.locator('.tx-card .meta').innerText(), /Updated just now/i);
    mock.syncDelay = 0;
    if (dark) { await quiet(page); await page.screenshot({ path: SHOTS + '/tx-header-v15-390.png' }); } else { await quiet(page); await page.screenshot({ path: SHOTS + '/tx-header-v15-light-390.png' }); }
  });

  await step(`Spent summary equals hero Spent so far (cycle) and the month total (Month); switch persists; list total matches (${tag})`, async () => {
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx-sum');
    assert.match(await page.locator('.tx-sum').innerText(), /Spent this pay cycle/i);
    const cyc = money(await page.locator('#tx-spent').innerText());
    const hero = await heroSpent(page);
    assert.equal(cyc, hero, 'cycle equals hero');
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx-sum');
    await page.click('.tx-sum [data-action="tx-range"][data-r="month"]');
    assert.match(await page.locator('.tx-sum').innerText(), /Spent this month/i);
    const mon = money(await page.locator('#tx-spent').innerText());
    const s = await getState(page);
    assert.equal(s.settings.txRange, 'month');
    const m2 = n => Math.round(n * 100);
    const inMonth = s.spends.filter(x => x.date >= MSTART && x.date <= TODAY).reduce((a, x) => a + x.amount, 0);
    const toReview = Object.values(s.bank.txns).filter(t => t.amount > 0 && t.date >= MSTART && !s.bank.seen[t.id] && !/transfer|payment/i.test(t.desc)).reduce((a, t) => a + t.amount, 0);
    assert.equal(m2(mon), m2(inMonth + toReview), 'month total = spends + lines to review in the month');
    assert.ok(mon >= cyc);
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.tx-sum');
    assert.equal(await page.locator('.tx-sum [data-action="tx-range"][data-r="month"]').getAttribute('aria-pressed'), 'true', 'persists after reload');
    assert.equal(money(await page.locator('#tx-spent').innerText()), mon);
    await page.click('.tx-sum .tx-sum-b'); await page.waitForSelector('#hl-sum');
    assert.equal(money(await page.locator('#hl-sum').innerText()), mon, 'list total = month amount');
    assert.match(await page.locator('#sheet .lede').innerText(), /This month/i);
    await page.click('#sheet .icon-btn[data-action="close"]');
    await page.click('.tx-sum [data-action="tx-range"][data-r="cycle"]');
    assert.equal(money(await page.locator('#tx-spent').innerText()), cyc);
    await page.click('.tx-sum .tx-sum-b'); await page.waitForSelector('#hl-sum');
    assert.equal(money(await page.locator('#hl-sum').innerText()), cyc, 'list total = cycle amount');
    assert.match(await page.locator('#sheet .lede').innerText(), /This pay cycle/i);
    await noHScroll(page, 'sheet ' + tag);
    await page.click('#sheet .icon-btn[data-action="close"]');
  });

  await step(`Screenshot note shows under the entry in Transactions (waiting), Overview and Spent list (${tag})`, async () => {
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.shot-wait');
    assert.equal(await page.locator('.shot-wait .nlabel:has-text("Birthday dinner")').count(), 1);
    await page.goto(BASE + '#overview'); await page.waitForSelector('.hs-tap dd');
    assert.ok(await page.locator('.row .nlabel:has-text("Birthday dinner")').count() >= 1, 'overview row');
    await page.click('.hs-tap [data-action="spent-list"]'); await page.waitForSelector('#hl-sum');
    assert.equal(await page.locator('#sheet .nlabel:has-text("Birthday dinner")').count(), 1, 'spent list');
    await page.click('#sheet .icon-btn[data-action="close"]');
  });

  await step(`Note stays after the bank copy links (Transactions row, Overview, Spent list) (${tag})`, async () => {
    mock.txns = [T('rev', TODAY, 'Corner Cafe', 12.34), T('dd', TODAY, 'DoorDash', 16.2, { rawDesc: 'DD *DOORDASH 855-973-1040 CA' })];
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx-card');
    await page.click('.tx-card [data-action="bk-sync"]');
    await page.waitForFunction(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); return !!(s.bank.seen['pl:dd'] && s.bank.seen['pl:dd'].src === 'shot'); }, null, { timeout: 8000 });
    await page.waitForTimeout(300);
    const s = await getState(page);
    assert.equal(s.bank.notes['pl:dd'], 'Birthday dinner', 'note carried into bank.notes');
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx');
    assert.equal(await page.locator('.shot-wait').count(), 0, 'no longer waiting');
    assert.equal(await page.locator('.tx:has-text("DoorDash") .nlabel:has-text("Birthday dinner")').count(), 1, 'tx row note');
    assert.equal(await page.locator('.tx:has-text("DoorDash") .txc:has-text("Matched with bank")').count(), 1);
    await page.goto(BASE + '#overview'); await page.waitForSelector('.hs-tap dd');
    assert.ok(await page.locator('.row .nlabel:has-text("Birthday dinner")').count() >= 1);
    await page.click('.hs-tap [data-action="spent-list"]'); await page.waitForSelector('#hl-sum');
    assert.equal(await page.locator('#sheet .nlabel:has-text("Birthday dinner")').count(), 1);
    await page.click('#sheet .icon-btn[data-action="close"]');
  });

  await step(`Appearance control in the hat sheet: Auto/Light/Dark switches data-theme and persists (${tag})`, async () => {
    await page.goto(BASE + '#overview'); await page.waitForSelector('.hs-tap dd');
    await page.evaluate(() => { const b = document.querySelector('#bud'); if (b) b.style.display = 'none'; });
    await page.locator('.wm svg.hd').first().dispatchEvent('click');
    await page.waitForSelector('#sheet .theme-seg');
    assert.deepEqual((await page.locator('#sheet .theme-seg button').allInnerTexts()).map(t => t.trim()), ['Auto', 'Light', 'Dark']);
    await page.click('#sheet .theme-seg [data-t="dark"]');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.locator('#sheet .theme-seg [data-t="dark"]').getAttribute('aria-pressed'), 'true');
    assert.ok(await page.locator('#hatprev svg').count() === 1, 'hat preview still there');
    await page.click('#sheet [data-action="hat-dir"][data-d="back"]');
    assert.equal((await getState(page)).settings.hat.dir, 'back');
    await page.click('#sheet .theme-seg [data-t="light"]');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    assert.equal((await getState(page)).settings.theme, 'light');
    if (w === 390 && dark) { await quiet(page); await page.screenshot({ path: SHOTS + '/hat-theme-390.png' }); }
    await page.reload({ waitUntil: 'load' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'persists after reload');
    await page.locator('.wm svg.hd').first().dispatchEvent('click');
    await page.waitForSelector('#sheet .theme-seg');
    assert.equal(await page.locator('#sheet .theme-seg [data-t="light"]').getAttribute('aria-pressed'), 'true');
    await page.click('#sheet .theme-seg [data-t="auto"]');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme || ''), '');
    await noHScroll(page, 'hat sheet ' + tag);
  });
  await step(`no page errors (${tag})`, async () => assert.deepEqual(errs, []));
  await ctx.close();
}

/* Note typed in the scan review is saved on the entry */
{
  const { ctx, page, errs, mock } = await newPage(390, 844, { dark: false, hash: '#transactions' });
  mock.scan = { bank: 'Chase', usage: {}, transactions: [{ merchant: 'BLUE BOTTLE', amount: 9.5, direction: 'out', date: TODAY, pending: false, kind: 'purchase', running_balance: null, account_hint: null }] };
  await step('Scan review: a note typed there is saved and shown under the waiting row', async () => {
    await page.click('.tx-card [data-action="shot-open"]'); await page.waitForSelector('#shotzone');
    await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 300; c.height = 500; c.getContext('2d').fillRect(0, 0, 300, 500);
      const blob = await new Promise(r => c.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([blob], 's.png', { type: 'image/png' }));
      const box = document.querySelector('#shotpaste'); box.focus(); box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForSelector('.shot-thumbs li'); await page.click('[data-action="shot-read"]'); await page.waitForSelector('.shot-list');
    await page.fill('.shot-row input[data-shot="note"]', 'Coffee with Sam');
    await page.click('#shotadd'); await page.waitForTimeout(400);
    const s = await getState(page);
    assert.equal(s.spends.find(x => x.desc === 'Blue Bottle').note, 'Coffee with Sam');
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.shot-wait');
    assert.equal(await page.locator('.shot-wait .nlabel:has-text("Coffee with Sam")').count(), 1);
  });
  await step('no page errors (scan note)', async () => assert.deepEqual(errs, []));
  await ctx.close();
}
await b.close();
console.log(failed ? failed + ' step(s) failed' : 'all steps passed');
process.exit(failed ? 1 : 0);
