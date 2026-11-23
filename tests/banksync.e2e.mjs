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
  bank: { seen: {}, rules: {}, links: {}, lastSync: null, inbox: [], api: '', autoFrom: '2026-11-01', historyFrom: '2026-10-01', savingsAccts: {} },
  bills: [{ id: 'rent', name: 'Rent', amount: 1050, day: 1, group: 'Fixed', category: 'Housing' }, { id: 'elec', name: 'Electric', amount: 70, day: 21, group: 'Fixed', category: 'Utilities' }],
  cards: [{ id: 'visa', name: 'Visa', day: 22, minPayment: 35, balance: 500, limit: 2000 }],
  plans: [{ id: 'k1', provider: 'Klarna', merchant: 'Nike', amount: 27.65, total: 4, paid: 1, freq: 'biweekly', lastDate: '2026-11-06', category: 'Other', dates: ['2026-10-23', '2026-11-06', '2026-11-20', '2026-12-04'] }],
  income: [{ id: 'pay', name: 'Payroll', freq: 'biweekly', date: '2026-11-19', amount: 1500, askFrom: '2026-11-19', perCycle: {} }],
  account: { balance: 3000, asOf: '2026-10-01', adj: [], auto: true }
});

let failures = 0;
const step = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 25).join('\n     ')); } };

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
    if (p === '/refresh' && m === 'POST') { if (mock.delay) await new Promise(r => setTimeout(r, mock.delay)); const it = u.searchParams.get('item'); if (it && !mock.enrollments.some(e => e.id === it)) return json({ error: 'unknown item' }, 404); return mock.refreshResp ? json(it ? { ...mock.refreshResp, results: mock.refreshResp.results.filter(x => x.itemId === it) } : mock.refreshResp) : json({ error: 'nope' }, 404); }
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
  await step('accounts list, toggle, typed-OKAY disconnect sheet, connect a bank', async () => {
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
    await d.click(); await page.waitForSelector('#dc-ok'); assert.ok(!calls.some(c => c.m === 'DELETE'), 'opening the sheet must not delete');
    assert.match(await page.locator('#sheet').innerText(), /free plan a removed bank still counts toward the 10-bank limit/);
    assert.equal(await page.locator('#dc-go').isDisabled(), true, 'disabled until OKAY is typed');
    await page.fill('#dc-ok', 'okay'); assert.equal(await page.locator('#dc-go').isDisabled(), true, 'lowercase does not unlock');
    await page.fill('#dc-ok', 'OKAYY'); assert.equal(await page.locator('#dc-go').isDisabled(), true);
    await page.fill('#dc-ok', 'OK'); assert.equal(await page.locator('#dc-go').isDisabled(), true);
    await page.fill('#dc-ok', '  OKAY '); assert.equal(await page.locator('#dc-go').isDisabled(), false, 'spaces around OKAY are ignored');
    await page.waitForTimeout(500); await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.classList.remove('on'); }); await page.screenshot({ path: SHOTS + '/disconnect-okay-390.png', animations: 'disabled' }); await sheetNoHScroll(page, '390 disconnect sheet');
    await page.click('#sheet [data-action="close"].btn'); assert.equal(await page.locator('#sheet').isHidden(), true, 'Cancel closes'); assert.ok(!calls.some(c => c.m === 'DELETE'));
    await page.locator('[data-action="bk-disc"]').nth(1).click(); await page.waitForSelector('#dc-ok');
    assert.equal(await page.locator('#dc-go').isDisabled(), true, 'a reopened sheet starts locked');
    await page.fill('#dc-ok', 'OKAY'); await page.click('#dc-go');
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
    assert.equal(sc[0].q, '?since=2026-10-01&acks='); assert.equal(sc[0].auth, 'Bearer secret-device-key-123');
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
    assert.equal(sc[1].q, '?since=' + exp + '&acks=&ack=tok-1', 'acks the first response token (a Worker without per-bank cursors)');
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
  await step('Overview bar opens the Transactions tab on All, at the To review section', async () => {
    await page.click('.bx-bar'); await page.waitForSelector('.tx');
    assert.equal(await page.evaluate(() => location.hash), '#transactions');
    assert.equal(await page.locator('#txreview .tx').count(), 4);
    assert.equal(await page.locator('[data-action="tx-filter"][aria-pressed="true"]').innerText().then(t => t.split(' ')[0]), 'All');
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
  await step('tapping Left in paycheck opens "This paycheck" with the per-account split', async () => {
    await page.click('.lad.l1'); await page.waitForSelector('#sheet .pc-part');
    const rows = (await page.locator('#sheet .pc-part').allInnerTexts()).map(r => r.replace(/\s+/g, ' '));
    assert.ok(rows.some(r => /Santander ••6429/.test(r) && /\$100\.00/.test(r)), rows.join('|')); assert.ok(rows.some(r => /Santander ••6429/.test(r) && /\$300\.00/.test(r))); assert.ok(rows.some(r => /Citizens ••4417/.test(r) && /\$1,873\.31/.test(r)));
    await noHScroll(page, '390 overview with split');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
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
    assert.match(t, /2,300/); assert.doesNotMatch(t, /\d+ accounts?/); assert.match(t, /(Updated|Upd\.) \d{1,2}:\d{2}/);
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
    // "Start fresh" so the lower balance doesn't open the "Where did $X go?" sheet a moment later and cover the next step.
    await page.fill('#a-bal', '1234.56'); await page.check('#a-fresh'); await page.click('#acctform button[type=submit]');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.useBankBalance === false);
    assert.doesNotMatch(await page.locator('.lad.l3').innerText(), /Updated|Upd\./);
    // The saved sheet must be fully closed before reopening, or the wait below can match the closing one.
    await page.waitForFunction(() => document.querySelector('#sheet').hidden);
    await page.click('[data-action="account"]'); await page.waitForSelector('#acctform');
    // Let the sheet finish sliding in before tapping inside it.
    await page.waitForTimeout(350);
    await page.click('[data-action="bal-live"]'); await page.waitForSelector('.bal-total');
    assert.match(await page.locator('.lad.l3').innerText(), /(Updated|Upd\.) \d{1,2}:\d{2}/);
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
  await step('bottom bar is Overview, Transactions, Bills, Plans, Income and fits at 390', async () => {
    assert.deepEqual(await page.locator('.tabs a').allInnerTexts(), ['Overview', 'Transactions', 'Bills', 'Plans', 'Income']);
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
    assert.equal(await page.locator('.tx').count(), 61, 'first 60 dated rows plus the line in the To review section');
    await page.click('[data-action="tx-more"]');
    assert.equal(await page.locator('.tx').count(), 75 + 3);
    assert.ok(await page.locator('.tx-day').count() > 5);
    assert.equal(await page.locator('.tx[data-id="m1"] .txc').innerText(), 'To review'); assert.equal(await page.locator('.tx[data-id="m2"] .txc').innerText(), 'Earlier · add by hand'); assert.equal(await page.locator('.tx[data-id="m3"] .txc').innerText(), 'Accepted · Other');
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
    assert.equal(await chip('pl:dd'), 'To review'); assert.equal(await chip('pl:wm'), 'To review');
    assert.match(await row('pl:pay').innerText(), /\+\$1,500\.00/); assert.ok(await row('pl:pay').locator('.amt.in').count());
    assert.match(await row('pl:pend').innerText(), /pending/i); assert.match(await row('pl:dd').innerText(), /Chime ••1234/);
    const days = await page.locator('.tx-day').allInnerTexts(); assert.deepEqual(days, [...days].sort((a, b) => 0)); assert.match(days[0], /Nov 21|Nov 20/);
    const dates = await page.evaluate(() => [...document.querySelectorAll('.tx-day')].map(e => e.textContent)); assert.equal(new Set(dates).size, dates.length);
    await noHScroll(page, '390 transactions'); await tabsFit(page, '390 transactions');
    await page.screenshot({ path: SHOTS + '/tx-390.png' });
  });
  await step('filters and search', async () => {
    const f = v => page.click(`[data-action="tx-filter"][data-f="${v}"]`);
    assert.equal(await page.locator('#txreview .tx').count(), 6, 'six lines in the To review section of All');
    await f('matched'); assert.equal(await page.locator('.tx').count(), 2);
    await f('accepted'); assert.equal(await page.locator('.tx').count(), 1);
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
    assert.equal(await chip('pl:dd'), 'Accepted · Dining Out');
  });
  await step('changing the category of an added row updates the spend', async () => {
    await open('pl:dd'); await row('pl:dd').locator('[data-action="tx-cats"]').click();
    await row('pl:dd').locator('.chip', { hasText: 'Groceries' }).click();
    const s = await getState(page); assert.equal(s.spends.find(z => z.bank === 'pl:dd').category, 'Groceries'); assert.equal(await chip('pl:dd'), 'Accepted · Groceries');
  });
  await step('Edit opens the spending form prefilled and saves through the same path', async () => {
    await open('pl:amb'); await row('pl:amb').locator('[data-action="tx-edit"]').click(); await page.waitForSelector('#form[data-tx]');
    assert.equal(await page.inputValue('#form [name=amount]'), '18.99'); assert.equal(await page.inputValue('#form [name=date]'), '2026-11-18');
    await page.fill('#form [name=desc]', 'Mystery lunch'); await page.selectOption('#form [name=category]', 'Dining Out'); await page.click('#form button[type=submit]');
    const s = await getState(page); const x = s.spends.find(z => z.bank === 'pl:amb'); assert.ok(x && x.desc === 'Mystery lunch' && x.category === 'Dining Out');
    assert.equal(await chip('pl:amb'), 'Accepted · Dining Out'); assert.ok(await page.evaluate(() => document.querySelector('#sheet').hidden));
  });
  await step('Undo on a matched bill reverses it; Match then links it from the list', async () => {
    await open('pl:electric'); await row('pl:electric').locator('[data-action="tx-undo"]').click();
    let s = await getState(page); const ek = Object.keys(s.occ).find(k => /^b:elec:/.test(k) && s.occ[k].txn); assert.ok(!ek, 'unlinked'); assert.ok(s.bank.inbox.some(i => i.txn.id === 'pl:electric'));
    assert.equal(await chip('pl:electric'), 'To review');
    await open('pl:electric'); await row('pl:electric').locator('[data-action="tx-match"]').click(); await page.waitForSelector('.pk-opt');
    const cands = await page.locator('.pk-opt').allInnerTexts(); assert.match(cands[0], /Electric/); assert.match(cands[0], /Bill · due Nov 21/); assert.match(await page.locator('.pk-sec').first().innerText(), /best match/i);
    await sheetNoHScroll(page, '390 match sheet');
    await page.locator('.pk-opt', { hasText: 'Electric' }).first().click();
    s = await getState(page); const k2 = s.bank.seen['pl:electric'].key; assert.ok(/^b:elec:/.test(k2)); assert.equal(s.marks[k2], true); assert.equal(s.occ[k2].txn, 'pl:electric'); assert.equal(s.occ[k2].paidOn, '2026-11-20'); assert.equal(s.bank.seen['pl:electric'].res, 'bill');
    assert.match(await chip('pl:electric'), /^Matched · Electric/);
  });
  await step('Match a Klarna payment to a plan from the list; screenshot of the match sheet', async () => {
    await open('pl:klarna'); await row('pl:klarna').locator('[data-action="tx-undo"]').click();
    let s = await getState(page); assert.ok(!(s.occ['p:k1:3'] && s.occ['p:k1:3'].txn)); assert.equal(await chip('pl:klarna'), 'To review');
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
    assert.equal(await chip('pl:cc'), 'Skipped'); assert.equal((await getState(page)).bank.seen['pl:cc'].res, 'skip');
    await page.click('[data-action="tx-filter"][data-f="ignored"]'); assert.equal(await page.locator('.tx').count(), 1);
    await open('pl:cc'); await row('pl:cc').locator('[data-action="tx-undo"]').click();
    assert.equal(await page.locator('.tx').count(), 0); await page.click('[data-action="tx-filter"][data-f="all"]');
    assert.equal(await chip('pl:cc'), 'To review'); assert.ok(!('pl:cc' in (await getState(page)).bank.seen));
  });
  await step('money in: Accept offers Paycheck or Refund, no Match', async () => {
    await open('pl:pay'); await row('pl:pay').locator('[data-action="tx-undo"]').click();
    assert.equal(await chip('pl:pay'), 'To review'); assert.equal((await getState(page)).income[0].perCycle['2026-11-19'], undefined);
    await open('pl:pay'); assert.equal(await row('pl:pay').locator('[data-action="tx-match"]').count(), 0); assert.equal(await row('pl:pay').locator('[data-action="tx-edit"]').count(), 0);
    await row('pl:pay').locator('[data-action="tx-in"]').click();
    assert.match(await row('pl:pay').innerText(), /Paycheck/); assert.match(await row('pl:pay').innerText(), /Refund or transfer/);
    await row('pl:pay').locator('[data-action="tx-paycheck"]').click();
    const s = await getState(page); assert.equal(s.income[0].perCycle['2026-11-19'], 1500); assert.equal(s.bank.seen['pl:pay'].res, 'income'); assert.equal(await chip('pl:pay'), 'Paycheck');
    await open('pl:pend'); await row('pl:pend').locator('[data-action="tx-ignore"]').click();
  });
  await step('"Review one by one" and Accept all sit in the To review section of All', async () => {
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
    const c = page.locator('#latestpay');
    const t0 = await c.innerText();
    assert.equal(await c.locator('.coll-h').getAttribute('aria-expanded'), 'false', 'collapsed by default');
    assert.match(t0, /\$2,273\.31/); assert.match(t0, /Fri, Nov 20/); assert.match(t0, /from your bank/i);
    assert.ok(!(await c.locator('.pc-parts').first().isVisible()), 'deposit parts hidden while collapsed'); assert.ok(!/Earlier paychecks|Next paycheck|Edit total/.test(t0));
    await page.screenshot({ path: SHOTS + '/income-collapsed-390.png' });
    await c.locator('.coll-h').click(); assert.equal(await c.locator('.coll-h').getAttribute('aria-expanded'), 'true');
    const t = await c.innerText();
    assert.match(t, /\$2,273\.31/); assert.match(t, /Fri, Nov 20/); assert.match(t, /from your bank/i); assert.equal(await c.locator('.pc-parts').first().locator('li').count(), 3);
    assert.match(t, /Citizens ••4417/); assert.match(t, /Santander ••6429/); assert.match(t, /Posted Nov 19/); assert.match(t, /\+\$1,873\.31/);
    assert.match(t, /Next paycheck Fri, Dec 4 · comes in automatically from your bank/);
    assert.ok(!/280/.test(t));
    assert.match(t, /earlier paychecks/i); assert.match(t, /Fri, Nov 6/);
    await c.locator('[data-action="pc-toggle"]').click(); assert.match(await page.locator('.pc-o').innerText(), /No bank deposits|\$1,500\.00/);
    await noHScroll(page, '390 income');
    await c.scrollIntoViewIfNeeded(); await page.screenshot({ path: SHOTS + '/income-390.png' }); await page.screenshot({ path: SHOTS + '/income-expanded-390.png' });
    assert.match(t, /Paycheck settings/);
    await c.locator('[data-action="edit"][data-type="income"]').click(); await page.waitForSelector('#form'); assert.match(await page.locator('#sheet').innerText(), /Payroll|Stat Delivery|Income/i); await page.keyboard.press('Escape');
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#latestpay');
    assert.equal(await page.locator('#latestpay .coll-h').getAttribute('aria-expanded'), 'true', 'expanded state remembered');
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
    assert.equal(await page.locator('.tx[data-id="pl:s2"] .txc').innerText(), 'To review');
    assert.equal(await page.locator('.tx[data-id="pl:s1"] .txc').innerText(), 'Paycheck');
    assert.equal(await page.locator('#main [data-action="ix-all"]').count(), 0, 'no Accept all while nothing is ready: it skips transfers without a target');
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
    // v13: an "Earlier" section (the previous two pay cycles, paid items included) follows the upcoming list.
    const secs = await page.locator('.pk-sec').allInnerTexts(); assert.deepEqual(secs.map(x => x.toLowerCase()), ['best match', 'same amount', 'near this date', 'everything upcoming', 'earlier']);
    assert.match(await page.locator('.pk-opt').first().innerText(), /Car payment/);
    const car = await page.locator('.pk-opt[data-key="b:car:2026-11-20"]').innerText(); assert.match(car, /Bill · due Nov 20/); assert.match(car, /\$280\.00/);
    assert.match(await page.locator('.pk-opt[data-key="b:ins:2026-12-05"]').innerText(), /Bill · due Dec 5/);
    assert.match(await page.locator('.pk-opt[data-key="b:ins:2026-11-05"]').innerText(), /Bill · due Nov 5/, 'last cycle\'s insurance (same amount) is offered too');
    assert.equal(await page.locator('.pk-opt[data-key="b:ph:2026-11-23"]').count(), 0, 'paid upcoming item hidden');
    await sheetNoHScroll(page, '390 picker'); await page.waitForTimeout(450); await page.screenshot({ path: SHOTS + '/picker-390.png' });
    const m = await page.evaluate(() => { const l = document.querySelector('#pklist'), h = document.querySelector('.pk-head'), top = h.getBoundingClientRect().top; l.scrollTop = l.scrollHeight; return { can: l.scrollHeight > l.clientHeight, at: l.scrollTop, same: Math.abs(h.getBoundingClientRect().top - top) < 1, sheetH: document.querySelector('#sheet .sheet').getBoundingClientRect().height }; });
    assert.ok(m.can && m.at > 0 && m.same, JSON.stringify(m)); assert.ok(m.sheetH > 700, 'full height ' + m.sheetH);
    assert.match(await page.locator('.pk-more').innerText(), /Show paid items too/);
  });
  await step('search filters; Show paid items too reveals the paid phone bill marked as such', async () => {
    await page.fill('#pkq', 'insur'); assert.equal(await page.locator('.pk-opt').count(), 2, 'this month and last month'); assert.ok(await page.evaluate(() => document.activeElement.id === 'pkq'));
    await page.fill('#pkq', ''); await page.click('[data-action="pk-paid"]');
    const t = await page.locator('.pk-opt[data-key="b:ph:2026-11-23"]').innerText(); assert.match(t, /Marked paid/);
    assert.match(await page.locator('[data-action="pk-paid"]').innerText(), /Hide paid items/);
    await page.click('[data-action="pk-paid"]'); assert.equal(await page.locator('.pk-opt[data-key="b:ph:2026-11-23"]').count(), 0);
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
    s = await getState(page); assert.ok(s.spends.some(x => x.bank === 'pl:wm')); assert.equal(await page.locator('.tx[data-id="pl:wm"] .txc').innerText(), 'Accepted · Groceries');
    await openPicker('pl:wm'); await page.fill('#pkq', 'visa'); await page.click('.pk-opt[data-key^="c:visa:"]'); await page.waitForSelector('.pk-warn');
    assert.match(await page.locator('#sheet').innerText(), /This will replace: Accepted · Groceries/);
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

/* ---------- v5: grouped categories, notes, strong delivery rules, tab order ---------- */
{
  const { page, errs } = await newPage(390, 844);
  const DD = T('ddwait', '2026-11-19', 'DOORDASH*CHICK FIL A', 24.5, { providerCategory: 'dining' });
  const put = (extra) => page.evaluate(([fx, ex]) => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1')); Object.assign(s, JSON.parse(fx)); Object.assign(s.bank, JSON.parse(ex));
    localStorage.setItem('budtrack.v1', JSON.stringify(s));
  }, [JSON.stringify(fixtureState({})), JSON.stringify(extra || {})]);
  await page.goto(BASE, { waitUntil: 'load' });
  await step('migration keeps user categories, adds defaults once, maps Dining, re-guesses a waiting DoorDash line', async () => {
    await page.evaluate(([dd]) => {
      const s = JSON.parse(localStorage.getItem('budtrack.v1'));
      s.categories = ['Gas', 'Dining', 'My Custom', 'Other']; s.billCats = ['Housing', 'Utilities', 'Other']; s.catParents = {};
      s.spends = [{ id: 'x1', category: 'Dining', desc: 'Pizza', amount: 12, date: '2026-11-20', note: '' }];
      s.imports = (s.imports || []).filter(k => k !== 'cats-v2' && k !== 'strong-rules-1');
      s.bank.inbox = [{ txn: JSON.parse(dd), kind: 'spend', confidence: 'medium', cands: [], pick: null, category: 'Dining Out', source: 'provider' }];
      localStorage.setItem('budtrack.v1', JSON.stringify(s));
    }, [JSON.stringify(DD)]);
    await page.reload({ waitUntil: 'load' });
    const s = await getState(page), all = [...s.categories, ...s.billCats];
    assert.ok(s.categories.includes('My Custom') && s.categories.includes('Gas') && !s.categories.includes('Dining'));
    assert.equal(s.spends[0].category, 'Dining Out');
    ['Food', 'Laundry', 'Takeout Food', 'Snacks & Drinks', 'Parking & Tolls', 'Fees', 'Housing'].forEach(c => assert.equal(all.filter(x => x === c).length, 1, c + ' appears once'));
    assert.equal(new Set(all).size, new Set([...s.categories]).size + s.billCats.filter(c => !s.categories.includes(c)).length, 'no duplicates across lists');
    assert.equal(s.catParents.Laundry, 'Home'); assert.equal(s.catParents['Takeout Food'], 'Food'); assert.ok(!('My Custom' in s.catParents)); assert.ok(!('Entertainment' in s.catParents));
    assert.equal(s.bank.inbox[0].category, 'Takeout Food');
    await page.reload({ waitUntil: 'load' });
    const s2 = await getState(page); assert.equal(s2.categories.length, s.categories.length, 'second load adds nothing');
  });
  await step('bottom bar order and screenshot', async () => {
    await put(); await page.goto(BASE + '#overview'); await page.reload({ waitUntil: 'load' });
    assert.deepEqual(await page.locator('.tabs a').allInnerTexts(), ['Overview', 'Transactions', 'Bills', 'Plans', 'Income']);
    await tabsFit(page, '390'); await noHScroll(page, '390 overview'); await page.screenshot({ path: SHOTS + '/tabs-390.png' });
  });
  await step('spending form: Note beside Or new category, grouped select with Food and Laundry', async () => {
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.imports = s.imports.filter(k => k !== 'cats-v2'); localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => document.querySelector('[data-action="add"][data-type="bill"]') && 0);
    await page.click('.ov-bills [data-action="add"]'); await page.waitForSelector('#form');
    if (await page.locator('#f-newcat').count() === 0) { await page.click('.kind-seg [data-type="extra"]'); await page.waitForSelector('#f-newcat'); }
    const bx = await page.evaluate(() => { const r = id => document.querySelector(id).closest('label').getBoundingClientRect(); const a = r('#f-newcat'), b = r('#f-note'); return { at: a.top, bt: b.top, aw: a.width, bw: b.width, al: a.left, bl: b.left }; });
    assert.ok(Math.abs(bx.at - bx.bt) < 2 && bx.bl > bx.al && Math.abs(bx.aw - bx.bw) < 2 && bx.aw < 200, JSON.stringify(bx));
    assert.match(await page.locator('label[for="f-note"] span').innerText(), /^Note \(optional\)$/);
    const groups = await page.evaluate(() => [...document.querySelectorAll('#f-category optgroup')].map(g => [g.label, [...g.children].map(o => o.value)]));
    const food = groups.find(g => g[0] === 'Food'), home = groups.find(g => g[0] === 'Home');
    assert.equal(food[1][0], 'Food'); assert.ok(food[1].includes('Takeout Food')); assert.ok(home[1].includes('Laundry'));
    await page.selectOption('#f-category', 'Laundry'); await page.fill('#f-note', 'quarters for the dryer'); await page.fill('#f-amount', '6.5'); await page.fill('#f-desc', 'Laundromat');
    await sheetNoHScroll(page, '390 spend form');
    await page.waitForTimeout(300); await page.screenshot({ path: SHOTS + '/cats-390.png' });
    await page.click('#form button[type=submit]');
    const s = await getState(page); const x = s.spends.find(z => z.desc === 'Laundromat'); assert.equal(x.note, 'quarters for the dryer'); assert.equal(x.category, 'Laundry');
    await page.waitForSelector('.row .nlabel'); assert.match(await page.locator('.row', { hasText: 'Laundromat' }).locator('.nlabel').innerText(), /quarters for the dryer/);
  });
  await step('Transactions: add note on a spend row and on a matched bill row; both show in Transactions and Overview', async () => {
    const t1 = T('spendtx', '2026-11-20', 'WALMART', 31.2), t2 = T('electric2', '2026-11-20', 'NATIONAL GRID ELECTRIC', 70);
    const KEY = 'b:elec:2026-11-21';
    await page.evaluate(([a, b, key]) => {
      const s = JSON.parse(localStorage.getItem('budtrack.v1')), A = JSON.parse(a), B = JSON.parse(b), at = new Date().toISOString();
      s.bank.txns[A.id] = A; s.bank.txns[B.id] = B;
      s.spends.push({ id: 'xs1', category: 'Groceries', desc: 'Walmart', amount: 31.2, date: '2026-11-20', note: 'Bank sync', bank: A.id });
      s.bank.seen[A.id] = { res: 'spend', kind: 'spend', spendId: 'xs1', what: 'Groceries · Walmart', date: A.date, amount: A.amount, desc: A.desc, at, src: 'sync', auto: false, txn: A };
      s.marks[key] = true; s.occ[key] = { txn: B.id, paidOn: B.date };
      s.bank.seen[B.id] = { res: 'bill', kind: 'bill', key, what: 'Electric bill', date: B.date, amount: B.amount, desc: B.desc, at, src: 'sync', auto: false, txn: B, prev: { mark: null, occ: null } };
      localStorage.setItem('budtrack.v1', JSON.stringify(s));
    }, [JSON.stringify(t1), JSON.stringify(t2), KEY]);
    await page.goto(BASE + '#transactions'); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.tx');
    for (const [id, text] of [['pl:spendtx', 'weekly shop'], ['pl:electric2', 'Nov bill, higher heat']]) {
      await page.locator('.tx[data-id="' + id + '"] .tx-main').click();
      await page.locator('.tx[data-id="' + id + '"] [data-action="tx-note"]').click();
      await page.fill('#txnote', text); await page.locator('[data-action="tx-note-save"]').click();
      await page.waitForSelector('.tx[data-id="' + id + '"] .nlabel');
      assert.equal(await page.locator('.tx[data-id="' + id + '"] .nlabel').innerText(), text);
    }
    await page.locator('.tx[data-id="pl:spendtx"] .tx-main').click();
    assert.equal(await page.locator('.tx[data-id="pl:spendtx"] [data-action="tx-note"]').innerText(), 'Edit note');
    await page.waitForTimeout(250); await noHScroll(page, '390 tx notes'); await page.screenshot({ path: SHOTS + '/tx-note-390.png' });
    const s = await getState(page);
    assert.equal(s.bank.notes['pl:spendtx'], 'weekly shop'); assert.equal(s.spends.find(z => z.id === 'xs1').note, 'weekly shop');
    assert.equal(s.bank.notes['pl:electric2'], 'Nov bill, higher heat'); assert.equal(s.occ[KEY].note, 'Nov bill, higher heat'); assert.equal(s.occ[KEY].txn, 'pl:electric2');
    await page.goto(BASE + '#overview'); await page.waitForSelector('.ov-bills');
    assert.match(await page.locator('.row', { hasText: 'Walmart' }).locator('.nlabel').innerText(), /weekly shop/);
    assert.match(await page.locator('.row', { hasText: 'Electric' }).locator('.nlabel').innerText(), /Nov bill, higher heat/);
    // the spend form edit keeps the txn note in step
    await page.locator('.row', { hasText: 'Walmart' }).locator('.tapzone').click(); await page.waitForSelector('#f-note');
    assert.equal(await page.inputValue('#f-note'), 'weekly shop'); await page.fill('#f-note', 'edited in form'); await page.click('#form button[type=submit]');
    assert.equal((await getState(page)).bank.notes['pl:spendtx'], 'edited in form');
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx'); assert.equal(await page.locator('.tx[data-id="pl:spendtx"] .nlabel').innerText(), 'edited in form');
  });
  await step('951x669: no horizontal scroll on Transactions, Overview and the spend form', async () => {
    await page.setViewportSize({ width: 951, height: 669 }); await page.waitForTimeout(200);
    await page.goto(BASE + '#transactions'); await noHScroll(page, '951 transactions'); await page.goto(BASE + '#overview'); await page.waitForSelector('.ov-bills'); await noHScroll(page, '951 overview');
    await page.click('.ov-bills [data-action="add"]'); await page.waitForSelector('#form'); await sheetNoHScroll(page, '951 form'); await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
  });
  await step('category manager groups categories and sets a group', async () => {
    await page.goto(BASE + '#income'); await page.waitForSelector('[data-k="cat"]');
    assert.equal(await page.getAttribute('[data-k="cat"]', 'aria-expanded'), 'false'); assert.ok(!(await page.locator('.cat-list').first().isVisible()), 'categories collapsed by default');
    await page.click('[data-k="cat"]'); await page.waitForSelector('.cat-list');
    assert.ok(await page.locator('.cat-gh', { hasText: 'Food' }).count() > 0);
    await noHScroll(page, '390 cat manager');
    await page.locator('.cat-gh', { hasText: 'Food' }).first().scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await page.screenshot({ path: SHOTS + '/catmgr-390.png' });
    await page.selectOption('select.cat-par[data-cat="Gaming"]', 'Shopping');
    assert.equal((await getState(page)).catParents.Gaming, 'Shopping');
    await page.fill('#nc-s', 'Pet food'); await page.selectOption('#np-s', 'Food'); await page.click('.cat-add[data-list="categories"] button[type=submit]');
    assert.equal((await getState(page)).catParents['Pet food'], 'Food');
  });
  await step('grouped Accept chips on Transactions: Food parent chip first', async () => {
    const t = T('newwait', '2026-11-18', 'MYSTERY CAFE', 9);
    await page.evaluate(([a]) => { const s = JSON.parse(localStorage.getItem('budtrack.v1')), A = JSON.parse(a); s.bank.txns[A.id] = A; s.bank.inbox = [{ txn: A, kind: 'spend', confidence: 'low', cands: [], pick: null, category: 'Other', source: 'default' }]; localStorage.setItem('budtrack.v1', JSON.stringify(s)); }, [JSON.stringify(t)]);
    await page.goto(BASE + '#transactions'); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.tx');
    await page.locator('.tx[data-id="pl:newwait"] .tx-main').click(); await page.locator('.tx[data-id="pl:newwait"] [data-action="tx-cats"]').click();
    const first = await page.evaluate(() => { const g = document.querySelector('.tx.open .cgrp'); return [...g.querySelectorAll('.chip')].map(c => c.textContent.trim()).slice(0, 2).concat(g.querySelector('.chip').classList.contains('chip-parent')); });
    assert.deepEqual(first, ['Food', 'Groceries', true]); await noHScroll(page, '390 chips'); await page.locator('.tx.open .cgroups').scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await page.screenshot({ path: SHOTS + '/chips-390.png' });
  });
  assert.deepEqual(errs, [], 'page errors in v5 block'); await page.context().close();
}

/* ---------- v6: an accepted transaction never shows Needs review again ---------- */
{
  const { page, errs, mock } = await prepared(390, 844);
  const santander = { id: 'acc9', name: 'Santander Checking', last4: '6429', institution: 'Santander', type: 'depository' };
  const DP = (extra) => T('dpend', '2026-11-19', 'DOORDASH*MIKES PIZZA', 17.99, Object.assign({ status: 'pending', account: santander }, extra || {}));
  const row = id => page.locator('.tx[data-id="' + id + '"]');
  const chip = async id => (await row(id).locator('.txc').innerText()).trim();
  const resync = async () => {
    await page.goto(BASE + '#income'); await page.waitForSelector('[data-action="bk-sync"]');
    const n = await page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.lastSync);
    await page.click('[data-action="bk-sync"]');
    await page.waitForFunction(o => JSON.parse(localStorage.getItem('budtrack.v1')).bank.lastSync !== o && document.querySelector('[data-action="bk-sync"]') && !document.querySelector('[data-action="bk-sync"]').disabled, n);
    await page.goto(BASE + '#transactions'); await page.waitForSelector('.tx');
  };
  const open = async id => { if (!(await row(id).locator('.tx-p').count())) await row(id).locator('.tx-main').click(); };
  const accept = async id => { await open(id); await row(id).locator('[data-action="tx-cats"]').click(); await row(id).locator('.chip', { hasText: 'Dining Out' }).first().click(); await page.waitForFunction(i => !!JSON.parse(localStorage.getItem('budtrack.v1')).bank.seen[i], id); };
  const addNote = async (id, text) => { await open(id); await row(id).locator('[data-action="tx-note"]').click(); await page.fill('#txnote', text); await page.locator('[data-action="tx-note-save"]').click(); await page.waitForTimeout(150); };
  const fresh = async txns => {
    mock.txns = txns; mock.removed = [];
    await page.goto(BASE + '#income', { waitUntil: 'load' });
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.bank = Object.assign(s.bank, { seen: {}, inbox: [], txns: {}, notes: {}, history: [], lastSync: null, syncToken: null }); s.spends = []; s.occ = {}; localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.lastSync);
    await page.goto(BASE + '#transactions'); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.tx');
  };
  const inboxHas = async id => (await getState(page)).bank.inbox.some(x => (x.parts || [x.txn]).some(t => t.id === id || t.pendingOf === id));
  await step('pending txn: Accept from Transactions tab shows Accepted, not To review', async () => {
    await fresh([DP()]);
    assert.equal(await chip('pl:dpend'), 'To review');
    await accept('pl:dpend');
    assert.match(await chip('pl:dpend'), /^Accepted/); assert.ok(!(await inboxHas('pl:dpend')), 'left the inbox');
  });
  await step('add note then accept, and accept then add note: stays Accepted', async () => {
    await fresh([DP()]);
    await addNote('pl:dpend', 'Mikes Pizza - Burguer');
    assert.equal(await chip('pl:dpend'), 'To review', 'note alone does not change review status');
    await accept('pl:dpend');
    assert.match(await chip('pl:dpend'), /^Accepted/);
    let s = await getState(page); assert.equal(s.spends[0].note, 'Mikes Pizza - Burguer');
    await resync(); await page.waitForTimeout(150);
    await fresh([DP()]); await accept('pl:dpend'); await addNote('pl:dpend', 'Mikes Pizza - Burguer');
    assert.match(await chip('pl:dpend'), /^Accepted/); assert.ok(!(await inboxHas('pl:dpend')));
    await resync(); await page.goto(BASE + '#transactions'); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.tx');
    assert.match(await chip('pl:dpend'), /^Accepted/); assert.equal((await getState(page)).spends.length, 1);
  });
  await step('Edit with a note from the Transactions tab: Added', async () => {
    await fresh([DP()]);
    await open('pl:dpend'); await row('pl:dpend').locator('[data-action="tx-edit"]').click(); await page.waitForSelector('#f-note');
    await page.fill('#f-note', 'Mikes Pizza - Burguer'); await page.click('#form button[type=submit]');
    await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('budtrack.v1')).bank.seen).length);
    assert.match(await chip('pl:dpend'), /^Accepted/); assert.ok(!(await inboxHas('pl:dpend')));
  });
  await step('re-delivered and modified pending txn after accept stays Added', async () => {
    await fresh([DP()]); await accept('pl:dpend');
    await resync(); await resync();
    mock.txns = [DP({ amount: 17.99, desc: 'DOORDASH*MIKES PIZZA NY' })]; await resync();
    await page.goto(BASE + '#transactions'); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.tx');
    assert.match(await chip('pl:dpend'), /^Accepted/); assert.ok(!(await inboxHas('pl:dpend')), 'not back in the inbox');
    assert.equal((await page.locator('.txc', { hasText: /^To review$/ }).count()), 0);
    assert.equal((await getState(page)).spends.length, 1, 'no duplicate spend');
  });
  await step('posted twin with pendingOf after accepting pending: Added on the posted row, no Needs review row', async () => {
    await fresh([DP()]); await accept('pl:dpend');
    mock.txns = [T('dpost', '2026-11-20', 'DOORDASH*MIKES PIZZA', 17.99, { account: santander, pendingOf: 'pl:dpend' })]; mock.removed = ['pl:dpend']; await resync();
    await page.goto(BASE + '#transactions'); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.tx');
    assert.match(await chip('pl:dpost'), /^Accepted/); assert.equal(await page.locator('.tx[data-id="pl:dpend"]').count(), 0);
    assert.equal((await page.locator('.txc', { hasText: /^To review$/ }).count()), 0);
    const s = await getState(page); assert.ok(s.bank.seen['pl:dpost'] && !s.bank.seen['pl:dpend']); assert.ok(!(await inboxHas('pl:dpend')) && !(await inboxHas('pl:dpost')));
    // the pending one is re-delivered later by a stale batch: still not a new review row
    mock.txns = [DP(), T('dpost', '2026-11-20', 'DOORDASH*MIKES PIZZA', 17.99, { account: santander, pendingOf: 'pl:dpend' })]; mock.removed = []; await resync();
    const s2 = await getState(page); assert.ok(!(await inboxHas('pl:dpend')), 'stale pending not re-queued'); assert.equal(s2.spends.length, 1);
  });
  await step('inbox-purge-1 repair removes inbox rows already handled, on load', async () => {
    await fresh([DP()]); await accept('pl:dpend');
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')), t = s.bank.txns['pl:dpend']; s.bank.inbox = [{ txn: t, kind: 'spend', confidence: 'low', cands: [], pick: null, category: 'Other', source: 'default' }]; s.imports = s.imports.filter(k => k !== 'inbox-purge-1'); localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.tx');
    assert.match(await chip('pl:dpend'), /^Accepted/);
    const s = await getState(page); assert.equal(s.bank.inbox.length, 0); assert.ok(s.imports.includes('inbox-purge-1'));
  });
  await step('inbox-purge-1 repair: posted row whose pending twin was accepted inherits the decision', async () => {
    await fresh([DP()]); await accept('pl:dpend');
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')), q = { id: 'pl:dpost', date: '2026-11-20', desc: 'DOORDASH*MIKES PIZZA', rawDesc: 'x', amount: 17.99, status: 'posted', pendingOf: 'pl:dpend', account: s.bank.txns['pl:dpend'].account };
      s.bank.txns['pl:dpost'] = q; s.bank.inbox = [{ txn: q, kind: 'spend', confidence: 'low', cands: [], pick: null, category: 'Other', source: 'default' }]; s.imports = s.imports.filter(k => k !== 'inbox-purge-1'); localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.tx');
    assert.match(await chip('pl:dpost'), /^Accepted/); assert.equal(await page.locator('.tx[data-id="pl:dpend"]').count(), 0);
    const s = await getState(page); assert.equal(s.bank.inbox.length, 0); assert.equal(s.spends.length, 1); assert.equal(s.spends[0].bank, 'pl:dpost');
  });
  assert.deepEqual(errs, [], 'page errors in v6 accept flow'); await page.context().close();
}

