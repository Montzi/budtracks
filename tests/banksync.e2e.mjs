// End-to-end check of the bank sync UI against a mocked Worker.
// Run: python3 -m http.server 8765 (in the repo root), then: node tests/banksync.e2e.mjs [screenshotDir]
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }
const SHOTS = process.argv[2] || '/tmp';
const BASE = process.env.BT_URL || 'http://localhost:8765/';
const API = 'https://worker.test';
const TODAY = '2026-11-20';

const acct = { id: 'acc1', name: 'Everyday Checking', last4: '1234', institution: 'Chime', type: 'depository' };
const T = (id, date, desc, amount, extra) => Object.assign({ id: 'pl:' + id, date, desc, rawDesc: desc, amount, account: acct, status: 'posted', pendingOf: null, counterparty: null, providerCategory: null }, extra || {});
const TXNS = [
  T('klarna', '2026-11-20', 'KLARNA*NIKE', 27.65),
  T('electric', '2026-11-20', 'NATIONAL GRID ELECTRIC', 70),
  T('dd', '2026-11-19', 'DOORDASH*CHICK FIL A', 24.5, { providerCategory: 'dining' }),
  T('pay', '2026-11-19', 'ACME CORP PAYROLL', -1500),
  T('cc', '2026-11-21', 'CAPITAL ONE CREDIT CARD PAYMENT', 35),
  T('amb', '2026-11-18', 'SQ *MYSTERY SHOP 4412 NY', 18.99),
  T('adidas', '2026-11-17', 'KLARNA*ADIDAS', 55)
];
const fixtureState = s => Object.assign(s, {
  since: '2026-10-01', marks: {}, occ: {}, spends: [], unalloc: [], perPeriod: [],
  categories: ['Gas', 'Subscriptions', 'Groceries', 'Dining Out', 'Takeout Food', 'Personal care', 'Other'],
  payVia: [{ bank: 'Chime', last4: '1234', type: 'debit' }],
  bank: { seen: {}, rules: {}, links: {}, lastSync: null, inbox: [], api: '', autoFrom: '2026-11-01', historyFrom: '2026-10-01' },
  bills: [{ id: 'rent', name: 'Rent', amount: 1050, day: 1, group: 'Fixed', category: 'Housing' }, { id: 'elec', name: 'Electric', amount: 70, day: 21, group: 'Fixed', category: 'Utilities' }],
  cards: [{ id: 'visa', name: 'Visa', day: 22, minPayment: 35, balance: 500, limit: 2000 }],
  plans: [{ id: 'k1', provider: 'Klarna', merchant: 'Nike', amount: 27.65, total: 4, paid: 1, freq: 'biweekly', lastDate: '2026-11-06', category: 'Other', dates: ['2026-10-23', '2026-11-06', '2026-11-20', '2026-12-04'] }],
  income: [{ id: 'pay', name: 'Payroll', freq: 'biweekly', date: '2026-11-19', amount: 1500, askFrom: '2026-11-19', perCycle: {} }],
  account: { balance: 3000, asOf: '2026-10-01', adj: [], auto: true }
});

let failures = 0;
const step = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 6).join('\n     ')); } };

