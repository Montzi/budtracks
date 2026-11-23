// v19: header fixed in place on every tab (period button inside it), Bud names the tab, new-data badges on tabs.
// Run: node tests/v19.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const SHOTS = process.argv[2] || '/tmp';
const BASE = process.env.BT_URL || 'http://localhost:8765/';
const API = 'https://worker.test';
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n   ', String(e.message).split('\n').slice(0, 14).join('\n    ')); } };
const TABS = ['overview', 'transactions', 'bills', 'plans', 'income'];
const SIZES = process.env.BT_ONE ? [[390, 844]] : [[390, 844], [430, 932], [669, 951], [951, 669], [1000, 703]];
const b = await pw.chromium.launch();

const acct = { id: 'acc1', name: 'Everyday Checking', last4: '1234', institution: 'Chime', type: 'depository' };
const T = (id, date, desc, amount, extra) => Object.assign({ id: 'pl:' + id, date, desc, rawDesc: desc, amount, account: acct, status: 'posted', pendingOf: null, counterparty: null, providerCategory: null }, extra || {});
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const THREE = [T('a1', day(-1), 'MYSTERY SHOP ONE', 18.99), T('a2', day(-1), 'CORNER DELI TWO', 9.5), T('a3', day(-2), 'HARDWARE THREE', 41.25)];
const AUTO = [T('klarna', day(-1), 'KLARNA*NIKE', 27.65), T('electric', day(-1), 'NATIONAL GRID ELECTRIC', 70), T('pay', day(-2), 'ACME CORP PAYROLL', -1500)];
const fixture = () => ({
  since: '2026-10-01', marks: {}, occ: {}, spends: [], unalloc: [], perPeriod: [],
  categories: ['Gas', 'Subscriptions', 'Groceries', 'Dining Out', 'Takeout Food', 'Personal care', 'Other'],
  payVia: [{ bank: 'Chime', last4: '1234', type: 'debit' }],
  bank: { seen: {}, rules: {}, links: {}, lastSync: null, inbox: [], api: API, autoFrom: '2026-11-01', historyFrom: '2026-10-01', savingsAccts: {} },
  bills: [{ id: 'elec', name: 'Electric', amount: 70, day: Number(day(0).slice(8)), group: 'Fixed', category: 'Utilities' }],
  cards: [], plans: [{ id: 'k1', provider: 'Klarna', merchant: 'Nike', amount: 27.65, total: 4, paid: 1, freq: 'biweekly', lastDate: day(-14), category: 'Other', dates: [day(-14), day(-1), day(13)] }],
  income: [{ id: 'pay', name: 'Payroll', freq: 'biweekly', date: day(-2), amount: 1500, askFrom: day(-2), perCycle: {} }],
  account: { balance: 3000, asOf: '2026-10-01', adj: [], auto: true }
});