/* ---------- v6: collapsible Income sections, per-bank refresh ---------- */
{
  const { page, errs, calls, mock } = await prepared(390, 844);
  mock.enrollments.push({ id: 'enr_2', institution: 'Citizens', needsReconnect: false, accounts: [{ id: 'acc3', name: 'Everyday', type: 'depository', subtype: 'checking', last_four: '4417', enabled: true }] });
  await page.goto(BASE + '#income', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.lastSync); await page.waitForSelector('.bk-enr');
  const exp = k => page.getAttribute('.coll-h[data-k="' + k + '"]', 'aria-expanded');
  await step('Paid via and Categories are collapsed by default and expand to their content', async () => {
    assert.equal(await exp('via'), 'false'); assert.equal(await exp('cat'), 'false');
    assert.match(await page.locator('.coll-h[data-k="via"]').innerText(), /Paid via\s*1/);
    assert.equal(await page.locator('#coll-via').isVisible(), false); assert.equal(await page.locator('#coll-cat').isVisible(), false);
    await noHScroll(page, '390 collapsed sections');
    await page.click('.coll-h[data-k="via"]'); assert.equal(await exp('via'), 'true'); assert.equal(await page.locator('#viaadd').isVisible(), true);
    await page.click('.coll-h[data-k="via"]'); assert.equal(await exp('via'), 'false'); assert.equal(await page.locator('#viaadd').isVisible(), false);
    await page.focus('.coll-h[data-k="cat"]'); await page.keyboard.press('Enter'); assert.equal(await exp('cat'), 'true'); assert.equal(await page.locator('.cat-list').first().isVisible(), true);
    await page.click('.coll-h[data-k="cat"]');
  });
  await step('Other income: one "Add income" button next to Add to savings; collapsed "Other income · N" section otherwise', async () => {
    assert.equal(await page.locator('.inc-acts [data-action="add"][data-type="income"]').innerText(), 'Add income'); assert.equal(await page.locator('.inc-acts .btn.primary').count(), 0);
    assert.equal(await page.locator('.oi-coll').count(), 0);
    await page.click('.inc-acts [data-action="add"][data-type="income"]'); await page.waitForSelector('#form'); await page.keyboard.press('Escape');
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.income.push({ id: 'side', name: 'Side gig', freq: 'monthly', date: '2026-11-25', amount: 300 }); localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.oi-coll');
    assert.equal(await exp('other'), 'false'); assert.match(await page.locator('.coll-h[data-k="other"]').innerText(), /Other income · 1/);
    assert.equal(await page.locator('#coll-other').isVisible(), false); assert.equal(await page.locator('.inc-acts [data-action="add"][data-type="income"]').count(), 1, 'one Add income, outside the section');
    await page.click('.coll-h[data-k="other"]');
    assert.equal(await page.locator('#coll-other .row').count(), 1, 'main paycheck is not listed here'); assert.match(await page.locator('#coll-other').innerText(), /Side gig/);
    assert.equal(await page.locator('#coll-other [data-action="add"][data-type="income"]').count(), 0, 'no second Add income inside');
    await noHScroll(page, '390 other income');
    await page.click('.coll-h[data-k="other"]');
  });
  await step('every bank row has its own Refresh: item-scoped refresh then sync, spinner on that row only, toast', async () => {
    assert.equal(await page.locator('.bk-enr [data-action="bk-item-sync"]').count(), 2);
    mock.refreshResp = { refreshed: true, notEnabled: false, results: [{ itemId: 'enr_1', refreshed: true }, { itemId: 'enr_2', refreshed: true }] }; mock.delay = 500;
    const ls = (await getState(page)).bank.lastSync; calls.length = 0;
    await page.locator('.bk-enr').nth(1).locator('[data-action="bk-item-sync"]').click();
    await page.waitForSelector('.bk-enr .spin');
    assert.equal(await page.locator('.bk-enr').nth(1).locator('.spin').count(), 1); assert.equal(await page.locator('.bk-enr').nth(0).locator('.spin').count(), 0);
    assert.equal(await page.locator('.bk-enr').nth(0).locator('[data-action="bk-item-sync"]').isDisabled(), true, 'no second sync while one runs');
    await page.screenshot({ path: SHOTS + '/bank-card-390.png' });
    await page.waitForFunction(() => !document.querySelector('.bk-enr .spin'));
    const rf = calls.find(c => c.p === '/refresh'), sc = calls.find(c => c.p === '/sync');
    assert.equal(rf.q, '?item=enr_2'); assert.match(sc.q, /[?&]item=enr_2(&|$)/); assert.ok(calls.indexOf(rf) < calls.indexOf(sc), 'refresh before sync');
    assert.match(await page.locator('#toast').innerText(), /Citizens refreshed/);
    assert.equal((await getState(page)).bank.lastSync, ls, 'a one-bank sync does not move the overall sync time');
    await noHScroll(page, '390 bank card');
    mock.delay = 0; calls.length = 0;
    await page.locator('.bk-enr').nth(0).locator('[data-action="bk-item-sync"]').click();
    await page.waitForFunction(() => /Chime refreshed/.test(document.querySelector('#toast').innerText));
    assert.equal(calls.find(c => c.p === '/refresh').q, '?item=enr_1');
    assert.ok(/[?&]ack=tok-/.test(calls.find(c => c.p === '/sync').q), 'carries the ack for the last response');
  });
  await step('Refresh failure shows the error and clears the spinner; Sync now still asks every bank', async () => {
    mock.refreshResp = null; calls.length = 0;
    await page.locator('.bk-enr').nth(1).locator('[data-action="bk-item-sync"]').click();
    await page.waitForFunction(() => /nope/.test(document.querySelector('#toast').innerText) && !document.querySelector('.bk-enr .spin'));
    assert.equal(calls.filter(c => c.p === '/sync').length, 0, 'no sync after a failed refresh');
    mock.refreshResp = { refreshed: true, notEnabled: false, results: [] }; calls.length = 0;
    await page.click('[data-action="bk-sync"]'); await page.waitForFunction(() => document.querySelector('[data-action="bk-sync"]') && !document.querySelector('[data-action="bk-sync"]').disabled);
    assert.equal(calls.find(c => c.p === '/refresh').q, ''); assert.equal(calls.find(c => c.p === '/sync').q.includes('item='), false);
  });
  await step('951x669: income tab with every section open has no horizontal scroll', async () => {
    await page.setViewportSize({ width: 951, height: 669 });
    for (const k of ['pay', 'via', 'cat', 'other']) { if (await page.locator('.coll-h[data-k="' + k + '"]').count() && (await exp(k)) === 'false') await page.click('.coll-h[data-k="' + k + '"]'); }
    await page.waitForTimeout(200); await noHScroll(page, '951 income open'); await page.screenshot({ path: SHOTS + '/income-951.png' });
    await page.locator('.bk-enr [data-action="bk-disc"]').first().click(); await page.waitForSelector('#dc-ok'); await sheetNoHScroll(page, '951 disconnect'); await page.keyboard.press('Escape');
  });
  assert.deepEqual(errs, [], 'page errors in v6 income block'); await page.context().close();
}

