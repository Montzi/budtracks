// v22: Logo field in the spending form (picked per merchant), backup file for a new phone, Ask Bud chat with Style and Settings.
// Run: node tests/v22.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import assert from 'node:assert/strict';
import { pw, SHOTS, BASE, API, iso, addD, step, finish, prep, go, synced } from './lib.mjs';

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
  const page = await ctx.newPage(); await prep(page);
  const errs = [], calls = [], mock = { txns: o.txns || [], offline: false };
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.route(u => !/localhost|worker\.test/.test(u.host), route => route.abort());
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ m, p });
    const json = (x, status) => route.fulfill({ status: status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(x) });
    if (p === '/config') return json({ provider: 'plaid', env: 'production', paired: true, ai: mock.ai || { claude: true, gemini: true } });
    if (p === '/accounts') return json({ enrollments: [{ id: 'enr_c', institution: 'Chime', accounts: [{ id: 'ch1', name: 'Checking', type: 'depository', subtype: 'checking', last_four: '1111', enabled: true }] }] });
    if (p === '/sync') return json({ txns: mock.txns, removed: mock.removed || [], errors: [], syncToken: 'tok', syncedAt: new Date().toISOString() });
    if (p === '/status') return json({ items: [], refresh: { supported: false, reason: 'no' }, balance: { supported: false, reason: 'no' }, env: 'production', at: new Date().toISOString() });
    if (p === '/snapshot') return json({ ok: true });
    if (p === '/ai') return json(mock.aiSt || { claude: { from: 'secret', length: 108, ends: 'wxyz' }, gemini: { from: 'secret', length: 53, ends: 'zRQQ' } });
    if (p === '/ai/key') { if (m === 'DELETE') return json({ ok: true }); const bd = JSON.parse(req.postData() || '{}'); mock.savedKey = bd; const k = bd.key.trim().replace('\u2014', '--'); return json({ ok: true, provider: bd.provider, length: k.length, ends: k.slice(-4) }); }
    if (p === '/ai/test') return json(mock.aiTest || { ok: true, from: 'app', length: 54, ends: 'zRQQ' });
    if (p === '/ask') { mock.asks = mock.asks || []; mock.asks.push(JSON.parse(req.postData() || '{}')); if (mock.askDelay) await new Promise(ok => setTimeout(ok, mock.askDelay)); return mock.askErr ? json({ error: mock.askErr[1] }, mock.askErr[0]) : json(mock.ask || { bubbles: ['You have $412 left this cycle after bills.', 'Groceries are $40 higher than last cycle, mostly Shoprite.', 'Rent is due in 6 days.'] }); }
    return json({ error: 'nope' }, 404);
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(([fx, extra]) => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1'));
    const f = JSON.parse(fx); Object.assign(s, f); Object.assign(s.settings, f.settings, extra || {});
    localStorage.setItem('budtrack.v1', JSON.stringify(s)); localStorage.setItem('budtrack.bankkey', 'secret-device-key-123');
  }, [JSON.stringify(o.fixture || fixture()), o.settings]);
  await page.goto(BASE + (o.hash || '#transactions'), { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  if (!o.noSync) await synced(page);
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
  const p2 = await ctx2.newPage(); await prep(p2); const errs2 = []; p2.on('pageerror', e => errs2.push(e.message));
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

/* ---------- 3. Ask Bud ---------- */
for (const [w, h, dark] of [[390, 844, true], [951, 669, false]]) {
  const tag = `${w}x${h} ${dark ? 'dark' : 'light'}`;
  const { ctx, page, errs, mock } = await newPage(w, h, { dark, hash: '#overview', txns: LOGO_TXNS() });
  await step(`${tag}: tapping Bud opens the chat at the top of the screen with Style, Settings, a greeting and suggestions`, async () => {
    await quiet(page);
    await page.locator('#brandbar svg.hd').dispatchEvent('click');
    await page.waitForSelector('#budchat:not([hidden]) .bc');
    const g = await page.evaluate(() => { const bb = document.querySelector('#brandbar').getBoundingClientRect(), bc = document.querySelector('.bc').getBoundingClientRect(); return { top: bc.top, bbBottom: bb.bottom, left: bc.left, right: bc.right, bottom: bc.bottom, vw: innerWidth, vh: innerHeight }; });
    assert.ok(g.top >= 0 && g.top <= 20, 'at the top ' + JSON.stringify(g));
    assert.ok(g.bottom >= g.vh - 20, 'full height ' + JSON.stringify(g));
    assert.ok(g.right <= g.vw && g.left >= 0 && g.bottom <= g.vh, 'inside the screen ' + JSON.stringify(g));
    assert.equal(await page.locator('.bc-h [data-action="style"]').innerText(), 'Style');
    assert.equal(await page.getAttribute('.bc-h [data-action="settings"]', 'aria-label'), 'Settings');
    assert.match(await txt(page, '.bc-m.bot'), /I'm Bud/);
    assert.equal(await page.locator('.bc-sug .chip').count(), 4);
    await noHScroll(page, tag + ' chat');
    await page.waitForTimeout(300); await page.screenshot({ path: SHOTS + `/v22-chat-open-${w}.png` });
  });
  await step(`${tag}: a suggestion asks Bud: the request carries the summary (no raw data), the answer arrives as bubbles`, async () => {
    await page.click('.bc-sug .chip >> nth=0');
    await page.waitForFunction(() => document.querySelectorAll('.bc-m.bot:not(.typing)').length >= 4, null, { timeout: 8000 });
    const a = mock.asks[0];
    assert.equal(a.q, 'How am I doing this pay cycle?'); assert.deepEqual(a.history, []); assert.equal(a.today, TODAY);
    for (const k of ['this_period', 'periods_oldest_first', 'months_oldest_first', 'upcoming_unpaid', 'transactions_75_days', 'top_merchants_30_days', 'budgets_this_period']) assert.ok(k in a.ctx, k);
    assert.ok(a.ctx.transactions_75_days.some(t => t.m === 'Shoprite 123' && t.a === 41.2));
    const raw = JSON.stringify(a);
    assert.ok(raw.length < 120 * 1024, 'size ' + raw.length);
    assert.ok(!/secret-device-key|data:image|logos|"marks"/.test(raw), 'no key, logos or raw state');
    const bubbles = await page.locator('.bc-m.bot:not(.typing) p').allInnerTexts();
    assert.deepEqual(bubbles.slice(1), ['You have $412 left this cycle after bills.', 'Groceries are $40 higher than last cycle, mostly Shoprite.', 'Rent is due in 6 days.']);
    assert.equal(await page.locator('.bc-sug').count(), 0);
    await page.screenshot({ path: SHOTS + `/v22-chat-answer-${w}.png` });
  });
  await step(`${tag}: a typed follow-up sends the earlier question and answer as history`, async () => {
    mock.ask = { bubbles: ['Last cycle you had $380 left, so you are $32 ahead.'] };
    await page.fill('#bcq', 'And compared to last cycle?'); await page.press('#bcq', 'Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.bc-m.bot p')].some(p => /\$32 ahead/.test(p.textContent)));
    const a = mock.asks[1];
    assert.equal(a.history.length, 1); assert.equal(a.history[0].q, 'How am I doing this pay cycle?'); assert.match(a.history[0].a, /\$412 left[\s\S]*Rent is due/);
    assert.equal(await page.inputValue('#bcq'), '');
  });
  if (w !== 390) { await step(`${tag}: no page errors`, async () => assert.deepEqual(errs, [])); await ctx.close(); continue; }
  await step(`${tag}: while Bud thinks, a typing bubble shows; the daily limit gets a friendly answer`, async () => {
    mock.askErr = [429, 'daily limit']; mock.askDelay = 600;
    await page.fill('#bcq', 'One more?'); await page.press('#bcq', 'Enter');
    await page.waitForSelector('.bc-m.typing');
    await page.waitForSelector('.bc-m.bot.err');
    assert.match(await txt(page, '.bc-m.bot.err'), /Ask me again tomorrow/);
    mock.askErr = null; mock.askDelay = 0;
  });
  await step(`${tag}: Style opens the hat and appearance sheet on top of the chat`, async () => {
    await page.click('.bc-h [data-action="style"]');
    await page.waitForSelector('#sheet:not([hidden]) .hat-sw');
    assert.match(await txt(page, '#sheet h3'), /^Style$/);
    assert.ok(await page.locator('#sheet .theme-seg, #sheet [data-action="theme"]').count() > 0, 'appearance in Style');
    await page.click('#sheet [data-action="hat-color"] >> nth=2');
    await page.keyboard.press('Escape'); await page.waitForSelector('#sheet', { state: 'hidden' });
    assert.equal(await page.locator('#budchat').isHidden(), false);
  });
  await step(`${tag}: header order is New chat, Style, AI, Clear, then the settings icon (close at the edge)`, async () => {
    const acts = await page.$$eval('.bc-h button', bs => bs.map(b => b.dataset.action));
    assert.deepEqual(acts, ['bc-new', 'style', 'bc-ai', 'bc-clear', 'settings', 'bc-close']);
    assert.equal(await page.getAttribute('.bc-h [data-action="settings"]', 'aria-label'), 'Settings');
    assert.equal((await page.locator('.bc-h [data-action="settings"]').innerText()).trim(), '', 'icon only');
    await page.screenshot({ path: SHOTS + '/v22-chat-header-390.png', clip: { x: 0, y: 200, width: 390, height: 120 } });
  });
  await step(`${tag}: the chat is kept after a reload; New chat starts fresh below a divider (Bud forgets the earlier part)`, async () => {
    await page.reload({ waitUntil: 'load' }); await quiet(page);
    await page.locator('#brandbar svg.hd').dispatchEvent('click'); await page.waitForSelector('#budchat:not([hidden])');
    const before = await page.locator('.bc-m.me').count(); assert.ok(before >= 2);
    await page.click('[data-action="bc-new"]');
    assert.equal(await page.locator('.bc-sep').count(), 1); assert.equal(await page.locator('.bc-m.me').count(), before, 'earlier messages stay on screen');
    assert.equal(await page.locator('.bc-sug .chip').count(), 4);
    await page.click('[data-action="bc-new"]'); assert.equal(await page.locator('.bc-sep').count(), 1, 'no second divider on an empty chat');
    mock.ask = { bubbles: ['Fresh answer.'] };
    await page.fill('#bcq', 'Fresh question'); await page.press('#bcq', 'Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.bc-m.bot p')].some(p => /Fresh answer/.test(p.textContent)));
    assert.deepEqual(mock.asks.at(-1).history, [], 'Bud does not see the earlier part');
  });
  await step(`${tag}: Clear asks for a second tap, then erases the whole chat`, async () => {
    await page.click('[data-action="bc-clear"]');
    assert.equal(await page.locator('[data-action="bc-clear"]').innerText(), 'Tap to confirm');
    assert.ok((await page.locator('.bc-m.me').count()) > 0, 'nothing erased yet');
    await page.click('[data-action="bc-clear"]');
    assert.equal(await page.locator('.bc-m.me').count(), 0); assert.equal(await page.locator('.bc-sep').count(), 0);
    assert.equal(await page.locator('[data-action="bc-clear"]').isHidden(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('budtrack.chat')), '[]');
  });
  await step(`${tag}: Settings goes to the Income tab, scrolled to the settings below the income part`, async () => {
    await page.click('.bc-h [data-action="settings"]');
    await page.waitForFunction(() => location.hash === '#income');
    // Wait for the scroll to settle instead of a fixed pause: parallel runs are slower.
    await page.waitForFunction(() => { const e = document.querySelector('#settings'); if (!e) return false; const t = e.getBoundingClientRect().top; return t >= -2 && t < 60; }).catch(() => {});
    assert.equal(await page.locator('#budchat').isHidden(), true);
    const top = await page.evaluate(() => document.querySelector('#settings').getBoundingClientRect().top);
    assert.ok(top >= -2 && top < 60, 'settings at the top: ' + top);
    assert.ok(await page.evaluate(() => scrollY > 50));
  });
  await step(`${tag}: without the pairing key Bud explains how to connect, and nothing is sent`, async () => {
    await page.evaluate(() => localStorage.removeItem('budtrack.bankkey'));
    await page.reload({ waitUntil: 'load' }); await quiet(page);
    const n = mock.asks.length;
    await page.locator('#brandbar svg.hd').dispatchEvent('click');
    await page.fill('#bcq', 'Hi'); await page.press('#bcq', 'Enter');
    await page.waitForSelector('.bc-m.bot.err');
    assert.match(await txt(page, '.bc-m.bot.err'), /not paired/);
    assert.equal(mock.asks.length, n);
  });
  await step(`${tag}: no page errors`, async () => assert.deepEqual(errs, []));
  await ctx.close();
}