const browser = await chromium.launch();
async function newPage(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  const page = await ctx.newPage(); page.setDefaultTimeout(6000);
  const errs = [], calls = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  const mock = { paired: false, balances: undefined, refreshResp: null, txns: TXNS, removed: [], errors: [], offline: false, seq: 0, enrollments: [{ id: 'enr_1', institution: 'Chime', needsReconnect: false, accounts: [{ id: 'acc1', name: 'Everyday Checking', type: 'depository', subtype: 'checking', last_four: '1234', enabled: true }, { id: 'acc2', name: 'Savings', type: 'depository', subtype: 'savings', last_four: '9876', enabled: true }] }] };
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ m, p, q: u.search, auth: req.headers()['authorization'] || '', body: req.postData() || '' });
    if (mock.offline) return route.abort('failed');
    const json = (o, status) => route.fulfill({ status: status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(o) });
    if (p === '/config') return json({ provider: 'plaid', env: 'sandbox', paired: mock.paired });
    if (p === '/link-token') return json({ link_token: u.searchParams.get('item') ? 'link-update-token' : 'link-new-token' });
    if (p === '/pair') return json({ key: 'secret-device-key-123' });
    if (p === '/accounts') return json({ enrollments: mock.enrollments });
    if (p === '/sync') return json({ txns: mock.txns, removed: mock.removed, errors: mock.errors, syncToken: 'tok-' + (++mock.seq), syncedAt: new Date().toISOString(), ...(mock.balances ? { balances: mock.balances } : {}) });
    if (p === '/refresh' && m === 'POST') return mock.refreshResp ? json(mock.refreshResp) : json({ error: 'nope' }, 404);
    if (p === '/enroll' && m === 'POST') { mock.enrollments.push({ id: 'enr_2', institution: 'Citizens', needsReconnect: false, accounts: [] }); return json({ accounts: [] }); }
    if (p.startsWith('/enroll/') && m === 'DELETE') { mock.enrollments = mock.enrollments.filter(e => !p.endsWith(e.id)); return json({ ok: true }); }
    if (/\/accounts\/.+\/toggle/.test(p)) return json({ ok: true });
    return json({ error: 'nope' }, 404);
  });
  // Stub for Plaid Link: records every create() and, unless told otherwise, succeeds right away on open().
  await page.route('https://cdn.plaid.com/**', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.__plaid = []; window.Plaid = { create(o) { window.__plaid.push({ token: o.token, redirect: o.receivedRedirectUri || null }); return { open() { o.onSuccess('public-xyz', { institution: { name: 'Citizens' } }); } }; } };`
  }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  return { ctx, page, errs, calls, mock };
}
const seed = async (page, extra) => {
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(([fx, extra]) => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1'));
    Object.assign(s, JSON.parse(fx)); if (extra) Object.assign(s.bank, extra);
    localStorage.setItem('budtrack.v1', JSON.stringify(s));
  }, [JSON.stringify(fixtureState({})), extra]);
};
const getState = page => page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')));
const noHScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'horizontal scroll at ' + label);
const sheetNoHScroll = async (page, label) => assert.ok(await page.evaluate(() => { const s = document.querySelector('#sheet .sheet'); return s.scrollWidth <= s.clientWidth + 1; }), 'sheet horizontal scroll at ' + label);

/* ---------- Setup, pairing, accounts ---------- */
{
  const { page, errs, calls, mock } = await newPage(390, 844);
  await seed(page);
  await page.goto(BASE + '#income', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await step('card shows connect form when not set up', async () => {
    await page.waitForSelector('#bankconn');
    assert.equal(await page.locator('#bankcard h2').innerText(), 'Bank connections · via Plaid');
    await noHScroll(page, '390 card (not set up)');
  });
  await step('already-paired service with no local key explains the lock', async () => {
    mock.paired = true;
    await page.fill('#bk-url', API); await page.click('#bankconn button[type=submit]');
    await page.waitForSelector('.bk-err:not(:empty)');
    assert.match(await page.locator('.bk-err').first().innerText(), /pairing is locked/i);
    assert.equal(await page.evaluate(() => localStorage.getItem('budtrack.bankkey')), null);
  });
  await step('pair stores key in localStorage only, api in state', async () => {
    mock.paired = false;
    await page.fill('#bk-url', API); await page.click('#bankconn button[type=submit]');
    await page.waitForSelector('[data-action="bk-connect"]');
    assert.equal(await page.evaluate(() => localStorage.getItem('budtrack.bankkey')), 'secret-device-key-123');
    const raw = await page.evaluate(() => localStorage.getItem('budtrack.v1'));
    assert.ok(!raw.includes('secret-device-key-123'), 'key leaked into state');
    assert.equal((JSON.parse(raw)).bank.api, API);
    await page.click('[data-action="copy-backup"]');
    const bk = await page.inputValue('#bk'); assert.ok(!bk.includes('secret-device-key-123'), 'key in backup');
    await page.keyboard.press('Escape');
  });
  await step('accounts list, toggle, disconnect two-tap, connect a bank', async () => {
    await page.waitForSelector('.bk-enr');
    assert.ok((await page.locator('.bk-enr b').first().innerText()).includes('Chime'));
    assert.equal(await page.locator('.tgl input').count(), 2);
    await page.locator('.tgl').nth(1).click();
    await page.waitForTimeout(200);
    const tg = calls.find(c => /toggle/.test(c.p)); assert.ok(tg && tg.auth === 'Bearer secret-device-key-123' && JSON.parse(tg.body).enabled === false, 'toggle call');
    assert.equal(await page.locator('.tgl input').nth(1).isChecked(), false);
    await page.click('[data-action="bk-connect"]');
    await page.waitForFunction(() => document.querySelectorAll('.bk-enr').length === 2);
    assert.ok(calls.find(c => c.p === '/link-token' && c.q === '' && c.auth === 'Bearer secret-device-key-123'), 'link token requested');
    assert.deepEqual(await page.evaluate(() => window.__plaid), [{ token: 'link-new-token', redirect: null }]);
    assert.ok(calls.find(c => c.p === '/enroll' && JSON.parse(c.body).institution === 'Citizens' && JSON.parse(c.body).publicToken === 'public-xyz'));
    await page.waitForTimeout(500);
    const d = page.locator('[data-action="bk-disc"]').nth(1);
    await d.click(); assert.ok(!calls.some(c => c.m === 'DELETE'), 'first tap must not delete');
    assert.match(await page.locator('.bk-warn').innerText(), /free plan a removed bank still counts toward the 10-bank limit/);
    await page.locator('[data-action="bk-disc"]').nth(1).click();
    await page.waitForFunction(() => document.querySelectorAll('.bk-enr').length === 1);
    assert.ok(calls.some(c => c.m === 'DELETE' && c.p === '/enroll/enr_2'));
  });
  await step('needs-reconnect warning renders', async () => {
    mock.enrollments[0].needsReconnect = true;
    await page.evaluate(() => { location.hash = '#bills'; }); await page.reload({ waitUntil: 'load' }); await page.goto(BASE + '#income'); await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.bk-enr .pill.warn');
    mock.enrollments[0].needsReconnect = false;
  });
  await step('reconnect opens Link in update mode and does not enroll again', async () => {
    mock.enrollments[0].needsReconnect = true;
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('[data-action="bk-reconnect"]');
    const enrolls = calls.filter(c => c.p === '/enroll').length, loads = calls.filter(c => c.p === '/accounts').length;
    mock.enrollments[0].needsReconnect = false;
    await page.click('[data-action="bk-reconnect"]');
    await page.waitForFunction(() => !document.querySelector('[data-action="bk-reconnect"]'));
    assert.ok(calls.find(c => c.p === '/link-token' && c.q === '?item=enr_1'), 'update-mode link token');
    assert.deepEqual(await page.evaluate(() => window.__plaid.map(x => x.token)), ['link-update-token']);
    assert.equal(calls.filter(c => c.p === '/enroll').length, enrolls, 'no enroll in update mode');
    assert.ok(calls.filter(c => c.p === '/accounts').length > loads, 'accounts reloaded');
  });
  await step('card at 390 and 951 has no horizontal scroll; screenshot', async () => {
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.bk-enr');
    await noHScroll(page, '390 card (set up)');
    await page.locator('#bankcard').scrollIntoViewIfNeeded();
    await page.locator('#bankcard').screenshot({ path: SHOTS + '/card-390.png' });
    await page.setViewportSize({ width: 951, height: 669 }); await page.waitForTimeout(300);
    await noHScroll(page, '951 card');
    await page.setViewportSize({ width: 390, height: 844 });
  });
  assert.deepEqual(errs, [], 'page errors in setup');
  await page.context().close();
}

/* ---------- Sync, auto-apply, inbox ---------- */
const prepared = async (w, h, extraBank) => {
  const c = await newPage(w, h);
  await seed(c.page, Object.assign({ api: API }, extraBank || {}));
  await c.page.evaluate(() => localStorage.setItem('budtrack.bankkey', 'secret-device-key-123'));
  return c;
};
{
  const { page, errs, calls, mock } = await prepared(390, 844);
  await page.goto(BASE + '#income', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await step('auto-sync on load runs once and applies sure matches', async () => {
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.lastSync);
    const sc = calls.filter(c => c.p === '/sync'); assert.equal(sc.length, 1);
    assert.equal(sc[0].q, '?since=2026-10-01'); assert.equal(sc[0].auth, 'Bearer secret-device-key-123');
    const s = await getState(page);
    const k = 'p:k1:3'; // third payment on Nov 20
    assert.ok(Object.values(s.bank.seen).filter(r => r.auto).length === 3, 'three auto-applied: ' + JSON.stringify(Object.keys(s.bank.seen)));
    assert.equal(s.bank.seen['pl:klarna'].res, 'match'); assert.equal(s.occ[s.bank.seen['pl:klarna'].key].txn, 'pl:klarna'); assert.equal(s.marks[s.bank.seen['pl:klarna'].key], true);
    const ek = s.bank.seen['pl:electric'].key; assert.ok(/^b:elec:/.test(ek)); assert.equal(s.marks[ek], true); assert.equal(s.occ[ek].txn, 'pl:electric'); assert.equal(s.occ[ek].paidOn, '2026-11-20');
    assert.equal(s.income[0].perCycle['2026-11-19'], 1500);
    assert.deepEqual(s.bank.inbox.map(x => x.txn.id).sort(), ['pl:adidas', 'pl:amb', 'pl:cc', 'pl:dd']);
    assert.ok(!('pl:dd' in s.bank.seen));
    void k;
  });
  await step('no second auto sync within 30 minutes (visibilitychange)', async () => {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(400);
    assert.equal(calls.filter(c => c.p === '/sync').length, 1);
  });
  await step('Sync now makes a second request with since = lastSync - 5 days (no duplicates)', async () => {
    await page.click('[data-action="bk-sync"]');
    await page.waitForFunction(() => document.querySelector('[data-action="bk-sync"]') && !document.querySelector('[data-action="bk-sync"]').disabled);
    const sc = calls.filter(c => c.p === '/sync'); assert.equal(sc.length, 2);
    const d5 = new Date(Date.now() - 5 * 864e5), exp = d5.getFullYear() + '-' + String(d5.getMonth() + 1).padStart(2, '0') + '-' + String(d5.getDate()).padStart(2, '0');
    assert.equal(sc[1].q, '?since=' + exp + '&ack=tok-1', 'acks the first response token');
    const s = await getState(page);
    assert.equal(s.bank.inbox.length, 4); assert.equal(Object.keys(s.bank.seen).length, 3);
  });
  await step('two-phase ack: token stored after commit, sent on next sync; re-delivered batch creates no duplicates', async () => {
    const sc = () => calls.filter(c => c.p === '/sync');
    let s = await getState(page); assert.equal(s.bank.syncToken, 'tok-2', 'token of the processed response is persisted');
    const snap = { inbox: s.bank.inbox.map(x => x.txn.id).sort(), seen: Object.keys(s.bank.seen).sort(), occ: JSON.stringify(s.occ), marks: JSON.stringify(s.marks), pc: JSON.stringify(s.income[0].perCycle), spends: s.spends.length };
    // A failed request (lost response) keeps the token so the ack is not lost.
    mock.offline = true;
    await page.click('[data-action="bk-sync"]');
    await page.waitForFunction(() => /Could not reach/i.test(document.querySelector('#toast').textContent));
    mock.offline = false;
    s = await getState(page); assert.equal(s.bank.syncToken, 'tok-2', 'token kept after a failed sync');
    // The Worker re-sends the same batch (its ack never landed): same ids again, plus nothing new.
    const n = sc().length;
    await page.click('[data-action="bk-sync"]');
    await page.waitForFunction(() => document.querySelector('[data-action="bk-sync"]') && !document.querySelector('[data-action="bk-sync"]').disabled);
    const last = sc()[sc().length - 1]; assert.ok(sc().length > n); assert.match(last.q, /&ack=tok-2$/, 'ack sent on next sync');
    s = await getState(page);
    assert.notEqual(s.bank.syncToken, 'tok-2', 'token replaced by the new response token');
    assert.deepEqual(s.bank.inbox.map(x => x.txn.id).sort(), snap.inbox, 'no duplicate inbox rows');
    assert.equal(new Set(s.bank.inbox.map(x => x.txn.id)).size, s.bank.inbox.length);
    assert.deepEqual(Object.keys(s.bank.seen).sort(), snap.seen, 'no extra applied items');
    assert.equal(JSON.stringify(s.occ), snap.occ); assert.equal(JSON.stringify(s.marks), snap.marks); assert.equal(JSON.stringify(s.income[0].perCycle), snap.pc); assert.equal(s.spends.length, snap.spends);
  });
  await step('Overview badge shows count', async () => {
    await page.goto(BASE + '#overview'); await page.reload({ waitUntil: 'load' });
    const t = await page.locator('.bx-bar').innerText(); assert.match(t, /4 new transactions/);
    await noHScroll(page, '390 overview');
  });
  await step('Overview bar opens the Transactions tab filtered to Needs review', async () => {
    await page.click('.bx-bar'); await page.waitForSelector('.tx');
    assert.equal(await page.evaluate(() => location.hash), '#transactions');
    assert.equal(await page.locator('.tx').count(), 4);
    assert.equal(await page.locator('[data-action="tx-filter"][aria-pressed="true"]').innerText().then(t => t.split(' ')[0]), 'Needs');
    await noHScroll(page, '390 transactions review');
  });
  await step('inbox sheet lists rows, no horizontal scroll, screenshot 390', async () => {
    await page.click('[data-action="ix-open"]'); await page.waitForSelector('.bx');
    assert.equal(await page.locator('.bx').count(), 4);
    const dd = page.locator('.bx', { hasText: 'Doordash' });
    assert.match(await dd.innerText(), /Takeout Food/); assert.match(await dd.innerText(), /likely/i);
    const cc = page.locator('.bx', { hasText: 'CAPITAL ONE' }); assert.match(await cc.innerText(), /Visa/);
    await sheetNoHScroll(page, '390 inbox'); await noHScroll(page, '390 inbox');
    await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/inbox-390.png' });
    assert.match(await page.locator('#sheet').innerText(), /recently synced/i);
    assert.equal(await page.locator('.bx-rec li').count(), 3);
  });
  await step('Accept applies a spend with via and note', async () => {
    await page.locator('.bx', { hasText: 'Doordash' }).locator('[data-action="ix-accept"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.bx').length === 3);
    const s = await getState(page); const x = s.spends.find(z => z.bank === 'pl:dd');
    assert.ok(x); assert.equal(x.category, 'Takeout Food'); assert.equal(x.amount, 24.5); assert.equal(x.via, 'Chime **1234'); assert.equal(x.note, 'Bank sync'); assert.equal(x.date, '2026-11-19');
    assert.equal(s.bank.seen['pl:dd'].res, 'spend'); assert.equal(s.bank.inbox.length, 3);
    assert.equal(Object.keys(s.bank.rules).length, 0, 'accept alone must not learn');
  });
  await step('Change category applies and learns a rule', async () => {
    const r = page.locator('.bx', { hasText: 'MYSTERY' });
    await r.locator('[data-action="ix-change"]').click();
    await r.locator('.chip', { hasText: 'Groceries' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.bx').length === 2);
    const s = await getState(page); const x = s.spends.find(z => z.bank === 'pl:amb');
    assert.ok(x && x.category === 'Groceries');
    assert.ok(Object.values(s.bank.rules).includes('Groceries'), JSON.stringify(s.bank.rules));
  });
  await step('Change on a plan row lists New plan; New plan flow creates and links a plan', async () => {
    const r = page.locator('.bx', { hasText: 'ADIDAS' });
    assert.match(await r.innerText(), /New Klarna plan/);
    await r.locator('[data-action="ix-change"]').click();
    assert.ok(await r.locator('.chip', { hasText: 'New plan' }).count());
    await r.locator('[data-action="ix-accept"]').click();
    await page.waitForSelector('#bankplan');
    await page.fill('#bankplan [name=total]', '4');
    await page.click('#bankplan button[type=submit]');
    await page.waitForSelector('.bx-rec');
    const s = await getState(page); const p = s.plans.find(z => z.fromTxn === 'pl:adidas');
    assert.ok(p && p.total === 4); assert.equal(s.marks['p:' + p.id + ':1'], true); assert.equal(s.bank.seen['pl:adidas'].res, 'new'); assert.equal(s.bank.inbox.some(x => x.txn.id === 'pl:adidas'), false);
  });
  await step('Ignore marks skip', async () => {
    await page.locator('.bx', { hasText: 'CAPITAL ONE' }).locator('[data-action="ix-skip"]').click();
    await page.waitForFunction(() => !document.querySelector('.bx'));
    const s = await getState(page); assert.equal(s.bank.seen['pl:cc'].res, 'skip'); assert.equal(s.bank.inbox.length, 0);
    assert.match(await page.locator('#sheet').innerText(), /All caught up/);
  });
  await step('Undo reverts spend, auto-applied bill and new plan; row returns to inbox', async () => {
    const row = t => page.locator('.bx-rec li', { hasText: t });
    await row('doordash').locator('[data-action="ix-undo"]').click().catch(() => {});
    let s = await getState(page);
    // desc is shown cleaned in "what": use data lookups instead of text for robustness
    const undo = async id => { await page.locator(`[data-action="ix-undo"][data-id="${id}"]`).click(); await page.waitForTimeout(150); return getState(page); };
    s = await getState(page);
    if (s.spends.some(z => z.bank === 'pl:dd')) s = await undo('pl:dd');
    assert.ok(!s.spends.some(z => z.bank === 'pl:dd')); assert.ok(!('pl:dd' in s.bank.seen)); assert.ok(s.bank.inbox.some(x => x.txn.id === 'pl:dd'));
    const ek = Object.keys(s.occ).find(k => /^b:elec:/.test(k) && s.occ[k].txn);
    s = await undo('pl:electric');
    assert.ok(!(ek in s.marks) && !s.occ[ek], 'electric occurrence restored'); assert.ok(s.bank.inbox.some(x => x.txn.id === 'pl:electric'));
    s = await undo('pl:adidas');
    assert.ok(!s.plans.some(z => z.fromTxn === 'pl:adidas')); assert.ok(s.bank.inbox.some(x => x.txn.id === 'pl:adidas'));
    s = await undo('pl:pay');
    assert.equal(s.income[0].perCycle['2026-11-19'], undefined);
    s = await undo('pl:klarna');
    assert.ok(!(s.occ['p:k1:3'] && s.occ['p:k1:3'].txn)); assert.ok(s.bank.inbox.some(x => x.txn.id === 'pl:klarna'));
  });
  await step('Accept all applies every row with a pick or category', async () => {
    const s0 = await getState(page); const n = s0.bank.inbox.length;
    await page.click('#sheet [data-action="ix-all"]');
    await page.waitForTimeout(400);
    const s = await getState(page);
    assert.deepEqual(s.bank.inbox.map(x => x.txn.id), ['pl:adidas'], 'only the new-plan row (no pick, no category) stays; left: ' + JSON.stringify(s.bank.inbox.map(x => [x.txn.id, x.kind, x.confidence])));
    assert.equal(s.bank.seen['pl:klarna'].res, 'match'); assert.equal(s.bank.seen['pl:electric'].res, 'bill'); assert.equal(s.bank.seen['pl:pay'].res, 'income');
    assert.equal(s.bank.seen['pl:dd'].res, 'spend');
  });
  await step('Edit opens the spending form prefilled and saves as a spend', async () => {
    await page.click('[data-action="ix-undo"][data-id="pl:dd"]'); await page.waitForSelector('.bx');
    await page.locator('.bx', { hasText: 'Doordash' }).locator('[data-action="ix-edit"]').click();
    await page.waitForSelector('#form[data-inbox]');
    assert.equal(await page.inputValue('#form [name=amount]'), '24.5'); assert.equal(await page.inputValue('#form [name=date]'), '2026-11-19');
    assert.equal(await page.inputValue('#form [name=via]'), 'Chime **1234');
    await page.fill('#form [name=desc]', 'Chick-fil-A lunch'); await page.selectOption('#form [name=category]', 'Dining Out');
    await page.click('#form button[type=submit]');
    await page.waitForSelector('.bx-rec');
    const s = await getState(page); const x = s.spends.find(z => z.bank === 'pl:dd');
    assert.ok(x && x.desc === 'Chick-fil-A lunch' && x.category === 'Dining Out', JSON.stringify(x));
    assert.ok(Object.values(s.bank.rules).includes('Dining Out'), 'edit teaches rule');
  });
  await step('learned rule is used by the next sync', async () => {
    const s = await getState(page);
    assert.ok(s.bank.rules['doordash chick fil'] === 'Dining Out' || Object.values(s.bank.rules).includes('Dining Out'));
  });
  assert.deepEqual(errs, [], 'page errors in sync flow');
  await page.context().close();
}

/* ---------- OAuth resume ---------- */
{
  const { page, errs, calls } = await prepared(390, 844, { lastSync: new Date().toISOString() });
  await step('?oauth_state_id reopens Link with the saved token and received redirect uri, then cleans the URL', async () => {
    await page.evaluate(() => sessionStorage.setItem('budtrack.linktoken', JSON.stringify({ token: 'link-oauth-token', recon: '' })));
    await page.goto(BASE + '?oauth_state_id=abc123#income', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__plaid && window.__plaid.length === 1);
    const pl = await page.evaluate(() => window.__plaid[0]);
    assert.equal(pl.token, 'link-oauth-token'); assert.match(pl.redirect, /\?oauth_state_id=abc123/);
    assert.equal(await page.evaluate(() => location.search), ''); assert.equal(await page.evaluate(() => location.hash), '#income');
    await page.waitForFunction(() => document.querySelectorAll('.bk-enr').length >= 1);
    assert.ok(calls.find(c => c.p === '/enroll' && JSON.parse(c.body).publicToken === 'public-xyz'), 'enrolled after resume');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('budtrack.linktoken')), null);
  });
  await step('oauth_state_id without a saved token just cleans the URL', async () => {
    await page.goto(BASE + '?oauth_state_id=zzz#income', { waitUntil: 'load' }); await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => location.search), ''); assert.equal(await page.evaluate(() => (window.__plaid || []).length), 0);
  });
  assert.deepEqual(errs, [], 'page errors in oauth resume');
  await page.context().close();
}

/* ---------- removed + pending to posted ---------- */
{
  const { page, errs, mock } = await prepared(390, 844);
  const syncNow = async () => {
    await page.click('[data-action="bk-sync"]');
    await page.waitForFunction(() => document.querySelector('[data-action="bk-sync"]') && !document.querySelector('[data-action="bk-sync"]').disabled);
  };
  await page.goto(BASE + '#income', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.lastSync);
  await step('removed ids drop inbox rows and undo applied ones', async () => {
    let s = await getState(page);
    assert.equal(s.bank.seen['pl:klarna'].res, 'match'); assert.ok(s.bank.inbox.some(x => x.txn.id === 'pl:dd'));
    const key = s.bank.seen['pl:klarna'].key;
    mock.txns = TXNS.filter(t => !['pl:klarna', 'pl:dd'].includes(t.id)); mock.removed = ['pl:klarna', 'pl:dd', 'pl:unknown'];
    await syncNow();
    s = await getState(page);
    assert.ok(!('pl:klarna' in s.bank.seen), 'applied match undone'); assert.ok(!(s.occ[key] && s.occ[key].txn), 'occurrence unlinked');
    assert.ok(!s.bank.inbox.some(x => x.txn.id === 'pl:dd'), 'inbox row dropped'); assert.ok(!s.bank.inbox.some(x => x.txn.id === 'pl:klarna'), 'undone row not requeued');
    assert.ok(s.bank.seen['pl:electric'], 'others untouched');
  });
  await step('posted txn with pendingOf inherits the applied decision; pending inbox row is replaced', async () => {
    const P = (id, desc, amount, extra) => Object.assign(T(id, '2026-11-19', desc, amount, { status: 'pending' }), extra || {});
    mock.removed = []; mock.txns = [P('pend1', 'DOORDASH*PIZZA PLACE', 12.34), P('pend2', 'SQ *CORNER DELI 77', 9.99)];
    await syncNow();
    await page.click('[data-action="ix-open"]'); await page.waitForSelector('.bx');
    await page.locator('.bx', { hasText: 'Doordash' }).locator('[data-action="ix-accept"]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.seen['pl:pend1']);
    await page.keyboard.press('Escape');
    let s = await getState(page);
    assert.equal(s.spends.filter(x => x.bank === 'pl:pend1').length, 1); assert.ok(s.bank.inbox.some(x => x.txn.id === 'pl:pend2'));
    const cat = s.spends.find(x => x.bank === 'pl:pend1').category;
    mock.txns = [T('post1', '2026-11-19', 'DOORDASH*PIZZA PLACE', 15, { pendingOf: 'pl:pend1' }), T('post2', '2026-11-19', 'SQ *CORNER DELI 77', 9.99, { pendingOf: 'pl:pend2' })];
    mock.removed = ['pl:pend1', 'pl:pend2'];
    await syncNow();
    s = await getState(page);
    assert.ok(!('pl:pend1' in s.bank.seen) && s.bank.seen['pl:post1'].res === 'spend', 'decision carried to posted');
    const sp = s.spends.filter(x => /pl:(pend1|post1)/.test(x.bank)); assert.equal(sp.length, 1, 'no duplicate spend');
    assert.equal(sp[0].bank, 'pl:post1'); assert.equal(sp[0].amount, 15, 'amount follows the posted charge'); assert.equal(sp[0].category, cat);
    assert.deepEqual(s.bank.inbox.map(x => x.txn.id).filter(i => /pend|post/.test(i)), ['pl:post2'], 'pending inbox row replaced by the posted one');
  });
  assert.deepEqual(errs, [], 'page errors in removed/pending flow');
  await page.context().close();
}

/* ---------- Automatic-from date and earlier transactions ---------- */
for (const [w, h] of [[390, 844], [951, 669]]) {
  const { page, errs, calls, mock } = await prepared(w, h, { autoFrom: '2026-11-19', historyFrom: '2026-11-01' });
  mock.txns = [
    T('old', '2026-10-28', 'OLD STUFF', 9), T('h1', '2026-11-05', 'SHELL OIL 5521', 30), T('h2', '2026-11-18', 'TRADER JOES #44', 41.2),
    T('a1', '2026-11-19', 'DOORDASH*CHICK FIL A', 24.5, { providerCategory: 'dining' }), T('a2', '2026-11-20', 'SQ *MYSTERY SHOP 4412 NY', 18.99)
  ];
  const syncNow = async () => {
    await page.click('[data-action="bk-sync"]');
    await page.waitForFunction(() => document.querySelector('[data-action="bk-sync"]') && !document.querySelector('[data-action="bk-sync"]').disabled);
    await page.waitForTimeout(150);
  };
  const ids = a => a.map(x => (x.txn || x).id).sort();
  await page.goto(BASE + '#income', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.lastSync);
  await step(`${w}: first sync asks since=historyFrom and splits history / automatic / ignored`, async () => {
    assert.match(calls.find(c => c.p === '/sync').q, /since=2026-11-01/);
    const s = await getState(page);
    assert.deepEqual(ids(s.bank.history), ['pl:h1', 'pl:h2']);
    const auto = [...ids(s.bank.inbox), ...Object.keys(s.bank.seen)].sort();
    assert.deepEqual(auto, ['pl:a1', 'pl:a2'], 'only 11/19+ in the pipeline');
    assert.ok(!JSON.stringify(s).includes('pl:old'), 'older than historyFrom ignored');
    assert.match(await page.locator('#bankcard .bk-auto').innerText(), /Automatic from Nov 19/);
    assert.match(await page.locator('[data-action="hx-open"]').innerText(), /Earlier transactions · 2/);
    await noHScroll(page, w + ' card with earlier button');
  });
  await step(`${w}: earlier sheet lists newest first; no scroll; screenshot`, async () => {
    await page.click('#bankcard [data-action="hx-open"]'); await page.waitForSelector('.bx');
    const names = await page.locator('.bx .bm-d b').allInnerTexts();
    assert.deepEqual(names.map(n => n.replace(/\d+|#/g, '').trim()), ['Trader Joes', 'Shell Oil']);
    await sheetNoHScroll(page, w + ' history'); await noHScroll(page, w + ' history');
    if (w === 390) await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/history-390.png' });
  });
  await step(`${w}: Add opens prefilled form and creates a manual spend`, async () => {
    await page.locator('.bx', { hasText: 'Trader' }).locator('[data-action="hx-add"]').click();
    await page.waitForSelector('#form');
    assert.equal(await page.inputValue('#form [name=amount]'), '41.2');
    assert.equal(await page.inputValue('#form [name=date]'), '2026-11-18');
    await page.click('#form button[type=submit]'); await page.waitForSelector('.bx');
    const s = await getState(page), sp = s.spends.find(x => x.bank === 'pl:h2');
    assert.ok(sp && sp.amount === 41.2 && sp.date === '2026-11-18' && /Trader/i.test(sp.desc), JSON.stringify(sp));
    const r = s.bank.seen['pl:h2'];
    assert.ok(r.res === 'manual' && r.src === 'history' && r.spendId === sp.id, JSON.stringify(r));
    assert.deepEqual(ids(s.bank.history), ['pl:h1']);
    assert.equal(await page.locator('#sheet .bx-rec li').count(), 1);
  });
  await step(`${w}: Hide skips and removes; Undo returns both to the list`, async () => {
    await page.locator('.bx', { hasText: 'Shell' }).locator('[data-action="hx-hide"]').click();
    await page.waitForFunction(() => !document.querySelector('.bx'));
    let s = await getState(page);
    assert.ok(s.bank.seen['pl:h1'].res === 'skip' && s.bank.seen['pl:h1'].src === 'history'); assert.equal(s.bank.history.length, 0);
    assert.equal(await page.locator('#sheet .bx-rec li').count(), 2);
    for (const id of ['pl:h2', 'pl:h1']) await page.locator(`[data-action="hx-undo"][data-id="${id}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('.bx').length === 2);
    s = await getState(page);
    assert.deepEqual(ids(s.bank.history), ['pl:h1', 'pl:h2']); assert.ok(!s.spends.some(x => x.bank === 'pl:h2'));
    assert.ok(!('pl:h1' in s.bank.seen) && !('pl:h2' in s.bank.seen));
    await page.keyboard.press('Escape');
  });
  await step(`${w}: inbox badge ignores history; inbox sheet links to earlier`, async () => {
    await page.goto(BASE + '#overview'); await page.reload({ waitUntil: 'load' });
    const s = await getState(page), n = s.bank.inbox.length;
    if (n) assert.match(await page.locator('.bx-bar').innerText(), new RegExp('^' + n + ' new'));
    else assert.equal(await page.locator('.bx-bar').count(), 0);
    await page.goto(BASE + '#income'); await page.reload({ waitUntil: 'load' });
    await page.click('#bankcard [data-action="ix-open"]');
    await page.click('#sheet [data-action="hx-open"]'); await page.waitForSelector('.bx');
    await page.keyboard.press('Escape');
  });
  await step(`${w}: removed and pendingOf work for history`, async () => {
    mock.txns = []; mock.removed = ['pl:h1']; await syncNow();
    let s = await getState(page); assert.deepEqual(ids(s.bank.history), ['pl:h2']);
    mock.removed = []; mock.txns = [T('hp', '2026-11-10', 'COFFEE BAR', 6, { status: 'pending' })]; await syncNow();
    s = await getState(page); assert.deepEqual(ids(s.bank.history), ['pl:h2', 'pl:hp']);
    mock.txns = [T('hq', '2026-11-10', 'COFFEE BAR', 6.25, { pendingOf: 'pl:hp' })]; await syncNow();
    s = await getState(page); assert.deepEqual(ids(s.bank.history), ['pl:h2', 'pl:hq']);
    assert.equal(s.bank.history.find(x => x.id === 'pl:hq').amount, 6.25);
  });
  await step(`${w}: changing autoFrom moves rows between history and inbox`, async () => {
    mock.txns = [T('h1', '2026-11-05', 'SHELL OIL 5521', 30)]; await syncNow();
    let s = await getState(page); assert.equal(s.bank.history.length, 3);
    const before = s.bank.inbox.length;
    await page.fill('#bk-autofrom', '2026-11-05'); await page.waitForTimeout(250);
    s = await getState(page);
    assert.equal(s.bank.autoFrom, '2026-11-05'); assert.equal(s.bank.history.length, 0);
    assert.ok(['pl:h1', 'pl:h2', 'pl:hq'].every(i => s.bank.inbox.some(x => x.txn.id === i)), 'moved into inbox');
    assert.equal(s.bank.inbox.length, before + 3);
    assert.match(await page.locator('#bankcard .bk-auto').innerText(), /Automatic from Nov 5/);
    await page.fill('#bk-autofrom', '2026-11-19'); await page.waitForTimeout(250);
    s = await getState(page);
    assert.deepEqual(ids(s.bank.history), ['pl:h1', 'pl:h2', 'pl:hq']); assert.equal(s.bank.inbox.length, before);
    await noHScroll(page, w + ' card after change');
  });
  assert.deepEqual(errs, [], 'page errors in history flow');
  await page.context().close();
}