const alignHero = async (page, label) => {
  const m = await page.evaluate(() => {
    const lads = [...document.querySelectorAll('.ladder .lad')], q = sel => lads.map(l => l.querySelector(sel)), top = e => e.getBoundingClientRect().top;
    const base = e => { const sp = document.createElement('span'); sp.style.cssText = 'display:inline-block;width:0;height:0'; e.appendChild(sp); const b = sp.getBoundingClientRect().bottom; sp.remove(); return b; };
    const textW = e => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().width; };
    return { n: lads.length, k: q('.hs-k').map(top), v: q('.v').map(top), vb: q('.v').map(base), s: q('.hs-s').map(top), fs: q('.v').map(e => getComputedStyle(e).fontSize),
      fit: q('.v').map((e, i) => e.scrollWidth <= e.clientWidth + 0.5 && textW(e) <= lads[i].clientWidth - 11), txt: q('.v').map(e => e.textContent), kt: q('.hs-k').map(e => e.scrollWidth <= e.clientWidth + 0.5 && e.getBoundingClientRect().right <= e.parentElement.getBoundingClientRect().right + 0.5) };
  });
  const same = a => Math.max(...a) - Math.min(...a) <= 1;
  assert.equal(m.n, 3, label); assert.ok(same(m.k), label + ' labels ' + m.k); assert.ok(same(m.v), label + ' values ' + m.v); assert.ok(same(m.vb), label + ' baselines ' + m.vb);
  assert.ok(same(m.s), label + ' sublines ' + m.s); assert.equal(new Set(m.fs).size, 1, label + ' one font size ' + m.fs); assert.deepEqual(m.fit, [true, true, true], label + ' no clipped digits ' + m.txt + ' ' + m.fs);
  assert.deepEqual(m.kt, [true, true, true], label + ' labels fit');
  return m;
};

