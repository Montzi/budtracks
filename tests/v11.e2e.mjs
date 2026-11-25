// Checks for: tidy hero sublines (Updated only since v12, "of $X" only), the read-only "This paycheck" sheet, hero stats
// centered under the ladder columns, the greeting line (default, edit, reload, backup), the "Pay cycle" label,
// the Transactions "Sync now" spinner + toast, the Auto/Light/Dark appearance setting, and light-mode contrast.
// Run: node tests/v11.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import assert from 'node:assert/strict';
import { pw, SHOTS, BASE, API, iso, addD, step, finish, prep, synced, txUpdated } from './lib.mjs';
// v19: the period switcher is a button + menu inside the header
const pickView = async (page, v) => { await page.click('#periodBtn'); await page.click('#periodMenu [data-view="' + v + '"]'); };

const TODAY = iso(new Date()), PAY = addD(TODAY, -1), dayOf = n => +addD(TODAY, n).slice(8);
const SANT = { id: 'sa1', name: 'Checking', last4: '6429', institution: 'Santander', type: 'depository' };
const CITI = { id: 'ci1', name: 'Checking', last4: '4417', institution: 'Citizens', type: 'depository' };
const T = (id, date, desc, amount, account) => ({ id: 'pl:' + id, date, desc, rawDesc: desc, amount, account, status: 'posted', pendingOf: null, counterparty: null, providerCategory: null });
// A paycheck split across three deposits in two banks, plus one unrelated Zelle that stays in review.
const SPLIT = [
  T('s1', TODAY, 'STAT DELIVERY SE PAYROLL', -100, SANT),
  T('s2', PAY, 'STAT DELIVERY SE', -300, SANT),
  T('s3', PAY, 'STAT DELIVERY SE PAYROLL CITIZENS PAID EARLY', -1873.31, CITI),
  T('z1', TODAY, 'ZELLE FROM PAT', -25, SANT),
  T('r1', TODAY, 'CPI*CANTEEN VENDING', 9.5, SANT) // spending waiting for review: "incl. $9.50 to review" under Spent so far
];
const NEW3 = [T('n1', TODAY, 'SHOPRITE 123', 41.2, SANT), T('n2', TODAY, 'SHELL OIL 5521', 38, SANT), T('n3', TODAY, 'CVS PHARMACY', 12.99, CITI)];
const A = (id, name, mask, available, extra) => Object.assign({ id, name, mask, type: 'depository', subtype: 'checking', available, current: available, limit: null, currency: 'USD', enabled: true }, extra || {});
// Six counted accounts in three banks, and a credit card that is not counted.
const BAL = () => [
  { itemId: 'enr_1', institution: 'Santander', accounts: [A('sa1', 'Checking', '6429', 1210.4), A('sa2', 'Savings', '0081', 800, { subtype: 'savings' }), A('sa3', 'Visa', '4242', 1500, { type: 'credit', current: 500, limit: 2000 })] },
  { itemId: 'enr_2', institution: 'Citizens', accounts: [A('ci1', 'Checking', '4417', 300), A('ci2', 'Savings', '5550', 95.5, { subtype: 'savings' })] },
  { itemId: 'enr_3', institution: 'Chime', accounts: [A('ch1', 'Spending', '1111', 50), A('ch2', 'Savings', '2222', 16, { subtype: 'savings' })] }
];
const fixture = () => ({
  since: addD(TODAY, -60), marks: {}, occ: {}, unalloc: [], payVia: [], spends: [], plans: [], cards: [],
  categories: ['Groceries', 'Takeout Food', 'Gas', 'Other'], billCats: ['Housing', 'Utilities', 'Other'],
  income: [{ id: 'pay', name: 'Stat Delivery', freq: 'biweekly', date: PAY, amount: 0, askFrom: addD(PAY, -14), perCycle: {} }],
  bills: [{ id: 'rent', name: 'Rent', amount: 1050, day: dayOf(3), group: 'Fixed', category: 'Housing', active: true },
    { id: 'elec', name: 'Electric', amount: 70, day: dayOf(5), group: 'Fixed', category: 'Utilities', active: true },
    { id: 'spot', name: 'Spotify', amount: 11.99, day: dayOf(6), group: 'Subscriptions', active: true }],
  perPeriod: [{ id: 'groc', name: 'Groceries', amount: 150, category: 'Groceries' }],
  savings: { on: false, bank: '', tx: [] },
  bank: { seen: {}, rules: {}, links: {}, lastSync: null, inbox: [], api: API, autoFrom: addD(TODAY, -30), historyFrom: addD(TODAY, -60), txns: {}, savingsAccts: {} },
  settings: { view: 'biweekly', anchor: PAY, legendOpen: {}, billsView: '', chartRange: 'cycle' }
});

