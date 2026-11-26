// Checks for v12: the light cycle card (light mode only; dark stays navy) with a contrast scan of every text in it,
// the Plans "Other" tile hidden at 0 active plans, "Add income" + "Add to savings" side by side, the eye button
// inside the sums (no separate row), shorter Transactions labels (Review / Skipped) on one line, and savings accounts:
// marked in the In account sheet, out of the spendable total, shown as savings, transfers to them not in Review.
// Run: node tests/v12.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import assert from 'node:assert/strict';
import { pw, SHOTS, BASE, API, iso, addD, step, finish, prep, R, synced } from './lib.mjs';

const TODAY = iso(new Date()), PAY = addD(TODAY, -1), dayOf = n => +addD(TODAY, n).slice(8);
const CHK = { id: 'ch1', name: 'Checking', last4: '1111', institution: 'Chime', type: 'depository' };
const SAV = { id: 'ch2', name: 'Savings', last4: '2222', institution: 'Chime', type: 'depository' };
const CIT = { id: 'ci1', name: 'Checking', last4: '4417', institution: 'Citizens', type: 'depository' };
const T = (id, date, desc, amount, account) => ({ id: 'pl:' + id, date, desc, rawDesc: desc, amount, account, status: 'posted', pendingOf: null, counterparty: null, providerCategory: null });
const TXNS = () => [
  T('pay', PAY, 'ACME PAYROLL', -2000, CHK),
  T('xo', TODAY, 'ONLINE TRANSFER TO SAVINGS', 150, CHK),      // checking -> savings, out leg
  T('xi', TODAY, 'ONLINE TRANSFER FROM CHK 1111', -150, SAV),  // checking -> savings, in leg (records the move)
  T('zel', TODAY, 'TRANSFER TO JOHN SMITH', 50, CIT),          // transfer wording but no savings leg: stays in review
  T('g1', TODAY, 'SHOPRITE 123', 41.2, CHK),
  T('g2', TODAY, 'SHELL OIL 5521', 38, CIT)
];
const A = (id, name, mask, available, extra) => Object.assign({ id, name, mask, type: 'depository', subtype: 'checking', available, current: available, limit: null, currency: 'USD', enabled: true }, extra || {});
const BAL = () => [
  { itemId: 'enr_1', institution: 'Chime', accounts: [A('ch1', 'Checking', '1111', 1200), A('ch2', 'Savings', '2222', 800, { subtype: 'savings' }), A('cc', 'Visa', '4242', 1500, { type: 'credit', current: 500, limit: 2000 })] },
  { itemId: 'enr_2', institution: 'Citizens', accounts: [A('ci1', 'Checking', '4417', 300)] }
];
const fixture = svAccts => {
  const bank = { seen: {}, rules: {}, links: {}, lastSync: null, inbox: [], api: API, autoFrom: addD(TODAY, -30), historyFrom: addD(TODAY, -60), txns: {} };
  if (svAccts !== undefined) bank.savingsAccts = svAccts;
  return {
    since: addD(TODAY, -60), marks: {}, occ: {}, unalloc: [], payVia: [], spends: [], cards: [],
    plans: [{ id: 'k1', provider: 'Klarna', merchant: 'Nike', amount: 27.65, total: 4, paid: 1, freq: 'biweekly', lastDate: addD(TODAY, -5), category: 'Other' }],
    categories: ['Groceries', 'Takeout Food', 'Gas', 'Other'], billCats: ['Housing', 'Utilities', 'Other'],
    income: [{ id: 'pay', name: 'Acme', freq: 'biweekly', date: PAY, amount: 2000 }],
    bills: [{ id: 'rent', name: 'Rent', amount: 1050, day: dayOf(3), group: 'Fixed', category: 'Housing', active: true },
      { id: 'elec', name: 'Electric', amount: 70, day: dayOf(5), group: 'Fixed', category: 'Utilities', active: true }],
    perPeriod: [{ id: 'groc', name: 'Groceries', amount: 150, category: 'Groceries' }],
    savings: { on: false, bank: '', tx: [] }, bank,
    settings: { view: 'biweekly', anchor: PAY, legendOpen: {}, billsView: '', chartRange: 'cycle' }
  };
};

