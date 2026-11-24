// v17: big due dates on plan cards, brand logos (icon probing, brand-colored letters) for services and merchants.
// Run: node tests/v17.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import assert from 'node:assert/strict';
import { pw, SHOTS, BASE, API, iso, addD, step, finish, prep } from './lib.mjs';
import zlib from 'node:zlib';
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
const ICON = png(32, [20, 120, 220]), ONE = png(1, [255, 255, 255]);
const ICACHE = 'budtrack.icons';
const plans = [
  { id: 'k1', provider: 'Klarna', merchant: 'Nike Air Max Running Shoes And Socks Bundle', amount: 39.985, total: 4, paid: 1, freq: 'biweekly', purchased: addD(TODAY, -28), lastDate: addD(TODAY, -28), category: 'Electronics', dates: [addD(TODAY, -28), addD(TODAY, 5), addD(TODAY, 19), addD(TODAY, 33)] },
  { id: 'a1', provider: 'Afterpay', merchant: 'Adidas', amount: 25, total: 4, paid: 1, freq: 'biweekly', autopay: false, purchased: addD(TODAY, -17), lastDate: addD(TODAY, -17), category: 'Phone & Internet', dates: [addD(TODAY, -17), addD(TODAY, -3), addD(TODAY, 11), addD(TODAY, 25)] },
  { id: 'n1', provider: 'Sezzle', merchant: 'Sectional Couch With A Really Long Merchant Name', amount: 1234.56, total: 4, paid: 1, freq: 'biweekly', purchased: addD(TODAY, -14), lastDate: addD(TODAY, -14), category: 'Household', dates: [addD(TODAY, -14), addD(TODAY, 400), addD(TODAY, 414), addD(TODAY, 428)] },
  { id: 'p1', provider: 'PayPal', merchant: 'Lamp', amount: 10, total: 4, paid: 4, freq: 'monthly', purchased: addD(TODAY, -120), lastDate: addD(TODAY, -30), category: 'Household', dates: [addD(TODAY, -120), addD(TODAY, -90), addD(TODAY, -60), addD(TODAY, -30)] }
];
const CHASE = { institution: 'Chase', last4: '1284', name: 'Checking' };
const T = (id, desc, amount, extra) => Object.assign({ id: 'pl:' + id, date: addD(TODAY, -2), desc, rawDesc: desc, amount, account: CHASE, status: 'posted', pendingOf: null, counterparty: null, providerCategory: null }, extra || {});
const TXNS = [T('dd', 'DD *DOORDASH CHIPOTLE', 23.4), T('ue', 'UBER * EATS HELP.UBER.COM', 31.2), T('ic', 'INSTACART HTTPSINSTACAR', 88.1), T('wm', 'WAL-MART SUPERCENTER #1234', 64.55), T('am', 'AMZN Mktp US*2K4TT8', 19.99),
  T('tm', 'T-MOBILE*PCS SVC', 85), T('eb', 'EBAY COMMERCE INC', 14.25), T('ub', 'UBER *TRIP HELP.UBER.COM', 18.9), T('cc', 'Corner Cafe', 6.5), T('sp', 'PAYPAL *SPOTIFY', 11.99)];