const b = await pw.chromium.launch();
async function newPage(w, h, o) {
  o = o || {};
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: o.dark ? 'dark' : 'light', deviceScaleFactor: 1 });
  const page = await ctx.newPage(); await prep(page);
  const errs = [], calls = [], mock = { txns: SPLIT, balances: BAL(), syncDelay: 0, fail: false };
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ m, p, t: Date.now() });
    const json = (x, status) => route.fulfill({ status: status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(x) });
    if (p === '/config') return json({ provider: 'plaid', env: 'sandbox', paired: true });
    if (p === '/accounts') return json({ enrollments: [{ id: 'enr_1', institution: 'Santander', accounts: [] }, { id: 'enr_2', institution: 'Citizens', accounts: [] }, { id: 'enr_3', institution: 'Chime', accounts: [] }] });
    if (p === '/sync') {
      if (mock.syncDelay) await new Promise(r => setTimeout(r, mock.syncDelay));
      if (mock.fail) return json({ error: 'Bank service is down' }, 500);
      return json({ txns: mock.txns, removed: [], errors: [], syncToken: 'tok', syncedAt: new Date().toISOString(), balances: mock.balances });
    }
    if (p === '/refresh') return json({ refreshed: false, notEnabled: true, results: [] });
    if (p === '/snapshot') return json({ ok: true });
    return json({ error: 'nope' }, 404);
  });
  await page.goto(BASE + (o.hash || ''), { waitUntil: 'load' });
  await page.evaluate(([fx, extra]) => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1'));
    const f = JSON.parse(fx); Object.assign(s, f); Object.assign(s.settings, f.settings, extra || {});
    localStorage.setItem('budtrack.v1', JSON.stringify(s)); localStorage.setItem('budtrack.bankkey', 'secret-device-key-123');
  }, [JSON.stringify(fixture()), o.settings]);
  await page.reload({ waitUntil: 'load' });
  // The first (automatic) sync brings the split paycheck and the live balances.
  await synced(page, true);
  await page.waitForTimeout(250);
  return { ctx, page, errs, calls, mock };
}
const noHScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'horizontal scroll at ' + label);
const quiet = page => page.evaluate(() => { const t = document.querySelector('#toast'); t.style.transition = 'none'; t.classList.remove('on'); document.querySelector('#bud').style.display = 'none'; });
const getState = page => page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')));

// WCAG contrast of an element's text against what is painted behind it (ancestor backgrounds composited, opacity applied).
const contrastOf = (page, sel, all) => page.evaluate(([sel, all]) => {
  const parse = c => {
    let m = c.match(/^rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    m = c.match(/^color\(srgb ([^)]+)\)/);
    if (m) { const p = m[1].split(/[\s\/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
    return [0, 0, 0, 0];
  };
  const over = (top, under) => { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const one = el => {
    const chain = []; let op = 1;
    for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); chain.push(parse(cs.backgroundColor)); op *= +cs.opacity; }
    let bg = parse(getComputedStyle(document.documentElement).backgroundColor); if (bg[3] < 1) bg = over(bg, [255, 255, 255, 1]);
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i][3] > 0) bg = over(chain[i], bg);
    const fg0 = parse(getComputedStyle(el).color); const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * op], bg);
    const L1 = lum(fg), L2 = lum(bg), r = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    return { sel, text: el.textContent.trim().slice(0, 40), ratio: Math.round(r * 100) / 100 };
  };
  const els = [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length && e.textContent.trim());
  return all ? els.map(one) : els.slice(0, 1).map(one);
}, [sel, !!all]);

const SIZES = [[390, 844], [430, 932], [669, 951], [951, 669], [1000, 703]];