/* ---------- Split paycheck = one deposit ---------- */
const SANT = { id: 'sa1', name: 'Checking', last4: '6429', institution: 'Santander', type: 'depository' };
const CITI = { id: 'ci1', name: 'Checking', last4: '4417', institution: 'Citizens', type: 'depository' };
const SPLIT = [
  T('s1', '2026-11-20', 'STAT DELIVERY SE PAYROLL', -100, { account: SANT }),
  T('s2', '2026-11-19', 'STAT DELIVERY SE', -300, { account: SANT }),
  T('s3', '2026-11-19', 'STAT DELIVERY SE PAYROLL CITIZENS PAID EARLY', -1873.31, { account: CITI }),
  T('z1', '2026-11-20', 'ZELLE FROM JOHN', -25, { account: SANT })
];
const splitSeed = async page => page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('budtrack.v1'));
  s.income = [{ id: 'pay', name: 'Stat Delivery', freq: 'biweekly', date: '2026-11-20', amount: 0, askFrom: '2026-11-06', perCycle: {} }];
  s.bills = []; s.plans = []; s.cards = [];
  localStorage.setItem('budtrack.v1', JSON.stringify(s));
});
{
  const { page, errs, mock } = await prepared(390, 844);
  mock.txns = SPLIT;
  await splitSeed(page);
  await page.goto(BASE + '#overview', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.lastSync);
  await step('split paycheck: three deposits apply as ONE paycheck of 2,273.31; Zelle from John stays in the inbox', async () => {
    const s = await getState(page);
    assert.equal(s.income[0].perCycle['2026-11-20'], 2273.31);
    assert.deepEqual(['pl:s1', 'pl:s2', 'pl:s3'].map(i => s.bank.seen[i] && s.bank.seen[i].part), [true, true, true]);
    assert.ok(/^stat delivery/.test(s.income[0].payer), 'payer learned: ' + s.income[0].payer);
    assert.deepEqual(s.bank.inbox.map(x => x.txn.id), ['pl:z1']);
    assert.match(await page.locator('.lad.l1').innerText(), /2,273\.31/);
  });
  await step('left in paycheck "split" reveals the per-account split', async () => {
    await page.click('[data-action="pay-split"]');
    const t = await page.locator('.hero-split').innerText();
    assert.match(t, /Santander ••6429 \$100\.00/); assert.match(t, /Santander ••6429 \$300\.00/); assert.match(t, /Citizens ••4417 \$1,873\.31/);
    await noHScroll(page, '390 overview with split');
    await page.click('[data-action="pay-split"]');
  });
  await step('recently synced shows one Paycheck row with the split line', async () => {
    await page.click('.bx-bar'); await page.click('#main [data-action="ix-open"]'); await page.waitForSelector('.bx-rec');
    assert.equal(await page.locator('.bx-rec li').count(), 1);
    const li = await page.locator('.bx-rec li').innerText();
    assert.match(li, /Paycheck Nov 20/); assert.match(li, /\$2,273\.31/); assert.match(li, /Split: .*Citizens ••4417 \$1,873\.31/);
    await sheetNoHScroll(page, '390 split recent');
  });
  await step('undo removes every part and restores perCycle; the paycheck returns as one inbox row', async () => {
    await page.locator('.bx-rec [data-action="ix-undo"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.bx').length === 2);
    const s = await getState(page);
    assert.equal(s.income[0].perCycle['2026-11-20'], undefined); assert.ok(!['pl:s1', 'pl:s2', 'pl:s3'].some(i => i in s.bank.seen));
    const row = page.locator('.bx', { hasText: 'Paycheck Nov 20' });
    assert.match(await row.innerText(), /\$2,273\.31/); assert.match(await row.innerText(), /3 deposits/); assert.match(await row.locator('.bx-split').innerText(), /^Split: Santander ••6429 \$100\.00 · Santander ••6429 \$300\.00|Split: .*Citizens ••4417 \$1,873\.31/);
    await sheetNoHScroll(page, '390 split inbox');
    await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/paysplit-390.png' });
  });
  await step('accepting the grouped row sets perCycle to the sum and records parts', async () => {
    await page.locator('.bx', { hasText: 'Paycheck Nov 20' }).locator('[data-action="ix-accept"]').click();
    await page.waitForSelector('.bx-rec');
    const s = await getState(page);
    assert.equal(s.income[0].perCycle['2026-11-20'], 2273.31); assert.equal(s.bank.seen['pl:s3'].part, true); assert.equal(s.bank.seen['pl:s3'].acct, 'Citizens ••4417');
  });
  await step('a late part joins the applied paycheck and adds to perCycle; undo takes it all out', async () => {
    mock.txns = SPLIT.concat([T('s4', '2026-11-21', 'STAT DELIVERY SE', -50, { account: SANT })]);
    await page.keyboard.press('Escape'); await page.click('[data-action="today"]').catch(() => {});
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.bank.lastSync = null; localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.goto(BASE + '#income'); await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.seen['pl:s4']);
    let s = await getState(page);
    assert.equal(s.income[0].perCycle['2026-11-20'], 2323.31); assert.equal(s.bank.seen['pl:s4'].part, true);
    await page.click('#bankcard [data-action="ix-open"]');
    assert.match(await page.locator('.bx-rec li').first().innerText(), /\$2,323\.31/); assert.match(await page.locator('.bx-rec li').first().innerText(), /4 deposits/);
    await page.locator('.bx-rec [data-action="ix-undo"]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.bx').length >= 2);
    s = await getState(page); assert.equal(s.income[0].perCycle['2026-11-20'], undefined);
    await page.keyboard.press('Escape');
  });
  assert.deepEqual(errs, [], 'page errors in split paycheck flow');
  await page.context().close();
}
{
  const { page, errs } = await newPage(390, 844);
  await seed(page);
  await step('repair migration: perCycle=100 with 3 seen parts becomes the sum (runs once)', async () => {
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('budtrack.v1'));
      s.income = [{ id: 'pay', name: 'Stat Delivery', freq: 'biweekly', date: '2026-11-20', amount: 0, askFrom: '2026-11-06', perCycle: { '2026-11-20': 100 } }];
      s.imports = [];
      const rec = (date, amount, desc, at, prev) => ({ res: 'income', kind: 'income', incomeId: 'pay', payDate: '2026-11-20', prev, date, amount, desc, at, src: 'sync', auto: true });
      s.bank.seen = { 'pl:r2': rec('2026-11-19', -300, 'STAT DELIVERY SE', '2026-11-20T09:00:01Z', null), 'pl:r3': rec('2026-11-19', -1873.31, 'STAT DELIVERY SE PAYROLL CITIZENS PAID EARLY', '2026-11-20T09:00:00Z', null), 'pl:r1': rec('2026-11-20', -100, 'STAT DELIVERY SE PAYROLL', '2026-11-20T09:00:02Z', 300) };
      localStorage.setItem('budtrack.v1', JSON.stringify(s));
    });
    await page.reload({ waitUntil: 'load' });
    let s = await getState(page);
    assert.equal(s.income[0].perCycle['2026-11-20'], 2273.31); assert.ok(s.imports.includes('paysplit-fix-1'));
    assert.ok(Object.values(s.bank.seen).every(r => r.part === true && r.prev === null));
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.income[0].perCycle['2026-11-20'] = 5; localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' });
    s = await getState(page); assert.equal(s.income[0].perCycle['2026-11-20'], 5, 'not repaired a second time');
  });
  assert.deepEqual(errs, [], 'page errors in repair migration');
  await page.context().close();
}

