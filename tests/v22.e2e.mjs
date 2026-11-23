// v22: Logo field in the spending form (picked per merchant), backup file for a new phone, Ask Bud chat with Style and Settings.
// Run: node tests/v22.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
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
const TODAY = iso(new Date()), PAY = addD(TODAY, -4);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = s => MON[+s.slice(5, 7) - 1] + ' ' + +s.slice(8);
const dayOf = s => +s.slice(8);

const CO = { id: 'co1', name: 'Quicksilver', last4: '7777', institution: 'Capital One', type: 'credit' };
const CHI = { id: 'ch1', name: 'Checking', last4: '1111', institution: 'Chime', type: 'depository' };
const PPA = { id: 'pp1', name: 'PayPal Balance', last4: '', institution: 'PayPal', type: 'depository' };
const VNA = { id: 'vn1', name: 'Venmo', last4: '', institution: 'Venmo', type: 'depository' };
const T = (id, date, desc, amount, account, extra) => Object.assign({ id: 'pl:' + id, date, desc, rawDesc: desc, amount, account: account || CHI, status: 'posted', pendingOf: null, counterparty: null, providerCategory: null }, extra || {});

const DASH_DUE = addD(TODAY, -3), OLD_DUE = addD(TODAY, -50), LAMP_DUE = addD(TODAY, -6);
const KEY_DASH = 'b:dash:' + DASH_DUE, KEY_OLD = 'b:music:' + OLD_DUE;
const fixture = over => Object.assign({
  since: addD(TODAY, -1), marks: {}, occ: {}, unalloc: [], payVia: [], spends: [], cards: [], plans: [],
  categories: ['Groceries', 'Gas', 'Takeout Food', 'Dining Out', 'Subscriptions', 'Other'], billCats: ['Housing', 'Subscriptions', 'Other'],
  income: [{ id: 'pay', name: 'Acme', freq: 'biweekly', date: PAY, amount: 2000 }],
  bills: [{ id: 'dash', name: 'DoorDash DashPass', amount: 9.99, day: dayOf(DASH_DUE), group: 'Subscriptions', category: 'Subscriptions', via: 'PayPal', active: true },
    { id: 'music', name: 'Music Club', amount: 9.99, day: dayOf(OLD_DUE), group: 'Subscriptions', category: 'Subscriptions', active: true },
    { id: 'rent', name: 'Rent', amount: 1050, day: dayOf(addD(TODAY, 6)), group: 'Fixed', category: 'Housing', active: true }],
  perPeriod: [{ id: 'groc', name: 'Groceries', amount: 150, category: 'Groceries' }],
  savings: { on: false, bank: '', tx: [] },
  bank: { seen: {}, rules: {}, links: {}, lastSync: null, inbox: [], api: API, autoFrom: addD(TODAY, -40), historyFrom: addD(TODAY, -90), txns: {} },
  settings: { view: 'biweekly', anchor: PAY, legendOpen: {}, billsView: '', chartRange: 'cycle' }
}, over || {});

