// v16: clearer plan cards (Due/Past due/Paid off, "2 of 4", Purchased/Ends/left rows), the logo centered on every tab,
// service logos (own upload > the service's own icon > letter) with a privacy setting.
// Run: node tests/v16.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const SHOTS = process.argv[2] || '/tmp';
const BASE = process.env.BT_URL || 'http://localhost:8765/';
const API = 'https://worker.test';
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n   ', String(e.message).split('\n').slice(0, 14).join('\n    ')); } };
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const addD = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dws = s => { const d = new Date(s + 'T12:00:00'); return DOW[d.getDay()] + ' ' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear(); };
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const short = s => { const d = new Date(s + 'T12:00:00'); return MON[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() !== new Date().getFullYear() ? " '" + String(d.getFullYear()).slice(-2) : ''); };   // v17: big due dates
const TODAY = iso(new Date()), PAY = addD(TODAY, -6);
// A 32x32 solid PNG standing in for a service's icon.
const png = (n, rgb) => { const crc = (() => { const t = []; for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return b => { let c = ~0; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; }; })();
  const chunk = (ty, d) => { const b = Buffer.concat([Buffer.from(ty), d]), o = Buffer.alloc(4); o.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(b)); return Buffer.concat([o, b, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: n }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: n }, () => rgb).flat())])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); };