const b = await pw.chromium.launch();
async function newPage(w, h, o) {
  o = o || {};
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: o.dark ? 'dark' : 'light', deviceScaleFactor: 1 });
  const page = await ctx.newPage(); await prep(page);
  const errs = [], mock = { txns: o.txns || TXNS(), balances: BAL() };
  if (o.savBal != null) { const a = mock.balances[0].accounts[1]; a.available = a.current = o.savBal; }
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), p = new URL(req.url()).pathname, m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = (x, status) => route.fulfill({ status: status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(x) });
    if (p === '/config') return json({ provider: 'plaid', env: 'sandbox', paired: true });
    if (p === '/accounts') return json({ enrollments: [{ id: 'enr_1', institution: 'Chime', accounts: [] }, { id: 'enr_2', institution: 'Citizens', accounts: [] }] });
    if (p === '/sync') return json({ txns: mock.txns, removed: [], errors: [], syncToken: 'tok', syncedAt: new Date().toISOString(), balances: mock.balances });
    if (p === '/refresh') return json({ refreshed: false, notEnabled: true, results: [] });
    if (p === '/snapshot') return json({ ok: true });
    return json({ error: 'nope' }, 404);
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(([fx, extra]) => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1'));
    const f = JSON.parse(fx); Object.assign(s, f); Object.assign(s.settings, f.settings, extra || {});
    localStorage.setItem('budtrack.v1', JSON.stringify(s)); localStorage.setItem('budtrack.bankkey', 'secret-device-key-123');
  }, [JSON.stringify(Object.assign(fixture('svAccts' in o ? o.svAccts : {}), o.fx || {})), o.settings]);
  // One load only. A goto followed at once by a reload cut the first sync off after it saved its time but before
  // the balances, and the second load then saw a fresh sync and did not ask again.
  await page.evaluate(h => history.replaceState(null, '', location.pathname + h), o.hash || ''); await page.reload({ waitUntil: 'load' });
  await synced(page, true);
  await page.waitForTimeout(250);
  return { ctx, page, errs, mock };
}
const noHScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'horizontal scroll at ' + label);
const quiet = page => page.evaluate(() => { const t = document.querySelector('#toast'); t.style.transition = 'none'; t.classList.remove('on'); document.querySelector('#bud').style.display = 'none'; });
const getState = page => page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')));
const heroBg = page => page.evaluate(() => getComputedStyle(document.querySelector('.ov > .hero')).backgroundColor);
const NAVY = 'rgb(24, 36, 63)'; // --hero in dark mode (#18243f)

// WCAG contrast of every piece of text inside the cycle card against what is painted behind it.
const heroContrast = page => page.evaluate(() => {
  const parse = c => {
    let m = c.match(/^rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    m = c.match(/^color\(srgb ([^)]+)\)/);
    if (m) { const p = m[1].split(/[\s\/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
    return [0, 0, 0, 0];
  };
  const over = (top, under) => { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const hero = document.querySelector('.ov > .hero');
  const bar = document.querySelector('#brandbar'), els = [hero, ...hero.querySelectorAll('*'), bar, ...bar.querySelectorAll('*')].filter(e => e.getClientRects().length && !e.closest('.sr, svg') && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
  return els.map(el => {
    const chain = []; let op = 1;
    for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); chain.push(parse(cs.backgroundColor)); op *= +cs.opacity; }
    let bg = parse(getComputedStyle(document.documentElement).backgroundColor); if (bg[3] < 1) bg = over(bg, [255, 255, 255, 1]);
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i][3] > 0) bg = over(chain[i], bg);
    const fg0 = parse(getComputedStyle(el).color), fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * op], bg);
    const L1 = lum(fg), L2 = lum(bg), r = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    return { text: [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim().slice(0, 30), cls: el.className && el.className.baseVal === undefined ? el.className : '', logo: !!el.closest('.wm'), ratio: Math.round(r * 100) / 100 };
  });
});