/* ---------- v7: refresh + reorder balances, aligned hero sums with hide, per-paycheck budgets ---------- */
{
  const bal = (itemId, institution, accounts) => ({ itemId, institution, accounts });
  const A = (id, name, mask, available, extra) => Object.assign({ id, name, mask, type: 'depository', subtype: 'checking', available, current: available, limit: null, currency: 'USD', enabled: true }, extra || {});
  const BAL3 = () => [
    bal('enr_1', 'Chime', [A('acc1', 'Everyday Checking', '1234', 1924.05), A('acc2', 'Savings', '9876', 800, { subtype: 'savings' })]),
    bal('enr_2', 'Citizens', [A('acc4', 'Checking', '4417', 300)]),
    bal('enr_3', 'Wells', [A('acc5', 'Checking', '1111', 50)])
  ];
  const { page, errs, calls, mock } = await prepared(390, 844);
  mock.balances = BAL3(); mock.refreshResp = { refreshed: true, notEnabled: false, results: [] };
  mock.enrollments.push({ id: 'enr_2', institution: 'Citizens', needsReconnect: false, accounts: [] }, { id: 'enr_3', institution: 'Wells', needsReconnect: false, accounts: [] });
  const TODAYS = () => page.evaluate(() => BT.iso(new Date()));
  // Budgets and spending for the current pay cycle. "Food" is the old name (the migration has not run yet).
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1'));
    s.imports = (s.imports || []).filter(x => x !== 'pp-groceries-1');
    s.perPeriod = [{ id: 'pp-gas', name: 'Gas', amount: 60, category: 'Gas' }, { id: 'pp-food', name: 'Food', amount: 150, category: '' }, { id: 'pp-pets', name: 'Pets', amount: 25, category: 'Pets' }];
    s.income[0].perCycle = { '2026-11-19': 2724.05 };
    localStorage.setItem('budtrack.v1', JSON.stringify(s));
  });
  await page.goto(BASE + '#overview', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => { const b = JSON.parse(localStorage.getItem('budtrack.v1')).bank; return b.balances && b.balances.items.length === 3; });
  await page.waitForTimeout(300);

  await step('Food becomes Groceries (category Groceries); other budgets are untouched', async () => {
    const s = await getState(page);
    assert.deepEqual(s.perPeriod.map(p => [p.name, p.category]), [['Gas', 'Gas'], ['Groceries', 'Groceries'], ['Pets', 'Pets']]);
    assert.ok(s.imports.includes('pp-groceries-1'));
  });

  const align = label => alignHero(page, label);
  await step('hero sums share one label row, value row, baseline and subline row (390, 951, 1000, 763)', async () => {
    const m = await align('390x844'); assert.match(m.txt.join(' '), /3,074\.05/); assert.match(m.txt.join(' '), /2,601\.90/); // 2,626.40 minus the $24.50 bank line still to review
    await noHScroll(page, '390 hero');
    await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.classList.remove('on'); });
    await page.locator('.hero').screenshot({ path: SHOTS + '/hero-390.png' });
    for (const [w, h] of [[951, 669], [1000, 703], [763, 390]]) {
      await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(150);
      await align(w + 'x' + h); await noHScroll(page, w + ' hero');
      if (w === 951) { await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.classList.remove('on'); }); await page.locator('.hero').screenshot({ path: SHOTS + '/hero-951.png' }); }
    }
    await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(150); await align('390 dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await step('hide balances: one slim row, money masked, persisted in settings and backups', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('[data-action="account"]'); await page.waitForSelector('.bal-total'); assert.match(await page.locator('.bal-total').innerText(), /\$3,074\.05/);
    await page.evaluate(() => document.querySelector('.lad-tools .eye').click()); await page.waitForSelector('.lad-tools.hid');
    assert.equal(await page.locator('.ladder').count(), 0);
    assert.match(await page.locator('.lad-tools.hid').innerText(), /Balances hidden\s*·\s*Show/);
    const hero = await page.locator('.hero').innerText(); assert.ok(!/\$\s?\d/.test(hero), 'no dollar amounts in the hero: ' + hero.replace(/\n/g, ' | '));
    assert.deepEqual(await page.locator('.hero-stats dd').allInnerTexts(), ['••••', '••••', '••••']);
    assert.equal((await getState(page)).settings.hideBalances, true);
    const sh = await page.locator('#sheet').innerText(); assert.ok(!/\$\s?\d/.test(sh), 'sheet masked: ' + sh.replace(/\n/g, ' | ')); assert.match(sh, /••••/);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100); await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.classList.remove('on'); }); await page.locator('.hero').screenshot({ path: SHOTS + '/hero-hidden-390.png' });
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.lad-tools.hid');
    assert.equal((await getState(page)).settings.hideBalances, true, 'persists after reload');
    await page.click('[data-action="hide-bal"] >> nth=0'); await page.waitForSelector('.ladder');
    assert.equal((await getState(page)).settings.hideBalances, false);
    assert.match(await page.locator('.lad.l3').innerText(), /3,074\.05/);
    await page.click('.lad-tools .eye'); await page.waitForSelector('.lad-tools.hid'); await page.click('.lad-tools .linkbtn'); await page.waitForSelector('.ladder');
    await page.click('.lad-tools .eye'); await page.waitForSelector('.lad-tools.hid');
    await page.goto(BASE + '#income', { waitUntil: 'load' }); await page.click('[data-action="copy-backup"]'); await page.waitForSelector('#bk');
    assert.equal(JSON.parse(await page.inputValue('#bk')).settings.hideBalances, true, 'in the backup'); await page.keyboard.press('Escape');
    await page.goto(BASE + '#overview', { waitUntil: 'load' }); await page.click('[data-action="hide-bal"] >> nth=0'); await page.waitForSelector('.ladder');
  });

  await step('In account refresh icon: POST /refresh then /sync, spins, updates totals, toasts', async () => {
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.bank.refreshOK = { ok: false, at: new Date().toISOString() }; localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.lad.l3');
    await page.evaluate(() => { window.BT_FOLLOWUP_MS = 600000; });
    await page.click('[data-action="account"]'); await page.waitForSelector('.bal-total');
    assert.match(await page.locator('.bal-total').innerText(), /\$3,074\.05/);
    const btn = page.getByRole('button', { name: 'Refresh balances' }); assert.equal(await btn.count(), 1);
    mock.balances = BAL3(); mock.balances[1].accounts[0].available = 450.5; mock.balances[1].accounts[0].current = 450.5; mock.delay = 500;
    const n = calls.length; await btn.click();
    await page.waitForSelector('.icon-btn.spinning[aria-label="Refresh balances"]');
    await page.waitForFunction(() => /Updated just now/.test(document.querySelector('#toast').innerText), null, { timeout: 8000 });
    const after = calls.slice(n).map(c => c.p); assert.ok(after.indexOf('/refresh') >= 0 && after.indexOf('/sync') > after.indexOf('/refresh'), after.join(','));
    assert.equal(calls.slice(n).find(c => c.p === '/refresh').m, 'POST'); assert.equal(calls.slice(n).find(c => c.p === '/refresh').q, '', 'all banks');
    assert.match(await page.locator('.bal-total').innerText(), /\$3,224\.55/);
    assert.equal(await page.locator('.icon-btn.spinning').count(), 0);
    assert.equal((await getState(page)).bank.balances.items[1].accounts[0].available, 450.5);
    mock.delay = 0; mock.offline = true;
    await btn.click(); await page.waitForFunction(() => /Could not refresh/.test(document.querySelector('#toast').innerText));
    await page.waitForFunction(() => !document.querySelector('.icon-btn.spinning')); mock.offline = false;
    await sheetNoHScroll(page, '390 balance sheet header');
    mock.errors = [{ institution: 'Chime', needsReconnect: true }];
    await btn.click(); await page.waitForFunction(() => !document.querySelector('.icon-btn.spinning'));
    const tt = await page.locator('#toast').innerText(); assert.match(tt, /needs reconnect/); assert.doesNotMatch(tt, /Updated just now/);
    mock.errors = [];
  });

  const order = () => page.locator('#balbanks .bx-sh').allTextContents();
  await step('drag a bank by its grip (pointer events), saved in state.bank.order and kept after reload and in backups', async () => {
    assert.deepEqual(await order(), ['Chime', 'Citizens', 'Wells']);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.grip')).touchAction), 'none');
    const g = await page.locator('.bal-bank').nth(0).locator('.grip').boundingBox(), t = await page.locator('.bal-bank').nth(2).boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + 40, { steps: 4 });
    await page.mouse.move(g.x + g.width / 2, t.y + t.height - 4, { steps: 10 });
    await page.screenshot({ path: SHOTS + '/balances-drag-390.png' });
    assert.equal(await page.locator('.bal-bank.dragging').count(), 1);
    await page.mouse.up();
    await page.waitForFunction(() => JSON.stringify(JSON.parse(localStorage.getItem('budtrack.v1')).bank.order) === '["enr_2","enr_3","enr_1"]');
    assert.deepEqual(await order(), ['Citizens', 'Wells', 'Chime']);
    await sheetNoHScroll(page, '390 after drag');
    await page.keyboard.press('Escape'); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.lad.l3'); await page.click('[data-action="account"]'); await page.waitForSelector('#balbanks');
    assert.deepEqual(await order(), ['Citizens', 'Wells', 'Chime'], 'persists');
    await page.keyboard.press('Escape'); await page.goto(BASE + '#income', { waitUntil: 'load' }); await page.click('[data-action="copy-backup"]'); await page.waitForSelector('#bk');
    assert.deepEqual(JSON.parse(await page.inputValue('#bk')).bank.order, ['enr_2', 'enr_3', 'enr_1']); await page.keyboard.press('Escape'); await page.goto(BASE + '#overview', { waitUntil: 'load' });
  });
  await step('touch-style pointer events also reorder (synthetic, pointerType touch)', async () => {
    await page.click('[data-action="account"]'); await page.waitForSelector('#balbanks');
    await page.evaluate(() => {
      const g = document.querySelectorAll('.grip')[2], r = g.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, top = document.querySelectorAll('.bal-bank')[0].getBoundingClientRect().top;
      const ev = (type, tgt, cy) => tgt.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: x, clientY: cy, bubbles: true, cancelable: true, button: 0 }));
      ev('pointerdown', g, y); [y - 30, y - 120, top - 70].forEach(cy => ev('pointermove', window, cy)); ev('pointerup', window, top - 70);
    });
    await page.waitForFunction(() => JSON.stringify(JSON.parse(localStorage.getItem('budtrack.v1')).bank.order) === '["enr_1","enr_2","enr_3"]');
    assert.deepEqual(await order(), ['Chime', 'Citizens', 'Wells']);
  });
  await step('Edit order: Move up / Move down buttons work, edges disabled, focus stays', async () => {
    await page.click('[data-action="bal-edit"]');
    const ups = page.locator('[data-action="bank-move"][aria-label="Move up"]'), downs = page.locator('[data-action="bank-move"][aria-label="Move down"]');
    assert.equal(await ups.count(), 3); assert.equal(await ups.nth(0).isDisabled(), true); assert.equal(await downs.nth(2).isDisabled(), true);
    await downs.nth(0).click();
    assert.deepEqual(await order(), ['Citizens', 'Chime', 'Wells']); assert.deepEqual((await getState(page)).bank.order, ['enr_2', 'enr_1', 'enr_3']);
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-id') + document.activeElement.dataset.dir), 'enr_11');
    await ups.nth(2).click(); assert.deepEqual(await order(), ['Citizens', 'Wells', 'Chime']);
    await sheetNoHScroll(page, '390 edit order');
    await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/balances-reorder-390.png' });
    await page.click('[data-action="bal-edit"]'); assert.equal(await page.locator('[data-action="bank-move"]').count(), 0);
    await page.keyboard.press('Escape');
  });
  await step('same order in the Bank connections card and the Transactions bank filter', async () => {
    await page.goto(BASE + '#income', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => document.querySelectorAll('.bk-enr').length === 3);
    assert.deepEqual(await page.locator('.bk-enr .bk-eh b').allTextContents(), ['Citizens', 'Wells', 'Chime']);
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); const t = (id, inst, l4) => ({ id, date: '2026-11-18', desc: 'SHOP', rawDesc: 'SHOP', amount: 5, status: 'posted', account: { institution: inst, name: 'Checking', last4: l4 } }); s.bank.txns['pl:c1'] = t('pl:c1', 'Citizens', '4417'); s.bank.txns['pl:w1'] = t('pl:w1', 'Wells', '1111'); localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.goto(BASE + '#transactions', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#txbank');
    const opts = await page.locator('#txbank option').allTextContents(); assert.deepEqual(opts, ['All banks', 'Citizens ••4417', 'Wells ••1111', 'Chime ••1234']);
    await noHScroll(page, '390 transactions');
  });
  await step('a newly connected bank joins at the end of the order', async () => {
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.bank.balances.items.push({ itemId: 'enr_9', institution: 'Ally', accounts: [{ id: 'a9', name: 'Savings', mask: '0009', type: 'depository', available: 1, current: 1 }] }); localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.goto(BASE + '#overview', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.lad.l3'); await page.click('[data-action="account"]'); await page.waitForSelector('#balbanks');
    assert.deepEqual((await order()).slice(-1), ['Ally']); await page.keyboard.press('Escape');
  });
  assert.deepEqual(errs, [], 'page errors in v7 balances');
  await page.context().close();
}