const b = await pw.chromium.launch();
async function newPage(w, h, o) {
  o = o || {};
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: o.dark ? 'dark' : 'light', deviceScaleFactor: 1 });
  const page = await ctx.newPage(); page.setDefaultTimeout(6000);
  const errs = [], calls = [], mock = { txns: o.txns || [], offline: false };
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  await page.route(u => !/localhost|worker\.test/.test(u.host), route => route.abort());
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ m, p });
    const json = (x, status) => route.fulfill({ status: status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(x) });
    if (p === '/config') return json({ provider: 'plaid', env: 'production', paired: true });
    if (p === '/accounts') return json({ enrollments: [{ id: 'enr_c', institution: 'Chime', accounts: [{ id: 'ch1', name: 'Checking', type: 'depository', subtype: 'checking', last_four: '1111', enabled: true }] }] });
    if (p === '/sync') return json({ txns: mock.txns, removed: mock.removed || [], errors: [], syncToken: 'tok', syncedAt: new Date().toISOString() });
    if (p === '/status') return json({ items: [], refresh: { supported: false, reason: 'no' }, balance: { supported: false, reason: 'no' }, env: 'production', at: new Date().toISOString() });
    if (p === '/snapshot') return json({ ok: true });
    return json({ error: 'nope' }, 404);
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(([fx, extra]) => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1'));
    const f = JSON.parse(fx); Object.assign(s, f); Object.assign(s.settings, f.settings, extra || {});
    localStorage.setItem('budtrack.v1', JSON.stringify(s)); localStorage.setItem('budtrack.bankkey', 'secret-device-key-123');
  }, [JSON.stringify(o.fixture || fixture()), o.settings]);
  await page.goto(BASE + (o.hash || '#transactions'), { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  if (!o.noSync) await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.lastSync);
  await page.waitForTimeout(300);
  return { ctx, page, errs, mock, calls };
}
const getState = page => page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')));
const noHScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'horizontal scroll at ' + label);
const sheetNoHScroll = async (page, label) => assert.ok(await page.evaluate(() => { const s = document.querySelector('#sheet .sheet'); return s && s.scrollWidth <= s.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; }), 'sheet scrolls sideways at ' + label);
const quiet = page => page.evaluate(() => { const t = document.querySelector('#toast'); t.style.transition = 'none'; t.classList.remove('on'); const bud = document.querySelector('#bud'); if (bud) bud.style.display = 'none'; });
const txt = (page, sel) => page.locator(sel).first().innerText().then(t => t.replace(/\s+/g, ' ').trim());
const chip = (page, id) => page.locator(`.tx[data-id="pl:${id}"] .txc`).innerText().then(t => t.replace(/\s+/g, ' ').trim());
const openRow = async (page, id) => { const row = page.locator(`.tx[data-id="pl:${id}"]`); await row.waitFor(); if (!(await row.evaluate(e => e.classList.contains('open')))) await row.locator('.tx-main').click(); return row; };
const spent = async page => (await page.locator('#tx-spent').innerText()).replace(/[^0-9.]/g, '');
const syncNow = async (page, mock, txns) => {
  if (txns) mock.txns = txns;
  const before = (await getState(page)).bank.lastSync;
  await page.click('[data-action="bk-sync"]');
  await page.waitForFunction(x => JSON.parse(localStorage.getItem('budtrack.v1')).bank.lastSync !== x, before);
  await page.waitForTimeout(400);
};
const inReview = async page => page.locator('#txreview .tx').evaluateAll(els => els.map(e => e.dataset.id));
const openPicker = async (page, id) => { const row = await openRow(page, id); await row.locator('[data-action="tx-match"]').click(); await page.waitForSelector('.pk-opt'); };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/* ---------- 1. Logo field ---------- */
const LOGO_TXNS = () => [T('sr1', TODAY, 'SHOPRITE 123', 41.2), T('sr2', addD(TODAY, -1), 'SHOPRITE 123', 12.5), T('ppj', TODAY, 'PAYPAL to Jordan Smith', 20, CO), T('ppx', TODAY, 'PAYPAL *NETFLIX', 15.49, CO)];
{
  const { ctx, page, errs } = await newPage(390, 844, { dark: true, txns: LOGO_TXNS() });
  await step('390: Edit on a bank line shows Logo beside What was it; picking Shell paints every Shoprite 123 line after Save', async () => {
    const row = await openRow(page, 'sr1');
    await row.locator('[data-action="tx-edit"]').click(); await page.waitForSelector('#form .lg-now');
    const pos = await page.evaluate(() => { const d = document.querySelector('#form [name=desc]').closest('label').getBoundingClientRect(), l = document.querySelector('.lg-fld').getBoundingClientRect(); return { dy: Math.abs(d.top - l.top), side: l.left > d.left }; });
    assert.ok(pos.dy < 4 && pos.side, 'Logo sits next to What was it: ' + JSON.stringify(pos));
    await page.click('[data-action="lgf-toggle"]');
    await page.fill('#lgq', 'shell');
    assert.equal(await page.locator('.lg-o:visible').count(), 1);
    await quiet(page); await page.screenshot({ path: SHOTS + '/v22-logo-pick-390.png' });
    await page.click('.lg-o[data-k="shell"]');
    assert.equal(await page.locator('.lg-inline').isHidden(), true);
    assert.equal(await page.locator('.lg-cur .slogo').getAttribute('data-svc'), 'shell');
    await page.click('#form button[type=submit]');
    await page.waitForFunction(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); return s.logoFor && s.logoFor.shoprite123; });
    const s = await getState(page);
    assert.deepEqual(s.logoFor.shoprite123, { k: 'shell', n: 'Shoprite 123' });
    for (const id of ['sr1', 'sr2']) assert.equal(await page.locator(`.tx[data-id="pl:${id}"] .slogo`).first().getAttribute('data-svc'), 'shell', id);
  });
  await step('390: picking a logo for "PayPal to Jordan Smith" does not repaint other PayPal lines', async () => {
    const row = await openRow(page, 'ppj');
    await row.locator('[data-action="tx-edit"]').click(); await page.waitForSelector('#form .lg-now');
    await page.click('[data-action="lgf-toggle"]'); await page.click('.lg-o[data-k="venmo"]');
    await page.click('#form button[type=submit]');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).logoFor.paypaltojordansmith);
    assert.equal(await page.locator('.tx[data-id="pl:ppj"] .slogo').first().getAttribute('data-svc'), 'venmo');
    assert.equal(await page.locator('.tx[data-id="pl:ppx"] .slogo').first().getAttribute('data-svc'), 'netflix');
  });
  await step('390: Upload new in the form saves your picture as this merchant\'s logo; survives reload; Reset in Service logos removes the pick', async () => {
    const row = await openRow(page, 'sr2');
    await row.locator('[data-action="tx-edit"]').click(); await page.waitForSelector('#form .lg-now');
    await page.click('[data-action="lgf-toggle"]');
    await page.setInputFiles('#lg-file', { name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForFunction(() => document.querySelector('#form [name=logo]').value === '+');
    await page.click('#form button[type=submit]');
    await page.waitForFunction(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); return s.logoFor.shoprite123 && s.logoFor.shoprite123.k === 'shoprite123'; });
    const s = await getState(page); assert.match(s.logos.shoprite123, /^data:image\/png;base64,/);
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(300);
    assert.equal(await page.locator('.tx[data-id="pl:sr1"] .slogo img').first().getAttribute('data-own'), '1');
    await page.goto(BASE + '#income'); await page.waitForTimeout(200);
    if (await page.locator('#coll-logos').isHidden()) await page.click('#svclogos [data-action="coll"], #svclogos .coll-h, #svclogos button[aria-controls="coll-logos"]');
    await page.click('[data-action="logo-unpick"][data-m="shoprite123"]');
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('budtrack.v1')).logoFor.shoprite123);
  });
  await step('390: no page errors', async () => assert.deepEqual(errs, []));
  await ctx.close();
}