/* ---------- 1. Light cycle card; dark stays navy ---------- */
for (const c of [{ tag: 'Light chosen (phone dark)', dark: true, settings: { theme: 'light' }, light: true },
  { tag: 'Auto + light phone', dark: false, light: true },
  { tag: 'Auto + dark phone', dark: true, light: false },
  { tag: 'Dark chosen (phone light)', dark: false, settings: { theme: 'dark' }, light: false }]) {
  const { ctx, page, errs } = await newPage(390, 844, c);
  await step(`${c.tag}: cycle card is ${c.light ? 'light (not navy), every text ≥ 4.5:1 (logo ≥ 3:1)' : 'navy as before'}`, async () => {
    const bg = await heroBg(page);
    if (!c.light) { assert.equal(bg, NAVY); return; }
    assert.notEqual(bg, NAVY); assert.equal(bg, 'rgb(255, 255, 255)');
    const st = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector('.ov > .hero')); return { color: cs.color, border: cs.borderTopColor, shadow: cs.boxShadow }; });
    assert.equal(st.color, 'rgb(17, 23, 38)', 'dark ink'); assert.notEqual(st.shadow, 'none', 'card shadow');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#brandbar .wm')).color), 'rgb(194, 83, 47)', 'logo in the darker coral');
    const all = await heroContrast(page);
    assert.ok(all.length >= 15, 'scanned ' + all.length);
    const bad = all.filter(x => x.ratio < (x.logo ? 3 : 4.5));
    assert.deepEqual(bad, [], JSON.stringify(bad));
    // Dividers and the meter track are visible on the white card.
    const vis = await page.evaluate(() => { const g = s => getComputedStyle(document.querySelector(s)); return [g('#brandbar').borderTopColor, g('.hero-foot').borderTopColor, g('.meter').backgroundColor, g('.meter i').backgroundColor, g('.navbtn').borderTopColor]; });
    vis.forEach(v => assert.notEqual(v, 'rgb(255, 255, 255)', 'visible: ' + vis));
    assert.deepEqual(errs, []);
  });
  await quiet(page);
  if (c.tag === 'Light chosen (phone dark)') await page.locator('.ov > .hero').screenshot({ path: SHOTS + '/hero-light-v12-390.png' });
  if (c.tag === 'Auto + dark phone') await page.locator('.ov > .hero').screenshot({ path: SHOTS + '/hero-dark-v12-390.png' });
  await ctx.close();
}
{
  const { ctx, page, errs } = await newPage(390, 844, { dark: false });
  await step('Auto follows the phone switching light → dark → light: white card, navy card, white card', async () => {
    assert.equal(await heroBg(page), 'rgb(255, 255, 255)');
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(80); assert.equal(await heroBg(page), NAVY);
    await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(80); assert.equal(await heroBg(page), 'rgb(255, 255, 255)');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 2. Plans: Other tile only with active plans ---------- */
{
  const { ctx, page, errs } = await newPage(390, 844, { dark: false, hash: '#plans' });
  await step('Plans: "Other" tile hidden at 0 active plans; Klarna, Afterpay, PayPal share one row', async () => {
    await page.waitForSelector('.prov .tile');
    const t = await page.evaluate(() => [...document.querySelectorAll('.prov .tile')].map(e => ({ k: e.querySelector('.k').textContent, top: Math.round(e.getBoundingClientRect().top) })));
    assert.deepEqual(t.map(x => x.k), ['Klarna', 'Afterpay', 'PayPal']);
    assert.equal(new Set(t.map(x => x.top)).size, 1, 'one row');
    await noHScroll(page, '390 plans');
    await quiet(page); await page.screenshot({ path: SHOTS + '/plans-v12-390.png' });
  });
  await step('Plans: an active "Other" plan brings its tile back', async () => {
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.plans.push({ id: 'o1', provider: 'Other', merchant: 'Sofa', amount: 50, total: 4, paid: 1, freq: 'monthly', lastDate: s.plans[0].lastDate, category: 'Other' }); localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.prov .tile');
    assert.deepEqual(await page.locator('.prov .tile .k').allInnerTexts(), ['Klarna', 'Afterpay', 'PayPal', 'Other']);
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 3. Income: Add income + Add to savings on one line ---------- */
for (const [w, h] of [[390, 844], [669, 951]]) {
  const { ctx, page, errs } = await newPage(w, h, { dark: true, hash: '#income' });
  await step(`${w}: "Add income" and "Add to savings" side by side, equal width, one entry point even with Other income`, async () => {
    await page.waitForSelector('.inc-acts');
    const m = () => page.evaluate(() => [...document.querySelectorAll('.inc-acts .btn')].map(e => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim(), top: Math.round(r.top), w: Math.round(r.width), fit: e.scrollWidth <= e.clientWidth + 1 }; }));
    let r = await m();
    assert.deepEqual(r.map(x => x.t), ['Add income', 'Add to savings']);
    assert.equal(r[0].top, r[1].top, 'one line'); assert.ok(Math.abs(r[0].w - r[1].w) <= 1, 'equal width ' + r.map(x => x.w)); assert.ok(r.every(x => x.fit), 'labels fit');
    assert.equal(await page.locator('[data-action="add"][data-type="income"]').count(), 1);
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.income.push({ id: 'side', name: 'Side gig', freq: 'monthly', date: s.income[0].date, amount: 300 }); localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.oi-coll'); await page.click('.coll-h[data-k="other"]');
    r = await m(); assert.equal(r[0].top, r[1].top, 'still one line');
    assert.equal(await page.locator('[data-action="add"][data-type="income"]').count(), 1, 'no duplicate inside Other income');
    await noHScroll(page, w + ' income');
    if (w === 390) { await quiet(page); await page.locator('.inc-acts').scrollIntoViewIfNeeded(); await page.screenshot({ path: SHOTS + '/income-btns-390.png' }); }
    await page.click('.inc-acts [data-action="sv-add"]'); await page.waitForSelector('#svadd');
    await page.keyboard.press('Escape');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 4. Eye button inside the sums ---------- */
for (const [w, h] of [[390, 844], [669, 951], [951, 669], [1000, 703]]) {
  const { ctx, page, errs } = await newPage(w, h, { dark: w % 2 === 0 });
  await step(`${w}x${h}: eye sits in the ladder (In account column, below "Updated …"), no separate row, no overlap, 36px`, async () => {
    const m = await page.evaluate(() => {
      const q = s => document.querySelector(s), R = e => e.getBoundingClientRect();
      const lad = R(q('.ladder')), eye = R(q('.ladder .eye')), top = R(q('.hero-top')), l3 = R(q('.lad.l3'));
      const texts = [...document.querySelectorAll('.hero .hs-k, .hero .lad .v, .hero .hs-s .fl, .hero .sv-chip, .hero .meter, .hero .ua-bar')].map(e => ({ t: e.className, r: R(e) }));
      const hit = texts.filter(x => !(x.r.right <= eye.left || x.r.left >= eye.right || x.r.bottom <= eye.top || x.r.top >= eye.bottom)).map(x => x.t);
      return { lad, eye, top, l3, hit, outside: document.querySelectorAll('.hero > .lad-tools').length, label: q('.ladder .eye').getAttribute('aria-label') };
    });
    assert.equal(m.outside, 0, 'no separate eye row');
    assert.ok(m.top.bottom <= m.lad.top + 0.5, 'ladder right under the pay cycle row');
    assert.ok(m.eye.top >= m.lad.top && m.eye.bottom <= m.lad.bottom + 0.5 && m.eye.right <= m.lad.right + 0.5, 'inside the ladder');
    assert.ok(m.eye.left >= m.l3.left - 0.5 && m.eye.right <= m.l3.right + 0.5 && m.eye.top >= m.l3.bottom - 0.5, 'below the In account column');
    assert.ok(m.eye.width >= 36 && m.eye.height >= 36, 'tap target ' + m.eye.width);
    assert.deepEqual(m.hit, [], 'overlaps ' + m.hit);
    assert.equal(m.label, 'Hide balances');
    await noHScroll(page, w + ' hero');
  });
  await step(`${w}x${h}: hide collapses the sums into one row with Show; Show brings them back`, async () => {
    await page.click('.ladder .eye'); await page.waitForSelector('.lad-tools.hid');
    assert.equal(await page.locator('.ladder').count(), 0);
    assert.match(await page.locator('.lad-tools.hid').innerText(), /Balances hidden\s*·\s*Show/);
    assert.equal(await page.locator('.lad-tools.hid .eye').getAttribute('aria-label'), 'Show balances');
    const box = await page.locator('.lad-tools.hid .eye').boundingBox(); assert.ok(box.width >= 36 && box.height >= 36);
    await page.click('.lad-tools.hid .linkbtn'); await page.waitForSelector('.ladder .eye');
    assert.equal(await page.locator('.ladder .eye').getAttribute('aria-label'), 'Hide balances');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 5. Transactions: shorter labels on one line ---------- */
{
  const { ctx, page, errs } = await newPage(390, 844, { dark: false, hash: '#transactions' });
  await step('390: chips read All · Accepted · Matched · Skipped on one line, no page scroll (v21: no Review chip)', async () => {
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx-chips');
    const m = await page.evaluate(() => { const row = document.querySelector('.tx-chips'), cs = [...row.querySelectorAll('.chip')];
      return { t: cs.map(c => c.textContent), tops: cs.map(c => Math.round(c.getBoundingClientRect().top)), fs: getComputedStyle(cs[0]).fontSize, sw: row.scrollWidth, cw: row.clientWidth, ox: getComputedStyle(row).overflowX }; });
    assert.equal(m.t.length, 4); assert.deepEqual(m.t, ['All', 'Accepted', 'Matched', 'Skipped']);
    assert.equal(new Set(m.tops).size, 1, 'one line ' + m.tops); assert.equal(m.fs, '13px');
    assert.ok(m.sw <= m.cw + 1, `all four fit at 390: ${m.sw} > ${m.cw}`);
    await noHScroll(page, '390 transactions');
    await quiet(page); await page.screenshot({ path: SHOTS + '/tx-chips-390.png' });
  });
  await step('row chips say "To review" and, after Skip, "Skipped"', async () => {
    const chip = id => page.locator(`.tx[data-id="${id}"] .txc`).innerText();
    assert.equal(await chip('pl:g2'), 'To review');
    await page.locator('.tx[data-id="pl:g2"] .tx-main').click(); await page.locator('.tx[data-id="pl:g2"] [data-action="tx-ignore"]').click();
    await page.waitForFunction(() => { const r = JSON.parse(localStorage.getItem('budtrack.v1')).bank.seen['pl:g2']; return r && r.res === 'skip'; });
    assert.equal(await chip('pl:g2'), 'Skipped');
    await page.click('[data-action="tx-filter"][data-f="ignored"]'); assert.equal(await page.locator('.tx[data-id="pl:g2"]').count(), 1);
    assert.equal(await page.locator('.txc', { hasText: /Needs review|Ignored/ }).count(), 0);
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 6. Savings accounts ---------- */
{
  // Never chosen: the account the bank calls "savings" is suggested (pre-checked) and its transfers are savings moves.
  const { ctx, page, errs } = await newPage(390, 844, { dark: true, svAccts: undefined });
  await step('first time: subtype "savings" is pre-checked as savings; In account leaves it out; savings chip on', async () => {
    let s = await getState(page); assert.equal(s.bank.savingsAccts, null, 'still never chosen');
    assert.match(await page.locator('.lad.l3 .v').innerText(), /1,500/);
    assert.match(await page.locator('.lad.l3 .sv-chip').innerText(), /^(Savings:? |Sav\. )?\$800$/);
    await page.click('[data-action="account"]'); await page.waitForSelector('.bal-total');
    assert.match(await page.locator('.bal-total').innerText(), /\$1,500\.00/);
    assert.equal(await page.locator('.bal-sv [data-action="bal-sv"][data-id="ch2"]').isChecked(), true);
    assert.equal(await page.locator('#balbanks [data-action="bal-sv"][data-id="ch1"]').isChecked(), false);
    assert.equal(await page.locator('.bal-sv .tgl').count(), 0, 'no Count in total toggle on a savings account');
    await page.keyboard.press('Escape');
  });
  await step('checking → savings transfer pair is a savings move: not in Review, one savings "in", Saved this cycle', async () => {
    const s = await getState(page), xo = s.bank.seen['pl:xo'], xi = s.bank.seen['pl:xi'];
    assert.ok(xo && xo.res === 'transfer' && xo.savings === 'in' && !xo.sv, 'checking leg marked, no ledger entry: ' + JSON.stringify(xo));
    assert.ok(xi && xi.res === 'transfer' && xi.savings === 'in' && xi.sv, 'savings leg records the move');
    const inbox = s.bank.inbox.flatMap(x => (x.parts || [x.txn]).map(t => t.id));
    assert.ok(!inbox.includes('pl:xo') && !inbox.includes('pl:xi'), 'not in review');
    assert.ok(inbox.includes('pl:zel'), 'a transfer to a person stays in review');
    const moves = s.savings.tx.filter(t => t.type === 'in'); assert.equal(moves.length, 1); assert.equal(moves[0].amount, 150); assert.equal(moves[0].txn, 'pl:xi');
    assert.match(await page.locator('.hero-saved').innerText(), /Saved this cycle\s*\$150\.00/);
    assert.equal(await page.locator('.cat-legend > li[data-g="Savings"]').count(), 1, 'savings group in the chart');
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx');
    assert.equal(await page.locator('.tx[data-id="pl:xo"] .txc').innerText(), 'Savings'); assert.equal(await page.locator('.tx[data-id="pl:xi"] .txc').innerText(), 'Savings');
    assert.equal(await page.locator('#txreview .tx[data-id="pl:xo"], #txreview .tx[data-id="pl:xi"]').count(), 0, 'not in To review');
  });
  await step('a later sync does not record the move twice', async () => {
    await page.goto(BASE + '#overview'); await page.click('.hero [data-action="account"]'); await page.waitForSelector('[data-action="bal-sync"]');
    await page.click('[data-action="bal-sync"]'); await page.waitForFunction(() => !document.querySelector('[data-action="bal-sync"]').disabled); await page.waitForTimeout(150);
    assert.equal((await getState(page)).savings.tx.length, 1);
    await page.keyboard.press('Escape');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}
{
  // Chosen before (nothing marked): marking Chime Savings by hand.
  const { ctx, page, errs } = await newPage(390, 844, { dark: false, svAccts: {} });
  await step('nothing marked: savings counts in the total and its transfers wait in Review', async () => {
    assert.match(await page.locator('.lad.l3 .v').innerText(), /2,300/);
    assert.equal(await page.locator('.hero .sv-chip').count(), 0);
    const inbox = (await getState(page)).bank.inbox.flatMap(x => (x.parts || [x.txn]).map(t => t.id));
    assert.ok(inbox.includes('pl:xo') && inbox.includes('pl:xi'));
  });
  await step('mark Chime Savings: total drops by $800, Savings section lists it, savings UI on, transfers leave Review', async () => {
    await page.click('[data-action="account"]'); await page.waitForSelector('.bal-total');
    assert.match(await page.locator('.bal-total').innerText(), /\$2,300\.00/);
    assert.equal(await page.locator('.bal-sv').count(), 0);
    await page.locator('.sv-mark', { has: page.locator('[data-id="ch2"]') }).click();
    await page.waitForFunction(() => /\$1,500\.00/.test(document.querySelector('.bal-total').textContent));
    assert.match(await page.locator('.bal-sv').innerText(), /Savings · not in total[\s\S]*\$800\.00[\s\S]*Chime Savings/i);
    assert.equal(await page.locator('.bal-sv [data-action="bal-sv"][data-id="ch2"]').isChecked(), true);
    assert.equal(await page.locator('#balbanks [data-id="ch2"]').count(), 0, 'moved out of the bank list');
    const s = await getState(page); assert.deepEqual(s.bank.savingsAccts, { ch2: true });
    const inbox = s.bank.inbox.flatMap(x => (x.parts || [x.txn]).map(t => t.id));
    assert.ok(!inbox.includes('pl:xo') && !inbox.includes('pl:xi'), 'swept out of review');
    assert.equal(s.savings.tx.filter(t => t.type === 'in').length, 1);
    await page.waitForTimeout(350); await quiet(page);
    assert.ok(await page.evaluate(() => { const s = document.querySelector('#sheet .sheet'); return s.scrollWidth <= s.clientWidth + 1; }), 'sheet has no horizontal scroll');
    await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/savings-acct-390.png' });
    await page.keyboard.press('Escape');
    assert.match(await page.locator('.lad.l3 .v').innerText(), /1,500/);
    assert.match(await page.locator('.hero .sv-chip').innerText(), /^(Savings:? |Sav\. )?\$800$/);
    assert.match(await page.locator('.hero-saved').innerText(), /\$150\.00/);
  });
  await step('the choice persists after reload and is in the backup JSON', async () => {
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.lad.l3');
    assert.match(await page.locator('.lad.l3 .v').innerText(), /1,500/);
    await page.goto(BASE + '#income'); await page.waitForSelector('.inc-sv');
    assert.match(await page.locator('.inc-sv').innerText(), /Savings \$800\.00/);
    await page.click('[data-action="copy-backup"]');
    const bk = JSON.parse(await page.inputValue('#bk')); assert.deepEqual(bk.bank.savingsAccts, { ch2: true });
    await page.keyboard.press('Escape');
  });
  await step('unmarking puts it back in the total; the choice is kept as "nothing marked"', async () => {
    await page.goto(BASE + '#overview'); await page.click('[data-action="account"]'); await page.waitForSelector('.bal-sv');
    await page.locator('.sv-mark', { has: page.locator('[data-id="ch2"]') }).click();
    await page.waitForFunction(() => /\$2,300\.00/.test(document.querySelector('.bal-total').textContent));
    assert.deepEqual((await getState(page)).bank.savingsAccts, {});
    await page.keyboard.press('Escape');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}
{
  // 669 and 951: the sheet with savings fits.
  for (const [w, h] of [[669, 951], [951, 669]]) {
    const { ctx, page, errs } = await newPage(w, h, { dark: true, svAccts: undefined });
    await step(`${w}x${h}: In account sheet with a Savings section has no horizontal scroll`, async () => {
      await page.click('[data-action="account"]'); await page.waitForSelector('.bal-sv'); await page.waitForTimeout(300);
      assert.ok(await page.evaluate(() => { const s = document.querySelector('#sheet .sheet'); return s.scrollWidth <= s.clientWidth + 1; }));
      await noHScroll(page, w + ' sheet'); assert.deepEqual(errs, []);
    });
    await ctx.close();
  }
}

{
  // Typed balance + an unallocated item: a savings move found by the sync is accounted like "To savings", and Undo is exact.
  const fx = { account: { balance: 1000, asOf: addD(TODAY, -10), adj: [], auto: false }, unalloc: [{ id: 'u1', date: addD(TODAY, -2), amount: 100 }] };
  const { ctx, page, errs } = await newPage(390, 844, { dark: false, svAccts: {}, fx });
  const snap = () => page.evaluate(([d]) => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); return { bal: BT.accountBalance(s, d), un: s.unalloc.map(u => [u.id, u.amount, u.fromPlans || 0]), adj: s.account.adj, sv: s.savings.tx }; }, [TODAY]);
  await step('typed balance: an automatic savings move tags what the account absorbed; Undo puts everything back', async () => {
    const s0 = await snap();
    await page.click('[data-action="account"]'); await page.waitForSelector('[data-action="bal-hand"]');
    // Live balance off would hide the sheet; here live balances are on, so mark from the balance sheet.
    await page.locator('.sv-mark', { has: page.locator('[data-id="ch2"]') }).click();
    await page.waitForFunction(() => { const r = JSON.parse(localStorage.getItem('budtrack.v1')).bank.seen['pl:xi']; return r && r.sv; });
    await page.keyboard.press('Escape');
    let st = await getState(page); const r = st.bank.seen['pl:xi'];
    const cut = (r.absorb || []).reduce((a, q) => a + q[1], 0), adj = st.account.adj.filter(x => x.sv === r.sv).reduce((a, x) => a + x.amount, 0);
    assert.equal(Math.round((cut + adj) * 100), 15000, 'the $150 move is explained by the unallocated cut plus a tagged adjustment: ' + JSON.stringify([r.absorb, st.account.adj]));
    assert.equal(st.account.adj.filter(x => !x.sv).length, s0.adj.length, 'no untagged adjustment');
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx[data-id="pl:xi"]');
    await page.locator('.tx[data-id="pl:xi"] .tx-main').click(); await page.locator('.tx[data-id="pl:xi"] [data-action="tx-undo"]').click();
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('budtrack.v1')).bank.seen['pl:xi']);
    const s1 = await snap();
    assert.deepEqual(s1, s0, 'back to where it started');
    st = await getState(page); assert.equal(st.bank.notSv['pl:xi'], true, 'not marked again by the next sync');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}
{
  // The checking leg was moved "To savings" by hand before the account was marked: the savings leg must not save it again.
  const { ctx, page, errs } = await newPage(390, 844, { dark: true, svAccts: {}, hash: '#transactions' });
  await step('"To savings" by hand on the checking leg, then marking the account: saved once, not twice', async () => {
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx[data-id="pl:xo"]');
    await page.locator('.tx[data-id="pl:xo"] .tx-main').click(); await page.locator('.tx[data-id="pl:xo"] [data-action="tx-sv"]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).savings.tx.length === 1);
    await page.goto(BASE + '#overview'); await page.click('[data-action="account"]'); await page.waitForSelector('.bal-total');
    await page.locator('.sv-mark', { has: page.locator('[data-id="ch2"]') }).click();
    await page.waitForFunction(() => { const r = JSON.parse(localStorage.getItem('budtrack.v1')).bank.seen['pl:xi']; return r && r.res === 'transfer'; });
    const s = await getState(page);
    assert.equal(s.savings.tx.filter(t => t.type === 'in').length, 1, JSON.stringify(s.savings.tx)); assert.ok(!s.bank.seen['pl:xi'].sv);
    await page.keyboard.press('Escape');
    assert.match(await page.locator('.hero-saved').innerText(), /\$150\.00/);
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}
for (const [w, h] of [[390, 844], [763, 390], [814, 430]]) {
  const { ctx, page, errs } = await newPage(w, h, { dark: true, svAccts: undefined, savBal: 12345.67 });
  await step(`${w}x${h}: savings chip ($12,346) fits the In account column, eye below it, no overlap`, async () => {
    const m = await page.evaluate(() => { const R = s => document.querySelector(s).getBoundingClientRect(), chip = document.querySelector('.lad.l3 .sv-chip');
      return { t: chip.textContent, c: R('.lad.l3 .sv-chip'), col: R('.lad.l3'), eye: R('.ladder .eye'), fit: chip.scrollWidth <= chip.clientWidth + 1 }; });
    assert.match(m.t, /^(Savings:? |Sav\. )?\$12,346$/); assert.ok(m.fit, 'chip text not clipped');
    assert.ok(m.c.left >= m.col.left - 0.5 && m.c.right <= m.col.right + 0.5, `chip inside its column ${JSON.stringify([m.c.left, m.c.right, m.col.left, m.col.right])}`);
    assert.ok(m.eye.top >= m.c.bottom - 0.5, 'eye below the chip');
    await noHScroll(page, w + ' chip');
    if (w === 390) { await quiet(page); await page.locator('.ov > .hero').screenshot({ path: SHOTS + '/hero-savings-chip-390.png' }); }
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}
for (const [w, h] of [[669, 951], [951, 669]]) {
  // A bill paid from the bank that is not matched yet shows the "likely completed" line.
  const fx = { bills: [{ id: 'rent', name: 'Rent', amount: 1050, day: dayOf(3), group: 'Fixed', category: 'Housing', active: true },
    { id: 'gym', name: 'Planet Fitness', amount: 24.99, day: dayOf(-1), group: 'Fixed', category: 'Other', active: true }],
    // Lines before "automatic from" are listed, not matched automatically: the gym charge stays a "likely completed" bill.
    bank: Object.assign(fixture({}).bank, { autoFrom: TODAY }) };
  const txns = TXNS().concat([T('gym', PAY, 'PLANET FITNESS CLUB FEES', 24.99, CHK)]);
  const { ctx, page, errs } = await newPage(w, h, { dark: true, settings: { theme: 'light' }, fx, txns });
  await step(`${w}x${h} light: every text in the cycle card (bars included) is ≥ 4.5:1, logo ≥ 3:1`, async () => {
    assert.equal(await heroBg(page), 'rgb(255, 255, 255)');
    const all = await heroContrast(page), bad = all.filter(x => x.ratio < (x.logo ? 3 : 4.5));
    assert.deepEqual(bad, [], JSON.stringify(bad));
    assert.ok(all.some(x => /new transactions?/.test(x.text)), 'bank bar scanned');
    assert.equal(await page.locator('.hero .lk-bar').count(), 1, 'likely-completed bar shown'); assert.ok(all.some(x => /likely completed/.test(x.text)), 'likely bar scanned');
    await noHScroll(page, w + ' light');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

await b.close();
finish();