async function newPage(w, h, o) {
  o = o || {};
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: o.scheme || 'dark', reducedMotion: o.reduce ? 'reduce' : 'no-preference', deviceScaleFactor: 1 });
  const page = await ctx.newPage(); page.setDefaultTimeout(6000);
  const errs = [], mock = { txns: o.txns || [], seq: 0 };
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await page.addInitScript(() => { window.__badge = []; navigator.setAppBadge = n => { window.__badge.push(n); return Promise.resolve(); }; navigator.clearAppBadge = () => { window.__badge.push(0); return Promise.resolve(); }; });
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname;
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = (x, status) => route.fulfill({ status: status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(x) });
    if (p === '/config') return json({ provider: 'plaid', env: 'sandbox', paired: true });
    if (p === '/accounts') return json({ enrollments: [{ id: 'enr_1', institution: 'Chime', needsReconnect: false, accounts: [{ id: 'acc1', name: 'Everyday Checking', type: 'depository', subtype: 'checking', last_four: '1234', enabled: true }] }] });
    if (p === '/sync') return json({ txns: mock.txns, removed: [], errors: [], syncToken: 'tok-' + (++mock.seq), syncedAt: new Date().toISOString() });
    return json({ error: 'nope' }, 404);
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(([fx, st, theme]) => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1') || '{}'), f = JSON.parse(fx);
    Object.assign(s, f); s.bank = Object.assign({}, f.bank, st.bank || {}); s.settings = Object.assign(s.settings || {}, st.settings || {}, theme ? { theme } : {});
    localStorage.setItem('budtrack.v1', JSON.stringify(s)); localStorage.setItem('budtrack.bankkey', 'secret-device-key-123');
  }, [JSON.stringify(fixture()), o.state || {}, o.theme || '']);
  await page.goto(BASE + '#overview', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(o.wait == null ? 500 : o.wait);
  return { ctx, page, errs, mock };
}
const go = async (page, t) => { await page.evaluate(t => { location.hash = t; }, t); await page.waitForTimeout(250); };
const getState = page => page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')));
const noHScroll = async (page, m) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 0.5), 'horizontal scroll ' + m);
const overlap = (a, c) => a.l < c.r - .01 && c.l < a.r - .01 && a.t < c.b - .01 && c.t < a.b - .01;
const geo = page => page.evaluate(() => {
  const q = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  return { bar: q('#brandbar'), wm: q('#brandbar .wm'), arms: q('#brandbar svg.arms'), hd: q('#brandbar svg.hd'), sync: q('#brandbar .sync'), per: q('#periodBtn'), menu: q('#periodMenu') };
});
const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
const ratio = (a, c) => { const x = lum(a), y = lum(c); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number);
const badge = (page, t) => page.evaluate(t => { const a = document.querySelector(`.tabs a[href="#${t}"]`), e = a.querySelector('.badge'); return { shown: !e.hidden && getComputedStyle(e).display !== 'none', text: e.textContent, label: a.getAttribute('aria-label') }; }, t);
const setView = async (page, v, label) => { await page.click('#periodBtn'); await page.click(`#periodMenu [data-view="${v}"]`); await page.waitForTimeout(150); };