/* ---------- 4. Ask Bud on short landscape screens ---------- */
for (const [w, h] of [[763, 390], [667, 375]]) {
  const { ctx, page, errs } = await newPage(w, h, { hash: '#overview', noSync: true });
  await step(`${w}x${h}: the chat keeps a usable message area (beside the logo, or over it)`, async () => {
    await quiet(page); await page.locator('#brandbar svg.hd').dispatchEvent('click'); await page.waitForSelector('#budchat:not([hidden])'); await page.waitForTimeout(250);
    const g = await page.evaluate(() => { const l = document.querySelector('.bc-log').getBoundingClientRect(), c = document.querySelector('.bc').getBoundingClientRect(); return { log: l.height, top: c.top, bottom: c.bottom, left: c.left, right: c.right }; });
    assert.ok(g.log >= 140, 'log height ' + JSON.stringify(g));
    assert.ok(g.top >= 0 && g.bottom <= h && g.left >= 0 && g.right <= w, 'on screen ' + JSON.stringify(g));
    await noHScroll(page, w + ' chat'); assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 5. Ask Bud: Claude Haiku or Gemini Flash, from Settings ---------- */
{
  const { ctx, page, errs, mock } = await newPage(390, 844, { dark: true, hash: '#income', txns: LOGO_TXNS() });
  await step('390: Settings has an Ask Bud card; Claude Haiku is the default and each choice explains cost and privacy', async () => {
    await page.waitForSelector('#aicard');
    assert.equal(await page.locator('#aicard [data-p="claude"]').getAttribute('aria-pressed'), 'true');
    assert.match(await txt(page, '#aicard'), /Claude Haiku 5\.5/);
    await page.click('#aicard [data-p="gemini"]');
    assert.equal((await getState(page)).settings.aiProvider, 'gemini');
    assert.match(await txt(page, '#aicard'), /Gemini 3\.8 Flash[\s\S]*free tier[\s\S]*improve its products/);
    assert.equal(await page.locator('#aicard .note.warn').count(), 0);
    await quiet(page); await page.locator('#aicard').screenshot({ path: SHOTS + '/v22-ai-card-390.png' });
  });
  await step('390: with Gemini picked, questions go out with provider "gemini" and the chat header says Gemini Flash', async () => {
    await page.locator('#brandbar svg.hd').dispatchEvent('click'); await page.waitForSelector('#budchat:not([hidden])');
    await page.click('.bc-h [data-action="bc-ai"]'); await page.waitForSelector('#bcmenu:not([hidden])');
    assert.equal(await page.getAttribute('#bcmenu [data-p="gemini"]', 'aria-checked'), 'true');
    await page.click('#bcq'); assert.equal(await page.locator('#bcmenu').isHidden(), true, 'a tap elsewhere closes the menu');
    await page.fill('#bcq', 'Hi'); await page.press('#bcq', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('.bc-m.bot:not(.typing)').length >= 4 && !document.querySelector('.bc-m.typing'));
    assert.equal(mock.asks.at(-1).provider, 'gemini');
    mock.askErr = [503, "Gemini isn't set up yet"];
    await page.fill('#bcq', 'Again'); await page.press('#bcq', 'Enter');
    await page.waitForSelector('.bc-m.bot.err'); assert.match(await txt(page, '.bc-m.bot.err'), /switch back to Claude in Settings/);
    mock.askErr = null; await page.keyboard.press('Escape');
  });
  await step('390: when the server has no Gemini key, the card says what to add', async () => {
    mock.ai = { claude: true, gemini: false }; await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#aicard .note.warn');
    assert.match(await txt(page, '#aicard .note.warn'), /No Gemini key/);
    await page.click('#aicard [data-p="claude"]'); assert.equal(await page.locator('#aicard .note.warn').count(), 0);
    assert.equal((await getState(page)).settings.aiProvider, 'claude');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 6. AI key from the app ---------- */
{
  const { ctx, page, errs, mock } = await newPage(390, 844, { dark: true, hash: '#income', noSync: true, settings: { aiProvider: 'gemini' } });
  await step('390: the Ask Bud card shows where the key comes from, its length and last 4; a pasted key is saved and tested', async () => {
    await page.waitForSelector('#aikeyform');
    assert.match(await txt(page, '#aikeyform .meta'), /From the GitHub secret · 53 characters, ends zRQQ/);
    assert.equal(await page.getAttribute('#aikey', 'type'), 'text'); assert.equal(await page.$eval('#aikey', e => getComputedStyle(e).webkitTextSecurity), 'disc');
    mock.aiTest = { ok: false, error: "Gemini's key is invalid (400 INVALID_ARGUMENT API_KEY_INVALID, key 53 characters ending zRQQ)" };
    await page.click('[data-action="ai-test"]');
    await page.waitForSelector('#aikeyform .note.warn[role=status]');
    assert.match(await txt(page, '#aikeyform [role=status]'), /53 characters ending zRQQ/);
    mock.aiTest = null;
    await page.fill('#aikey', 'AQ.Ab8RN6L75o3Q_mXrolldgrjoe7a6jbVvIt-R3czzme79-qRzRQQ'); await page.press('#aikey', 'Enter');
    await page.waitForSelector('#aikeyform .note.good');
    assert.equal(mock.savedKey.provider, 'gemini'); assert.equal(mock.savedKey.key, 'AQ.Ab8RN6L75o3Q_mXrolldgrjoe7a6jbVvIt-R3czzme79-qRzRQQ');
    assert.match(await txt(page, '#aikeyform .meta'), /Saved from this app · 54 characters, ends zRQQ/);
    assert.match(await txt(page, '#aikeyform .note.good'), /The key works/);
    assert.equal(await page.inputValue('#aikey').catch(() => ''), '');
    assert.equal(await page.locator('[data-action="ai-forget"]').count(), 1);
    await quiet(page); await page.locator('#aicard').screenshot({ path: SHOTS + '/v22-ai-key-390.png' });
    assert.ok(!(await page.evaluate(() => localStorage.getItem('budtrack.v1'))).includes('Ab8RN6L75o3Q'), 'key not kept on the phone');
    await noHScroll(page, 'ai key'); assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 7. AI button in the chat: see and switch the model, cost of answers ---------- */
{
  const { ctx, page, errs, mock } = await newPage(390, 844, { dark: true, hash: '#overview', noSync: true });
  await step('390: AI in the chat header shows the models; picking one switches; a Claude answer shows its tokens and cost', async () => {
    await quiet(page); await page.locator('#brandbar svg.hd').dispatchEvent('click'); await page.waitForSelector('#budchat:not([hidden])');
    assert.equal(await page.locator('.bc-h [data-action="bc-ai"]').innerText(), 'AI');
    await page.click('[data-action="bc-ai"]'); await page.waitForSelector('#bcmenu:not([hidden])');
    assert.equal(await page.getAttribute('#bcmenu [data-p="claude"]', 'aria-checked'), 'true');
    assert.match(await txt(page, '#bcmenu'), /No answers yet/);
    await page.click('#bcmenu [data-p="gemini"]');
    assert.equal((await getState(page)).settings.aiProvider, 'gemini'); assert.equal(await page.getAttribute('#bcmenu [data-p="gemini"]', 'aria-checked'), 'true');
    await page.click('#bcmenu [data-p="claude"]');
    mock.ask = { bubbles: ['Rent is next.'], model: 'claude-haiku-5-5', usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0 } };
    await page.click('[data-action="bc-ai"]');
    await page.fill('#bcq', 'Next bill?'); await page.press('#bcq', 'Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.bc-m.bot p')].some(p => /Rent is next/.test(p.textContent)));
    assert.equal(mock.asks.at(-1).provider, 'claude');
    await page.click('[data-action="bc-ai"]');
    const t = await txt(page, '#bcmenu');
    // 1,200 x $0.10 + 8,000 x $0.01 + 300 x $0.50 per million = $0.00035
    assert.match(t, /Last answer: Claude Haiku 5\.5 · 9,500 tokens · about \$0\.000[34]/); assert.match(t, /\$0\.000[34] for 1 answer/);
    await page.screenshot({ path: SHOTS + '/v22-ai-menu-390.png' });
    await page.click('#bcmenu [data-action="bc-keys"]');
    await page.waitForFunction(() => location.hash === '#income');
    await page.waitForFunction(() => { const e = document.querySelector('#aicard'); if (!e) return false; const t = e.getBoundingClientRect().top; return t > -10 && t < 80; }).catch(() => {});
    const top = await page.evaluate(() => document.querySelector('#aicard').getBoundingClientRect().top); assert.ok(top > -10 && top < 80, 'Ask Bud card at top: ' + top);
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 8. Chat with the keyboard up ---------- */
{
  const { ctx, page, errs } = await newPage(390, 844, { dark: true, hash: '#overview', noSync: true });
  await step('390: when the keyboard takes the bottom 336px, only the chat\'s bottom edge moves up; the header stays at the top', async () => {
    await quiet(page); await page.locator('#brandbar svg.hd').dispatchEvent('click'); await page.waitForSelector('#budchat:not([hidden])'); await page.waitForTimeout(250);
    const before = await page.evaluate(() => { const r = document.querySelector('.bc').getBoundingClientRect(), h = document.querySelector('.bc-h').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, head: h.top }; });
    // Stand in for the iOS keyboard: a visual viewport 336px shorter than the window.
    await page.evaluate(() => { const vv = window.visualViewport; Object.defineProperty(vv, 'height', { configurable: true, get: () => innerHeight - 336 }); vv.dispatchEvent(new Event('resize')); });
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => { const r = document.querySelector('.bc').getBoundingClientRect(), h = document.querySelector('.bc-h').getBoundingClientRect(), i = document.querySelector('.bc-in').getBoundingClientRect(), l = document.querySelector('.bc-log').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, head: h.top, inBottom: i.bottom, log: l.height }; });
    assert.equal(after.top, before.top, 'top unchanged'); assert.equal(after.head, before.head, 'header unchanged');
    assert.ok(after.bottom <= 844 - 336 && after.bottom >= 844 - 336 - 20, 'above the keyboard ' + JSON.stringify(after));
    assert.ok(after.log >= 200, 'room for messages ' + JSON.stringify(after));
    await page.screenshot({ path: SHOTS + '/v22-chat-keyboard-390.png' });
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 9. Messages: bank news stays until closed; others at least 10 seconds ---------- */
{
  const { ctx, page, errs } = await newPage(390, 844, { dark: true, hash: '#income', txns: LOGO_TXNS() });
  await step('390: new bank lines from a sync stay on screen with an X; another message shows its 10 seconds, then the bank news comes back; X closes it', async () => {
    await page.waitForSelector('#toast.on');
    const news = await txt(page, '#toast');
    assert.match(news, /to review/); assert.equal(await page.getAttribute('#toast', 'data-pin'), '1');
    assert.equal(await page.locator('#toast .toast-x').count(), 1);
    await page.waitForTimeout(11000);
    assert.ok(await page.locator('#toast.on').count(), 'still showing after 11 s'); assert.equal(await txt(page, '#toast'), news);
    await page.waitForSelector('#aicard'); await page.click('#aicard [data-p="gemini"]');
    assert.match(await txt(page, '#toast'), /Gemini Flash answers now/);
    await page.waitForTimeout(6000); assert.match(await txt(page, '#toast'), /Gemini Flash answers now/, 'still up after 6 s');
    await page.waitForTimeout(4600); assert.equal(await txt(page, '#toast'), news, 'bank news back after 10 s');
    await page.click('#toast .toast-x');
    assert.equal(await page.locator('#toast.on').count(), 0);
    await page.waitForTimeout(500); assert.equal(await page.locator('#toast.on').count(), 0, 'stays closed');
  });
  await step('390: a plain message closes with its X before the 10 seconds are up', async () => {
    await page.click('#aicard [data-p="claude"]'); await page.waitForSelector('#toast.on');
    assert.equal(await page.getAttribute('#toast', 'data-pin'), '');
    await page.click('#toast .toast-x'); assert.equal(await page.locator('#toast.on').count(), 0);
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}
await b.close();
finish();