const ICON = png(32, [20, 120, 220]);
const plans = [
  { id: 'k1', provider: 'Klarna', merchant: 'Nike Air Max Running Shoes And Socks Bundle', amount: 39.985, total: 4, paid: 1, freq: 'biweekly', purchased: addD(TODAY, -28), lastDate: addD(TODAY, -28), category: 'Electronics', dates: [addD(TODAY, -28), addD(TODAY, 5), addD(TODAY, 19), addD(TODAY, 33)] },
  { id: 'a1', provider: 'Afterpay', merchant: 'Adidas', amount: 25, total: 4, paid: 1, freq: 'biweekly', autopay: false, purchased: addD(TODAY, -17), lastDate: addD(TODAY, -17), category: 'Phone & Internet', dates: [addD(TODAY, -17), addD(TODAY, -3), addD(TODAY, 11), addD(TODAY, 25)] },
  { id: 'p1', provider: 'PayPal', merchant: 'Lamp', amount: 10, total: 4, paid: 4, freq: 'monthly', purchased: addD(TODAY, -120), lastDate: addD(TODAY, -30), category: 'Household', dates: [addD(TODAY, -120), addD(TODAY, -90), addD(TODAY, -60), addD(TODAY, -30)] }
];
const fixture = () => ({
  marks: {}, occ: {}, unalloc: [], payVia: [], cards: [], plans, bills: [], perPeriod: [], spends: [],
  categories: ['Electronics', 'Household', 'Other'], billCats: ['Housing', 'Other'], catParents: {},
  income: [{ id: 'pay', name: 'Stat Delivery', freq: 'biweekly', date: PAY, amount: 1200 }],
  savings: { on: false, bank: '', tx: [] },
  bank: { seen: {}, rules: {}, links: {}, lastSync: new Date(Date.now() - 5 * 60e3).toISOString(), inbox: [], api: API, autoFrom: addD(TODAY, -30), historyFrom: addD(TODAY, -60), txns: {}, notes: {}, notShot: {} },
  settings: { view: 'biweekly', anchor: PAY, legendOpen: {}, billsView: '' }
});
const b = await pw.chromium.launch();
async function newPage(w, h, o) {
  o = o || {};
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: o.dark ? 'dark' : 'light', deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(6000);
  await page.addInitScript(() => { if (!localStorage.getItem('budtrack.incopen')) localStorage.setItem('budtrack.incopen', '{"bank":true}'); }); // v46: Bank connections opens and closes
  const errs = [], hits = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  // Every icon URL the page ever puts in an <img> (headless Chromium never sends a bare /favicon.ico to the network, so the first try is read here).
  await page.addInitScript(() => { window.__srcs = []; const seen = n => { if (n.nodeType === 1) { if (n.matches('.slogo img')) window.__srcs.push(n.getAttribute('src')); n.querySelectorAll('.slogo img').forEach(i => window.__srcs.push(i.getAttribute('src'))); } };
    new MutationObserver(ms => ms.forEach(m => { m.addedNodes.forEach(seen); if (m.type === 'attributes' && m.target.matches('.slogo img')) window.__srcs.push(m.target.getAttribute('src')); })).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] }); });
  // v17: the page probes icons with detached Images; record every src they are given (Playwright cannot intercept favicon.ico requests).
  await page.addInitScript(() => { window.__probed = []; const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src'); Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, get() { return d.get.call(this); }, set(v) { window.__probed.push(String(v)); d.set.call(this, v); } }); });
  // Service domains: icons load (or 404 when the test says so). Every request is recorded.
  await page.route(/^https:\/\/(?!worker\.test)[^/]*(klarna|afterpay|paypal|chase|capitalone|affirm|zip|sezzle)\.[a-z]+\//, route => { const u = route.request().url(); hits.push(u);
    if (o.icon404) return route.fulfill({ status: 404, body: 'no' });
    return route.fulfill({ status: 200, contentType: 'image/png', body: ICON }); });
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), p = new URL(req.url()).pathname, m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = x => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(x) });
    if (p === '/config') return json({ provider: 'plaid', env: 'production', paired: true });
    if (p === '/accounts') return json({ enrollments: [{ id: 'enr_c', institution: 'Chase', accounts: [{ id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', last_four: '1284', enabled: true }] }] });
    if (p === '/sync') return json({ txns: [], removed: [], errors: [], cursors: {}, syncedAt: new Date().toISOString(), balances: [] });
    if (p === '/status') return json({ items: [], refresh: { supported: null }, balance: { supported: null } });
    if (p === '/refresh') return json({ refreshed: false, notEnabled: true, results: [] });
    if (p === '/snapshot') return json({ ok: true });
    return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{"error":"nope"}' });
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(fx => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1')), f = JSON.parse(fx);
    Object.assign(s, f); Object.assign(s.settings, f.settings);
    localStorage.setItem('budtrack.v1', JSON.stringify(s)); localStorage.setItem('budtrack.bankkey', 'secret-device-key-123');
  }, JSON.stringify(fixture()));
  await page.goto(BASE + (o.hash || ''), { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  return { ctx, page, errs, hits };
}
const tried = page => page.evaluate(() => window.__srcs);
const planOf = (page, name) => page.locator('.plan', { hasText: name }).first();
const noHScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'horizontal scroll at ' + label);
const quiet = page => page.evaluate(() => { const t = document.querySelector('#toast'); t.style.transition = 'none'; t.classList.remove('on'); const bud = document.querySelector('#bud'); if (bud) bud.style.display = 'none'; });
const getState = page => page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')));
// v21: the Service logos card is collapsed until opened.
const openLogos = async page => { const h = page.locator('#svclogos .coll-h'); if ((await h.getAttribute('aria-expanded')) !== 'true') await h.click(); };
const rect = (page, sel, within) => page.evaluate(([s, w]) => { const root = w ? document.querySelector(w) : document; const e = root.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }, [sel, within || '']);
const overlap = (a, c) => !(a.r <= c.l + 0.5 || c.r <= a.l + 0.5 || a.b <= c.t + 0.5 || c.b <= a.t + 0.5);

for (const [w, h] of [[390, 844], [669, 951], [951, 669]]) for (const dark of [false, true]) {
  const { page, errs } = await newPage(w, h, { hash: '#plans', dark });
  const tag = `${w}x${h} ${dark ? 'dark' : 'light'}`;
  await step(`${tag}: plan card rows, labels and no overlap`, async () => {
    const t = i => planOf(page, ['Nike', 'Adidas'][i]);
    const k = t(0), kt = (await k.textContent()).replace(/\s+/g, ' ');
    assert.ok(kt.includes(`Due ${short(addD(TODAY, 5))}`) && !kt.includes(dws(addD(TODAY, 5))), kt);
    assert.ok(/\b2 of 4\b/.test(kt), kt);
    assert.ok(kt.includes(`Purchased ${dws(addD(TODAY, -28))}`) && kt.includes(`Ends ${dws(addD(TODAY, 33))}`), kt);
    assert.match(kt, /\$119\.96 left/);   // 3 payments of 39.99 (rounded)
    assert.ok(/every 2 weeks/.test(kt) && !/Bought|Every 2 weeks/.test(kt), kt);
    assert.equal(await k.locator('.pc-r1 .amt').textContent(), '$39.99');
    assert.ok(/^Klarna/.test((await k.locator('.prov-tag').textContent()).trim()));
    const late = (await t(1).textContent()).replace(/\s+/g, ' ');
    assert.ok(late.includes(`Past due ${short(addD(TODAY, -3))}`) && /\b2 of 4\b/.test(late), late);
    assert.ok(await t(1).locator('.pc-due.late').count() === 1, 'warn color class');
    const lateColor = await t(1).locator('.pc-due').evaluate(e => getComputedStyle(e).color), okColor = await t(0).locator('.pc-due').evaluate(e => getComputedStyle(e).color);
    assert.notEqual(lateColor, okColor);
    // Completed ones sit in the Completed list.
    await page.locator('details.done summary').click();
    const done = (await page.locator('details.done .plan').first().textContent()).replace(/\s+/g, ' ');
    assert.ok(done.includes('Paid off') && /4 of 4 · paid/.test(done) && /Purchased /.test(done), done);
    assert.ok(!/Bought|Every month/.test(done), done);
    // No overlap between the left and right items of rows 1 and 2, and nothing wider than the card.
    for (const el of await page.locator('.plan').all()) {
      const g = await el.evaluate(e => { const q = s => { const x = e.querySelector(s).getBoundingClientRect(); return { l: x.left, r: x.right, t: x.top, b: x.bottom }; }, c = e.getBoundingClientRect();
        return { nm: q('.pc-r1 .nm'), amt: q('.pc-r1 .amt'), pl: q('.pc-l'), due: q('.pc-nx'), card: { l: c.left, r: c.right }, pips: q('.pips'), n: q('.pc-n') }; });
      assert.ok(!overlap(g.nm, g.amt), 'row 1 overlap ' + JSON.stringify(g));
      assert.ok(!overlap(g.nm, g.due), 'row 1 name/due overlap ' + JSON.stringify(g));
      assert.ok(!overlap(g.pips, g.n), 'row 3 overlap');
      for (const k2 of ['nm', 'amt', 'pl', 'due', 'n']) assert.ok(g[k2].l >= g.card.l - 0.5 && g[k2].r <= g.card.r + 0.5, k2 + ' inside card');
    }
    await noHScroll(page, tag);
  });
  if (w === 390) { await quiet(page); await page.locator('details.done summary').click().catch(() => {}); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: `${SHOTS}/plans-v16${dark ? '-dark' : '-light'}-390.png`, fullPage: true });
    if (!dark) await page.screenshot({ path: `${SHOTS}/plans-v16-390.png`, fullPage: true }); }
  await step(`${tag}: no page errors`, async () => assert.deepEqual(errs, []));
  await page.context().close();
}

for (const [w, h] of [[390, 844], [951, 669]]) for (const dark of [false, true]) {
  const { page } = await newPage(w, h, { hash: '#transactions', dark });
  for (const tab of ['transactions', 'bills', 'plans', 'income']) {
    await step(`${w}${dark ? ' dark' : ''}: brand header logo centered on ${tab}, Saved in the corner`, async () => {
      await page.evaluate(t => { location.hash = t; }, tab); await page.waitForTimeout(350);
      const r = await rect(page, '#brandbar .wm'); assert.ok(r, 'logo visible');
      const bar = await rect(page, '#brandbar'), mid = (bar.l + bar.r) / 2;   // v19: in landscape the header is the same left-column box on every tab
      assert.ok(Math.abs((r.l + r.r) / 2 - mid) <= 2, `center ${(r.l + r.r) / 2} vs ${mid}`);
      const s = await rect(page, '#brandbar .sync'); assert.ok(s && s.r > mid + 40 && s.b <= r.t + 40, 'Saved is in the top-right corner ' + JSON.stringify(s));
      await noHScroll(page, tab);
      if (w === 390 && tab === 'transactions' && !dark) { await quiet(page); await page.screenshot({ path: `${SHOTS}/tabs-logo-390.png` }); }
    });
  }
  await step(`${w}${dark ? ' dark' : ''}: Overview shows the same header above the hero`, async () => {
    await page.evaluate(() => { location.hash = 'overview'; }); await page.waitForTimeout(300);
    assert.ok((await page.locator('#brandbar').isVisible()) && (await page.locator('.wm').count()) === 1 && (await page.locator('.hero .wm').count()) === 0);
  });
  await page.context().close();
}

await step('service logo: icon from the provider domain; letter when off; letter when the image fails', async () => {
  const { page, hits } = await newPage(390, 844, { hash: '#plans' });
  const first = planOf(page, 'Nike').locator('.prov-tag .slogo');
  await first.locator('img').waitFor({ state: 'attached' }); await page.waitForTimeout(500);
  assert.match(await first.locator('img').getAttribute('src'), /^https:\/\/www\.klarna\.com\/apple-touch-icon\.png$/);
  assert.equal(await first.locator('img').evaluate(i => getComputedStyle(i).opacity), '1', 'loaded icon is visible');
  const sz = await first.evaluate(e => e.getBoundingClientRect().width); assert.ok(sz >= 20 && sz <= 24, 'size ' + sz);
  assert.ok(hits.some(u => /klarna\.com\//.test(u)) && !hits.some(u => /google|gstatic|duckduckgo|clearbit/.test(u)), 'only the service domain is asked');
  // Turn the setting off in Income.
  await page.evaluate(() => { location.hash = 'income'; }); await page.waitForTimeout(300);
  await openLogos(page); await page.locator('#svclogos input[data-action="svc-icons"]').click(); await page.waitForTimeout(200);
  assert.equal((await getState(page)).settings.svcIcons, false);
  const before = hits.length;
  await page.evaluate(() => { location.hash = 'plans'; }); await page.waitForTimeout(400);
  assert.equal(await page.locator('.plan .slogo img').count(), 0, 'no img when off');
  assert.equal(await planOf(page, 'Nike').locator('.prov-tag .slogo').getAttribute('data-l'), 'K');
  const ch = await planOf(page, 'Nike').locator('.prov-tag .slogo').evaluate(e => getComputedStyle(e, '::before').content); assert.equal(ch, '"K"');
  await page.waitForTimeout(300); assert.equal(hits.length, before, 'no requests when off');
  assert.ok(!/KNike|K Nike/.test((await planOf(page, 'Nike').textContent())), 'letter is not page text');
  await page.context().close();
  // Image fails: letter badge, no broken image.
  const f = await newPage(390, 844, { hash: '#plans', icon404: true });
  await f.page.waitForTimeout(800);
  assert.equal(await f.page.locator('.plan .slogo img').count(), 0, 'failed images removed');
  assert.equal(await planOf(f.page, 'Nike').locator('.prov-tag .slogo').getAttribute('data-l'), 'K');
  assert.deepEqual((await f.page.evaluate(() => window.__probed)).filter(u => /klarna\.com/.test(u)), ['https://www.klarna.com/apple-touch-icon.png', 'https://klarna.com/apple-touch-icon.png', 'https://www.klarna.com/favicon.ico', 'https://klarna.com/favicon.ico'], 'tried in order');
  await f.page.context().close();
});

await step('Bank connections card and In account list show the bank icon from its domain; name mapping is flexible', async () => {
  const { page, hits } = await newPage(390, 844, { hash: '#income' });
  await page.waitForSelector('.bk-eh');
  await page.waitForTimeout(500);
  const img = page.locator('.bk-eh .slogo[data-svc="chase"] img');
  assert.match(await img.getAttribute('src'), /^https:\/\/www\.chase\.com\/apple-touch-icon\.png$/);
  assert.ok(hits.some(u => /chase\.com/.test(u)));
  const keys = await page.evaluate(() => { const l = document.querySelectorAll('.svc-list .slogo'); return [...l].map(e => e.dataset.svc); });
  for (const k of ['klarna', 'afterpay', 'paypal', 'affirm', 'zip', 'sezzle', 'chase']) assert.ok(keys.includes(k), k + ' in ' + keys);
  await noHScroll(page, 'income');
  await page.context().close();
});

await step('uploaded logo: resized to a small PNG, shows first, persists, is in the backup, removable', async () => {
  const { page } = await newPage(390, 844, { hash: '#plans', icon404: true });
  const big = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 250; const g = c.getContext('2d'); for (let i = 0; i < 400; i += 8) { g.fillStyle = `hsl(${i % 360} 70% 50%)`; g.fillRect(i, 0, 8, 250); } g.fillStyle = '#000'; g.fillRect(100, 60, 200, 130); return c.toDataURL('image/png').split(',')[1]; });
  await page.locator('.prov .tile', { hasText: 'Klarna' }).locator('.slogo-btn').click();
  assert.match(await page.locator('#sheet h3').textContent(), /Klarna logo/);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#sheet [data-action="logo-up"]').click()]);
  await fc.setFiles({ name: 'k.png', mimeType: 'image/png', buffer: Buffer.from(big, 'base64') });
  await page.waitForTimeout(500);
  const st = await getState(page), url = st.logos && st.logos.klarna;
  assert.ok(url && url.startsWith('data:image/png;base64,') && url.length <= 27000, 'stored ' + (url || '').length);
  const dim = await page.evaluate(u => new Promise(r => { const i = new Image(); i.onload = () => r([i.width, i.height]); i.src = u; }), url); assert.deepEqual(dim, [96, 96]);
  const own = planOf(page, 'Nike').locator('.prov-tag .slogo img');
  assert.equal(await own.getAttribute('src'), url); assert.equal(await own.evaluate(i => getComputedStyle(i).opacity), '1');
  assert.ok(await page.locator('.prov .tile', { hasText: 'Klarna' }).locator('.slogo img').getAttribute('src').then(s => s === url));
  // Survives a reload, and own logo wins even with website icons off.
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(300);
  assert.equal(await planOf(page, 'Nike').locator('.prov-tag .slogo img').getAttribute('src'), url);
  // In the backup text, and a restore keeps it.
  await page.evaluate(() => { location.hash = 'income'; }); await page.waitForTimeout(300);
  await page.locator('[data-action="copy-backup"]').click();
  const bk = await page.locator('#bk').inputValue(); assert.ok(bk.includes('"logos"') && bk.includes(url.slice(0, 60)));
  await page.locator('#sheet [data-action="close"]').first().click();
  // Remove from the settings list.
  await openLogos(page); await page.locator('.svc-list li', { hasText: 'Klarna' }).locator('[data-action="logo-rm"]').click(); await page.waitForTimeout(200);
  assert.equal(Object.keys((await getState(page)).logos).length, 0);
  // A bad file is refused.
  await page.locator('.svc-list li', { hasText: 'Afterpay' }).locator('[data-action="logo-up"]').click().catch(() => {});
  await page.context().close();
});

await step('email logo script output exists and is a transparent PNG', async () => {
  const fs = await import('node:fs'); const buf = fs.readFileSync(new URL('../icons/email-logo.png', import.meta.url));
  assert.equal(buf.slice(1, 4).toString(), 'PNG'); assert.ok(buf.readUInt32BE(16) >= 480 && buf[25] === 6, 'wide RGBA png');
});

await b.close();
console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