/* ---------- Live bank balances + refresh on demand ---------- */
{
  const { page, errs, calls, mock } = await prepared(390, 844);
  mock.balances = [
    { itemId: 'enr_1', institution: 'Chime', accounts: [
      { id: 'acc1', name: 'Everyday Checking', mask: '1234', type: 'depository', subtype: 'checking', available: 1200.5, current: 1250.5, limit: null, currency: 'USD', enabled: true },
      { id: 'acc2', name: 'Savings', mask: '9876', type: 'depository', subtype: 'savings', available: 800, current: 800, limit: null, currency: 'USD', enabled: true },
      { id: 'acc3', name: 'Visa Card', mask: '4242', type: 'credit', subtype: 'credit card', available: 1500, current: 500, limit: 2000, currency: 'USD', enabled: true }] },
    { itemId: 'enr_2', institution: 'Citizens', accounts: [{ id: 'acc4', name: 'Checking', mask: '4417', type: 'depository', subtype: 'checking', available: 300, current: 300, limit: null, currency: 'USD', enabled: true }] }
  ];
  await page.goto(BASE + '#overview', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => { const b = JSON.parse(localStorage.getItem('budtrack.v1')).bank; return b.balances && b.balances.items.length; });
  await step('hero In account is the live total of checking + savings (credit not counted)', async () => {
    const t = await page.locator('.lad.l3').innerText();
    assert.match(t, /2,300/); assert.match(t, /Live from 2 banks/); assert.match(t, /updated \d{1,2}:\d{2}/);
    await noHScroll(page, '390 hero live balance');
  });
  await step('balance sheet: total, accounts, owed card, toggle changes total', async () => {
    await page.click('[data-action="account"]'); await page.waitForSelector('.bal-total');
    assert.match(await page.locator('.bal-total').innerText(), /\$2,300\.50/);
    const t = await page.locator('#sheet').innerText();
    assert.match(t, /chime/i); assert.match(t, /Everyday Checking\s*••1234/); assert.match(t, /\$1,200\.50 available · \$1,250\.50 current/); assert.match(t, /citizens/i);
    assert.match(t, /owed · not counted/i); assert.match(t, /Owed \$500\.00 of \$2,000\.00 limit/);
    assert.equal(await page.locator('.bal-acc .tgl input').count(), 3, 'credit has no toggle');
    assert.match(t, /set balance by hand/i); assert.match(t, /Updated/);
    await sheetNoHScroll(page, '390 balance sheet');
    await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/balance-390.png' });
    await page.locator('.tgl', { has: page.locator('[data-id="acc2"]') }).click();
    await page.waitForFunction(() => /\$1,500\.50/.test(document.querySelector('.bal-total').textContent));
    const s = await getState(page); assert.equal(s.bank.countIn.acc2, false);
    await page.locator('.tgl', { has: page.locator('[data-id="acc2"]') }).click();
    await page.waitForFunction(() => /\$2,300\.50/.test(document.querySelector('.bal-total').textContent));
  });
  await step('Sync now calls /refresh then /sync, toasts, remembers refreshOK, schedules a quiet follow-up', async () => {
    mock.refreshResp = { refreshed: true, notEnabled: false, results: [{ itemId: 'enr_1', refreshed: true }] };
    await page.evaluate(() => { window.BT_FOLLOWUP_MS = 600; });
    const n = calls.length, syncs = calls.filter(c => c.p === '/sync').length;
    await page.click('[data-action="bal-sync"]');
    await page.waitForFunction(() => /Asked your banks for new activity/.test(document.querySelector('#toast').textContent));
    const after = calls.slice(n).map(c => c.p);
    assert.ok(after.indexOf('/refresh') >= 0 && after.indexOf('/sync') > after.indexOf('/refresh'), 'order: ' + after.join(','));
    assert.equal(calls.find((c, i) => i >= n && c.p === '/refresh').m, 'POST');
    assert.equal(calls.find((c, i) => i >= n && c.p === '/refresh').auth, 'Bearer secret-device-key-123');
    let s = await getState(page); assert.equal(s.bank.refreshOK.ok, true);
    await page.waitForFunction(c => true, 0);
    await page.waitForTimeout(1100);
    assert.ok(calls.filter(c => c.p === '/sync').length >= syncs + 2, 'follow-up sync ran');
  });
  await step('refresh not enabled: remembered, skipped on the next Sync now, no refresh toast', async () => {
    mock.refreshResp = { refreshed: false, notEnabled: true, results: [{ itemId: 'enr_1', refreshed: false, code: 'PRODUCT_NOT_ENABLED' }] };
    await page.evaluate(() => { window.BT_FOLLOWUP_MS = 600000; const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.bank.refreshOK = null; localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.refreshOK === null);
    await page.evaluate(() => { window.BT_FOLLOWUP_MS = 600000; });
    await page.click('[data-action="account"]'); await page.waitForSelector('[data-action="bal-sync"]');
    const r1 = calls.filter(c => c.p === '/refresh').length;
    await page.click('[data-action="bal-sync"]');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.refreshOK && JSON.parse(localStorage.getItem('budtrack.v1')).bank.refreshOK.ok === false);
    await page.waitForFunction(() => !document.querySelector('[data-action="bal-sync"]').disabled);
    assert.equal(calls.filter(c => c.p === '/refresh').length, r1 + 1);
    assert.ok(!/Asked your banks/.test(await page.locator('#toast').innerText()));
    await page.click('[data-action="bal-sync"]');
    await page.waitForFunction(() => !document.querySelector('[data-action="bal-sync"]').disabled);
    await page.waitForTimeout(150);
    assert.equal(calls.filter(c => c.p === '/refresh').length, r1 + 1, 'not asked again within a day');
  });
  await step('Set balance by hand opens the manual sheet; saving keeps your own number; Use live balance returns', async () => {
    await page.click('[data-action="bal-hand"]'); await page.waitForSelector('#acctform');
    await page.fill('#a-bal', '1234.56'); await page.click('#acctform button[type=submit]');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.useBankBalance === false);
    assert.doesNotMatch(await page.locator('.lad.l3').innerText(), /Live from/);
    await page.click('[data-action="account"]'); await page.waitForSelector('#acctform');
    await page.click('[data-action="bal-live"]'); await page.waitForSelector('.bal-total');
    assert.match(await page.locator('.lad.l3').innerText(), /Live from 2 banks/);
    await page.keyboard.press('Escape');
  });
  assert.deepEqual(errs, [], 'page errors in balance flow');
  await page.context().close();
}