for (const [w, h] of SIZES) for (const scheme of process.env.BT_ONE ? ['dark'] : ['dark', 'light']) {
  const { page, errs } = await newPage(w, h, { scheme, theme: scheme });
  const tag = `${w}x${h} ${scheme}`;
  await step(`${tag}: nothing above the header; same box and wordmark on all five tabs`, async () => {
    assert.equal(await page.locator('.top, #viewSeg').count(), 0, 'old switcher gone');
    assert.equal(await page.evaluate(() => document.querySelector('.app').firstElementChild.id), 'brandbar');
    let ref = null;
    for (const t of [...TABS, 'plans', 'overview', 'income', 'transactions']) {
      await go(page, t);
      const g = await geo(page);
      assert.ok(g.bar.t <= 20, 'header at the top ' + g.bar.t);
      if (!ref) ref = g;
      for (const k of ['l', 't', 'w', 'h']) { assert.ok(Math.abs(g.bar[k] - ref.bar[k]) <= .5, `header ${k} ${g.bar[k]} vs ${ref.bar[k]} on ${t}`); assert.ok(Math.abs(g.wm[k] - ref.wm[k]) <= .5, `wordmark ${k} ${g.wm[k]} vs ${ref.wm[k]} on ${t}`); }
      for (const k of ['hd', 'arms', 'per', 'sync']) for (const f of ['l', 't', 'w', 'h']) assert.ok(Math.abs(g[k][f] - ref[k][f]) <= .5, `${k} ${f} moved on ${t}`);
      await noHScroll(page, t);
    }
    assert.deepEqual(errs, []);
  });
  await step(`${tag}: period button + Saved pill clear of Bud, wordmark and arms (also with a long Saved text)`, async () => {
    for (const long of [false, true]) for (const t of TABS) {
      await go(page, t);
      await page.evaluate(l => { document.querySelectorAll('.sync').forEach(e => { e.textContent = l ? 'Not synced. Saved in this browser' : 'Saved'; }); }, long);
      const g = await geo(page);
      for (const k of ['wm', 'arms', 'hd']) { assert.ok(!overlap(g.per, g[k]), `${k} overlaps the period button on ${t}`); assert.ok(!overlap(g.sync, g[k]), `${k} overlaps Saved on ${t}`); }
      assert.ok(!overlap(g.per, g.sync), 'period vs Saved');
      assert.ok(g.per.l >= g.bar.l && g.per.l - g.bar.l <= 16 && g.per.t - g.bar.t <= 10, 'top-left ' + JSON.stringify([g.per, g.bar]));
      assert.ok(g.sync.r <= g.bar.r - 8 && g.sync.t - g.bar.t <= 12, 'Saved top-right');
    }
  });
  await step(`${tag}: header colors: Overview = hero, other tabs deeper, text contrast >= 4.5`, async () => {
    await go(page, 'overview');
    const bg = async () => page.evaluate(() => { const bb = document.querySelector('#brandbar'); return { bg: getComputedStyle(bb).backgroundColor, hero: document.querySelector('.ov > .hero') ? getComputedStyle(document.querySelector('.ov > .hero')).backgroundColor : '', per: getComputedStyle(document.querySelector('#periodBtn')).color, sync: getComputedStyle(bb.querySelector('.sync')).color, ink: getComputedStyle(bb).color }; });
    const o = await bg(); assert.equal(o.bg, o.hero);
    for (const t of TABS) {
      await go(page, t); await page.waitForTimeout(150);
      const c = await bg();
      if (t === 'overview') { assert.equal(c.bg, o.hero); } else { assert.notEqual(c.bg, o.hero, 'differs on ' + t); const [a, d] = [lum(rgb(c.bg)), lum(rgb(o.hero))]; if (scheme === 'dark') assert.ok(a < d, 'deeper navy'); else assert.ok(a < d, 'deeper tint'); }
      for (const k of ['per', 'sync', 'ink']) { const r = ratio(rgb(c[k]), rgb(c.bg)); assert.ok(r >= 4.5, `${k} contrast ${r.toFixed(2)} on ${t}`); }
    }
  });
  await step(`${tag}: other-tab header keeps the same outer height as the Overview header (only corners differ)`, async () => {
    await go(page, 'overview'); const o = await geo(page);
    const r1 = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('#brandbar')); return [s.borderBottomLeftRadius, s.borderTopLeftRadius]; });
    assert.deepEqual(r1, ['0px', '22px']);
    await go(page, 'bills'); const g = await geo(page);
    const r2 = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('#brandbar')); return [s.borderBottomLeftRadius, s.borderTopLeftRadius]; });
    assert.deepEqual(r2, ['22px', '22px']); assert.ok(Math.abs(g.bar.h - o.bar.h) <= .5);
    const m = await page.evaluate(() => document.querySelector('#main').getBoundingClientRect().top); assert.ok(m >= g.bar.b + 8, 'content below the header');
  });
  await step(`${tag}: period menu opens, shows 3 options, current checked, Escape/outside close, Weekly persists`, async () => {
    await go(page, 'bills');
    assert.equal((await page.locator('#periodLbl').innerText()).trim(), 'Bi-weekly');
    assert.equal(await page.getAttribute('#periodBtn', 'aria-haspopup'), 'menu'); assert.equal(await page.getAttribute('#periodBtn', 'aria-expanded'), 'false');
    assert.ok(await page.locator('#periodMenu').isHidden());
    await page.click('#periodBtn'); assert.ok(await page.locator('#periodMenu').isVisible());
    assert.equal(await page.getAttribute('#periodBtn', 'aria-expanded'), 'true');
    assert.deepEqual(await page.$$eval('#periodMenu [role="menuitemradio"]', e => e.map(x => [x.textContent.trim(), x.getAttribute('aria-checked')])), [['Weekly', 'false'], ['Bi-weekly', 'true'], ['Monthly', 'false']]);
    const g = await geo(page); assert.ok(g.menu.t >= g.per.b - 1 && g.menu.l >= g.bar.l - 1 && g.menu.r <= w, 'anchored under the button ' + JSON.stringify(g.menu)); await noHScroll(page, 'menu open');
    await page.keyboard.press('Escape'); assert.ok(await page.locator('#periodMenu').isHidden()); assert.equal(await page.getAttribute('#periodBtn', 'aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'periodBtn', 'focus returns to the button');
    await page.click('#periodBtn'); await page.mouse.click(w - 4, h - 200); assert.ok(await page.locator('#periodMenu').isHidden(), 'outside tap closes');
    await page.focus('#periodBtn'); await page.keyboard.press('ArrowDown'); assert.ok(await page.locator('#periodMenu').isVisible());
    assert.equal(await page.evaluate(() => document.activeElement.dataset.view), 'biweekly'); await page.keyboard.press('ArrowUp'); assert.equal(await page.evaluate(() => document.activeElement.dataset.view), 'weekly');
    await page.keyboard.press('Enter'); await page.waitForTimeout(150);
    assert.ok(await page.locator('#periodMenu').isHidden()); assert.equal((await page.locator('#periodLbl').innerText()).trim(), 'Weekly');
    assert.equal((await getState(page)).settings.view, 'weekly');
    await go(page, 'overview'); assert.equal((await page.locator('#periodLbl').innerText()).trim(), 'Weekly');
    assert.match(await page.locator('.ov .hero').innerText(), /week/i);
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(300); assert.equal((await page.locator('#periodLbl').innerText()).trim(), 'Weekly');
    await setView(page, 'monthly'); assert.equal((await getState(page)).settings.view, 'monthly'); assert.equal((await page.locator('#periodLbl').innerText()).trim(), 'Monthly');
    await setView(page, 'biweekly'); assert.equal((await page.locator('#periodLbl').innerText()).trim(), 'Bi-weekly');
    await noHScroll(page, 'after view changes'); assert.deepEqual(errs, []);
  });
  await step(`${tag}: header node never remounted, hat sheet from any tab, glow animation not restarted`, async () => {
    await go(page, 'overview');
    await page.evaluate(() => { const bb = document.querySelector('#brandbar'); bb.__tag = 'same'; bb.querySelector('svg.hd').__tag = 'same'; bb.querySelector('#periodBtn').__tag = 'same'; window.__anim = document.getAnimations().filter(a => a.animationName === 'glowDrift').map(a => a.startTime); });
    for (const t of ['transactions', 'bills', 'plans', 'income', 'overview']) await go(page, t);
    await setView(page, 'weekly'); await setView(page, 'biweekly');
    assert.ok(await page.evaluate(() => document.querySelector('#brandbar').__tag === 'same' && document.querySelector('#brandbar svg.hd').__tag === 'same' && document.querySelector('#periodBtn').__tag === 'same'), 'remounted');
    assert.deepEqual(await page.evaluate(() => document.getAnimations().filter(a => a.animationName === 'glowDrift').map(a => a.startTime)), await page.evaluate(() => window.__anim));
    await go(page, 'income'); await page.locator('#brandbar svg.hd').dispatchEvent('click'); await page.waitForSelector('#budchat:not([hidden])'); await page.click('.bc-h [data-action="style"]'); await page.waitForSelector('#sheet:not([hidden]) .hat-sw'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  });
  if (w === 390 || w === 951) await step(`${tag}: screenshots`, async () => {
    await page.evaluate(() => document.querySelectorAll('.sync').forEach(e => { e.textContent = 'Saved'; }));
    const go = async (p, t) => { await p.evaluate(t => { location.hash = t; }, t); await p.waitForTimeout(2000); };   // wait for Bud's bubble to leave
    if (scheme === 'dark' && w === 390) {
      await go(page, 'overview'); await page.screenshot({ path: `${SHOTS}/v19-overview-390.png` });
      await go(page, 'transactions'); await page.screenshot({ path: `${SHOTS}/v19-tx-390.png` });
      await page.click('#periodBtn'); await page.waitForTimeout(150); await page.screenshot({ path: `${SHOTS}/v19-period-menu-390.png` }); await page.keyboard.press('Escape');
    }
    if (scheme === 'light' && w === 390) { await go(page, 'overview'); await page.screenshot({ path: `${SHOTS}/v19-overview-light-390.png` }); await go(page, 'bills'); await page.screenshot({ path: `${SHOTS}/v19-bills-light-390.png` }); }
    if (scheme === 'dark' && w === 951) { await go(page, 'overview'); await page.screenshot({ path: `${SHOTS}/v19-951.png` }); await go(page, 'plans'); await page.screenshot({ path: `${SHOTS}/v19-951-plans.png` }); }
  });
  await page.context().close();
}

await step('Bud says the tab name on every tab change (not on load), replaces the bubble, no stacking', async () => {
  const { page } = await newPage(390, 844);
  assert.equal(await page.evaluate(() => document.querySelector('#bud').classList.contains('on')), false, 'quiet on load');
  const names = { transactions: 'Transactions', bills: 'Bills', plans: 'Plans', income: 'Income', overview: 'Overview' };
  for (const t of ['transactions', 'bills', 'plans', 'income', 'overview']) {
    await page.evaluate(t => { location.hash = t; }, t); await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({ on: document.querySelector('#bud').classList.contains('on'), txt: document.querySelector('#bud').textContent, n: document.querySelectorAll('#bud').length }));
    assert.ok(r.on && r.txt.trim() === names[t] && r.n === 1, t + ' ' + JSON.stringify(r));
  }
  await page.evaluate(() => { location.hash = 'bills'; }); await page.waitForTimeout(120); await page.evaluate(() => { location.hash = 'plans'; }); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.querySelector('#bud').textContent.trim()), 'Plans', 'replaced, not stacked');
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(() => document.querySelector('#bud').classList.contains('on')), false, 'gone after ~1.6s');
  await page.click('.tabs a[href="#bills"]'); await page.waitForTimeout(300); assert.equal(await page.evaluate(() => document.querySelector('#bud').textContent.trim()), 'Bills', 'tap');
  await page.waitForTimeout(1900);
  await page.click('.tabs a[href="#bills"]'); await page.waitForTimeout(300); assert.equal(await page.evaluate(() => document.querySelector('#bud').classList.contains('on') && document.querySelector('#bud').textContent.trim()), 'Bills', 'same tab tapped again');
  await page.context().close();
});