/* ---------- Hero at every size, dark and light ---------- */
for (const [w, h] of SIZES) {
  for (const dark of [true, false]) {
    if (!dark && ![390, 951].includes(w)) continue;
    const tag = `${w}x${h} ${dark ? 'dark' : 'light'}`;
    const { ctx, page, errs } = await newPage(w, h, { dark });
    await step(`${tag}: In account subline is "Updated <time>" only (no account count), every line fits`, async () => {
      const m = await page.evaluate(() => [...document.querySelectorAll('.lad.l3 .hs-s .fl')].map(e => ({ t: e.textContent, fit: e.scrollWidth <= e.clientWidth })));
      assert.equal(m.length, 1, JSON.stringify(m));
      assert.match(m[0].t, /^(Updated|Upd\.) \d{1,2}:\d{2} [AP]M$|^\d{1,2}:\d{2} [AP]M$/, m[0].t);
      assert.doesNotMatch(await page.locator('.lad.l3').innerText(), /\d+ (accounts?|accts?)/);
      const all = await page.evaluate(() => [...document.querySelectorAll('.ladder .fl')].map(e => [e.textContent, e.scrollWidth <= e.clientWidth]));
      assert.ok(all.every(x => x[1]), 'clipped: ' + JSON.stringify(all));
      assert.doesNotMatch(await page.locator('.ladder').innerText(), /Live from|banks ·/);
    });
    await step(`${tag}: sublines share one row: same font size, centered, at most 2 lines, first line tops within 1px`, async () => {
      const m = await page.evaluate(() => {
        const ss = [...document.querySelectorAll('.ladder .lad .hs-s')];
        const firstTop = e => { const r = document.createRange(); const n = e.querySelector('.fl') || e; r.selectNodeContents(n.firstChild || n); return r.getClientRects()[0].top; };
        return ss.map(e => { const cs = getComputedStyle(e), lh = parseFloat(cs.lineHeight), col = e.closest('.lad').getBoundingClientRect(), r = e.getBoundingClientRect();
          return { fs: cs.fontSize, lines: Math.round(r.height / lh), top: firstTop(e), ta: cs.textAlign, dc: Math.abs((r.left + r.right) / 2 - (col.left + col.right) / 2) }; });
      });
      assert.equal(m.length, 3);
      assert.equal(new Set(m.map(x => x.fs)).size, 1, 'font sizes ' + m.map(x => x.fs));
      assert.ok(m.every(x => x.lines >= 1 && x.lines <= 2), 'lines ' + m.map(x => x.lines));
      const tops = m.map(x => x.top); assert.ok(Math.max(...tops) - Math.min(...tops) <= 1, 'first line tops ' + tops);
      assert.ok(m.every(x => x.ta === 'center' && x.dc <= 1), 'centered ' + JSON.stringify(m));
    });
    await step(`${tag}: Left in paycheck reads "of $2,273.31" only: no pay date, no split, no edit`, async () => {
      assert.equal((await page.locator('.lad.l1 .hs-s').textContent()).trim(), 'of $2,273.31');
      assert.equal(await page.locator('.hero [data-action="pay-edit"], .hero [data-action="pay-split"], .hero .pay-edit, .hero-split').count(), 0);
      assert.doesNotMatch(await page.locator('.lad.l1').innerText(), /Mon|Tue|Wed|Thu|Fri|Sat|Sun|split/);
      assert.equal(await page.locator('.hero #payamt').count(), 0, 'no manual amount field in the hero');
    });
    await step(`${tag}: Spent so far / Still due / After all bills are centered under the three ladder columns`, async () => {
      const m = await page.evaluate(() => {
        const c = e => { const r = e.getBoundingClientRect(); return (r.left + r.right) / 2; };
        const lad = [...document.querySelectorAll('.ladder .lad')].map(c), st = [...document.querySelectorAll('.hero-stats > div')];
        return { lad, st: st.map(c), dd: st.map(d => c(d.querySelector('dd'))), ta: st.map(d => getComputedStyle(d).textAlign) };
      });
      assert.equal(m.st.length, 3);
      m.st.forEach((x, i) => assert.ok(Math.abs(x - m.lad[i]) <= 2, `column ${i}: stat ${x} vs ladder ${m.lad[i]}`));
      m.dd.forEach((x, i) => assert.ok(Math.abs(x - m.lad[i]) <= 2, `value ${i}: ${x} vs ladder ${m.lad[i]}`));
      assert.deepEqual(m.ta, ['center', 'center', 'center']);
    });
    await step(`${tag}: Spent so far subline ("incl. $9.50 to review") is shown whole`, async () => {
      const m = await page.evaluate(() => [...document.querySelectorAll('.hero-stats .ss-sub')].map(e => [e.textContent, e.scrollWidth <= e.clientWidth, Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight))]));
      assert.ok(m.length >= 1, 'no subline'); assert.ok(m.some(x => x[0] === 'incl. $9.50 to review'), JSON.stringify(m));
      assert.ok(m.every(x => x[1] && x[2] <= 2), JSON.stringify(m));
    });
    await step(`${tag}: greeting first, then "Pay cycle" + dates with prev/next, eye inside the sums on the right, nothing overlaps`, async () => {
      const g = (await page.locator('.hero .greet').textContent()).replace(/\s+/g, ' ').trim();
      assert.match(g, /^Welcome · Today is (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [A-Z][a-z]+ \d{1,2}$/, g);
      assert.equal((await page.locator('.hero .eyebrow').textContent()).trim(), 'Pay cycle');
      const r = await page.evaluate(() => { const q = s => document.querySelector(s).getBoundingClientRect(); return { g: q('.greet'), top: q('.hero-top'), eye: q('.lad-tools .eye'), lad: q('.ladder'), hero: q('.hero'), prev: q('[data-action="prev"]'), next: q('[data-action="next"]') }; });
      assert.ok(r.g.bottom <= r.top.top + 0.5, 'greeting above the pay cycle row');
      assert.ok(r.top.bottom <= r.lad.top + 0.5, 'no row between the pay cycle row and the ladder');
      assert.ok(r.eye.top >= r.lad.top - 0.5 && r.eye.bottom <= r.lad.bottom + 0.5, 'eye inside the ladder');
      assert.ok(r.eye.right <= r.hero.right - 8 && r.eye.right >= r.lad.right - 14, 'eye on the right');
      const l3 = await page.evaluate(() => { const q = s => document.querySelector(s).getBoundingClientRect(); return { s: q('.lad.l3 .hs-s'), e: q('.ladder .eye') }; });
      assert.ok(l3.e.top >= l3.s.bottom - 0.5, 'eye below "Updated …"');
      assert.ok(r.prev.right < r.next.left);
    });
    await step(`${tag}: no horizontal scroll, no page errors`, async () => { await noHScroll(page, tag); assert.deepEqual(errs, []); });
    await quiet(page);
    if (w === 390 && dark) await page.locator('.ov > .hero').screenshot({ path: SHOTS + '/hero-v11-390.png' });
    if (w === 390 && !dark) await page.locator('.ov > .hero').screenshot({ path: SHOTS + '/hero-v11-light-390.png' });
    if (w === 951 && dark) await page.screenshot({ path: SHOTS + '/hero-v11-951.png' });
    await ctx.close();
  }
}