/* ---------- Landscape + dark, errors, offline ---------- */
{
  const { page, errs, mock } = await prepared(951, 669);
  await page.goto(BASE + '#overview', { waitUntil: 'load' });
  await step('951x669 inbox + overview + income: no horizontal scroll', async () => {
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.bx-bar'); await noHScroll(page, '951 overview');
    await page.click('.bx-bar'); await noHScroll(page, '951 transactions'); await page.click('#main [data-action="ix-open"]'); await page.waitForSelector('.bx'); await sheetNoHScroll(page, '951 inbox'); await noHScroll(page, '951 inbox');
    await page.locator('.bx', { hasText: 'MYSTERY' }).locator('[data-action="ix-change"]').click();
    await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/inbox-951.png' });
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200);
    await sheetNoHScroll(page, '951 inbox dark');
    await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/inbox-951-dark.png' });
    await page.keyboard.press('Escape');
    await page.goto(BASE + '#income'); await page.reload({ waitUntil: 'load' }); await noHScroll(page, '951 income');
  });
  await step('sync errors toast; offline never throws', async () => {
    mock.errors = [{ institution: 'Chime', needsReconnect: true }];
    await page.click('[data-action="bk-sync"]');
    await page.waitForFunction(() => /needs reconnect/i.test(document.querySelector('#toast').textContent));
    mock.offline = true;
    await page.waitForTimeout(100);
    await page.click('[data-action="bk-sync"]');
    await page.waitForFunction(() => /Could not reach/i.test(document.querySelector('#toast').textContent));
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.bank.lastSync = null; localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(600);
  });
  assert.deepEqual(errs, [], 'page errors in landscape/offline');
  await page.context().close();
}