const fixture = (o) => ({
  marks: {}, occ: {}, unalloc: [], payVia: [], cards: [], plans, bills: [], perPeriod: [], spends: [],
  categories: ['Electronics', 'Household', 'Other'], billCats: ['Housing', 'Other'], catParents: {},
  income: [{ id: 'pay', name: 'Stat Delivery', freq: 'biweekly', date: PAY, amount: 1200 }],
  savings: { on: false, bank: '', tx: [] },
  bank: { seen: {}, rules: {}, links: {}, lastSync: new Date(Date.now() - 5 * 60e3).toISOString(), inbox: [], api: API, autoFrom: addD(TODAY, -30), historyFrom: addD(TODAY, -60), txns: Object.fromEntries(((o && o.txns) || []).map(t => [t.id, t])), notes: {}, notShot: {} },
  settings: Object.assign({ view: 'biweekly', anchor: PAY, legendOpen: {}, billsView: '' }, o && o.settings || {}), logos: (o && o.logos) || {}
});
const b = await pw.chromium.launch();
async function newPage(w, h, o) {
  o = o || {};
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: o.dark ? 'dark' : 'light', deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage(); await prep(page);
  const errs = [], hits = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  // Every src given to an image (the page probes icons with detached Images). Playwright cannot intercept bare favicon.ico requests, so these are the only record of them.
  await page.addInitScript(() => { window.__probed = []; const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src'); Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, get() { return d.get.call(this); }, set(v) { window.__probed.push(String(v)); d.set.call(this, v); } }); });
  // Icon hosts: 404 unless the test gives that URL a body. Every request is recorded.
  await page.route(/^https:\/\/(?!worker\.test)[^/]+\/(apple-touch-icon\.png|favicon\.ico)/, route => { const u = route.request().url(); hits.push(u);
    const body = o.icons && o.icons[u]; if (body) return route.fulfill({ status: 200, contentType: 'image/png', body });
    return route.fulfill({ status: 404, body: 'no' }); });
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
  }, JSON.stringify(fixture(o)));
  await page.goto(BASE + (o.hash || ''), { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  page.hits = hits;
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

const probed = (page, re) => page.evaluate(r => [...new Set(window.__probed.filter(u => new RegExp(r).test(u)))], re.source);
const klarnaSlogo = page => page.locator('.prov .tile', { hasText: 'Klarna' }).locator('.slogo').first();
const KURLS = ['https://www.klarna.com/apple-touch-icon.png', 'https://klarna.com/apple-touch-icon.png', 'https://www.klarna.com/favicon.ico', 'https://klarna.com/favicon.ico'];

/* 1. Due date block */
for (const [w, h] of [[390, 844], [669, 951], [951, 669]]) for (const dark of [false, true]) {
  const { page, errs } = await newPage(w, h, { hash: '#plans', dark });
  const tag = `${w}x${h} ${dark ? 'dark' : 'light'}`;
  await step(`${tag}: plan card right block: amount over big "Due NOV 26", same font`, async () => {
    const k = planOf(page, 'Nike'), txt = (await k.textContent()).replace(/\s+/g, ' ');
    assert.equal((await k.locator('.pc-r1 .amt').textContent()).trim(), '$39.99');
    assert.equal((await k.locator('.pc-nx .pc-dd').textContent()).trim(), short(addD(TODAY, 5)));
    assert.ok(/^Due\s+[A-Z]{3} \d{1,2}$/.test((await k.locator('.pc-nx .pc-due').textContent()).replace(/\s+/g, ' ').trim()), 'Due label');
    assert.ok(!/(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d\/\d\d\/\d{4}.*Due|Due (Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(txt), 'old Due format gone: ' + txt);
    assert.equal(await k.locator('.pc-r2 .pc-due').count(), 0, 'row 2 has no due');
    assert.equal((await k.locator('.pc-r2 .tag').count()), 2, 'row 2 keeps the two badges');
    const f = sel => k.locator(sel).evaluate(e => { const c = getComputedStyle(e); return { fs: c.fontSize, ff: c.fontFamily, fw: c.fontWeight }; });
    const a = await f('.pc-r1 .amt'), d = await f('.pc-nx .pc-dd'); assert.deepEqual(d, a); assert.ok(parseFloat(a.fs) >= 18, 'big ' + a.fs);
    const dl = await f('.pc-nx .pc-dl'); assert.ok(parseFloat(dl.fs) < parseFloat(a.fs) * .7, 'Due is small: ' + dl.fs);
    assert.notEqual(await k.locator('.pc-dl').evaluate(e => getComputedStyle(e).color), await k.locator('.pc-dd').evaluate(e => getComputedStyle(e).color), 'Due is muted');
    assert.ok(txt.includes(`Purchased ${dws(addD(TODAY, -28))}`) && txt.includes(`Ends ${dws(addD(TODAY, 33))}`), 'row 4 long format: ' + txt);
  });
  await step(`${tag}: past due, other year, paid off`, async () => {
    const late = planOf(page, 'Adidas'), lt = (await late.locator('.pc-nx').textContent()).replace(/\s+/g, ' ').trim();
    assert.equal(lt, `$25.00Past due ${short(addD(TODAY, -3))}`);
    const ok = await planOf(page, 'Nike').locator('.pc-dd').evaluate(e => getComputedStyle(e).color), bad = await late.locator('.pc-dd').evaluate(e => getComputedStyle(e).color);
    assert.notEqual(ok, bad, 'warning color'); assert.equal(await late.locator('.pc-dd').evaluate(e => getComputedStyle(e).fontSize), await late.locator('.amt').evaluate(e => getComputedStyle(e).fontSize), 'same big size');
    const ny = (await planOf(page, 'Sectional').locator('.pc-dd').textContent()).trim(); assert.match(ny, /^[A-Z]{3} \d{1,2} '\d\d$/); assert.equal(ny, short(addD(TODAY, 400)));
    await page.locator('details.done summary').click();
    const done = planOf(page, 'Lamp'); assert.ok(/Paid off/.test(await done.locator('.pc-nx').textContent()), 'Paid off');
  });
  await step(`${tag}: no overlap in the plan cards`, async () => {
    for (const el of await page.locator('.plan').all()) {
      const g = await el.evaluate(e => { const q = s => { const x = e.querySelector(s).getBoundingClientRect(); return { l: x.left, r: x.right, t: x.top, b: x.bottom }; }, c = e.getBoundingClientRect();
        return { nm: q('.pc-r1 .nm'), nx: q('.pc-nx'), amt: q('.pc-r1 .amt'), dd: e.querySelector('.pc-dd') ? q('.pc-dd') : null, pl: q('.pc-l'), card: { l: c.left, r: c.right }, pips: q('.pips'), n: q('.pc-n') }; });
      assert.ok(!overlap(g.nm, g.nx), 'name vs right block ' + JSON.stringify(g));
      if (g.dd) { assert.ok(g.amt.b <= g.dd.t + 1, 'date sits under the amount'); assert.ok(!overlap(g.amt, g.dd)); }
      assert.ok(!overlap(g.pips, g.n)); for (const k2 of ['nm', 'nx', 'pl', 'n']) assert.ok(g[k2].l >= g.card.l - .5 && g[k2].r <= g.card.r + .5, k2 + ' inside card ' + JSON.stringify(g));
    }
    await noHScroll(page, tag);
  });
  if (w === 390) { await quiet(page); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: `${SHOTS}/plans-v17${dark ? '-dark' : ''}-390.png`, fullPage: true }); }
  await step(`${tag}: no page errors`, async () => assert.deepEqual(errs, []));
  await page.context().close();
}

/* 2. Service icons: probing order, brand fallback, cache */
await step('Klarna: every icon URL 404s -> brand pink letter badge, tried in order, remembered', async () => {
  const { page } = await newPage(390, 844, { hash: '#plans' }); await page.waitForTimeout(700);
  assert.deepEqual(await probed(page, /klarna\.com/), KURLS);
  const k = klarnaSlogo(page);
  assert.equal(await k.locator('img').count(), 0); assert.equal(await k.getAttribute('data-l'), 'K');
  const cs = await k.evaluate(e => { const c = getComputedStyle(e); return [c.backgroundColor, c.color]; }); assert.deepEqual(cs, ['rgb(255, 168, 205)', 'rgb(11, 5, 29)']);
  const c = await page.evaluate(k2 => JSON.parse(localStorage.getItem(k2)), ICACHE); assert.equal(c.klarna.u, '');
  const before = await page.evaluate(() => window.__probed.length);
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(500);
  assert.deepEqual(await probed(page, /klarna\.com/), [], 'no retry after reload');
  assert.equal(await klarnaSlogo(page).evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 168, 205)');
  // Older than 7 days: probe again.
  await page.evaluate(k2 => { const o = JSON.parse(localStorage.getItem(k2)); o.klarna.t = Date.now() - 8 * 864e5; localStorage.setItem(k2, JSON.stringify(o)); }, ICACHE);
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(600);
  assert.deepEqual(await probed(page, /klarna\.com/), KURLS, 'expired -> retried'); void before;
  await page.context().close();
});
await step('Klarna: 1x1 rejected, the next URL that loads is used and remembered for reloads', async () => {
  const { page, hits } = await newPage(390, 844, { hash: '#plans', icons: { 'https://www.klarna.com/apple-touch-icon.png': ONE, 'https://klarna.com/apple-touch-icon.png': ICON } });
  const img = klarnaSlogo(page).locator('img'); await img.waitFor({ state: 'attached' });
  assert.equal(await img.getAttribute('src'), 'https://klarna.com/apple-touch-icon.png'); assert.equal(await img.evaluate(i => getComputedStyle(i).opacity), '1');
  assert.deepEqual(await probed(page, /klarna\.com/), ['https://www.klarna.com/apple-touch-icon.png', 'https://klarna.com/apple-touch-icon.png'], 'stops at the first that loads');
  assert.equal((await page.evaluate(k2 => JSON.parse(localStorage.getItem(k2)), ICACHE)).klarna.u, 'https://klarna.com/apple-touch-icon.png');
  // The icon shows everywhere that service appears (tile + card badge).
  assert.ok((await page.locator('.slogo[data-svc="klarna"] img').count()) >= 2);
  const n = hits.length; await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(600);
  const re = hits.slice(n).filter(u => /klarna/.test(u)); assert.ok(re.length >= 1 && re.every(u => u === 'https://klarna.com/apple-touch-icon.png'), 'only the remembered URL: ' + re.join(','));
  assert.equal(await klarnaSlogo(page).locator('img').getAttribute('src'), 'https://klarna.com/apple-touch-icon.png');
  assert.deepEqual(await probed(page, /klarna\.com/), [], 'no probe after reload');
  await page.context().close();
});
await step('a remembered icon that stops loading falls back to the letter and is forgotten', async () => {
  const { page } = await newPage(390, 844, { hash: '#plans', icons: { 'https://www.klarna.com/apple-touch-icon.png': ICON } });
  await klarnaSlogo(page).locator('img').waitFor({ state: 'attached' });
  await page.route(/www\.klarna\.com\/apple-touch/, r => r.abort()); await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(700);
  assert.equal(await page.locator('.slogo[data-svc="klarna"] img').count(), 0);
  assert.equal(await klarnaSlogo(page).evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 168, 205)');
  await page.context().close();
});
await step('brand colors on letter badges', async () => {
  const { page } = await newPage(390, 844, { hash: '#transactions', txns: TXNS }); await page.waitForTimeout(500);
  const want = { doordash: ['rgb(255, 48, 8)', 'rgb(255, 255, 255)', 'D'], ubereats: ['rgb(6, 193, 103)', 'rgb(0, 0, 0)', 'UE'], walmart: ['rgb(0, 113, 220)', 'rgb(255, 194, 32)', 'W'], amazon: ['rgb(35, 47, 62)', 'rgb(255, 153, 0)', 'a'], tmobile: ['rgb(226, 0, 116)', 'rgb(255, 255, 255)', 'T'], ebay: ['rgb(255, 255, 255)', 'rgb(229, 50, 56)', 'e'] };
  for (const [k, [bg, fg, l]] of Object.entries(want)) {
    const s = page.locator(`.tx .slogo[data-svc="${k}"]`).first(); assert.equal(await s.count(), 1, k);
    assert.deepEqual(await s.evaluate(e => { const c = getComputedStyle(e); return [c.backgroundColor, c.color, e.dataset.l]; }), [bg, fg, l], k);
  }
  await page.context().close();
});

/* 3. Merchant logos on Transactions */
for (const dark of [true, false]) await step(`Transactions rows: logos for known merchants, category icon for unknown (${dark ? 'dark' : 'light'}, 390)`, async () => {
  const { page, errs } = await newPage(390, 844, { hash: '#transactions', dark, txns: TXNS, icons: { 'https://www.doordash.com/apple-touch-icon.png': ICON } }); await page.waitForTimeout(800);
  const row = name => page.locator('.tx', { hasText: name }).first();
  const keyOf = async name => row(name).locator('.slogo').first().getAttribute('data-svc');
  assert.equal(await keyOf('Dd Doordash'), 'doordash'); assert.equal(await keyOf('Uber Eats'), 'ubereats'); assert.equal(await keyOf('Instacart'), 'instacart');
  assert.equal(await keyOf('Wal-Mart'), 'walmart'); assert.equal(await keyOf('Amzn'), 'amazon'); assert.equal(await keyOf('T-mobile'), 'tmobile'); assert.equal(await keyOf('Ebay'), 'ebay');
  assert.equal(await keyOf('Uber Trip'), 'uber', 'plain Uber ride is not Uber Eats'); assert.equal(await keyOf('Spotify'), 'spotify', 'PayPal *Spotify is Spotify');
  const sz = await row('Instacart').locator('.slogo').first().evaluate(e => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }); assert.deepEqual(sz, [28, 28]);
  // logo comes before the name
  const order = await row('Instacart').evaluate(e => { const l = e.querySelector('.slogo').getBoundingClientRect(), n = e.querySelector('.tx-l b').getBoundingClientRect(); return l.right <= n.left + 1; }); assert.ok(order, 'logo before name');
  const cafe = row('Corner Cafe'); assert.equal(await cafe.locator('.slogo[data-svc]').count(), 0); assert.equal(await cafe.locator('.slogo-cat svg').count(), 1, 'neutral category icon');
  assert.equal(await row('Dd Doordash').locator('.slogo img').getAttribute('src'), 'https://www.doordash.com/apple-touch-icon.png', 'real icon replaces the badge');
  // names unchanged
  assert.ok(!/[A-Z]{2}Instacart/.test(await row('Instacart').textContent()));
  await noHScroll(page, 'transactions'); await quiet(page);
  await page.screenshot({ path: `${SHOTS}/${dark ? 'tx-logos-390' : 'tx-logos-light-390'}.png` });
  assert.deepEqual(errs, []); await page.context().close();
});
await step('setting off: letters only, no icon requests; own upload wins; settings list shows merchants found', async () => {
  const mine = 'data:image/png;base64,' + ICON.toString('base64');
  const { page, hits } = await newPage(390, 844, { hash: '#transactions', txns: TXNS, settings: { svcIcons: false }, logos: { instacart: mine } }); await page.waitForTimeout(700);
  assert.equal(await page.locator('.tx .slogo img').count(), 1, 'only the upload');
  assert.equal(await page.locator('.tx', { hasText: 'Instacart' }).locator('.slogo img').getAttribute('src'), mine);
  assert.equal(await page.locator('.tx .slogo[data-svc="doordash"]').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 48, 8)');
  assert.equal(hits.length, 0, 'no icon requests: ' + hits.join(','));
  await page.evaluate(() => { location.hash = 'income'; }); await page.waitForTimeout(400);
  const keys = await page.evaluate(() => [...document.querySelectorAll('.svc-list .slogo')].map(e => e.dataset.svc));
  for (const k of ['doordash', 'ubereats', 'uber', 'instacart', 'walmart', 'amazon', 'tmobile', 'ebay']) assert.ok(keys.includes(k), k + ' in ' + keys);
  assert.ok(keys.indexOf('doordash') < keys.indexOf('klarna'), 'found merchants listed first');
  // Upload for a merchant key from the list, e.g. Walmart
  await openLogos(page);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.svc-list li', { hasText: 'Walmart' }).locator('[data-action="logo-up"]').click()]);
  await fc.setFiles({ name: 'w.png', mimeType: 'image/png', buffer: ICON }); await page.waitForTimeout(500);
  assert.ok((await getState(page)).logos.walmart, 'saved under the walmart key');
  await page.evaluate(() => { location.hash = 'transactions'; }); await page.waitForTimeout(400);
  assert.equal(await page.locator('.tx', { hasText: 'Wal-Mart' }).locator('.slogo img').count(), 1);
  await page.context().close();
});

/* 4. Tab logo: superseded in v18 by the shared brand header (tests/v18.e2e.mjs). */

await b.close();
finish();
