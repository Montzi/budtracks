// "Add from screenshot": paste or pick bank-app screenshots, the Worker's /scan (mocked) reads them, review and add them as
// spending; the bank's own transactions then link to those entries instead of counting twice (pending -> posted keeps the
// link), a tip-changed amount waits in Review with a suggestion, Undo keeps the entry, and the Worker's errors read plainly.
// Run: node tests/screenshots.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import assert from 'node:assert/strict';
import { pw, SHOTS, BASE, API, iso, addD, step, finish, prep, R, synced } from './lib.mjs';

const TODAY = iso(new Date()), PAY = addD(TODAY, -6);
const D1 = addD(TODAY, -1), D2 = addD(TODAY, -2), D3 = addD(TODAY, -3), D4 = addD(TODAY, -4);

// What /scan "reads" off two screenshots: a Chase-style list and a Capital One one.
const SCAN = () => ({ bank: 'Capital One', usage: { input_tokens: 2210, output_tokens: 530 }, transactions: [
  { merchant: 'DD *DOORDASH', amount: 16.2, direction: 'out', date: TODAY, pending: true, kind: 'purchase', running_balance: null, account_hint: null },
  { merchant: 'DURANLAUNDROMA', amount: 32.32, direction: 'out', date: D2, pending: false, kind: 'purchase', running_balance: 812.4, account_hint: null },
  { merchant: 'DURANLAUNDROMA', amount: 23.98, direction: 'out', date: D2, pending: false, kind: 'purchase', running_balance: 844.72, account_hint: null },
  { merchant: 'SQ *EL MESON R', amount: 23.54, direction: 'out', date: null, pending: false, kind: 'purchase', running_balance: null, account_hint: null },
  { merchant: 'UBER * EATS', amount: 35.35, direction: 'out', date: TODAY, pending: true, kind: 'purchase', running_balance: null, account_hint: null },
  { merchant: 'PAYPAL to Ana Lopez', amount: 7.99, direction: 'out', date: D4, pending: false, kind: 'transfer', running_balance: 1204.11, account_hint: '360 Checking ...1284' },
  { merchant: 'KLARNA', amount: 27.65, direction: 'out', date: D4, pending: false, kind: 'transfer', running_balance: 1212.1, account_hint: '360 Checking ...1284' },
  { merchant: 'STAT DELIVERY', amount: 612.5, direction: 'in', date: D4, pending: false, kind: 'deposit', running_balance: 1239.75, account_hint: '360 Checking ...1284' }
] });
const ADDED = 16.2 + 32.32 + 23.98 + 23.54 + 35.35;
const CHASE = { id: 'chk', name: 'Checking', last4: '1284', institution: 'Chase', type: 'depository' };
const T = (id, date, desc, amount, extra) => Object.assign({ id: 'pl:' + id, date, desc, rawDesc: desc, amount, account: CHASE, status: 'posted', pendingOf: null, counterparty: null, providerCategory: null }, extra || {});
// The bank's copies, a day or two later: DoorDash still pending, Uber Eats posted with a tip.
const BANK1 = () => [
  T('ddp', TODAY, 'DoorDash', 16.2, { rawDesc: 'DD *DOORDASH 855-973-1040 CA', status: 'pending' }),
  T('la1', D1, 'DURAN LAUNDROMAT', 32.32), T('la2', D1, 'DURAN LAUNDROMAT', 23.98),
  T('mes', D2, 'El Meson Restaurant', 23.54, { rawDesc: 'SQ *EL MESON R' }),
  T('ube', TODAY, 'Uber Eats', 41.35, { rawDesc: 'UBER * EATS PENDING' }),
  T('sh', D1, 'SHELL OIL 5521', 32.32)
];
const BANK2 = () => [T('ddpost', D1, 'DoorDash', 16.2, { rawDesc: 'DD *DOORDASH 855-973-1040 CA', pendingOf: 'pl:ddp' })];
const fixture = () => ({
  since: addD(TODAY, -20), marks: {}, occ: {}, unalloc: [], payVia: [], spends: [], cards: [], plans: [],
  categories: ['Groceries', 'Gas', 'Takeout Food', 'Dining Out', 'Laundry', 'Other'], billCats: ['Housing', 'Subscriptions', 'Other'],
  catParents: { Groceries: 'Food', Gas: 'Transportation', 'Takeout Food': 'Food', 'Dining Out': 'Food', Laundry: 'Home' },
  income: [{ id: 'pay', name: 'Stat Delivery', freq: 'biweekly', date: PAY, amount: 1200 }],
  bills: [{ id: 'rent', name: 'Rent', amount: 900, day: +addD(TODAY, 3).slice(8), group: 'Fixed', category: 'Housing', active: true }],
  perPeriod: [], savings: { on: false, bank: '', tx: [] },
  bank: { seen: {}, rules: {}, links: {}, lastSync: null, inbox: [], api: API, autoFrom: addD(TODAY, -30), historyFrom: addD(TODAY, -60), txns: {} },
  settings: { view: 'biweekly', anchor: PAY, legendOpen: {}, billsView: '', chartRange: 'cycle' }
});