await step('content fades in on a tab change; reduced motion turns it off; header unaffected', async () => {
  for (const reduce of [false, true]) {
    const { page } = await newPage(390, 844, { reduce });
    const r = await page.evaluate(async () => { const before = document.querySelector('#brandbar').getBoundingClientRect().top; location.hash = 'bills'; await new Promise(r => setTimeout(r, 30)); const m = document.querySelector('#main'); return { anim: getComputedStyle(m).animationName, dur: getComputedStyle(m).animationDuration, hb: document.querySelector('#brandbar').getBoundingClientRect().top - before }; });
    if (reduce) assert.equal(r.anim, 'none'); else { assert.equal(r.anim, 'tabIn'); assert.ok(parseFloat(r.dur) >= .15 && parseFloat(r.dur) <= .2, r.dur); }
    assert.equal(r.hb, 0);
    await page.context().close();
  }
});

await step('scroll returns to the top on a tab change and the header is visible', async () => {
  const { page } = await newPage(390, 844);
  await go(page, 'transactions'); await page.evaluate(() => window.scrollTo(0, 400)); await page.waitForTimeout(100);
  await go(page, 'bills'); assert.equal(await page.evaluate(() => scrollY), 0);
  assert.ok((await geo(page)).bar.t >= 0);
  await page.context().close();
});

