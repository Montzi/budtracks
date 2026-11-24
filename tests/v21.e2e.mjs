// v21: late bank lines match past bills of every kind (3+ cycles, Show older), To savings only where it makes sense, "To review" on top of All
// with Accepted / Matched / Skipped chips, PayPal / Venmo double-count guard, screenshot entries without "waiting", centered Plans switch,
// collapsible Service logos with "Add a logo".
// Run: node tests/v21.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import assert from 'node:assert/strict';
import { pw, SHOTS, BASE, API, iso, addD, step, finish, prep, R, synced } from './lib.mjs';

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

/* ---------- 1. Match late lines to past bills of every kind ---------- */
const PAST_TXNS = () => [T('pp', TODAY, 'PAYPAL to Jordan Smith', 9.99, CO), T('pp2', addD(TODAY, -1), 'PAYPAL INST XFER', 9.99, CO)];
const PAST_FX = over => fixture(Object.assign({
  plans: [{ id: 'lamp', provider: 'PayPal', merchant: 'Lamp', amount: 9.99, total: 4, paid: 1, freq: 'biweekly', lastDate: addD(TODAY, -20), dates: [addD(TODAY, -20), LAMP_DUE, addD(TODAY, 8), addD(TODAY, 22)], category: 'Other', autopay: true }]
}, over || {}));
for (const [w, h, dark] of [[390, 844, true], [669, 951, false], [951, 669, true]]) {
  const tag = `${w}x${h} ${dark ? 'dark' : 'light'}`;
  const { ctx, page, errs } = await newPage(w, h, { dark, txns: PAST_TXNS(), fixture: PAST_FX() });
  await step(`${tag}: the PayPal $9.99 line (Capital One, today) is "New PayPal plan?" in To review; its picker lists the DashPass bill due 3 days earlier, assumed paid`, async () => {
    assert.deepEqual((await inReview(page)).includes('pl:pp'), true);
    const row = await openRow(page, 'pp');
    assert.match(await row.innerText(), /New PayPal plan\?/i);
    await row.locator('[data-action="tx-match"]').click(); await page.waitForSelector('.pk-opt');
    const first = page.locator('.pk-grp').first().locator('.pk-opt').first();
    assert.equal(await first.getAttribute('data-key'), KEY_DASH, 'best match');
    const t = await first.innerText();
    assert.match(t, /DoorDash DashPass/); assert.match(t, /3 days late/i); assert.match(t, /Assumed paid/i); assert.match(t, new RegExp('due ' + md(DASH_DUE)));
    // plan payments of every state (the Lamp payment 6 days back was assumed paid by autopay) are in the list too
    assert.equal(await page.locator('#pklist .pk-opt[data-key="p:lamp:2"]').count(), 1, 'past plan payment');
    assert.match(await page.locator('#pklist .pk-opt[data-key="p:lamp:2"]').innerText(), /Pay plan/i);
    await sheetNoHScroll(page, tag + ' picker');
    if (w === 390 && dark) { await quiet(page); await page.waitForTimeout(300); await page.screenshot({ path: SHOTS + '/v21-match-past-390.png' }); }
  });
  await step(`${tag}: Show older adds three more pay cycles per tap (the Music Club bill from 50 days ago appears after one tap)`, async () => {
    assert.equal(await page.locator(`#pklist .pk-opt[data-key="${KEY_OLD}"]`).count(), 0, 'not in the first three cycles');
    assert.match(await txt(page, '.pk-span'), /last 3 pay cycles/);
    await page.click('[data-action="pk-older"]');
    assert.equal(await page.locator(`#pklist .pk-opt[data-key="${KEY_OLD}"]`).count(), 1, 'listed after Show older');
    assert.match(await txt(page, '.pk-span'), /last 6 pay cycles/);
    const old = await page.locator(`#pklist .pk-opt[data-key="${KEY_OLD}"]`).innerText();
    assert.match(old, /Music Club/); assert.match(old, /50 days late/i); assert.match(old, /Assumed paid/i);
    await sheetNoHScroll(page, tag + ' picker older');
  });
  if (w !== 390) { await ctx.close(); continue; }
  await step(`${tag}: linking the DashPass bill: marked as matched, not added again (the line stops counting as spending), no spending created`, async () => {
    await page.keyboard.press('Escape'); await page.waitForSelector('#sheet[hidden]', { state: 'attached' });
    await page.waitForTimeout(200);
    const before = await spent(page), s0 = await getState(page);
    await openPicker(page, 'pp');
    await page.click(`.pk-opt[data-key="${KEY_DASH}"]`);
    await page.waitForFunction(k => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); return s.occ[k] && s.occ[k].txn === 'pl:pp'; }, KEY_DASH);
    const s = await getState(page);
    assert.equal(s.bank.seen['pl:pp'].res, 'bill'); assert.ok(!(KEY_DASH in s.marks), 'still assumed paid, not re-marked');
    assert.equal(s.occ[KEY_DASH].paidOn, TODAY, 'paid on the bank date');
    assert.equal(s.spends.length, s0.spends.length, 'no spending created'); assert.ok(!s.bank.inbox.some(x => x.txn.id === 'pl:pp'));
    assert.match(await page.locator('.tx[data-id="pl:pp"] .txc').innerText(), /^Matched · DoorDash DashPass/i);
    const after = await spent(page);
    assert.equal(+(before - after).toFixed(2), 9.99, `the $9.99 is counted once: spent ${before} -> ${after}`);
    assert.deepEqual(errs, []);
  });
  await step(`${tag}: a plan payment assumed paid by autopay (6 days back) links to the second line; undo restores it`, async () => {
    await openPicker(page, 'pp2');
    await page.click('#pklist .pk-opt[data-key="p:lamp:2"]');
    await page.waitForSelector('[data-action="cf-yes"]'); assert.match(await page.locator('#sheet').innerText(), /5 days after the due date/);
    await page.click('[data-action="cf-yes"]');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).occ['p:lamp:2']?.txn === 'pl:pp2');
    let s = await getState(page); assert.equal(s.bank.seen['pl:pp2'].res, 'match');
    assert.match(await chip(page, 'pp2'), /^Matched · PayPal · Lamp 2 of 4/i);
    await (await openRow(page, 'pp2')).locator('[data-action="tx-undo"]').click();
    s = await getState(page); assert.ok(!s.occ['p:lamp:2']?.txn); assert.ok(s.bank.inbox.some(x => x.txn.id === 'pl:pp2'), 'back in To review');
  });
  await ctx.close();
}
{
  // Unpaid bill (explicitly unticked) and an older (Show older) bill: link, confirm warnings, nothing double counted.
  const { ctx, page, errs } = await newPage(390, 844, { dark: false, txns: PAST_TXNS(), fixture: PAST_FX({ marks: { [KEY_DASH]: false } }) });
  await step('an unpaid DashPass bill due 3 days before is offered and linking it marks it paid on the bank date', async () => {
    await openPicker(page, 'pp');
    const o = page.locator(`#pklist .pk-opt[data-key="${KEY_DASH}"]`); assert.equal(await o.count(), 1);
    assert.doesNotMatch(await o.innerText(), /Assumed paid|Marked paid/);
    await o.click();
    await page.waitForFunction(k => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); return s.occ[k] && s.occ[k].txn === 'pl:pp'; }, KEY_DASH);
    const s = await getState(page); assert.notEqual(s.marks[KEY_DASH], false, 'no longer unticked'); assert.equal(s.occ[KEY_DASH].txn, 'pl:pp'); assert.equal(s.occ[KEY_DASH].paidOn, TODAY);
  });
  await step('the 50-day-old Music Club bill: Show older, the confirm step keeps its warnings, Match anyway links it', async () => {
    await openPicker(page, 'pp2');
    await page.click('[data-action="pk-older"]');
    await page.click(`#pklist .pk-opt[data-key="${KEY_OLD}"]`);
    await page.waitForSelector('.pk-warn');
    const w = await page.locator('.pk-warn').innerText();
    assert.match(w, /Date is 49 days after the due date/); assert.match(w, /Names don't look alike/);
    await page.click('[data-action="cf-yes"]');
    await page.waitForFunction(k => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); return s.occ[k] && s.occ[k].txn === 'pl:pp2'; }, KEY_OLD);
    const s = await getState(page); assert.equal(s.bank.seen['pl:pp2'].res, 'bill'); assert.ok(!(KEY_OLD in s.marks), 'assumed paid stays assumed paid');
    assert.deepEqual(errs, []);
  });
  await step('a bill linked to ANOTHER line is not offered again; the line it is linked to still sees it', async () => {
    // pl:pp is linked to DashPass, pl:pp2 to Music Club (the two steps above).
    await openPicker(page, 'pp2');
    assert.equal(await page.locator(`#pklist .pk-opt[data-key="${KEY_DASH}"]`).count(), 0, 'DashPass belongs to the other line');
    await page.click('[data-action="pk-older"]');
    assert.equal(await page.locator(`#pklist .pk-opt[data-key="${KEY_OLD}"]`).count(), 1, 'its own link may be matched again');
    await page.keyboard.press('Escape'); await page.waitForSelector('#sheet[hidden]', { state: 'attached' });
    await openPicker(page, 'pp');
    assert.equal(await page.locator(`#pklist .pk-opt[data-key="${KEY_DASH}"]`).count(), 1);
    await page.click('[data-action="pk-older"]');
    assert.equal(await page.locator(`#pklist .pk-opt[data-key="${KEY_OLD}"]`).count(), 0, 'Music Club belongs to pp2');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}
{
  // The Review sheet's Change panel for a "New PayPal plan?" line used to offer plan payments only.
  const { ctx, page } = await newPage(390, 844, { dark: true, txns: PAST_TXNS(), fixture: PAST_FX() });
  await step('Review one by one: Change on a PayPal line offers "Match to a bill or plan…", which opens the full picker with past bills', async () => {
    await page.click('#txreview [data-action="ix-open"]'); await page.waitForSelector('.bx[data-id="pl:pp"]');
    await page.locator('.bx[data-id="pl:pp"] [data-action="ix-change"]').click();
    assert.match(await txt(page, '.bx[data-id="pl:pp"] .bx-ch'), /Match to a bill or plan/i);
    await page.locator('.bx[data-id="pl:pp"] [data-action="ix-match"]').click(); await page.waitForSelector('.pk-opt');
    assert.equal(await page.locator(`#pklist .pk-opt[data-key="${KEY_DASH}"]`).count(), 1);
    await page.keyboard.press('Escape');
  });
  await ctx.close();
}

/* ---------- 2. To savings only where it makes sense ---------- */
{
  const TX = () => [T('dep', TODAY, 'MOBILE DEPOSIT', -250), T('zel', TODAY, 'ZELLE PAYMENT TO MAYA', 40), T('buy', TODAY, 'SHOPRITE 123', 41.2), T('ppb', TODAY, 'PAYPAL *SPOTIFY', 12.5),
    T('xfer', TODAY, 'ONLINE TRANSFER TO SAV 9876', 60), T('ppx', TODAY, 'PAYPAL INST XFER', 25), T('kl', TODAY, 'KLARNA*NIKE', 27.65), T('gas', TODAY, 'SHELL OIL 5521', 38)];
  const { ctx, page, errs } = await newPage(390, 844, { dark: false, txns: TX(), fixture: fixture({ bills: [], perPeriod: [] }) });
  const hasSv = async id => { const row = await openRow(page, id); const n = await row.locator('[data-action="tx-sv"]').count(); await row.locator('.tx-main').click(); return n === 1; };
  await step('To savings shows for a deposit, a Zelle line, transfer wording and PayPal transfer wording', async () => {
    for (const id of ['dep', 'zel', 'xfer', 'ppx']) assert.equal(await hasSv(id), true, id);
  });
  await step('To savings is not offered for purchases: grocery, gas, a PayPal purchase and a Klarna plan payment', async () => {
    for (const id of ['buy', 'gas', 'ppb', 'kl']) assert.equal(await hasSv(id), false, id);
  });
  await step('To savings on a deposit records a savings move (ledger in, row "Savings"), and Undo gives it back', async () => {
    const row = await openRow(page, 'dep'); await row.locator('[data-action="tx-sv"]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).savings.tx.length === 1);
    const s = await getState(page); assert.equal(s.savings.tx[0].type, 'in'); assert.equal(s.savings.tx[0].amount, 250); assert.equal(s.savings.on, true);
    assert.equal(s.bank.seen['pl:dep'].res, 'transfer'); assert.ok(s.bank.seen['pl:dep'].sv);
    assert.match(await chip(page, 'dep'), /^(Transfer|Savings)$/i);
    assert.equal(await page.locator('.tx[data-id="pl:dep"] [data-action="tx-sv"]').count(), 0, 'not again');
    await (await openRow(page, 'dep')).locator('[data-action="tx-undo"]').click();
    const u = await getState(page); assert.equal(u.savings.tx.length, 0); assert.ok(u.bank.inbox.some(x => x.txn.id === 'pl:dep'));
    assert.deepEqual(errs, []);
  });
  await step('"PAYPAL to <your own name>" is a transfer: To savings is offered; someone else\'s name is a PayPal line without it', async () => {
    const r = await newPage(390, 844, { dark: false, txns: [T('me', TODAY, 'PAYPAL to Jordan Smith', 50, CO), T('other', TODAY, 'PAYPAL to Maria Lopez', 20, CO)], fixture: fixture({ bills: [], perPeriod: [], displayName: 'Jordan Smith' }) });
    const has = async id => { const row = r.page.locator(`.tx[data-id="pl:${id}"]`); await row.locator('.tx-main').click(); const n = await row.locator('[data-action="tx-sv"]').count(); await row.locator('.tx-main').click(); return n; };
    assert.match(await r.page.locator('.tx[data-id="pl:me"]').innerText(), /Transfer|To review/i);
    assert.equal(await has('me'), 1); assert.equal(await has('other'), 0);
    assert.equal(await spent(r.page), '20.00', 'the transfer to yourself is not spending');
    await r.ctx.close();
  });
  await step('a purchase accepted as spending still has no To savings; a Zelle line accepted as spending keeps it', async () => {
    const r1 = await openRow(page, 'buy'); await r1.locator('[data-action="tx-cats"]').click(); await page.click('[data-action="tx-cat"][data-cat="Groceries"]');
    assert.match(await chip(page, 'buy'), /^Accepted · Groceries/i);
    assert.equal(await hasSv('buy'), false);
    const r2 = await openRow(page, 'zel'); await r2.locator('[data-action="tx-cats"]').click(); await page.click('[data-action="tx-cat"][data-cat="Other"]');
    assert.match(await chip(page, 'zel'), /^Accepted · Other/i);
    assert.equal(await (await openRow(page, 'zel')).locator('[data-action="tx-sv"]').count(), 1);
  });
  await ctx.close();
}

/* ---------- 3. Review flow ---------- */
const REV_TX = () => [T('g1', TODAY, 'SHOPRITE 123', 41.2), T('g2', addD(TODAY, -1), 'KROGER 55', 55.1), T('shell', TODAY, 'SHELL OIL 5521', 38, CHI, { status: 'pending' }), T('dd', addD(TODAY, -2), 'DOORDASH*CHICK FIL A', 24.5, CHI, { providerCategory: 'dining' }),
  T('nf', addD(TODAY, -2), 'NETFLIX.COM', 15.49, CHI), T('old', addD(TODAY, -3), 'PUBLIX 88', 12.3)];
for (const [w, h, dark] of [[390, 844, true], [669, 951, false], [951, 669, false]]) {
  const tag = `${w}x${h} ${dark ? 'dark' : 'light'}`;
  const { ctx, page, errs } = await newPage(w, h, { dark, txns: REV_TX(), fixture: fixture({ bills: [], perPeriod: [] }) });
  await step(`${tag}: chips are All · Accepted · Matched · Skipped, four equal cells, no page scroll`, async () => {
    const m = await page.evaluate(() => [...document.querySelectorAll('.tx-chips .chip')].map(e => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim(), w: r.width, top: Math.round(r.top), h: Math.round(r.height), fit: e.scrollWidth <= e.clientWidth + 1 }; }));
    assert.deepEqual(m.map(x => x.t.toLowerCase()), ['all', 'accepted', 'matched', 'skipped']);
    assert.ok(m.every(x => Math.abs(x.w - m[0].w) <= 1), 'equal widths ' + m.map(x => x.w)); assert.ok(m.every(x => x.top === m[0].top && x.h === m[0].h), 'one row, same height'); assert.ok(m.every(x => x.fit), 'labels fit');
    assert.equal(await page.locator('.tx-chips .chip:has-text("Review")').count(), 0);
    await noHScroll(page, tag + ' transactions');
  });
  await step(`${tag}: "To review · 6" sits on top of All with Accept all; the dated list has none of those rows; Pending keeps its tag`, async () => {
    const first = await page.locator('#txlist').evaluate(e => e.firstElementChild.id); assert.equal(first, 'txreview');
    const head = await txt(page, '#txreview .tx-rh'); assert.match(head, /^To review\s*6/i); assert.match(head, /Accept all \(\d+\)/i);
    assert.equal(await page.locator('#txreview .tx').count(), 6);
    assert.equal(await page.locator('#txlist > .tx, #txlist > .tx-day').count(), 0, 'nothing is in the dated list yet');
    assert.match(await chip(page, 'g1'), /^To review$/i);
    assert.match(await txt(page, '.tx[data-id="pl:shell"] .tx-s'), /pending/i);
    const beforeAll = await page.locator('.tx[data-id="pl:g1"]').count(); assert.equal(beforeAll, 1, 'a line shows once');
    if (w === 390 && dark) { await quiet(page); await page.waitForTimeout(300); await page.screenshot({ path: SHOTS + '/v21-tx-390.png' }); }
  });
  await step(`${tag}: the tab badge and the Overview bar count the lines to review`, async () => {
    assert.equal(await txt(page, '.tabs a[href="#transactions"] .badge'), '6');
    await page.goto(BASE + '#overview'); await page.waitForSelector('.bx-bar');
    assert.match(await txt(page, '.bx-bar'), /^6 new transactions/);
    await page.click('.bx-bar'); await page.waitForSelector('#txreview');
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => location.hash), '#transactions');
    assert.equal(await page.locator('.tx-chips .chip[aria-pressed="true"]').innerText(), 'All');
    const top = await page.locator('#txreview').evaluate(e => e.getBoundingClientRect().top); assert.ok(top >= -2 && top < 420, 'scrolled to the section: ' + top);
  });
  await step(`${tag}: Accept moves a line out of To review at once and into the dated list with its status chip; counts follow`, async () => {
    const row = await openRow(page, 'g1'); await row.locator('[data-action="tx-cats"]').click(); await page.click('[data-action="tx-cat"][data-cat="Groceries"]');
    await page.waitForFunction(() => !document.querySelector('#txreview .tx[data-id="pl:g1"]'));
    assert.equal(await page.locator('#txreview .tx').count(), 5); assert.match(await txt(page, '#txreview .tx-rh'), /^To review\s*5/i);
    assert.equal(await page.locator('#txlist > .tx[data-id="pl:g1"]').count(), 1, 'in the dated list');
    assert.match(await chip(page, 'g1'), /^Accepted · Groceries$/i);
    assert.equal(await txt(page, '.tabs a[href="#transactions"] .badge'), '5');
    await page.click('[data-action="tx-filter"][data-f="accepted"]'); assert.equal(await page.locator('.tx').count(), 1); assert.equal(await page.locator('#txreview').count(), 0, 'the section is only in All');
    await page.click('[data-action="tx-filter"][data-f="all"]');
  });
  await step(`${tag}: Skip leaves To review for Skipped; Accept all empties the section and the badge goes away`, async () => {
    const row = await openRow(page, 'old'); await row.locator('[data-action="tx-ignore"]').click();
    await page.waitForFunction(() => !document.querySelector('#txreview .tx[data-id="pl:old"]'));
    assert.match(await chip(page, 'old'), /^Skipped$/i);
    await page.click('[data-action="tx-filter"][data-f="ignored"]'); assert.equal(await page.locator('.tx').count(), 1); await page.click('[data-action="tx-filter"][data-f="all"]');
    await page.locator('#txreview [data-action="ix-all"]').click();
    await page.waitForFunction(() => !document.querySelector('#txreview'));
    assert.equal(await page.locator('#txlist > .tx').count(), 6);
    assert.equal(await page.locator('.tabs a[href="#transactions"] .badge').evaluate(e => e.hidden), true);
    await page.goto(BASE + '#overview'); await page.waitForTimeout(200); assert.equal(await page.locator('.bx-bar').count(), 0);
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 4. PayPal / Venmo double-count guard ---------- */
const APP = (id, date, amount, desc) => T(id, date, desc || 'DOORDASH DASHPASS', amount, PPA);
const BANK = (id, date, amount, desc) => T(id, date, desc || 'PAYPAL *DOORDASH', amount, CHI);
const DFX = () => fixture({ bills: [], perPeriod: [], categories: ['Groceries', 'Takeout Food', 'Subscriptions', 'Other'] });
const seenOf = async (page, id) => (await getState(page)).bank.seen['pl:' + id];
{
  const { ctx, page, errs, mock } = await newPage(390, 844, { dark: true, txns: [APP('app', addD(TODAY, -1), 9.99), BANK('bank', TODAY, 9.99)], fixture: DFX() });
  await step('both legs in one sync: the bank debit is "Same as PayPal payment" (seen dupe of the PayPal txn), only the PayPal line is in To review and counted once', async () => {
    const r = await seenOf(page, 'bank'); assert.equal(r.res, 'dupe'); assert.equal(r.of, 'pl:app');
    assert.deepEqual(await inReview(page), ['pl:app']);
    assert.match(await chip(page, 'bank'), /^Same as PayPal payment$/i);
    assert.equal(await spent(page), '9.99', 'counted once in Spent');
    assert.equal((await getState(page)).bank.inbox.some(x => x.txn.id === 'pl:bank'), false);
    await page.click('[data-action="tx-filter"][data-f="matched"]'); assert.equal(await page.locator('.tx[data-id="pl:bank"]').count(), 1, 'listed under Matched'); await page.click('[data-action="tx-filter"][data-f="all"]');
  });
  await step('the dupe row says what it is the same as, has Undo and no Accept / To savings; Undo counts it on its own, and the next sync does not pair it again', async () => {
    const row = await openRow(page, 'bank');
    assert.match(await row.innerText(), /Counted once, as DOORDASH DASHPASS|Counted once, as Doordash Dashpass/i);
    assert.equal(await row.locator('[data-action="tx-undo"]').count(), 1); assert.equal(await row.locator('[data-action="tx-sv"], [data-action="tx-cats"]').count(), 0);
    await row.locator('[data-action="tx-undo"]').click();
    assert.deepEqual((await inReview(page)).sort(), ['pl:app', 'pl:bank']);
    assert.equal(await spent(page), '19.98', 'both count when you say they are different');
    assert.equal((await getState(page)).bank.notDupe['pl:bank'], true);
    await syncNow(page, mock);
    assert.deepEqual((await inReview(page)).sort(), ['pl:app', 'pl:bank'], 'a new sync leaves them as you said');
    assert.ok(!(await seenOf(page, 'bank')));
    assert.deepEqual(errs, []);
  });
  await step('after Undo, accepting one leg does not link the pair the other way round', async () => {
    const row = await openRow(page, 'bank'); await row.locator('[data-action="tx-cats"]').click(); await page.click('[data-action="tx-cat"][data-cat="Subscriptions"]');
    assert.match(await chip(page, 'bank'), /^Accepted · Subscriptions/i);
    assert.ok(!(await seenOf(page, 'app')), 'the PayPal line is not turned into a dupe');
    assert.deepEqual(await inReview(page), ['pl:app']);
    await syncNow(page, mock);
    assert.ok(!(await seenOf(page, 'app'))); assert.deepEqual(await inReview(page), ['pl:app']);
  });
  await ctx.close();
}
{
  const { ctx, page, mock } = await newPage(390, 844, { dark: false, txns: [BANK('bank', TODAY, 9.99)], fixture: DFX() });
  await step('bank line first, PayPal transaction later: the bank line in To review becomes the dupe on the next sync', async () => {
    assert.deepEqual(await inReview(page), ['pl:bank']); assert.equal(await spent(page), '9.99');
    await syncNow(page, mock, [BANK('bank', TODAY, 9.99), APP('app', addD(TODAY, -2), 9.99)]);
    const r = await seenOf(page, 'bank'); assert.equal(r.res, 'dupe'); assert.equal(r.of, 'pl:app');
    assert.deepEqual(await inReview(page), ['pl:app']); assert.equal(await spent(page), '9.99');
    assert.match(await chip(page, 'bank'), /Same as PayPal payment/i);
  });
  await ctx.close();
}
{
  const { ctx, page, mock } = await newPage(390, 844, { dark: false, txns: [APP('app', addD(TODAY, -2), 9.99)], fixture: DFX() });
  await step('PayPal transaction first, bank line later: the bank line is the dupe from the start', async () => {
    assert.deepEqual(await inReview(page), ['pl:app']);
    await syncNow(page, mock, [APP('app', addD(TODAY, -2), 9.99), BANK('bank', TODAY, 9.99)]);
    assert.equal((await seenOf(page, 'bank')).res, 'dupe'); assert.deepEqual(await inReview(page), ['pl:app']); assert.equal(await spent(page), '9.99');
  });
  await step('the PayPal side accepted by hand, then it keeps being the one that counts', async () => {
    const row = await openRow(page, 'app'); await row.locator('[data-action="tx-cats"]').click(); await page.click('[data-action="tx-cat"][data-cat="Subscriptions"]');
    assert.match(await chip(page, 'app'), /^Accepted · Subscriptions/i); assert.match(await chip(page, 'bank'), /Same as PayPal payment/i); assert.equal(await spent(page), '9.99');
  });
  await ctx.close();
}
{
  const { ctx, page, mock } = await newPage(390, 844, { dark: false, txns: [BANK('bank', TODAY, 9.99)], fixture: DFX() });
  await step('the bank line accepted by hand first; when the PayPal side arrives it is linked as the same payment, not counted again', async () => {
    const row = await openRow(page, 'bank'); await row.locator('[data-action="tx-cats"]').click(); await page.click('[data-action="tx-cat"][data-cat="Subscriptions"]');
    assert.match(await chip(page, 'bank'), /^Accepted · Subscriptions/i); assert.equal(await spent(page), '9.99');
    await syncNow(page, mock, [BANK('bank', TODAY, 9.99), APP('app', addD(TODAY, -1), 9.99)]);
    const r = await seenOf(page, 'app'); assert.equal(r.res, 'dupe'); assert.equal(r.of, 'pl:bank');
    assert.match(await chip(page, 'app'), /^Same as bank payment$/i); assert.deepEqual(await inReview(page), []); assert.equal(await spent(page), '9.99');
    assert.match(await chip(page, 'bank'), /^Accepted/i);
  });
  await ctx.close();
}
{
  const { ctx, page, mock } = await newPage(390, 844, { dark: false, txns: [APP('a1', addD(TODAY, -4), 9.99), BANK('b1', TODAY, 9.99), APP('a2', addD(TODAY, -1), 14.5, 'SPOTIFY'), BANK('b2', TODAY, 15.5, 'PAYPAL *SPOTIFY')], fixture: DFX() });
  await step('not paired: PayPal side 4 days earlier, and a different amount', async () => {
    assert.ok(!(await seenOf(page, 'b1')) && !(await seenOf(page, 'b2')));
    assert.deepEqual((await inReview(page)).sort(), ['pl:a1', 'pl:a2', 'pl:b1', 'pl:b2']);
    assert.equal(await spent(page), (9.99 * 2 + 14.5 + 15.5).toFixed(2));
  });
  await step('Venmo: the Venmo app transaction and the "VENMO PAYMENT" bank debit are one payment', async () => {
    await syncNow(page, mock, [...mock.txns, T('va', addD(TODAY, -2), 'Maya', 25, VNA), T('vb', TODAY, 'VENMO PAYMENT 4455', 25, CHI)]);
    const r = await seenOf(page, 'vb'); assert.equal(r.res, 'dupe'); assert.equal(r.of, 'pl:va'); assert.match(await chip(page, 'vb'), /^Same as Venmo payment$/i);
    assert.ok(!(await seenOf(page, 'va')));
  });
  await step('the line only on the bank side (no PayPal item) behaves as before: a normal line to review', async () => {
    const r = await newPage(390, 844, { dark: false, txns: [BANK('solo', TODAY, 9.99)], fixture: DFX() });
    assert.deepEqual(await inReview(r.page), ['pl:solo']); assert.equal(await spent(r.page), '9.99'); await r.ctx.close();
  });
  await ctx.close();
}

/* ---------- 5. Screenshot entries ---------- */
for (const [w, h, dark] of [[390, 844, true], [951, 669, false]]) {
  const tag = `${w}x${h} ${dark ? 'dark' : 'light'}`;
  const shotSpend = { id: 'sh1', category: 'Dining Out', desc: 'El Meson', amount: 23.4, date: addD(TODAY, -1), via: '', note: '', shot: { at: new Date().toISOString(), bank: 'Chime', pending: false, rawMerchant: 'SQ *EL MESON R', accountHint: '' } };
  const { ctx, page, errs, mock } = await newPage(w, h, { dark, txns: [T('g1', TODAY, 'SHOPRITE 123', 41.2)], fixture: fixture({ bills: [], perPeriod: [], spends: [shotSpend] }) });
  await step(`${tag}: screenshot entries read "From screenshots", have a small photo icon and no "waiting" wording anywhere`, async () => {
    assert.match(await txt(page, '.shot-wait .tx-day'), /^From screenshots$/i);
    assert.equal(await page.locator('.shot-wait .shot-w .shot-ic svg').count(), 1, 'photo icon');
    assert.equal(await page.locator('.shot-wait .tag.shot').count(), 0, 'no warning-style chip');
    assert.doesNotMatch(await page.locator('#main').innerText(), /waiting/i);
    assert.equal(await page.locator('#txreview').evaluate(e => e.compareDocumentPosition(document.querySelector('.shot-wait')) & Node.DOCUMENT_POSITION_FOLLOWING), 4, 'To review stays on top');
    await page.goto(BASE + '#overview'); await page.waitForSelector('.hero');
    assert.doesNotMatch(await page.locator('#main').innerText(), /waiting for bank|Screenshot · waiting/i);
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx');
    await noHScroll(page, tag + ' screenshots');
  });
  await step(`${tag}: once the bank line arrives and links, the entry shows the photo icon and "Matched with bank"`, async () => {
    await syncNow(page, mock, [T('g1', TODAY, 'SHOPRITE 123', 41.2), T('meson', addD(TODAY, -1), 'SQ *EL MESON R 4412', 23.4)]);
    assert.equal(await page.locator('.shot-wait').count(), 0, 'no longer listed as unlinked');
    const s = await getState(page); assert.equal(s.spends.find(x => x.id === 'sh1').bank, 'pl:meson'); assert.equal(s.bank.seen['pl:meson'].src, 'shot');
    assert.match(await chip(page, 'meson'), /^Matched with bank$/i);
    assert.equal(await page.locator('.tx[data-id="pl:meson"] .txc svg').count(), 1, 'photo icon in the chip');
    await page.click('[data-action="tx-filter"][data-f="matched"]'); assert.equal(await page.locator('.tx[data-id="pl:meson"]').count(), 1); await page.click('[data-action="tx-filter"][data-f="all"]');
    await page.goto(BASE + '#overview'); await page.waitForSelector('.hero');
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 6. Plans switch centered ---------- */
for (const [w, h, dark] of [[390, 844, true], [669, 951, false], [951, 669, true]]) {
  const tag = `${w}x${h} ${dark ? 'dark' : 'light'}`;
  const { ctx, page, errs } = await newPage(w, h, { dark, hash: '#plans', noSync: true, fixture: fixture({ bank: { seen: {}, rules: {}, links: {}, lastSync: null, inbox: [], autoFrom: addD(TODAY, -40), historyFrom: addD(TODAY, -90), txns: {} } }) });
  await step(`${tag}: "Pay later | Credit cards" is centered on the Plans tab in both views`, async () => {
    for (const v of ['plans', 'cards']) {
      await page.click(`.plans-seg [data-v="${v}"]`); await page.waitForTimeout(150);
      const m = await page.evaluate(() => { const s = document.querySelector('.plans-seg').getBoundingClientRect(), st = document.querySelector('#main .stack').getBoundingClientRect(), cr = document.querySelector('#main').getBoundingClientRect(); return { seg: s.left + s.width / 2, stack: st.left + st.width / 2, card: cr.left + cr.width / 2, vw: document.documentElement.clientWidth / 2 }; });
      assert.ok(Math.abs(m.seg - m.stack) <= 2, v + ' seg ' + m.seg + ' vs stack ' + m.stack);
      assert.ok(Math.abs(m.seg - m.card) <= 2, v + ' seg vs the content column ' + m.card);
      assert.ok(Math.abs(m.seg - m.vw) <= 2, v + ' seg vs viewport ' + m.vw);
    }
    await noHScroll(page, tag + ' plans');
    if (w === 390) { await page.click('.plans-seg [data-v="plans"]'); await quiet(page); await page.waitForTimeout(250); await page.screenshot({ path: SHOTS + '/v21-plans-390.png' }); }
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

/* ---------- 7. Service logos card ---------- */
for (const [w, h, dark] of [[390, 844, true], [669, 951, false], [951, 669, true]]) {
  const tag = `${w}x${h} ${dark ? 'dark' : 'light'}`;
  const { ctx, page, errs } = await newPage(w, h, { dark, hash: '#income', txns: [T('dl', TODAY, 'DURANLAUNDROMA', 18.5), T('nf', TODAY, 'NETFLIX.COM', 15.49)], fixture: fixture({ bills: [], perPeriod: [] }), settings: { svcIcons: false } });
  await step(`${tag}: Service logos is collapsed by default, its header shows a count, and it opens and stays open after a reload`, async () => {
    const head = page.locator('#svclogos .coll-h');
    assert.equal(await head.getAttribute('aria-expanded'), 'false'); assert.equal(await page.locator('#coll-logos').evaluate(e => e.hidden), true);
    assert.equal(await page.locator('#svclogos [data-action="logo-add"]').isVisible(), false);
    assert.match(await head.innerText(), /Service logos\s*\d+/);
    const n = +(await head.locator('.meta').innerText()); assert.ok(n >= 7, 'count ' + n);
    await head.click(); assert.equal(await head.getAttribute('aria-expanded'), 'true'); assert.equal(await page.locator('#svclogos [data-action="logo-add"]').isVisible(), true);
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#svclogos');
    assert.equal(await page.locator('#svclogos .coll-h').getAttribute('aria-expanded'), 'true', 'remembered like Paid via and Categories');
    await page.locator('#svclogos .coll-h').click(); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#svclogos');
    assert.equal(await page.locator('#svclogos .coll-h').getAttribute('aria-expanded'), 'false', 'collapsing is remembered too');
    await noHScroll(page, tag + ' logos card');
  });
  await step(`${tag}: "Add a logo" sheet: name with suggestions + picture; saved under a custom key that later matches the merchant by name`, async () => {
    await page.locator('#svclogos .coll-h').click();
    assert.equal(await page.locator('#svclogos .card-b > div:first-child [data-action="logo-add"]').count(), 1, 'button on top of the card body');
    await page.click('#svclogos [data-action="logo-add"]'); await page.waitForSelector('#logoadd');
    assert.match(await txt(page, '#sheetBody h3'), /add a logo/i);
    // suggestions: known services and merchants found in the data
    const sug0 = (await page.locator('.la-sug .chip').allInnerTexts()).map(x => x.trim());
    assert.ok(sug0.length >= 3, 'suggestions: ' + sug0);
    await page.fill('#la-name', 'dur');
    assert.ok((await page.locator('.la-sug .chip').allInnerTexts()).some(x => /^Duranlaundroma/i.test(x.trim())), 'the merchant found in your bank lines is suggested');
    await page.fill('#la-name', 'net'); assert.ok((await page.locator('.la-sug .chip').allInnerTexts()).some(x => /^Netflix$/i.test(x.trim())));
    await page.fill('#la-name', 'Duran Laundromat');
    // saving without a picture asks for one
    await page.click('#logoadd button[type=submit]'); assert.match(await txt(page, '#ferr'), /choose a picture/i);
    await page.setInputFiles('#la-file', { name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForSelector('#la-prev img');
    await sheetNoHScroll(page, tag + ' add logo sheet');
    if (w === 390) { await quiet(page); await page.waitForTimeout(250); await page.screenshot({ path: SHOTS + '/v21-logos-390.png' }); }
    await page.click('#logoadd button[type=submit]');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).logos.duranlaundromat);
    const s = await getState(page); assert.match(s.logos.duranlaundromat, /^data:image\/png/); assert.equal(s.logoNames.duranlaundromat, 'Duran Laundromat');
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#svclogos');
    assert.equal((await getState(page)).logoNames.duranlaundromat, 'Duran Laundromat', 'kept across a reload');
    assert.ok(await page.locator('#svclogos .svc-list li', { hasText: 'Duran Laundromat' }).locator('[data-action="logo-rm"]').count(), 'listed with Remove');
    assert.equal(await page.locator('#svclogos [data-action="logo-add"]').isVisible(), true, 'the card stays open');
    // a known service typed by name uses its own key
    await page.click('#svclogos [data-action="logo-add"]'); await page.fill('#la-name', 'Netflix'); await page.setInputFiles('#la-file', { name: 'n.png', mimeType: 'image/png', buffer: PNG }); await page.waitForSelector('#la-prev img');
    await page.click('#logoadd button[type=submit]'); await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).logos.netflix);
    // the bank line's own (cut-off) merchant name picks the logo up on the Transactions tab
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx[data-id="pl:dl"]');
    assert.equal(await page.locator('.tx[data-id="pl:dl"] .slogo img[data-own]').count(), 1, 'own logo on the merchant row');
    assert.equal(await page.locator('.tx[data-id="pl:nf"] .slogo img[data-own]').count(), 1);
    // Remove (per row) stays
    await page.goto(BASE + '#income'); await page.waitForSelector('#svclogos');
    await page.locator('#svclogos .svc-list li', { hasText: 'Duran Laundromat' }).locator('[data-action="logo-rm"]').click();
    const r = await getState(page); assert.ok(!r.logos.duranlaundromat && !(r.logoNames || {}).duranlaundromat);
    assert.equal(await page.locator('#svclogos .svc-list li', { hasText: 'Duran Laundromat' }).count(), 0);
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

await b.close();
finish();