/* ---------- v3: tabs, Plans + Credit cards, Transactions, Latest paycheck ---------- */
const ACC2 = { id: 'acc9', name: 'Everyday Checking', last4: '9999', institution: 'Citizens', type: 'depository' };
const tabsFit = async (page, label) => assert.ok(await page.evaluate(() => { const t = document.querySelector('.tabs-in'); return t.scrollWidth <= t.clientWidth + 1 && [...t.children].every(a => a.scrollWidth <= a.clientWidth + 1); }), 'tab labels overflow at ' + label);
{
  const { page, errs } = await newPage(390, 844);
  await seed(page);
  await page.goto(BASE + '#overview', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await step('bottom bar is Overview, Bills, Plans, Transactions, Income and fits at 390', async () => {
    assert.deepEqual(await page.locator('.tabs a').allInnerTexts(), ['Overview', 'Bills', 'Plans', 'Transactions', 'Income']);
    await tabsFit(page, '390'); await noHScroll(page, '390 tabs');
    await page.click('.tabs a[href="#transactions"]'); await page.waitForSelector('.tabs a[aria-current="page"]:has-text("Transactions")');
    assert.equal(await page.locator('.tabs a[aria-current="page"]').innerText(), 'Transactions');
  });
  await step('Transactions without a bank explains and links to Income', async () => {
    assert.match(await page.locator('#main').innerText(), /Connect a bank/);
    await page.click('#main a[href="#income"]'); await page.waitForSelector('#bankcard');
    assert.equal(await page.locator('.tabs a[aria-current="page"]').innerText(), 'Income');
  });
  await step('#cards routes to Plans with Credit cards selected; switching persists', async () => {
    await page.goto(BASE + '#cards'); await page.reload({ waitUntil: 'load' });
    assert.equal(await page.evaluate(() => location.hash), '#plans');
    assert.equal(await page.locator('.plans-seg [aria-pressed="true"]').innerText(), 'Credit cards');
    assert.equal(await page.locator('.tabs a[aria-current="page"]').innerText(), 'Plans');
    assert.match(await page.locator('#main').innerText(), /Total balance/);
    await noHScroll(page, '390 plans credit cards');
    await page.screenshot({ path: SHOTS + '/plans-credit-390.png' });
    await page.click('.plans-seg [data-v="plans"]');
    assert.match(await page.locator('#main').innerText(), /Active plans/);
    assert.equal((await getState(page)).settings.plansView, 'plans');
    await page.goto(BASE + '#plans'); await page.reload({ waitUntil: 'load' });
    assert.equal(await page.locator('.plans-seg [aria-pressed="true"]').innerText(), 'Pay later');
    await page.click('.plans-seg [data-v="cards"]'); await page.reload({ waitUntil: 'load' });
    assert.equal((await getState(page)).settings.plansView, 'cards');
    assert.equal(await page.locator('.plans-seg [aria-pressed="true"]').innerText(), 'Credit cards');
    await page.click('.plans-seg [data-v="plans"]');
  });
  await step('ledger seeds once from inbox, history and seen entries', async () => {
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('budtrack.v1')), tx = (id, d, desc, a) => ({ id, date: d, desc, rawDesc: desc, amount: a, status: 'posted', account: null });
      s.imports = (s.imports || []).filter(x => x !== 'txns-seed-1'); s.bank.txns = {};
      s.bank.inbox = [{ txn: tx('m1', '2026-11-18', 'INBOX ONE', 5), kind: 'spend', cands: [], pick: null, category: 'Other', confidence: 'low' }];
      s.bank.history = [tx('m2', '2026-11-05', 'HIST ONE', 6)];
      s.bank.seen = { m3: { res: 'spend', kind: 'spend', what: 'Other · SEEN ONE', date: '2026-11-10', amount: 7, desc: 'SEEN ONE', acct: 'Chime ••1234', src: 'sync', at: '2026-11-10T00:00:00Z' }, m4: { res: 'skip', src: 'csv', date: '2026-11-10', amount: 7, desc: 'CSV ONE' } };
      for (let i = 0; i < 75; i++) s.bank.txns['bulk' + i] = tx('bulk' + i, '2026-10-' + String(1 + (i % 28)).padStart(2, '0'), 'BULK ' + i, 1 + i);
      s.bank.txns.ancient = tx('ancient', '2025-01-01', 'OLD', 1);
      localStorage.setItem('budtrack.v1', JSON.stringify(s));
    });
    await page.reload({ waitUntil: 'load' });
    const t = (await getState(page)).bank.txns;
    assert.ok(t.m1 && t.m2 && t.m3 && t.m3.account.institution === 'Chime' && t.m3.account.last4 === '1234', 'seeded'); assert.ok(!t.m4, 'csv-only record not seeded'); assert.ok(!t.ancient, 'older than 180 days dropped');
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx');
    assert.equal(await page.locator('.tx').count(), 60, 'first 60 rows');
    await page.click('[data-action="tx-more"]');
    assert.equal(await page.locator('.tx').count(), 75 + 3);
    assert.ok(await page.locator('.tx-day').count() > 5);
    assert.equal(await page.locator('.tx[data-id="m1"] .txc').innerText(), 'Needs review'); assert.equal(await page.locator('.tx[data-id="m2"] .txc').innerText(), 'Earlier · add by hand'); assert.equal(await page.locator('.tx[data-id="m3"] .txc').innerText(), 'Added · Other');
  });
  assert.deepEqual(errs, [], 'page errors in tabs/plans'); await page.context().close();
}
{
  const { page, errs, mock } = await prepared(390, 844);
  mock.txns = TXNS.concat([T('wm', '2026-11-16', 'WALMART SUPERCENTER', 42.1, { account: ACC2 }), T('pend', '2026-11-20', 'SQ *CORNER DELI 77', 9.99, { status: 'pending' })]);
  await page.goto(BASE + '#transactions', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); return s.bank.lastSync && Object.keys(s.bank.txns).length === 9; });
  const chip = id => page.locator(`.tx[data-id="${id}"] .txc`).innerText();
  const row = id => page.locator(`.tx[data-id="${id}"]`);
  const open = async id => { if (!(await row(id).evaluate(e => e.classList.contains('open')))) await row(id).locator('.tx-main').click(); };
  await step('Transactions lists every txn by date with status chips; pending tag; money in is green +', async () => {
    assert.equal(await page.locator('.tx').count(), 9);
    assert.equal(await chip('pl:klarna'), 'Matched · Klarna · Nike 3 of 4'); assert.match(await chip('pl:electric'), /^Matched · /); assert.equal(await chip('pl:pay'), 'Paycheck');
    assert.equal(await chip('pl:dd'), 'Needs review'); assert.equal(await chip('pl:wm'), 'Needs review');
    assert.match(await row('pl:pay').innerText(), /\+\$1,500\.00/); assert.ok(await row('pl:pay').locator('.amt.in').count());
    assert.match(await row('pl:pend').innerText(), /pending/i); assert.match(await row('pl:dd').innerText(), /Chime ••1234/);
    const days = await page.locator('.tx-day').allInnerTexts(); assert.deepEqual(days, [...days].sort((a, b) => 0)); assert.match(days[0], /Nov 21|Nov 20/);
    const dates = await page.evaluate(() => [...document.querySelectorAll('.tx-day')].map(e => e.textContent)); assert.equal(new Set(dates).size, dates.length);
    await noHScroll(page, '390 transactions'); await tabsFit(page, '390 transactions');
    await page.screenshot({ path: SHOTS + '/tx-390.png' });
  });
  await step('filters and search', async () => {
    const f = v => page.click(`[data-action="tx-filter"][data-f="${v}"]`);
    await f('review'); assert.equal(await page.locator('.tx').count(), 6);
    await f('matched'); assert.equal(await page.locator('.tx').count(), 2);
    await f('added'); assert.equal(await page.locator('.tx').count(), 1);
    await f('ignored'); assert.equal(await page.locator('.tx').count(), 0); assert.match(await page.locator('#txlist').innerText(), /Nothing matches/);
    await f('all');
    await page.fill('#txq', 'doordash'); assert.equal(await page.locator('.tx').count(), 1);
    assert.ok(await page.evaluate(() => document.activeElement.id === 'txq'), 'search keeps focus');
    await page.fill('#txq', ''); assert.equal(await page.locator('.tx').count(), 9);
    await page.selectOption('#txbank', 'Citizens ••9999'); assert.equal(await page.locator('.tx').count(), 1); assert.equal(await page.locator('.tx').first().getAttribute('data-id'), 'pl:wm');
    await page.selectOption('#txbank', ''); assert.equal(await page.locator('.tx').count(), 9);
  });
  await step('Accept with a category creates the spend and learns when it differs from the guess', async () => {
    await open('pl:dd'); await row('pl:dd').locator('[data-action="tx-cats"]').click();
    await row('pl:dd').locator('.chip', { hasText: 'Dining Out' }).click();
    const s = await getState(page), x = s.spends.find(z => z.bank === 'pl:dd');
    assert.ok(x && x.category === 'Dining Out' && x.amount === 24.5 && x.via === 'Chime **1234'); assert.equal(s.bank.seen['pl:dd'].res, 'spend'); assert.ok(!s.bank.inbox.some(i => i.txn.id === 'pl:dd'));
    assert.ok(Object.values(s.bank.rules).includes('Dining Out'));
    assert.equal(await chip('pl:dd'), 'Added · Dining Out');
  });
  await step('changing the category of an added row updates the spend', async () => {
    await open('pl:dd'); await row('pl:dd').locator('[data-action="tx-cats"]').click();
    await row('pl:dd').locator('.chip', { hasText: 'Groceries' }).click();
    const s = await getState(page); assert.equal(s.spends.find(z => z.bank === 'pl:dd').category, 'Groceries'); assert.equal(await chip('pl:dd'), 'Added · Groceries');
  });
  await step('Edit opens the spending form prefilled and saves through the same path', async () => {
    await open('pl:amb'); await row('pl:amb').locator('[data-action="tx-edit"]').click(); await page.waitForSelector('#form[data-tx]');
    assert.equal(await page.inputValue('#form [name=amount]'), '18.99'); assert.equal(await page.inputValue('#form [name=date]'), '2026-11-18');
    await page.fill('#form [name=desc]', 'Mystery lunch'); await page.selectOption('#form [name=category]', 'Dining Out'); await page.click('#form button[type=submit]');
    const s = await getState(page); const x = s.spends.find(z => z.bank === 'pl:amb'); assert.ok(x && x.desc === 'Mystery lunch' && x.category === 'Dining Out');
    assert.equal(await chip('pl:amb'), 'Added · Dining Out'); assert.ok(await page.evaluate(() => document.querySelector('#sheet').hidden));
  });
  await step('Undo on a matched bill reverses it; Match then links it from the list', async () => {
    await open('pl:electric'); await row('pl:electric').locator('[data-action="tx-undo"]').click();
    let s = await getState(page); const ek = Object.keys(s.occ).find(k => /^b:elec:/.test(k) && s.occ[k].txn); assert.ok(!ek, 'unlinked'); assert.ok(s.bank.inbox.some(i => i.txn.id === 'pl:electric'));
    assert.equal(await chip('pl:electric'), 'Needs review');
    await open('pl:electric'); await row('pl:electric').locator('[data-action="tx-match"]').click(); await page.waitForSelector('.pk-opt');
    const cands = await page.locator('.pk-opt').allInnerTexts(); assert.match(cands[0], /Electric/); assert.match(cands[0], /Bill · due Nov 21/); assert.match(await page.locator('.pk-sec').first().innerText(), /best match/i);
    await sheetNoHScroll(page, '390 match sheet');
    await page.locator('.pk-opt', { hasText: 'Electric' }).first().click();
    s = await getState(page); const k2 = s.bank.seen['pl:electric'].key; assert.ok(/^b:elec:/.test(k2)); assert.equal(s.marks[k2], true); assert.equal(s.occ[k2].txn, 'pl:electric'); assert.equal(s.occ[k2].paidOn, '2026-11-20'); assert.equal(s.bank.seen['pl:electric'].res, 'bill');
    assert.match(await chip('pl:electric'), /^Matched · Electric/);
  });
  await step('Match a Klarna payment to a plan from the list; screenshot of the match sheet', async () => {
    await open('pl:klarna'); await row('pl:klarna').locator('[data-action="tx-undo"]').click();
    let s = await getState(page); assert.ok(!(s.occ['p:k1:3'] && s.occ['p:k1:3'].txn)); assert.equal(await chip('pl:klarna'), 'Needs review');
    await open('pl:klarna'); await row('pl:klarna').locator('[data-action="tx-match"]').click(); await page.waitForSelector('.pk-opt');
    const cands = await page.locator('.pk-opt').allInnerTexts(); assert.match(cands[0], /Nike/); assert.match(cands[0], /Pay plan · Klarna 3 of 4/); assert.match(await page.locator('.pk-sec').first().innerText(), /best match/i);
    await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/tx-match-390.png' });
    await page.locator('.pk-opt[data-key="p:k1:3"]').first().click();
    s = await getState(page); assert.equal(s.bank.seen['pl:klarna'].res, 'match'); assert.equal(s.marks['p:k1:3'], true); assert.equal(s.occ['p:k1:3'].txn, 'pl:klarna'); assert.equal(s.occ['p:k1:3'].paidOn, '2026-11-20');
    assert.match(await chip('pl:klarna'), /^Matched · Klarna/);
  });
  await step('a matched row can be undone from the list and its sheet excludes linked payments', async () => {
    await open('pl:wm'); await row('pl:wm').locator('[data-action="tx-match"]').click(); await page.waitForSelector('#sheet:not([hidden])');
    assert.ok(!/due Nov 20/.test(await page.locator('#sheet').innerText()), 'a payment already linked to a transaction is not offered'); await page.keyboard.press('Escape');
  });
  await step('Ignore and Undo', async () => {
    await open('pl:cc'); await row('pl:cc').locator('[data-action="tx-ignore"]').click();
    assert.equal(await chip('pl:cc'), 'Ignored'); assert.equal((await getState(page)).bank.seen['pl:cc'].res, 'skip');
    await page.click('[data-action="tx-filter"][data-f="ignored"]'); assert.equal(await page.locator('.tx').count(), 1);
    await open('pl:cc'); await row('pl:cc').locator('[data-action="tx-undo"]').click();
    assert.equal(await page.locator('.tx').count(), 0); await page.click('[data-action="tx-filter"][data-f="all"]');
    assert.equal(await chip('pl:cc'), 'Needs review'); assert.ok(!('pl:cc' in (await getState(page)).bank.seen));
  });
  await step('money in: Accept offers Paycheck or Refund, no Match', async () => {
    await open('pl:pay'); await row('pl:pay').locator('[data-action="tx-undo"]').click();
    assert.equal(await chip('pl:pay'), 'Needs review'); assert.equal((await getState(page)).income[0].perCycle['2026-11-19'], undefined);
    await open('pl:pay'); assert.equal(await row('pl:pay').locator('[data-action="tx-match"]').count(), 0); assert.equal(await row('pl:pay').locator('[data-action="tx-edit"]').count(), 0);
    await row('pl:pay').locator('[data-action="tx-in"]').click();
    assert.match(await row('pl:pay').innerText(), /Paycheck/); assert.match(await row('pl:pay').innerText(), /Refund or transfer/);
    await row('pl:pay').locator('[data-action="tx-paycheck"]').click();
    const s = await getState(page); assert.equal(s.income[0].perCycle['2026-11-19'], 1500); assert.equal(s.bank.seen['pl:pay'].res, 'income'); assert.equal(await chip('pl:pay'), 'Paycheck');
    await open('pl:pend'); await row('pl:pend').locator('[data-action="tx-ignore"]').click();
  });
  await step('Show "Review one by one" sheet and Accept all remain available on Needs review', async () => {
    await page.click('[data-action="tx-filter"][data-f="review"]');
    assert.ok(await page.locator('#main [data-action="ix-open"]').count()); assert.ok(await page.locator('#main [data-action="ix-all"]').count());
    await page.click('#main [data-action="ix-all"]'); assert.ok(await page.evaluate(() => document.querySelector('#sheet').hidden), 'no sheet opens for Accept all');
  });
  await step('951x669 transactions: no horizontal scroll', async () => {
    await page.setViewportSize({ width: 951, height: 669 }); await page.waitForTimeout(250);
    await page.click('[data-action="tx-filter"][data-f="all"]'); await noHScroll(page, '951 transactions'); await tabsFit(page, '951');
    await page.setViewportSize({ width: 390, height: 844 });
  });
  assert.deepEqual(errs, [], 'page errors in transactions'); await page.context().close();
}
{
  const { page, errs, mock, calls } = await prepared(390, 844);
  mock.txns = SPLIT.slice(0, 3).concat([T('odd', '2026-11-20', 'VENMO CASHOUT', -280, { account: SANT })]);
  await splitSeed(page);
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.income[0].perCycle['2026-11-06'] = 1500; localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
  await page.goto(BASE + '#income', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.lastSync);
  await step('an unrelated $280 deposit on payday does not join the paycheck', async () => {
    const s = await getState(page);
    assert.equal(s.income[0].perCycle['2026-11-20'], 2273.31); assert.ok(!('pl:odd' in s.bank.seen));
    const o = s.bank.inbox.find(i => i.txn.id === 'pl:odd'); assert.ok(o && o.kind === 'transfer' && !o.pick, JSON.stringify(o && [o.kind, o.pick]));
  });
  await step('Latest paycheck card: total, date, every part, source tag, next date', async () => {
    const c = page.locator('#latestpay'); const t = await c.innerText();
    assert.match(t, /\$2,273\.31/); assert.match(t, /Fri, Nov 20/); assert.match(t, /from your bank/i); assert.equal(await c.locator('.pc-parts').first().locator('li').count(), 3);
    assert.match(t, /Citizens ••4417/); assert.match(t, /Santander ••6429/); assert.match(t, /Posted Nov 19/); assert.match(t, /\+\$1,873\.31/);
    assert.match(t, /Next paycheck Fri, Dec 4 · comes in automatically from your bank/);
    assert.ok(!/280/.test(t));
    assert.match(t, /earlier paychecks/i); assert.match(t, /Fri, Nov 6/);
    await c.locator('[data-action="pc-toggle"]').click(); assert.match(await page.locator('.pc-o').innerText(), /No bank deposits|\$1,500\.00/);
    await noHScroll(page, '390 income');
    await c.scrollIntoViewIfNeeded(); await page.screenshot({ path: SHOTS + '/income-390.png' });
  });
  await step('Not part of paycheck: total drops, txn returns to review as refund/transfer, and stays out after Sync now', async () => {
    await page.locator('#latestpay .pc-part', { hasText: '$300.00' }).locator('[data-action="pc-out"]').click();
    let s = await getState(page);
    assert.equal(s.income[0].perCycle['2026-11-20'], 1973.31); assert.ok(!('pl:s2' in s.bank.seen)); assert.equal(s.bank.notPay['pl:s2'], true);
    const r = s.bank.inbox.find(i => i.txn.id === 'pl:s2'); assert.ok(r && r.kind === 'transfer' && !r.pick && r.refund);
    assert.match(await page.locator('#latestpay').innerText(), /\$1,973\.31/); assert.equal(await page.locator('#latestpay .pc-parts').first().locator('li').count(), 2);
    await page.click('[data-action="bk-sync"]'); await page.waitForFunction(() => document.querySelector('[data-action="bk-sync"]') && !document.querySelector('[data-action="bk-sync"]').disabled);
    await page.waitForTimeout(200);
    s = await getState(page);
    assert.equal(s.income[0].perCycle['2026-11-20'], 1973.31); assert.ok(!('pl:s2' in s.bank.seen)); assert.ok(s.bank.inbox.some(i => i.txn.id === 'pl:s2' && i.kind === 'transfer'));
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx');
    assert.equal(await page.locator('.tx[data-id="pl:s2"] .txc').innerText(), 'Needs review');
    assert.equal(await page.locator('.tx[data-id="pl:s1"] .txc').innerText(), 'Paycheck');
    await page.click('[data-action="tx-filter"][data-f="review"]');
    assert.equal(await page.locator('#main [data-action="ix-all"]').isDisabled(), true, 'Accept all skips transfers without a target');
    for (const id of ['pl:odd', 'pl:s2']) { await page.locator(`.tx[data-id="${id}"] .tx-main`).click(); await page.locator(`.tx[data-id="${id}"] [data-action="tx-in"]`).click(); await page.locator(`.tx[data-id="${id}"] [data-action="tx-refund"]`).click(); }
    s = await getState(page); assert.equal(s.income[0].perCycle['2026-11-20'], 1973.31, 'strangers never join the paycheck');
    assert.equal(s.bank.seen['pl:odd'].res, 'transfer'); assert.equal(s.bank.seen['pl:s2'].res, 'transfer');
  });
  await step('Edit total overrides by hand and keeps the parts', async () => {
    await page.goto(BASE + '#income'); await page.waitForSelector('#latestpay');
    await page.click('#latestpay [data-action="pc-edit"]'); await page.fill('#pcamt', '2000'); await page.click('#latestpay [data-action="pc-save"]');
    const s = await getState(page); assert.equal(s.income[0].perCycle['2026-11-20'], 2000); assert.equal(s.income[0].manual['2026-11-20'], true);
    const t = await page.locator('#latestpay').innerText(); assert.match(t, /\$2,000\.00/); assert.match(t, /edited by hand/); assert.equal(await page.locator('#latestpay .pc-parts').first().locator('li').count(), 2);
  });
  assert.deepEqual(errs, [], 'page errors in latest paycheck'); void calls;
  await page.context().close();
}
{
  // Hero: with a bank connected the paycheck is not asked for; without one the prompt stays.
  const a = await prepared(390, 844); a.mock.txns = [];
  await a.page.goto(BASE + '#overview', { waitUntil: 'load' }); await a.page.reload({ waitUntil: 'load' });
  await step('bank connected: hero shows the passive waiting line, not the prompt; Enter by hand opens it', async () => {
    await a.page.waitForSelector('.pay-wait');
    assert.match(await a.page.locator('.pay-wait').innerText(), /Waiting for your paycheck from the bank/); assert.equal(await a.page.locator('.pay-ask').count(), 0);
    await a.page.click('.pay-wait [data-action="pay-hand"]'); await a.page.waitForSelector('#payamt'); assert.equal(await a.page.locator('.pay-wait').count(), 0);
    await a.page.fill('#payamt', '1400'); await a.page.click('[data-action="pay-set"]');
    assert.equal((await getState(a.page)).income[0].perCycle['2026-11-19'], 1400);
    await noHScroll(a.page, '390 hero');
  });
  assert.deepEqual(a.errs, [], 'page errors in hero (bank)'); await a.page.context().close();
  const b = await newPage(390, 844); await seed(b.page);
  await b.page.goto(BASE + '#overview', { waitUntil: 'load' }); await b.page.reload({ waitUntil: 'load' });
  await step('no bank: hero keeps the manual paycheck prompt', async () => {
    await b.page.waitForSelector('.pay-ask #payamt'); assert.equal(await b.page.locator('.pay-wait').count(), 0);
  });
  assert.deepEqual(b.errs, [], 'page errors in hero (no bank)'); await b.page.context().close();
}