const unseen = '2000-01-01T00:00:00.000Z';
await step('badges: 3 bank transactions to review -> Transactions badge "3"; opening does not clear it (v21), reviewing them does', async () => {
  const { page, mock } = await newPage(390, 844, { txns: THREE, state: { bank: { lastSync: null } } });
  await page.waitForFunction(() => !document.querySelector('.tabs a[href="#transactions"] .badge').hidden);
  let r = await badge(page, 'transactions'); assert.deepEqual([r.shown, r.text, r.label], [true, '3', 'Transactions, 3 to review']);
  for (const t of ['overview', 'bills', 'plans', 'income']) assert.equal((await badge(page, t)).shown, false, 'no badge on ' + t);
  const st = await getState(page); assert.ok(Object.values(st.bank.txns).every(t => typeof t.at === 'string'), 'first-seen at stored');
  assert.equal((await page.evaluate(() => window.__badge)).slice(-1)[0], 3, 'app icon badge');
  const pos = await page.evaluate(() => { const a = document.querySelector('.tabs a[href="#transactions"]'), s = a.querySelector('svg').getBoundingClientRect(), e = a.querySelector('.badge').getBoundingClientRect(); return { dx: e.left - s.left, top: s.top - e.top, w: e.width, h: e.height, bg: getComputedStyle(a.querySelector('.badge')).backgroundColor, ar: a.getBoundingClientRect() }; });
  assert.ok(pos.h >= 16 && Math.abs(pos.w - pos.h) < 14, 'badge on the icon corner ' + JSON.stringify(pos));
  assert.ok(ratio(rgb(pos.bg), [255, 255, 255]) >= 4.5, 'white on red');
  await page.screenshot({ path: `${SHOTS}/v19-badges-390.png` });
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(400);
  r = await badge(page, 'transactions'); assert.equal(r.text, '3', 'persists across reload'); assert.equal(r.shown, true);
  await go(page, 'transactions');
  r = await badge(page, 'transactions'); assert.equal(r.shown, true, 'the badge is the To review count: opening the tab keeps it'); assert.equal(r.text, '3');
  await page.click('#txreview [data-action="ix-all"]'); await page.waitForFunction(() => document.querySelector('.tabs a[href="#transactions"] .badge').hidden);
  r = await badge(page, 'transactions'); assert.equal(r.shown, false, 'cleared once reviewed'); assert.equal(r.label, null);
  assert.equal((await page.evaluate(() => window.__badge)).slice(-1)[0], 0, 'app icon badge cleared');
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(400);
  assert.equal((await badge(page, 'transactions')).shown, false, 'stays cleared');
  // a later sync brings one more while on another tab
  mock.txns = THREE.concat([T('a4', day(-1), 'FOURTH SHOP', 5)]);
  await go(page, 'income'); await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.context().close();
});

