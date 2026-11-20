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
  bank: { seen: {}, rules: {}, links: {}, lastSync: null, inbox: [], api: '' },
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
  const mock = { paired: false, txns: TXNS, removed: [], errors: [], offline: false, enrollments: [{ id: 'enr_1', institution: 'Chime', needsReconnect: false, accounts: [{ id: 'acc1', name: 'Everyday Checking', type: 'depository', subtype: 'checking', last_four: '1234', enabled: true }, { id: 'acc2', name: 'Savings', type: 'depository', subtype: 'savings', last_four: '9876', enabled: true }] }] };
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
    if (p === '/sync') return json({ txns: mock.txns, removed: mock.removed, errors: mock.errors, syncedAt: new Date().toISOString() });
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
  const { page, errs, calls } = await prepared(390, 844);
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
    assert.equal(sc[1].q, '?since=2026-11-15');
    const s = await getState(page);
    assert.equal(s.bank.inbox.length, 4); assert.equal(Object.keys(s.bank.seen).length, 3);
  });
  await step('Overview badge shows count', async () => {
    await page.goto(BASE + '#overview'); await page.reload({ waitUntil: 'load' });
    const t = await page.locator('.bx-bar').innerText(); assert.match(t, /4 new transactions/);
    await noHScroll(page, '390 overview');
  });
  await step('inbox sheet lists rows, no horizontal scroll, screenshot 390', async () => {
    await page.click('.bx-bar'); await page.waitForSelector('.bx');
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
    await page.click('[data-action="ix-all"]');
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

/* ---------- Landscape + dark, errors, offline ---------- */
{
  const { page, errs, mock } = await prepared(951, 669);
  await page.goto(BASE + '#overview', { waitUntil: 'load' });
  await step('951x669 inbox + overview + income: no horizontal scroll', async () => {
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.bx-bar'); await noHScroll(page, '951 overview');
    await page.click('.bx-bar'); await page.waitForSelector('.bx'); await sheetNoHScroll(page, '951 inbox'); await noHScroll(page, '951 inbox');
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

await browser.close();
console.log(failures ? failures + ' step(s) FAILED' : 'all steps passed');
process.exit(failures ? 1 : 0);