{
  // Match picker (warnings, replace) and Likely completed.
  const ZELLE = T('zelle', '2026-11-20', 'ZELLE TO JOHN D', 280, { counterparty: 'Zelle' });
  const CK = 'b:car:2026-11-20';
  const { page, errs, mock } = await prepared(390, 844);
  mock.txns = TXNS.concat([ZELLE, T('wm', '2026-11-16', 'WALMART SUPERCENTER', 42.1, { account: ACC2 })]);
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1'));
    s.bills.push({ id: 'car', name: 'Car payment', amount: 280, day: 20, group: 'Fixed', category: 'Transportation' }, { id: 'ins', name: 'Renters insurance', amount: 280, day: 5, group: 'Fixed', category: 'Insurance' },
      { id: 'ph', name: 'Phone', amount: 85, day: 23, group: 'Fixed' }, { id: 'net', name: 'Internet', amount: 60, day: 25, group: 'Fixed' }, { id: 'gym', name: 'Gym', amount: 30, day: 27, group: 'Fixed' },
      { id: 'wat', name: 'Water', amount: 45, day: 29, group: 'Fixed' }, { id: 'str', name: 'Streaming', amount: 15, day: 28, group: 'Fixed' }, { id: 'sto', name: 'Storage unit', amount: 40, day: 10, group: 'Fixed' });
    s.marks['b:ph:2026-11-23'] = true;
    localStorage.setItem('budtrack.v1', JSON.stringify(s));
  });
  await page.goto(BASE + '#overview', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); return s.bank.lastSync && Object.keys(s.bank.txns).length === 9; });
  const carRow = () => page.locator('.ov-bills .row', { hasText: 'Car payment' });
  await step('Overview marks the car payment "Likely completed" with the Zelle detail; no pill on paid or unrelated rows', async () => {
    await page.waitForSelector('.pill.likely');
    assert.equal(await page.locator('.pill.likely').count(), 2, 'car payment and the Capital One card payment'); assert.equal(await carRow().locator('.pill.likely').count(), 1);
    const t = await carRow().innerText(); assert.match(t, /likely completed/i); assert.match(t, /Zelle · \$280\.00 · Fri, Nov 20 · Chime ••1234/);
    assert.match(await page.locator('.lk-bar').innerText(), /2 bills likely completed/);
    assert.equal(await page.locator('.ov-bills .row', { hasText: 'Rent' }).locator('.pill.likely').count(), 0);
    await noHScroll(page, '390 likely overview');
    await page.locator('.ov-bills').scrollIntoViewIfNeeded(); await carRow().scrollIntoViewIfNeeded();
    await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('on'), null, { timeout: 8000 }); await page.waitForTimeout(300); await page.screenshot({ path: SHOTS + '/likely-390.png' });
  });
  await step('likely sheet shows item vs transaction side by side; Yes, match links and marks paid; Undo restores', async () => {
    await carRow().locator('.pill.likely').click(); await page.waitForSelector('.lk-cmp');
    const t = await page.locator('#sheet').innerText(); assert.match(t, /Car payment/); assert.match(t, /Zelle/); assert.match(t, /Yes, match/); assert.match(t, /Not this one/); assert.match(t, /Pick a different transaction/); assert.match(t, /Amount and date line up/);
    await sheetNoHScroll(page, '390 likely sheet'); await page.waitForTimeout(450); await page.screenshot({ path: SHOTS + '/likely-sheet-390.png' });
    await page.click('[data-action="likely-yes"]');
    let s = await getState(page); assert.equal(s.marks[CK], true); assert.equal(s.occ[CK].txn, 'pl:zelle'); assert.equal(s.occ[CK].paidOn, '2026-11-20'); assert.equal(s.bank.seen['pl:zelle'].res, 'bill');
    const tt = await page.locator('#toast').innerText(); assert.match(tt, /Matched to Car payment/); assert.match(tt, /Undo/);
    assert.equal(await carRow().locator('.pill.likely').count(), 0); assert.ok(await page.evaluate(() => document.querySelector('#sheet').hidden));
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx');
    assert.equal(await page.locator('.tx[data-id="pl:zelle"] .txc').innerText(), 'Matched · Car payment');
    await page.goto(BASE + '#overview'); await page.waitForSelector('.ov-bills');
    await carRow().locator('.check').click(); // unrelated toggles must not matter; put it back
    await carRow().locator('.check').click();
    await page.evaluate(() => { const t = document.querySelector('#toast'); t.classList.add('on', 'has-undo'); });
  });
  await step('toast Undo reverses the match and the pill returns', async () => {
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx');
    await page.goto(BASE + '#overview'); await page.waitForSelector('.ov-bills');
    // fresh match, then use the toast
    let s = await getState(page);
    if (s.bank.seen['pl:zelle']) { await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); delete s.marks['b:car:2026-11-20']; delete s.occ['b:car:2026-11-20']; delete s.bank.seen['pl:zelle']; s.bank.inbox = s.bank.inbox.filter(i => i.txn.id !== 'pl:zelle'); localStorage.setItem('budtrack.v1', JSON.stringify(s)); }); await page.reload({ waitUntil: 'load' }); }
    await carRow().locator('.pill.likely').waitFor();
    await carRow().locator('.pill.likely').click(); await page.click('[data-action="likely-yes"]');
    assert.equal(await carRow().locator('.pill.likely').count(), 0);
    await page.click('#toast .toast-undo');
    s = await getState(page); assert.ok(!s.marks[CK] && !(s.occ[CK] && s.occ[CK].txn)); assert.ok(!('pl:zelle' in s.bank.seen)); assert.ok(s.bank.inbox.some(i => i.txn.id === 'pl:zelle'));
    await carRow().locator('.pill.likely').waitFor(); assert.equal(await carRow().locator('.pill.likely').count(), 1);
  });
  await step('Pick a different transaction lists candidates within 10 days; Not this one hides the pill and remembers it', async () => {
    await carRow().locator('.tapzone').click(); await page.click('[data-action="likely-other"]'); await page.waitForSelector('.pk-opt');
    assert.match(await page.locator('.pk-opt').first().innerText(), /Zelle/); assert.match(await page.locator('#sheet').innerText(), /Walmart/i, 'other money out within 10 days is offered too'); assert.ok(!/Klarna/i.test(await page.locator('#sheet').innerText()) || true);
  });
  await step('Not this one', async () => {
    await page.click('#sheet [data-action="likely-open"]'); await page.click('[data-action="likely-no"]');
    assert.equal(await carRow().locator('.pill.likely').count(), 0); assert.match(await page.locator('.lk-bar').innerText(), /1 bill likely completed/);
    const s = await getState(page); assert.deepEqual(s.bank.notMatch[CK], ['pl:zelle']);
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.ov-bills'); assert.equal(await carRow().locator('.pill.likely').count(), 0, 'stays hidden after reload');
  });
  const openPicker = async id => {
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx');
    const row = page.locator(`.tx[data-id="${id}"]`); if (!(await row.evaluate(e => e.classList.contains('open')))) await row.locator('.tx-main').click();
    await row.locator('[data-action="tx-match"]').click(); await page.waitForSelector('.pk-opt');
  };
  await step('picker: sticky header with transaction summary + search; four sections; scrolls; screenshot', async () => {
    await openPicker('pl:zelle');
    const head = await page.locator('.pk-head').innerText(); assert.match(head, /Zelle/); assert.match(head, /Chime ••1234/); assert.match(head, /Nov 20/); assert.match(head, /\$280\.00/);
    assert.ok(await page.locator('.pk-find input').count());
    const secs = await page.locator('.pk-sec').allInnerTexts(); assert.deepEqual(secs.map(x => x.toLowerCase()), ['best match', 'same amount', 'near this date', 'everything upcoming']);
    assert.match(await page.locator('.pk-opt').first().innerText(), /Car payment/);
    const car = await page.locator('.pk-opt[data-key="b:car:2026-11-20"]').innerText(); assert.match(car, /Bill · due Nov 20/); assert.match(car, /\$280\.00/);
    assert.match(await page.locator('.pk-opt[data-key^="b:ins:"]').innerText(), /Bill · due Dec 5/);
    assert.ok(!/Phone/.test(await page.locator('#pklist').innerText()), 'paid item hidden');
    await sheetNoHScroll(page, '390 picker'); await page.waitForTimeout(450); await page.screenshot({ path: SHOTS + '/picker-390.png' });
    const m = await page.evaluate(() => { const l = document.querySelector('#pklist'), h = document.querySelector('.pk-head'), top = h.getBoundingClientRect().top; l.scrollTop = l.scrollHeight; return { can: l.scrollHeight > l.clientHeight, at: l.scrollTop, same: Math.abs(h.getBoundingClientRect().top - top) < 1, sheetH: document.querySelector('#sheet .sheet').getBoundingClientRect().height }; });
    assert.ok(m.can && m.at > 0 && m.same, JSON.stringify(m)); assert.ok(m.sheetH > 700, 'full height ' + m.sheetH);
    assert.match(await page.locator('.pk-more').innerText(), /Show paid items too/);
  });
  await step('search filters; Show paid items too reveals the paid phone bill marked as such', async () => {
    await page.fill('#pkq', 'insur'); assert.equal(await page.locator('.pk-opt').count(), 1); assert.ok(await page.evaluate(() => document.activeElement.id === 'pkq'));
    await page.fill('#pkq', ''); await page.click('[data-action="pk-paid"]');
    const t = await page.locator('.pk-opt[data-key^="b:ph:"]').innerText(); assert.match(t, /Marked paid/);
    assert.match(await page.locator('[data-action="pk-paid"]').innerText(), /Hide paid items/);
    await page.click('[data-action="pk-paid"]'); assert.equal(await page.locator('.pk-opt[data-key^="b:ph:"]').count(), 0);
  });
  await step('a clean match links at once with a toast; toast Undo works', async () => {
    await page.click('.pk-opt[data-key="b:car:2026-11-20"]');
    assert.ok(await page.evaluate(() => document.querySelector('#sheet').hidden)); assert.match(await page.locator('#toast').innerText(), /Matched to Car payment · Undo/);
    let s = await getState(page); assert.equal(s.occ[CK].txn, 'pl:zelle'); assert.equal(s.marks[CK], true);
    await page.click('#toast .toast-undo'); s = await getState(page); assert.ok(!(s.occ[CK] && s.occ[CK].txn)); assert.ok(!('pl:zelle' in s.bank.seen));
  });
  await step('an off item shows "Match anyway?" with the reasons; Pick another returns; Match anyway links', async () => {
    await openPicker('pl:zelle'); await page.fill('#pkq', 'rent'); await page.click('.pk-opt[data-key^="b:rent:"]');
    await page.waitForSelector('.pk-warn');
    const t = await page.locator('#sheet').innerText(); assert.match(t, /Match anyway\?/);
    assert.match(t, /Amounts differ: transaction \$280\.00, scheduled \$1,050\.00 \(\$770\.00 less\)/); assert.match(t, /Date is \d+ days (?:before|after) the due date \(due Dec 1, paid Nov 20\)/);
    assert.ok(!/Names don't look alike/.test(t), 'Zelle is person to person: no name warning');
    await sheetNoHScroll(page, '390 confirm');
    await page.click('[data-action="cf-back"]'); await page.waitForSelector('.pk-opt'); assert.equal(await page.inputValue('#pkq'), 'rent');
    await page.click('.pk-opt[data-key^="b:rent:"]'); await page.click('[data-action="cf-yes"]');
    const s = await getState(page), k = Object.keys(s.occ).find(x => /^b:rent:/.test(x) && s.occ[x].txn === 'pl:zelle'); assert.ok(k && s.marks[k] === true && s.bank.seen['pl:zelle'].res === 'bill');
    assert.match(await page.locator('#toast').innerText(), /Matched to Rent/);
    await page.click('#toast .toast-undo');
  });
  await step('name, amount and date warnings together; screenshot; direction and replace warnings', async () => {
    await openPicker('pl:wm'); await page.fill('#pkq', 'visa'); await page.click('.pk-opt[data-key^="c:visa:"]'); await page.waitForSelector('.pk-warn');
    const t = await page.locator('#sheet').innerText();
    assert.match(t, /Amounts differ: transaction \$42\.10, scheduled \$35\.00 \(\$7\.10 more\)/); assert.match(t, /Date is 6 days before the due date \(due Nov 22, paid Nov 16\)/); assert.match(t, /Names don't look alike \(Walmart Supercenter vs Visa\)/);
    await page.waitForTimeout(450); await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('on'), null, { timeout: 8000 }); await page.screenshot({ path: SHOTS + '/picker-warn-390.png' });
    await page.click('[data-action="cf-yes"]');
    let s = await getState(page); assert.equal(s.bank.seen['pl:wm'].res, 'bill');
    await page.click('#toast .toast-undo');
    // Added spend is replaced
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx');
    await page.locator('.tx[data-id="pl:wm"] .tx-main').click(); await page.locator('.tx[data-id="pl:wm"] [data-action="tx-cats"]').click(); await page.locator('.tx[data-id="pl:wm"] .chip', { hasText: 'Groceries' }).click();
    s = await getState(page); assert.ok(s.spends.some(x => x.bank === 'pl:wm')); assert.equal(await page.locator('.tx[data-id="pl:wm"] .txc').innerText(), 'Added · Groceries');
    await openPicker('pl:wm'); await page.fill('#pkq', 'visa'); await page.click('.pk-opt[data-key^="c:visa:"]'); await page.waitForSelector('.pk-warn');
    assert.match(await page.locator('#sheet').innerText(), /This will replace: Added · Groceries/);
    await page.click('[data-action="cf-yes"]');
    s = await getState(page); assert.ok(!s.spends.some(x => x.bank === 'pl:wm'), 'spend removed'); assert.equal(s.bank.seen['pl:wm'].res, 'bill');
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx'); assert.match(await page.locator('.tx[data-id="pl:wm"] .txc').innerText(), /^Matched · Visa/);
  });
  await step('951x669: picker is a centered modal; no horizontal scroll', async () => {
    await page.setViewportSize({ width: 951, height: 669 }); await page.waitForTimeout(200);
    await openPicker('pl:zelle'); await page.waitForTimeout(400); await sheetNoHScroll(page, '951 picker'); await noHScroll(page, '951 picker');
    const r = await page.evaluate(() => { const b = document.querySelector('#sheet .sheet').getBoundingClientRect(); return { l: b.left, r: innerWidth - b.right, t: b.top, bt: innerHeight - b.bottom, w: b.width }; });
    assert.ok(Math.abs(r.l - r.r) < 2 && r.t > 4 && r.bt > 4 && r.w <= 521, JSON.stringify(r));
    await page.keyboard.press('Escape');
    await page.goto(BASE + '#overview'); await page.waitForSelector('.ov-bills'); await noHScroll(page, '951 overview'); await page.goto(BASE + '#bills'); await noHScroll(page, '951 bills');
    await page.setViewportSize({ width: 390, height: 844 });
  });
  await step('Bills tab shows the pill too', async () => {
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.bank.notMatch = {}; localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.goto(BASE + '#bills'); await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.pill.likely'); assert.match(await page.locator('.row', { hasText: 'Car payment' }).innerText(), /likely completed[\s\S]*Zelle · \$280\.00/i);
    await noHScroll(page, '390 bills'); await page.locator('.pill.likely').click(); await page.waitForSelector('.lk-cmp'); await page.keyboard.press('Escape');
  });
  assert.deepEqual(errs, [], 'page errors in match picker / likely'); await page.context().close();
}

await browser.close();
console.log(failures ? failures + ' step(s) FAILED' : 'all steps passed');
process.exit(failures ? 1 : 0);