/* ---------- 2. Backup file for a new phone ---------- */
{
  const { ctx, page, errs } = await newPage(951, 669, { hash: '#income', txns: LOGO_TXNS() });
  let file;
  await step('951: Save backup file downloads one JSON file with the data, uploaded logos, picks and (box checked) the bank key', async () => {
    await page.evaluate(png => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.logos.duranlaundromat = 'data:image/png;base64,' + png; s.logoNames.duranlaundromat = 'Duran Laundromat'; s.logoFor = { shoprite123: { k: 'shell', n: 'Shoprite 123' } }; localStorage.setItem('budtrack.v1', JSON.stringify(s)); }, PNG.toString('base64'));
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(300);
    assert.equal(await page.locator('#bk-key').isChecked(), true);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="bk-file"]')]);
    assert.match(dl.suggestedFilename(), /^budtracks-backup-\d{4}-\d{2}-\d{2}\.json$/);
    file = SHOTS + '/' + dl.suggestedFilename(); await dl.saveAs(file);
    const j = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));
    assert.equal(j.app, 'BudTracks'); assert.equal(j.v, 2);
    assert.equal(j.bank.key, 'secret-device-key-123'); assert.equal(j.bank.api, API);
    assert.ok(j.data.logos.duranlaundromat); assert.deepEqual(j.data.logoFor.shoprite123, { k: 'shell', n: 'Shoprite 123' });
    assert.ok(Object.keys(j.data.bank.txns).length >= 4);
    assert.match(await txt(page, '#yourdata .meta'), /Last backup file/);
  });
  await step('951: unchecking the box leaves the bank key out', async () => {
    await page.uncheck('#bk-key');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="bk-file"]')]);
    const j = JSON.parse(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8'));
    assert.equal(j.bank, undefined);
  });
  await step('951: no page errors', async () => assert.deepEqual(errs, []));
  await ctx.close();
  // A new phone: empty data, no pairing key.
  const ctx2 = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', deviceScaleFactor: 1 });
  const p2 = await ctx2.newPage(); p2.setDefaultTimeout(6000); const errs2 = []; p2.on('pageerror', e => errs2.push(e.message));
  await p2.route(u => !/localhost/.test(u.host), route => route.abort());
  await p2.goto(BASE + '#income', { waitUntil: 'load' });
  await step('390 new phone: Restore from file shows what is in the file, then brings back data, logos, picks and the bank connection', async () => {
    assert.equal(await p2.evaluate(() => localStorage.getItem('budtrack.bankkey')), null);
    await p2.setInputFiles('#bkfile', file);
    await p2.waitForSelector('.bk-sum');
    const sum = await txt(p2, '.bk-sum');
    assert.match(sum, /1 uploaded logo/); assert.match(sum, /Bank connection included/); assert.match(sum, /\b4 bank transactions/);
    await p2.screenshot({ path: SHOTS + '/v22-restore-390.png' });
    await p2.click('[data-action="bk-restore"]');
    await p2.waitForFunction(() => localStorage.getItem('budtrack.bankkey') === 'secret-device-key-123');
    const s = await getState(p2);
    assert.ok(s.logos.duranlaundromat); assert.equal(s.logoFor.shoprite123.k, 'shell'); assert.equal(s.bank.api, API);
  });
  await step('390 new phone: a pasted old-style text backup still restores (no bank connection)', async () => {
    await p2.click('[data-action="restore"]');
    const st = await getState(p2); st.bills = st.bills.slice(0, 1);
    await p2.fill('#bk', JSON.stringify(st)); await p2.click('[data-action="do-restore"]');
    assert.match(await txt(p2, '.bk-sum'), /Text backups have no bank connection/);
    await p2.click('[data-action="bk-restore"]');
    await p2.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bills.length === 1);
    assert.deepEqual(errs2, []);
  });
  await ctx2.close();
}
await b.close(); console.log(failed ? failed + " FAILED" : "all ok"); process.exit(failed ? 1 : 0);