const b = await pw.chromium.launch();
async function newPage(w, h, o) {
  o = o || {};
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: o.dark ? 'dark' : 'light', deviceScaleFactor: 1 });
  const page = await ctx.newPage(); await prep(page);
  const errs = [], calls = [];
  const mock = { txns: [], removed: [], scan: SCAN(), scanErr: null, scanDelay: 400 };
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ m, p, q: u.search, body: p === '/scan' ? req.postDataJSON() : null, auth: req.headers().authorization });
    const json = (x, status) => route.fulfill({ status: status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(x) });
    if (p === '/config') return json({ provider: 'plaid', env: 'production', paired: true });
    if (p === '/accounts') return json({ enrollments: [{ id: 'enr_c', institution: 'Chase', accounts: [{ id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', last_four: '1284', enabled: true }] }] });
    if (p === '/sync') return json({ txns: mock.txns, removed: mock.removed, errors: [], cursors: {}, syncedAt: new Date().toISOString(), balances: [{ itemId: 'enr_c', institution: 'Chase', accounts: [{ id: 'chk', name: 'Checking', mask: '1284', type: 'depository', subtype: 'checking', available: 900, current: 900, limit: null, currency: 'USD', enabled: true }] }] });
    if (p === '/scan' && m === 'POST') {
      await new Promise(r => setTimeout(r, mock.scanDelay));
      return mock.scanErr ? json({ error: mock.scanErr.error }, mock.scanErr.status) : json(mock.scan);
    }
    if (p === '/status') return json({ items: [], refresh: { supported: null }, balance: { supported: null } });
    if (p === '/refresh') return json({ refreshed: false, notEnabled: true, results: [] });
    if (p === '/snapshot') return json({ ok: true });
    return json({ error: 'nope' }, 404);
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(fx => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1')), f = JSON.parse(fx);
    Object.assign(s, f); Object.assign(s.settings, f.settings);
    localStorage.setItem('budtrack.v1', JSON.stringify(s)); localStorage.setItem('budtrack.bankkey', 'secret-device-key-123');
  }, JSON.stringify(fixture()));
  await page.evaluate(h => history.replaceState(null, '', location.pathname + h), o.hash || ''); await page.reload({ waitUntil: 'load' }); // one load: see v12
  await synced(page);
  await page.waitForTimeout(250);
  return { ctx, page, errs, mock, calls };
}
const noHScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'horizontal scroll at ' + label);
const sheetNoHScroll = async (page, label) => assert.ok(await page.evaluate(() => { const s = document.querySelector('#sheet .sheet'); return s && s.scrollWidth <= s.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; }), 'sheet scrolls sideways at ' + label);
const quiet = page => page.evaluate(() => { const t = document.querySelector('#toast'); t.style.transition = 'none'; t.classList.remove('on'); const bud = document.querySelector('#bud'); if (bud) bud.style.display = 'none'; });
const getState = page => page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')));
const waitToast = (page, rx) => page.waitForFunction(r => new RegExp(r).test(document.querySelector('#toast').innerText), rx.source, { timeout: 8000 });
const money = s => +String(s).replace(/[^0-9.-]/g, '');
const spentSoFar = async page => { if (!/#overview|^[^#]*$/.test(page.url())) { await page.goto(BASE + '#overview'); } await page.waitForSelector('.hs-tap dd'); return money(await page.locator('.hs-tap dd').first().innerText()); };
// A PNG made in the page (w x h), pasted with a synthetic ClipboardEvent the way iOS Safari / Chrome deliver one.
const pastePng = (page, w, h) => page.evaluate(async ([w, h]) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, w, h); g.fillStyle = '#123'; g.font = '40px sans-serif'; g.fillText('DD *DOORDASH  -$16.20', 30, 120);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
  const box = document.querySelector('#shotpaste'); box.focus();
  box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, [w, h]);
const pngBuffer = async (page, w, h) => Buffer.from(await page.evaluate(async ([w, h]) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = '#004977'; g.fillRect(0, 0, w, h);
  return c.toDataURL('image/png').split(',')[1];
}, [w, h]), 'base64');
// Long edge of a base64 JPEG, decoded in the page.
const jpegSize = (page, data) => page.evaluate(d => new Promise(ok => { const i = new Image(); i.onload = () => ok([i.naturalWidth, i.naturalHeight]); i.src = 'data:image/jpeg;base64,' + d; }), data);

/* ---------- 1. Screenshot -> review -> add -> bank links ---------- */
{
  const { ctx, page, errs, mock, calls } = await newPage(390, 844, { dark: true, hash: '#overview' });
  const before = await spentSoFar(page);
  await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx-card');

  await step('Transactions header: camera, + and sync icon buttons (no Screenshot text, no Sync chip), fit at 390', async () => {
    const hdr = page.locator('.tx-card .card-h .tx-hb > button.icon-btn');
    assert.deepEqual(await hdr.evaluateAll(bs => bs.map(b => b.dataset.action)), ['shot-open', 'add', 'bk-sync']);
    assert.deepEqual(await hdr.evaluateAll(bs => bs.map(b => b.getAttribute('aria-label'))), ['Add from photo or screenshot', 'Add spending', 'Sync']);
    assert.doesNotMatch(await page.locator('.tx-card .card-h').innerText(), /Screenshot/i);
    assert.equal(await page.locator('.tx-chips [data-action="bk-sync"]').count(), 0);
    const bx = await hdr.evaluateAll(bs => bs.map(b => { const r = b.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
    bx.forEach(([, , w, h]) => assert.ok(w >= 39.9 && h >= 39.9 && Math.abs(w - h) < 1, 'tap target ' + w + 'x' + h));
    assert.ok(bx[0][0] + bx[0][2] <= bx[1][0] && bx[1][0] + bx[1][2] <= bx[2][0], 'buttons do not overlap');
    const [hb, card, h2] = await Promise.all([page.locator('.tx-hb').boundingBox(), page.locator('.tx-card').boundingBox(), page.locator('.tx-card .card-h .tx-sum-b').boundingBox()]); // v49: Spent this pay cycle replaced the title
    assert.ok(hb.x + hb.width <= card.x + card.width + 0.5, 'header buttons inside the card');
    assert.ok(h2.x + h2.width <= hb.x, 'Spent this pay cycle clear of the buttons');
    await noHScroll(page, 'transactions 390');
  });
  await step('+ opens the one-time spending form', async () => {
    await page.click('.tx-card .card-h [data-action="add"]'); await page.waitForSelector('#sheet:not([hidden]) form');
    assert.match(await page.locator('#sheet').innerText(), /one-time spending/i);
    await page.keyboard.press('Escape'); await page.evaluate(() => { const s = document.querySelector('#sheet'); if (!s.hidden) document.querySelector('#sheet [data-action="close"]').click(); });
    await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  });
  await step('Chips: four equal widths and identical tops; spent row on one line with the switch', async () => {
    const m = await page.$$eval('.tx-chips > button', bs => bs.map(b => { const r = b.getBoundingClientRect(); return [r.width, r.top, r.height]; }));
    assert.equal(m.length, 4);
    m.forEach(x => { assert.ok(Math.abs(x[0] - m[0][0]) <= 1, 'equal width ' + m.map(y => y[0])); assert.equal(Math.round(x[1]), Math.round(m[0][1])); assert.ok(Math.abs(x[2] - m[0][2]) <= 1); });
    const row = await page.$eval('.tx-chips', el => { const r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect(); return [r.width, p.width, el.scrollWidth <= el.clientWidth + 1]; });
    assert.ok(row[0] > row[1] - 24 && row[2], 'fills the width, no inner scroll');
    const [sb, seg] = await Promise.all([page.locator('.tx-sum-b').boundingBox(), page.locator('.tx-sum .tx-rg1:visible, .tx-sum .seg:visible').boundingBox()]);
    assert.ok(sb.x + sb.width <= seg.x, 'amount and switch do not collide');
  });

  await step('Scan sheet: paste a PNG (synthetic paste event) and pick one from Photos (file input)', async () => {
    await page.click('.tx-card [data-action="shot-open"]');
    await page.waitForSelector('#shotzone');
    assert.deepEqual((await page.locator('.shot-pick .btn').allInnerTexts()).map(t => t.trim()), ['Paste', 'Take photo', 'Choose from Photos']);
    assert.equal(await page.getAttribute('#shotcam', 'capture'), 'environment');
    assert.equal(await page.getAttribute('#shotcam', 'accept'), 'image/*');
    assert.equal(await page.getAttribute('#shotpaste', 'contenteditable'), 'true');
    assert.equal(await page.getAttribute('#shotfile', 'accept'), 'image/*');
    assert.notEqual(await page.getAttribute('#shotfile', 'multiple'), null);
    assert.ok(await page.locator('[data-action="shot-read"]').isDisabled(), 'nothing to read yet');
    await pastePng(page, 1170, 2532);
    await page.waitForSelector('.shot-thumbs li');
    assert.equal(await page.locator('.shot-thumbs li').count(), 1, 'one paste adds one image');
    await page.setInputFiles('#shotfile', { name: 'capone.png', mimeType: 'image/png', buffer: await pngBuffer(page, 600, 900) });
    await page.waitForFunction(() => document.querySelectorAll('.shot-thumbs li').length === 2);
    assert.match(await page.locator('[data-action="shot-read"]').innerText(), /Read 2 screenshots/);
    await sheetNoHScroll(page, 'scan sheet 390');
    await quiet(page);
    await page.screenshot({ path: SHOTS + '/scan-sheet-390.png' });
  });

  await step('Read: spinner, then one /scan with two downscaled JPEGs, today and tz, Bearer key', async () => {
    await page.click('[data-action="shot-read"]');
    await page.waitForSelector('.shot-busy');
    assert.match(await page.locator('.shot-busy').innerText(), /Reading screenshot…/);
    await page.waitForSelector('.shot-list');
    const sc = calls.filter(c => c.p === '/scan');
    assert.equal(sc.length, 1);
    const bd = sc[0].body;
    assert.equal(sc[0].auth, 'Bearer secret-device-key-123');
    assert.equal(bd.today, TODAY); assert.ok(typeof bd.tz === 'string' && bd.tz.length > 0);
    assert.equal(bd.images.length, 2);
    for (const im of bd.images) { assert.equal(im.media_type, 'image/jpeg'); assert.match(im.data, /^[A-Za-z0-9+/]+=*$/); assert.ok(!im.data.startsWith('data:')); }
    const [w, h] = await jpegSize(page, bd.images[0].data);
    assert.equal(Math.max(w, h), 1568, 'long edge scaled to 1568'); assert.equal(Math.round(1170 * 1568 / 2532), w);
    assert.deepEqual(await jpegSize(page, bd.images[1].data), [600, 900], 'small images keep their size');
    const s = await getState(page);
    assert.ok(!JSON.stringify(s).includes(bd.images[0].data.slice(0, 200)), 'images are not stored');
  });

  await step('Review: purchases checked, transfers and the deposit unchecked; categories, date? and pending tags; bank name', async () => {
    assert.match(await page.locator('#sheet .sheet-h').innerText(), /Review 8 transactions[\s\S]*From Capital One/);
    const rows = await page.$$eval('.shot-row', rs => rs.map(r => ({ m: r.querySelector('.shot-m').value, on: r.querySelector('.shot-on').checked, cat: r.querySelector('select').value, tags: r.querySelector('.shot-r2').textContent, date: r.querySelector('input[type=date]').value })));
    const by = m => rows.find(r => r.m.toLowerCase() === m.toLowerCase()) || assert.fail('no row ' + m + ' in ' + JSON.stringify(rows.map(r => r.m)));
    assert.deepEqual(rows.filter(r => r.on).map(r => r.m), ['DoorDash', 'Duranlaundroma', 'Duranlaundroma', 'El Meson R', 'Uber Eats']);
    assert.equal(by('DoorDash').cat, 'Takeout Food'); assert.equal(by('Uber Eats').cat, 'Takeout Food');
    assert.equal(rows.filter(r => r.m === 'Duranlaundroma').every(r => r.cat === 'Laundry'), true);
    assert.equal(by('El Meson R').cat, 'Dining Out');
    assert.match(by('El Meson R').tags, /date\?/i); assert.equal(by('El Meson R').date, TODAY);
    assert.match(by('DoorDash').tags, /Pending/); assert.match(by('Uber Eats').tags, /Pending/);
    assert.match(by('Paypal To Ana Lopez').tags, /Transfer/); assert.match(by('Klarna').tags, /Transfer/);
    assert.match(by('Stat Delivery').tags, /Money in/);
    assert.match(await page.locator('#shotadd').innerText(), /Add 5/);
    await sheetNoHScroll(page, 'review 390');
    await quiet(page);
    await page.screenshot({ path: SHOTS + '/scan-review-390.png' });
  });

  await step('Add 5: spends with a shot marker and clean notes; Spent so far goes up; tags shown', async () => {
    // A note typed on one row is kept; the others stay empty.
    await page.fill('.shot-row:nth-child(4) input[data-shot="note"]', 'Lunch with Rosa');
    await page.click('#shotadd');
    await waitToast(page, /Added 5 transactions from screenshot/);
    const s = await getState(page);
    const sh = s.spends.filter(x => x.shot);
    assert.equal(sh.length, 5);
    assert.deepEqual(sh.map(x => [x.desc, x.amount, x.category]), [['DoorDash', 16.2, 'Takeout Food'], ['Duranlaundroma', 32.32, 'Laundry'], ['Duranlaundroma', 23.98, 'Laundry'], ['El Meson R', 23.54, 'Dining Out'], ['Uber Eats', 35.35, 'Takeout Food']]);
    assert.deepEqual(sh.map(x => x.note), ['', '', '', 'Lunch with Rosa', '']);
    assert.ok(sh.every(x => x.shot.bank === 'Capital One' && x.shot.at && !x.bank));
    assert.equal(sh[0].shot.pending, true); assert.equal(sh[0].shot.rawMerchant, 'DD *DOORDASH');
    const after = await spentSoFar(page);
    assert.equal(Math.round((after - before) * 100), Math.round(ADDED * 100), `spent ${before} -> ${after}`);
    assert.ok(await page.locator('.shot-ic').count() >= 5, 'photo icons in the overview list (v21: no "waiting for bank" chip)');
    assert.doesNotMatch(await page.locator('#main').innerText(), /waiting for bank/i);
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.shot-wait');
    assert.equal(await page.locator('.shot-wait .shot-w').count(), 5);
    await noHScroll(page, 'transactions waiting 390');
  });

  await step('Sync: the bank copies link to the screenshot entries, no duplicates; a tip-changed one waits in Review', async () => {
    mock.txns = BANK1();
    const spentBefore = await spentSoFar(page);
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx-card');
    await page.click('.tx-card [data-action="bk-sync"]');
    await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('budtrack.v1')).bank.seen).length >= 4, null, { timeout: 12000 });
    await page.waitForTimeout(400);
    const s = await getState(page);
    const shotSeen = Object.entries(s.bank.seen).filter(([, r]) => r.src === 'shot').map(([id]) => id).sort();
    assert.deepEqual(shotSeen, ['pl:ddp', 'pl:la1', 'pl:la2', 'pl:mes']);
    assert.equal(s.spends.length, 5, 'no spend added for linked lines');
    const sp = id => s.spends.find(x => x.id === s.bank.seen[id].spendId);
    assert.equal(sp('pl:la1').amount, 32.32); assert.equal(sp('pl:la2').amount, 23.98);
    assert.equal(sp('pl:ddp').bank, 'pl:ddp'); assert.equal(sp('pl:mes').category, 'Dining Out'); assert.equal(sp('pl:mes').note, 'Lunch with Rosa');
    assert.ok(!s.bank.seen['pl:sh'], 'Shell (same amount as the laundromat) is not linked');
    const inbox = s.bank.inbox.map(x => x.txn.id).sort();
    assert.deepEqual(inbox, ['pl:sh', 'pl:ube']);
    assert.equal(s.spends.find(x => x.desc === 'Uber Eats').bank, undefined);
    // Spent so far: only Shell is new (to review); Uber Eats is the screenshot entry already counted.
    const after = await spentSoFar(page);
    assert.equal(Math.round((after - spentBefore) * 100), 3232, `spent ${spentBefore} -> ${after}`);
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx');
    assert.equal(await page.locator('.tx:has-text("Duran Laundromat") .txc:has-text("Matched with bank")').count(), 2);
    assert.equal(await page.locator('.shot-wait .shot-w').count(), 1, 'only Uber Eats still waits');
    await noHScroll(page, 'transactions matched 390');
    await page.goto(BASE + '#overview'); await page.waitForSelector('.hs-tap dd');
    assert.ok(await page.locator('.tag.shot.ok:has-text("Matched with bank")').count() >= 4);
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx');
    await quiet(page);
    await page.screenshot({ path: SHOTS + '/scan-matched-390.png' });
  });

  await step('Pending -> posted keeps the link (no duplicate)', async () => {
    mock.txns = BANK2(); mock.removed = ['pl:ddp'];
    await page.click('.tx-card [data-action="bk-sync"]');
    await page.waitForFunction(() => !!JSON.parse(localStorage.getItem('budtrack.v1')).bank.seen['pl:ddpost'], null, { timeout: 12000 });
    const s = await getState(page);
    assert.equal(s.bank.seen['pl:ddp'], undefined);
    assert.equal(s.bank.seen['pl:ddpost'].src, 'shot');
    const x = s.spends.find(z => z.id === s.bank.seen['pl:ddpost'].spendId);
    assert.equal(x.bank, 'pl:ddpost'); assert.equal(x.amount, 16.2); assert.equal(x.desc, 'DoorDash');
    assert.equal(s.spends.length, 5);
    assert.ok(!s.bank.inbox.some(z => /^pl:dd/.test(z.txn.id)));
    mock.removed = [];
  });

  await step('Review suggestion: "Matches your screenshot entry Uber Eats $35.35 (bank $41.35)" -> Link and use bank amount', async () => {
    const spentBefore = await spentSoFar(page);
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx');
    await page.click('#txreview [data-action="ix-open"]');
    await page.waitForSelector('.shot-sg');
    assert.match(await page.locator('.shot-sg').innerText(), /Matches your screenshot entry Uber Eats \$35\.35 \(bank \$41\.35\)/);
    assert.equal(await page.locator('.shot-sg [data-action="shot-no"]').innerText(), 'Not the same');
    await sheetNoHScroll(page, 'review suggestion 390');
    await page.click('.shot-sg [data-action="shot-link"]');
    await waitToast(page, /Linked/);
    const s = await getState(page);
    assert.equal(s.bank.seen['pl:ube'].src, 'shot');
    const x = s.spends.find(z => z.desc === 'Uber Eats');
    assert.equal(x.amount, 41.35); assert.equal(x.bank, 'pl:ube'); assert.equal(s.spends.length, 5);
    assert.ok(!s.bank.inbox.some(z => z.txn.id === 'pl:ube'));
    await page.click('[data-action="close"]').catch(() => {});
    const after = await spentSoFar(page);
    assert.equal(Math.round((after - spentBefore) * 100), 600, 'the tip is added once');
  });

  await step('Undo keeps the screenshot entry (unlinked, its own amount back) and never re-links that bank line', async () => {
    await page.goto(BASE + '#transactions'); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.tx');
    await page.waitForFunction(() => document.querySelector('#sheet').hidden);
    await page.click('[data-action="tx-filter"][data-f="all"]');
    await page.click('.tx[data-id="pl:ube"] [data-action="tx-open"]');
    await page.click('.tx[data-id="pl:ube"] [data-action="tx-undo"]');
    await waitToast(page, /Undone/);
    let s = await getState(page);
    const x = s.spends.find(z => z.desc === 'Uber Eats');
    assert.ok(x, 'entry kept'); assert.equal(x.amount, 35.35); assert.equal(x.bank, undefined); assert.ok(x.shot);
    assert.equal(s.bank.seen['pl:ube'], undefined);
    assert.ok(s.bank.inbox.some(z => z.txn.id === 'pl:ube'), 'bank line back in Review');
    assert.deepEqual(s.bank.notShot['pl:ube'], [x.id]);
    // An automatic link undone from "Recently synced": the laundromat entry stays too.
    await page.click('#txreview [data-action="ix-open"]');
    await page.waitForSelector('.bx-rec');
    const li = page.locator('.bx-rec li:has-text("Laundry") [data-action="ix-undo"]').first();
    await li.click();
    s = await getState(page);
    assert.equal(s.spends.filter(z => z.category === 'Laundry').length, 2);
    assert.equal(Object.values(s.bank.seen).filter(r => r.src === 'shot').length, 3);
    // A later sync (same lines again) does not link the undone ones back.
    mock.txns = [...BANK1().filter(t => t.id !== 'pl:ddp'), ...BANK2()];
    // The first [data-action="close"] is the backdrop under the sheet; press Escape to close instead.
    await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
    await page.click('.tx-card [data-action="bk-sync"]');
    await page.waitForTimeout(900);
    s = await getState(page);
    assert.equal(Object.values(s.bank.seen).filter(r => r.src === 'shot').length, 3);
    assert.equal(s.spends.length, 5);
  });

  await step('Spending sheet: "Add from screenshot" link opens the scan sheet', async () => {
    await page.goto(BASE + '#overview'); await page.waitForSelector('.hs-tap dd');
    await page.waitForFunction(() => document.querySelector('#sheet').hidden);
    await page.click('.ov-bills [data-action="add"][data-type="extra"]');
    await page.waitForSelector('#sheet [data-action="shot-open"]'); // the link sits above the form, not inside it
    const top = await page.$eval('#form', f => f.previousElementSibling && f.previousElementSibling.matches('.shot-link, .kind-seg'));
    assert.ok(top !== null);
    await page.click('[data-action="shot-open"]');
    await page.waitForSelector('#shotzone');
    await page.click('[data-action="shot-cancel"]');
  });

  await step('Errors read plainly: 503 not set up, 429 daily limit, 422 / 502 unreadable', async () => {
    const tryOne = async (status, error, rx) => {
      mock.scanErr = { status, error }; mock.scanDelay = 50;
      // Start each case from a fresh sheet so the screenshot kept from the last error doesn't add up.
      if (await page.isVisible('#shotzone')) { await page.click('[data-action="shot-cancel"]'); await page.waitForFunction(() => document.querySelector('#sheet').hidden); }
      { await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx-card'); await page.waitForFunction(() => document.querySelector('#sheet').hidden); await page.click('.tx-card [data-action="shot-open"]'); }
      await page.waitForSelector('#shotzone');
      await pastePng(page, 300, 500);
      await page.waitForSelector('.shot-thumbs li');
      await page.click('[data-action="shot-read"]');
      await page.waitForFunction(r => new RegExp(r).test(document.querySelector('#shoterr').innerText), rx.source);
      assert.equal(await page.locator('.shot-thumbs li').count(), 1, 'screenshot kept to try again');
    };
    await tryOne(503, "Screenshot reading isn't set up yet", /isn't set up yet/);
    await tryOne(429, 'daily limit', /today's limit/);
    await tryOne(422, 'Could not read this screenshot', /Couldn't read this screenshot/);
    await tryOne(502, 'Could not read this screenshot clearly', /Couldn't read this screenshot clearly/);
    await sheetNoHScroll(page, 'error 390');
    mock.scanErr = null;
    await page.click('[data-action="shot-cancel"]');
  });

  await step('no page errors (390 dark)', async () => assert.deepEqual(errs, []));
  await ctx.close();
}

/* ---------- 2. Light theme, 951 and 390: layout, duplicates flagged ---------- */
for (const [w, h] of [[951, 669], [390, 844]]) {
  const { ctx, page, errs, mock } = await newPage(w, h, { hash: '#transactions' });
  await step(`light ${w}: scan + review fit, duplicate rows unchecked "Already in BudTracks"`, async () => {
    // Already in BudTracks: Uber Eats typed by hand, and the DoorDash bank line synced.
    await page.evaluate(([today]) => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.spends.push({ id: 'm1', category: 'Takeout Food', desc: 'Uber Eats', amount: 35.35, date: today, note: '' }); localStorage.setItem('budtrack.v1', JSON.stringify(s)); }, [TODAY]);
    await page.reload({ waitUntil: 'load' });
    mock.txns = [T('ddp', TODAY, 'DoorDash', 16.2, { rawDesc: 'DD *DOORDASH', status: 'pending' })];
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx-card');
    await page.click('.tx-card [data-action="bk-sync"]');
    await page.waitForFunction(() => !!JSON.parse(localStorage.getItem('budtrack.v1')).bank.txns['pl:ddp']);
    await noHScroll(page, 'transactions ' + w);
    await page.click('.tx-card [data-action="shot-open"]');
    await pastePng(page, 800, 1600);
    await page.waitForSelector('.shot-thumbs li');
    await sheetNoHScroll(page, 'scan ' + w);
    if (w === 951) await page.screenshot({ path: SHOTS + '/scan-sheet-951.png' });
    await page.click('[data-action="shot-read"]');
    await page.waitForSelector('.shot-list');
    const rows = await page.$$eval('.shot-row', rs => rs.map(r => ({ m: r.querySelector('.shot-m').value, on: r.querySelector('.shot-on').checked, tags: r.querySelector('.shot-r2').textContent })));
    const dupes = rows.filter(r => /Already in BudTracks/.test(r.tags)).map(r => r.m);
    assert.deepEqual(dupes, ['DoorDash', 'Uber Eats']);
    assert.ok(rows.filter(r => dupes.includes(r.m)).every(r => !r.on));
    assert.match(await page.locator('#shotadd').innerText(), /Add 3/);
    await sheetNoHScroll(page, 'review ' + w);
    await noHScroll(page, 'review page ' + w);
    if (w === 951) await page.screenshot({ path: SHOTS + '/scan-review-951.png' });
    else await page.screenshot({ path: SHOTS + '/scan-review-390-light.png' });
  });
  await step(`no page errors (light ${w})`, async () => assert.deepEqual(errs, []));
  await ctx.close();
}

/* ---------- 3. v15: one-tap Paste, Take photo, receipts ---------- */
{
  const { ctx, page, errs, mock, calls } = await newPage(390, 844, { dark: false, hash: '#transactions' });
  // Stubs navigator.clipboard.read: a PNG ClipboardItem, nothing, or a thrown NotAllowedError.
  const stubClip = (mode) => page.evaluate(async (mode) => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 500; c.getContext('2d').fillRect(0, 0, 300, 500);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: async () => {
      if (mode === 'throw') throw new DOMException('denied', 'NotAllowedError');
      if (mode === 'empty') return [{ types: ['text/plain'], getType: async () => new Blob(['hi'], { type: 'text/plain' }) }];
      return [{ types: ['image/png'], getType: async () => blob }];
    } } });
  }, mode);
  const openScanSheet = async () => { await page.click('.tx-card [data-action="shot-open"]'); await page.waitForSelector('#shotzone'); };
  await step('camera button opens the scan sheet; Take photo input uses the rear camera', async () => {
    await openScanSheet();
    assert.equal(await page.getAttribute('#shotcam', 'capture'), 'environment');
    assert.equal(await page.locator('#shotcam').getAttribute('multiple'), null);
    assert.match(await page.locator('#sheet h3').first().innerText(), /photo or screenshot/i);
    await page.setInputFiles('#shotcam', { name: 'IMG_1.jpg', mimeType: 'image/jpeg', buffer: await pngBuffer(page, 400, 600) });
    await page.waitForSelector('.shot-thumbs li');
    assert.equal(await page.locator('.shot-thumbs li').count(), 1);
    await page.click('[data-action="shot-cancel"]'); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  });
  await step('Paste button: one tap reads clipboard.read() and adds a thumbnail', async () => {
    await stubClip('png'); await openScanSheet();
    await page.click('[data-action="shot-paste"]'); await page.waitForSelector('.shot-thumbs li');
    assert.equal(await page.locator('.shot-thumbs li').count(), 1);
    assert.ok(await page.locator('[data-action="shot-read"]').isEnabled());
    await sheetNoHScroll(page, 'paste 390');
    await page.click('[data-action="shot-cancel"]'); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  });
  for (const mode of ['throw', 'empty']) await step(`Paste button falls back to the paste box with a hint when clipboard.read ${mode === 'throw' ? 'throws' : 'has no image'}`, async () => {
    await stubClip(mode); await openScanSheet();
    await page.click('[data-action="shot-paste"]');
    await page.waitForFunction(() => /tap and hold, then paste/i.test(document.querySelector('#shothint').textContent));
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'shotpaste');
    assert.equal(await page.locator('.shot-thumbs li').count(), 0);
    await page.click('[data-action="shot-cancel"]', { force: true }); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  });
  await step('Paste button without navigator.clipboard.read also falls back', async () => {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} })); await openScanSheet();
    await page.click('[data-action="shot-paste"]');
    await page.waitForFunction(() => /tap and hold/i.test(document.querySelector('#shothint').textContent));
    await page.screenshot({ path: SHOTS + '/scan-v15-390.png' });
    await page.click('[data-action="shot-cancel"]', { force: true }); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  });
  await step('Receipt result: header says Receipt, one row with the paid total, note prefilled from items_summary, then added', async () => {
    mock.scan = { bank: null, source: 'receipt', usage: { input_tokens: 1, output_tokens: 1 }, transactions: [
      { merchant: "TRADER JOE'S #123", amount: 48.37, direction: 'out', date: TODAY, pending: false, kind: 'purchase', running_balance: null, account_hint: null, items_summary: 'Groceries · 12 items' }] };
    await stubClip('png'); await openScanSheet();
    await page.click('[data-action="shot-paste"]'); await page.waitForSelector('.shot-thumbs li');
    await page.click('[data-action="shot-read"]'); await page.waitForSelector('.shot-row');
    assert.match(await page.locator('#sheet h3').first().innerText(), /receipt/i);
    assert.equal(await page.locator('.shot-row').count(), 1);
    assert.equal(await page.inputValue('.shot-row input[data-shot="note"]'), 'Groceries · 12 items');
    assert.match(await page.locator('.shot-row .amt').innerText(), /48\.37/);
    await sheetNoHScroll(page, 'receipt 390');
    await page.click('#shotadd'); await waitToast(page, /Added 1 transaction/);
    const sp = (await getState(page)).spends.filter(x => x.shot);
    assert.deepEqual(sp.map(x => [x.amount, x.note]), [[48.37, 'Groceries · 12 items']]);
  });
  await step('no page errors (v15 scan)', async () => assert.deepEqual(errs, []));
  await ctx.close();
}

await b.close();
finish();