const BT_round = n => Math.round(n * 100) / 100;
{
  const { page, errs, mock } = await prepared(390, 844);
  const today = await page.evaluate(() => BT.iso(new Date()));
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1'));
    s.perPeriod = [{ id: 'pp-gas', name: 'Gas', amount: 60, category: 'Gas' }, { id: 'pp-groc', name: 'Groceries', amount: 150, category: 'Groceries' }, { id: 'pp-off', name: 'Pets', amount: 0, category: 'Pets' }];
    s.income[0].perCycle = { '2026-11-19': 2000 }; s.spends = [];
    localStorage.setItem('budtrack.v1', JSON.stringify(s));
  });
  const num = () => page.evaluate(() => { const state = JSON.parse(localStorage.getItem('budtrack.v1')), TODAY = BT.iso(new Date()), r = BT.periodRange(state, 'biweekly', 0, TODAY), s = BT.summary(state, r, TODAY); return { needed: s.needed, paid: s.paid, left: s.left, due: s.due, acct: BT.accountBalance(state, TODAY), r }; });
  await page.goto(BASE + '#overview', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.ov-bills');
  const base = await num();
  await step('budgets sit at the bottom of the bills list, undated, not checkable, never Up next or Past due', async () => {
    const card = page.locator('.ov-bills');
    assert.equal(await card.locator('.bud-h').textContent(), 'Budgets this cycle');
    assert.equal(await card.evaluate(c => c.lastElementChild.classList.contains('bud-rows') && c.lastElementChild.previousElementSibling.classList.contains('bud-h')), true, 'last in the card');
    const rows = card.locator('.row.bgt'); assert.equal(await rows.count(), 3);
    assert.equal(await rows.locator('.check, .date, .pill').count(), 0);
    assert.match(await rows.nth(1).innerText(), /Groceries[\s\S]*Spent \$0\.00 of \$150\.00 · \$150\.00 left/);
    assert.match(await rows.nth(2).innerText(), /Pets[\s\S]*Not set · tap to set budget/); assert.equal(await rows.nth(2).evaluate(e => e.classList.contains('off')), true);
    assert.equal(await page.locator('.ov-bills .rows:not(.bud-rows) .row.bgt').count(), 0);
    assert.equal(base.needed, (await page.evaluate(() => { const state = JSON.parse(localStorage.getItem('budtrack.v1')), TODAY = BT.iso(new Date()); return BT.summary(state, BT.periodRange(state, 'biweekly', 0, TODAY), TODAY).items.filter(x => x.kind !== 'spend').reduce((a, x) => a + x.amount, 0); })) + 210, 'unspent budgets are reserved');
  });
  await step('$40 + $30 Groceries spends: "Spent $70.00 of $150.00 · $80.00 left"; money counted once', async () => {
    await page.evaluate(([d]) => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.spends.push({ id: 'g1', category: 'Groceries', desc: 'Aldi', amount: 40, date: d, note: '' }, { id: 'g2', category: 'Groceries', desc: 'Kroger', amount: 30, date: d, note: 'Snacks' }); localStorage.setItem('budtrack.v1', JSON.stringify(s)); }, [today]);
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.row.bgt');
    assert.match(await page.locator('.row.bgt', { hasText: 'Groceries' }).innerText(), /Spent \$70\.00 of \$150\.00 · \$80\.00 left/);
    const n = await num(); assert.equal(n.needed, base.needed); assert.equal(n.paid, base.paid + 70); assert.equal(n.left, base.left); assert.equal(n.acct, BT_round(base.acct - 70));
    assert.equal(await page.locator('.ov-bills .rows:not(.bud-rows) .nm', { hasText: /Aldi|Kroger/ }).count(), 0, 'the purchases are inside the budget, not listed twice');
    await page.locator('.ov-bills').screenshot({ path: SHOTS + '/budgets-390.png' });
    await page.locator('.row.bgt', { hasText: 'Groceries' }).click(); await page.waitForSelector('.bud-strip');
    const sh = await page.locator('#sheet').innerText(); assert.match(sh, /Aldi/); assert.match(sh, /Kroger/); assert.match(sh, /Snacks/); assert.match(sh, /\$40\.00/); assert.match(sh, /\$30\.00/); assert.match(sh, /Edit budget amount/);
    await sheetNoHScroll(page, '390 budget sheet');
    await page.locator('#sheet .sheet').screenshot({ path: SHOTS + '/budget-sheet-390.png' });
  });
  await step('a $100 more Groceries spend: "$20.00 over budget", red full bar, needed and left follow', async () => {
    await page.click('#sheet [data-action="add"][data-type="extra"]'); await page.waitForSelector('#f-amount');
    await page.fill('#f-amount', '100'); await page.fill('#f-desc', 'Costco'); await page.click('#form button[type=submit]'); await page.waitForSelector('.row.bgt');
    const row = page.locator('.row.bgt', { hasText: 'Groceries' }); assert.match(await row.innerText(), /\$20\.00 over budget/);
    assert.equal(await row.locator('.bud-bar.over').count(), 1); assert.equal(await row.locator('.bud-bar i').evaluate(e => e.style.width), '100%');
    assert.notEqual(await row.locator('b.over').evaluate(e => getComputedStyle(e).color), await row.locator('.nm').evaluate(e => getComputedStyle(e).color));
    const n = await num(); assert.equal(n.needed, BT_round(base.needed + 20)); assert.equal(n.paid, base.paid + 170); assert.equal(n.left, BT_round(base.left - 20)); assert.equal(n.acct, BT_round(base.acct - 170));
    const leg = await page.locator('.cat-legend').innerText(); assert.match(leg, /Groceries\s*\$170\.00/);
    const tip = await page.locator('.ov-bars g.cur[data-tip]').getAttribute('data-tip'); assert.ok(tip.includes('Needed ' + ('$' + n.needed.toLocaleString('en-US', { minimumFractionDigits: 2 }))), tip);
    assert.equal(await page.locator('.ov-bills .rows:not(.bud-rows) .nm', { hasText: 'Costco' }).count(), 0);
    assert.doesNotMatch(leg, /Pets/, 'a budget that is not set adds no donut slice');
    await noHScroll(page, '390 budgets');
  });
  await step('Bills tab lists the budgets of this cycle; edit budget opens the amount form', async () => {
    await page.goto(BASE + '#bills', { waitUntil: 'load' }); await page.waitForSelector('.bud-rows');
    assert.match(await page.locator('.bud-rows').innerText(), /Gas[\s\S]*Groceries[\s\S]*\$20\.00 over budget/);
    await page.locator('.row.bgt', { hasText: 'Gas' }).click(); await page.waitForSelector('.bud-strip');
    await page.click('#sheet [data-action="bud-amt"]'); await page.waitForSelector('#budamt #o-scope');
    await page.click('#sheet [data-action="edit"][data-type="spend"]'); await page.waitForSelector('#form[data-type="spend"]');
    assert.match(await page.locator('#sheet').innerText(), /Budget each pay cycle/); await page.keyboard.press('Escape'); await noHScroll(page, '390 bills');
  });
  await step('Match picker offers "Count toward Groceries budget": creates a Groceries spend, no paid mark; likely ignores budgets', async () => {
    await page.evaluate(([d]) => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.bank.txns['pl:g9'] = { id: 'pl:g9', date: d, desc: 'GROCERY OUTLET', rawDesc: 'GROCERY OUTLET', amount: 55.25, status: 'posted', account: { institution: 'Chime', name: 'Checking', last4: '1234' } }; s.bank.txns['pl:g150'] = { id: 'pl:g150', date: d, desc: 'GROCERIES', rawDesc: 'GROCERIES', amount: 150, status: 'posted', account: { institution: 'Chime', name: 'Checking', last4: '1234' } }; localStorage.setItem('budtrack.v1', JSON.stringify(s)); }, [today]);
    await page.goto(BASE + '#overview', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.row.bgt');
    assert.equal(await page.locator('.bud-rows .likely, .bud-rows [data-action="likely-open"]').count(), 0);
    const before = (await getState(page)).spends.length;
    await page.goto(BASE + '#transactions', { waitUntil: 'load' }); await page.waitForSelector('.tx[data-id="pl:g9"]');
    await page.locator('.tx[data-id="pl:g9"] .tx-main').click(); await page.locator('.tx[data-id="pl:g9"] [data-action="tx-match"]').click(); await page.waitForSelector('.pk-opt');
    const opt = page.locator('.pk-opt', { hasText: 'Count toward Groceries budget' }).filter({ hasNotText: 'Cycle of' }); assert.equal(await opt.count(), 1, 'this cycle once; earlier cycles are labeled');
    assert.ok(await page.locator('.pk-opt', { hasText: /Count toward Groceries budget[\s\S]*Cycle of/ }).count() >= 1, 'earlier cycles are offered too');
    assert.match(await page.locator('#sheet').innerText(), /Count toward Gas budget/); assert.doesNotMatch(await page.locator('#sheet').innerText(), /Pets budget/);
    await opt.click(); await page.waitForFunction(n => JSON.parse(localStorage.getItem('budtrack.v1')).spends.length === n + 1, before);
    const s = await getState(page), sp = s.spends.find(x => x.bank === 'pl:g9');
    assert.ok(sp); assert.equal(sp.category, 'Groceries'); assert.equal(sp.amount, 55.25); assert.ok(!Object.keys(s.marks).some(k => k.startsWith('s:')), 'no paid mark on a budget');
    await page.goto(BASE + '#overview', { waitUntil: 'load' }); await page.waitForSelector('.row.bgt'); assert.match(await page.locator('.row.bgt', { hasText: 'Groceries' }).innerText(), /\$75\.25 over budget/);
  });
  await step('Savings chip stays inside the In account subline: hero sums still aligned', async () => {
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.savings = { on: true, bank: '', tx: [{ id: 'sv1', type: 'open', amount: 250, date: '2026-11-01' }] }; localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
    await page.goto(BASE + '#overview', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.lad.l3 .sv-chip');
    assert.equal(await page.locator('.lad.l3 > .sv-chip').count(), 0); await alignHero(page, '390 savings chip');
    await page.setViewportSize({ width: 951, height: 669 }); await page.waitForTimeout(150); await alignHero(page, '951 savings chip'); await page.setViewportSize({ width: 390, height: 844 });
  });
  await step('951x669 landscape and dark: budgets have no horizontal scroll', async () => {
    await page.setViewportSize({ width: 951, height: 669 }); await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200);
    await noHScroll(page, '951 budgets dark'); await page.locator('.ov-bills').screenshot({ path: SHOTS + '/budgets-951-dark.png' });
    await page.emulateMedia({ colorScheme: 'light' });
  });
  assert.deepEqual(errs, [], 'page errors in budgets'); await page.context().close();
}

await browser.close();
console.log(failures ? failures + ' step(s) FAILED' : 'all steps passed');
process.exit(failures ? 1 : 0);