await step('badges: auto-matched bill, plan payment and paycheck show on Bills, Plans and Income; each clears only when opened', async () => {
  const { page } = await newPage(390, 844, { txns: AUTO, state: { bank: { lastSync: null } } });
  await page.waitForFunction(() => [...document.querySelectorAll('.tabs .badge')].some(e => !e.hidden), null, { timeout: 8000 });
  await page.waitForTimeout(400);
  const st = await getState(page); const kinds = Object.values(st.bank.seen).map(r => r.res + ':' + (r.auto ? 'auto' : 'hand') + ':' + r.src).sort();
  const b1 = { bills: await badge(page, 'bills'), plans: await badge(page, 'plans'), income: await badge(page, 'income'), tx: await badge(page, 'transactions') };
  assert.equal(b1.tx.shown, false, 'matched on their own: nothing waits in To review ' + JSON.stringify([b1, kinds]));
  assert.ok(b1.bills.shown && b1.bills.text === '1' && b1.bills.label === 'Bills, 1 new', JSON.stringify([b1.bills, kinds]));
  assert.ok(b1.plans.shown && b1.plans.text === '1', JSON.stringify([b1.plans, kinds]));
  assert.ok(b1.income.shown && b1.income.text === '1', JSON.stringify([b1.income, kinds]));
  assert.equal((await badge(page, 'overview')).shown, false, 'no Overview badge');
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(400);
  assert.equal((await badge(page, 'bills')).text, '1', 'persists');
  await go(page, 'bills'); assert.equal((await badge(page, 'bills')).shown, false); assert.equal((await badge(page, 'plans')).shown, true, 'Plans untouched');
  await go(page, 'plans'); assert.equal((await badge(page, 'plans')).shown, false); assert.equal((await badge(page, 'income')).shown, true);
  await go(page, 'income'); assert.equal((await badge(page, 'income')).shown, false);
  await page.context().close();
});