/* ---------- Balances from yesterday ---------- */
{
  const { ctx, page, errs } = await newPage(390, 844, { dark: true });
  await step('balances from yesterday read "Updated yesterday" (or "Upd. yesterday")', async () => {
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(12, 0, 0, 0); s.bank.balances.at = d.toISOString(); s.bank.lastSync = new Date().toISOString(); localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(200);
    assert.match(await page.locator('.lad.l3 .hs-s .fl').first().textContent(), /^(Updated|Upd\.) yesterday$|^Yesterday$/);
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- Labels for other periods ---------- */
{
  const { ctx, page, errs } = await newPage(390, 844, { dark: true });
  await step('prev/next keep "Past pay cycle" / "Upcoming pay cycle"; weekly says "Week", monthly "Month"', async () => {
    const eb = () => page.locator('.hero .eyebrow').textContent().then(t => t.trim());
    await page.click('[data-action="prev"]'); assert.equal(await eb(), 'Past pay cycle');
    await page.click('[data-action="next"]'); await page.click('[data-action="next"]'); assert.equal(await eb(), 'Upcoming pay cycle');
    await page.click('[data-action="today"]'); assert.equal(await eb(), 'Pay cycle');
    await pickView(page, 'weekly'); assert.equal(await eb(), 'Week');
    await pickView(page, 'monthly'); assert.equal(await eb(), 'Month');
    await pickView(page, 'biweekly'); assert.equal(await eb(), 'Pay cycle');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- This paycheck sheet ---------- */
{
  const { ctx, page, errs } = await newPage(390, 844, { dark: true });
  await step('tapping Left in paycheck opens a read-only "This paycheck" sheet with the split', async () => {
    await page.click('.lad.l1 .v'); await page.waitForSelector('#sheet:not([hidden]) .pc-total');
    const t = await page.locator('#sheet').innerText();
    assert.match(t, /This paycheck/); assert.match(t, /Stat Delivery/);
    assert.match(await page.locator('#sheet .pc-total').innerText(), /Split across 3 deposits[\s\S]*\$2,273\.31/);
    const rows = await page.locator('#sheet .pc-part').allInnerTexts();
    assert.equal(rows.length, 3, rows.join('|'));
    assert.ok(rows.some(r => /Santander ••6429/.test(r) && /\$100\.00/.test(r)), rows.join('|'));
    assert.ok(rows.some(r => /Santander ••6429/.test(r) && /\$300\.00/.test(r)));
    assert.ok(rows.some(r => /Citizens ••4417/.test(r) && /\$1,873\.31/.test(r) && /Stat Delivery/i.test(r)));
    assert.equal(await page.locator('#sheet input, #sheet [data-action="pc-edit"], #sheet [data-action="pc-out"]').count(), 0, 'read-only');
    assert.ok(await page.evaluate(() => { const s = document.querySelector('#sheet .sheet'); return s.scrollWidth <= s.clientWidth + 1; }));
    await quiet(page);
    await page.waitForTimeout(350); await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/paycheck-sheet-390.png' });
  });
  await step('"Change in Income tab" goes to Income with Latest paycheck expanded (Edit total there)', async () => {
    await page.click('#sheet [data-action="pay-to-income"]');
    await page.waitForFunction(() => location.hash === '#income' && document.querySelector('#latestpay'));
    assert.equal(await page.locator('#sheet').isHidden(), true);
    assert.equal(await page.locator('#coll-pay').isHidden(), false, 'expanded after the first visit');
    assert.equal(await page.locator('#latestpay .coll-h[data-k="pay"]').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#latestpay [data-action="pc-edit"]').count(), 1);
    // Going there again keeps it open (it does not toggle shut).
    await page.goto(BASE + '#overview'); await page.click('.lad.l1'); await page.waitForSelector('#sheet [data-action="pay-to-income"]');
    await page.waitForTimeout(300); await page.click('#sheet [data-action="pay-to-income"]');
    await page.waitForFunction(() => location.hash === '#income' && document.querySelector('#latestpay'));
    assert.equal(await page.locator('#coll-pay').isHidden(), false, 'still expanded after the second visit');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- Greeting ---------- */
{
  const { ctx, page, errs } = await newPage(390, 844, { dark: true });
  await step('greeting edits in place and persists after reload; included in the backup', async () => {
    await page.click('.hero .greet'); await page.waitForSelector('#greetform');
    assert.equal(await page.inputValue('#g-name'), ''); assert.equal(await page.inputValue('#g-text'), 'Welcome');
    assert.equal(await page.getAttribute('#g-name', 'maxlength'), '40');
    await page.fill('#g-name', 'Test User'); await page.fill('#g-text', 'Hello'); await page.click('#greetform button[type=submit]');
    await page.waitForFunction(() => /^Hello, Test User · Today is /.test(document.querySelector('.greet').textContent.replace(/\s+/g, ' ').trim()));
    await page.reload({ waitUntil: 'load' });
    assert.match((await page.locator('.greet').textContent()).replace(/\s+/g, ' '), /^Hello, Test User · Today is /);
    const s = await getState(page); assert.equal(s.settings.displayName, 'Test User'); assert.equal(s.settings.greeting, 'Hello');
    await page.goto(BASE + '#income'); await page.click('[data-action="copy-backup"]');
    const bk = JSON.parse(await page.inputValue('#bk')); assert.equal(bk.settings.displayName, 'Test User', 'backup has the name'); assert.equal(bk.settings.greeting, 'Hello');
    await page.keyboard.press('Escape'); await page.goto(BASE + '#overview');
  });
  await step('a 40-character name wraps without horizontal scroll; markup in the name is shown as text', async () => {
    await page.click('.hero .greet'); await page.waitForSelector('#greetform');
    await page.fill('#g-name', '<b>Abcdefghij Klmnopqrst Uvwxyzabcd Efg'); await page.fill('#g-text', 'Welcome'); await page.click('#greetform button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#sheet').hidden);
    assert.equal(await page.locator('.greet b').count(), 0);
    assert.match(await page.locator('.greet').textContent(), /^Welcome, <b>Abcdefghij/);
    await noHScroll(page, '390 long greeting');
    const r = await page.evaluate(() => { const g = document.querySelector('.greet').getBoundingClientRect(), h = document.querySelector('.hero').getBoundingClientRect(); return g.right <= h.right && g.left >= h.left; });
    assert.ok(r, 'greeting inside the card');
    // Clearing the name falls back to "Welcome · Today is …".
    await page.click('.hero .greet'); await page.waitForSelector('#greetform'); await page.fill('#g-name', ''); await page.click('#greetform button[type=submit]');
    await page.waitForFunction(() => /^Welcome · Today is /.test(document.querySelector('.greet').textContent.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- Transactions: Sync now ---------- */
{
  const { ctx, page, errs, calls, mock } = await newPage(390, 844, { dark: false, hash: '#transactions' });
  await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx-card [data-action="bk-sync"]');
  await step('Sync now shows a spinner while /sync is slow, then toasts "3 new transactions" and updates Last synced', async () => {
    await page.evaluate(() => { window.BT_FOLLOWUP_MS = 600000; const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.bank.lastSync = new Date(Date.now() - 20 * 60e3).toISOString(); localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' }); await page.evaluate(() => { window.BT_FOLLOWUP_MS = 600000; });
    await page.waitForSelector('.tx-card [data-action="bk-sync"]:not([disabled])');
    assert.match(await txUpdated(page), /Updated 20 min ago/);
    mock.txns = SPLIT.concat(NEW3); mock.syncDelay = 1200;
    const n = calls.length;
    await page.click('.tx-card [data-action="bk-sync"]');
    await page.waitForSelector('.tx-card [data-action="bk-sync"][disabled][aria-busy="true"].spinning', { timeout: 400 });
    await page.waitForFunction(() => /3 new transactions/.test(document.querySelector('#toast').textContent), null, { timeout: 5000 });
    assert.ok(calls.slice(n).some(c => c.p === '/sync'), 'synced');
    await page.waitForSelector('.tx-card [data-action="bk-sync"]:not([disabled])');
    assert.equal(await page.getAttribute('.tx-card [data-action="bk-sync"]', 'aria-label'), 'Sync');
    assert.match(await txUpdated(page), /Updated just now/);
    await quiet(page);
    await page.screenshot({ path: SHOTS + '/tx-light-390.png' });
  });
  await step('a second Sync now with nothing new says "No new transactions"', async () => {
    mock.syncDelay = 300;
    await page.evaluate(() => document.querySelector('#toast').classList.remove('on'));
    await page.click('.tx-card [data-action="bk-sync"]');
    await page.waitForSelector('.tx-card [data-action="bk-sync"].spinning', { timeout: 400 });
    await page.waitForFunction(() => /No new transactions/.test(document.querySelector('#toast').textContent));
  });
  await step('a failing sync shows the error and clears the spinner', async () => {
    mock.fail = true; mock.syncDelay = 200;
    await page.click('.tx-card [data-action="bk-sync"]');
    await page.waitForFunction(() => document.querySelector('#toast').classList.contains('on') && /down|could not|error/i.test(document.querySelector('#toast').textContent));
    await page.waitForSelector('.tx-card [data-action="bk-sync"]:not([disabled])');
    assert.equal(await page.locator('.tx-card [data-action="bk-sync"].spinning').count(), 0);
    mock.fail = false; mock.syncDelay = 0;
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- Appearance ---------- */
{
  const { ctx, page, errs } = await newPage(390, 844, { dark: true, hash: '#income' });
  const theme = () => page.evaluate(() => [document.documentElement.dataset.theme || '', document.querySelector('meta[name="theme-color"]').content, JSON.parse(localStorage.getItem('budtrack.v1')).settings.theme || 'auto', getComputedStyle(document.body).backgroundColor]);
  await step('Appearance Auto/Light/Dark in the Income tab sets data-theme, theme-color and persists after reload', async () => {
    await page.goto(BASE + '#income'); await page.waitForSelector('.theme-seg');
    let t = await theme(); assert.equal(t[0], ''); assert.equal(t[2], 'auto'); assert.equal(t[1], '#0c0f15', 'auto follows the dark system');
    assert.equal(await page.locator('.theme-seg [data-t="auto"]').getAttribute('aria-pressed'), 'true');
    await page.click('.theme-seg [data-t="light"]'); t = await theme();
    assert.deepEqual(t.slice(0, 3), ['light', '#eceef2', 'light']); assert.equal(t[3], 'rgb(236, 238, 242)');
    await page.reload({ waitUntil: 'load' }); t = await theme(); assert.deepEqual(t.slice(0, 3), ['light', '#eceef2', 'light']);
    assert.equal(await page.locator('.theme-seg [data-t="light"]').getAttribute('aria-pressed'), 'true');
    await page.click('.theme-seg [data-t="dark"]'); t = await theme(); assert.deepEqual(t.slice(0, 3), ['dark', '#0c0f15', 'dark']);
    await page.reload({ waitUntil: 'load' }); t = await theme(); assert.equal(t[0], 'dark');
    await page.click('.theme-seg [data-t="auto"]'); t = await theme(); assert.deepEqual(t.slice(0, 3), ['', '#0c0f15', 'auto']);
    await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(100); t = await theme(); assert.equal(t[1], '#eceef2', 'auto follows the system when it changes');
  });
  await step('the greeting sheet has the same Appearance switch', async () => {
    await page.goto(BASE + '#overview'); await page.click('.hero .greet'); await page.waitForSelector('#greetform .theme-seg');
    await page.click('#greetform .theme-seg [data-t="dark"]'); assert.equal((await theme())[0], 'dark');
    assert.equal(await page.locator('#greetform .theme-seg [data-t="dark"]').getAttribute('aria-pressed'), 'true');
    await page.click('#greetform .theme-seg [data-t="auto"]'); assert.equal((await theme())[0], '');
    await page.keyboard.press('Escape');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- Light mode contrast ---------- */
{
  const { ctx, page, errs } = await newPage(390, 844, { dark: true, settings: { theme: 'light' } });
  const check = async (sels, min) => {
    const bad = []; await page.waitForTimeout(260);   // v19: let the tab fade-in finish (the contrast check multiplies opacity)
    for (const s of sels) { const r = await contrastOf(page, s, true); if (!r.length) bad.push(s + ': not found'); r.filter(x => x.ratio < min).forEach(x => bad.push(`${s} "${x.text}" ${x.ratio}`)); }
    assert.deepEqual(bad, []);
  };
  await step('light (chosen while the phone is dark): muted text in key places is at least 4.5:1', async () => {
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await check(['.hero .greet span', '.hero .range', '.hero .hs-k', '.hero .hs-s .fl', '.hero-stats dt', '.hero .hero-foot span', '.ov-bills .card-h .meta', '.ov-bills .row .sub', '.ov-donut .card-h .meta', '.tabs a:not([aria-current])'], 4.5);
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx-card');
    await check(['.tx-card .tx-sum-b span', '.tx-card .tx-s', '.tx-card .tx-day', '.tx-card .txc'], 4.5);
    await page.goto(BASE + '#bills'); await page.waitForSelector('.row');
    await check(['.row .sub', '.card-h .meta'], 4.5);
    await quiet(page);
    await page.screenshot({ path: SHOTS + '/bills-light-390.png' });
    await page.goto(BASE + '#income'); await page.waitForSelector('#latestpay');
    await check(['.pc-date', '.note', '.card-h .meta'], 4.5);
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

await b.close();
finish();