await step('badges: seen records and likely-completed lines are counted by time; hand-made decisions are not; migrated ledger counts as seen', async () => {
  const old = '2026-11-01T00:00:00.000Z', fut = new Date(Date.now() + 60000).toISOString();
  const { page } = await newPage(390, 844, { state: { bank: { lastSync: new Date().toISOString() } } });
  await page.evaluate(([old, fut]) => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1'));
    s.settings.tabSeen = { overview: old, transactions: old, bills: old, plans: old, income: old };
    s.bank.txns = { x1: { id: 'x1', date: '2026-11-10', desc: 'OLD LINE', amount: 5, account: null, status: 'posted' } };   // no `at`: migrated as seen
    s.bank.seen = {
      s1: { res: 'bill', kind: 'bill', src: 'sync', auto: true, at: fut, date: '2026-11-20', amount: 70, desc: 'ELEC', key: 'k' },
      s2: { res: 'bill', kind: 'bill', src: 'sync', auto: false, at: fut, date: '2026-11-20', amount: 70, desc: 'HAND', key: 'k2' },
      s3: { res: 'match', kind: 'plan', src: 'sync', auto: true, at: fut, date: '2026-11-20', amount: 27.65, desc: 'KLARNA', key: 'p' },
      s4: { res: 'income', kind: 'income', src: 'sync', auto: true, at: fut, date: '2026-11-20', amount: -1500, desc: 'PAY', incomeId: 'pay', payDate: '2026-11-19' },
      s5: { res: 'income', kind: 'income', src: 'sync', auto: true, at: fut, date: '2026-11-20', amount: -100, desc: 'PAY2', incomeId: 'pay', payDate: '2026-11-19' },
      s6: { res: 'bill', kind: 'bill', src: 'sync', auto: true, at: old, date: '2026-11-20', amount: 1, desc: 'OLDER', key: 'k3' }
    };
    localStorage.setItem('budtrack.v1', JSON.stringify(s));
  }, [old, fut]);
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(400);
  const r = {}; for (const t of ['transactions', 'bills', 'plans', 'income', 'overview']) r[t] = (await badge(page, t));
  assert.equal(r.transactions.shown, false, 'ledger line without `at` counts as seen');
  assert.equal((await getState(page)).bank.txns.x1.at.slice(0, 4), '2000');
  assert.deepEqual([r.bills.text, r.plans.text, r.income.text, r.overview.shown], ['1', '1', '2', false], JSON.stringify(r));
  await page.context().close();
});

await step('badges: 99+ cap, hidden at 0, backup carries tabSeen, restore keeps it', async () => {
  const { page } = await newPage(390, 844, { state: { bank: { lastSync: new Date().toISOString() } } });
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1')), fut = new Date(Date.now() + 60000).toISOString(); s.bank.txns = {};
    s.bank.inbox = [];
    for (let i = 0; i < 120; i++) { const t = s.bank.txns['z' + i] = { id: 'z' + i, date: new Date().toISOString().slice(0, 10), desc: 'L' + i, amount: 1, account: null, status: 'posted', at: fut }; s.bank.inbox.push({ txn: t, kind: 'spend', cands: [], pick: null, category: 'Other', confidence: 'low' }); }
    s.settings.tabSeen = { overview: fut, transactions: '2026-11-01T00:00:00.000Z', bills: fut, plans: fut, income: fut };
    localStorage.setItem('budtrack.v1', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(400);
  let r = await badge(page, 'transactions'); assert.deepEqual([r.shown, r.text, r.label], [true, '99+', 'Transactions, 120 to review']);
  assert.equal((await badge(page, 'bills')).shown, false);
  const st = await getState(page); assert.ok(st.settings.tabSeen && TABS.every(k => typeof st.settings.tabSeen[k] === 'string'));
  await page.context().close();
});

await step('no horizontal scroll with badges on at 390 / 430, both themes', async () => {
  for (const [w, h] of [[390, 844], [430, 932]]) for (const scheme of ['dark', 'light']) {
    const { page } = await newPage(w, h, { scheme, theme: scheme, txns: THREE, state: { bank: { lastSync: null } } });
    await page.waitForFunction(() => !document.querySelector('.tabs a[href="#transactions"] .badge').hidden);
    for (const t of TABS) { await go(page, t); await noHScroll(page, `${w} ${t} ${scheme}`); }
    const o = await page.evaluate(() => [...document.querySelectorAll('.tabs a')].map(a => { const r = a.getBoundingClientRect(), e = a.querySelector('.badge'); return e.hidden ? null : { in: e.getBoundingClientRect().right <= innerWidth && e.getBoundingClientRect().left >= 0 }; }).filter(Boolean));
    assert.ok(o.every(x => x.in));
    await page.context().close();
  }
});

await b.close();
console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
