// Checks for the per-bank sync protocol (webhooks): the app sends `acks=<bank>:<seq>,...`, saves the Worker's per-bank
// cursors only together with the batch they belong to, a re-delivered batch creates no duplicates, and the "Turn on instant
// updates" button plus the status sheet's "Instant updates" / "Last webhook received" rows.
// Run: node tests/webhooks.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import assert from 'node:assert/strict';
import { pw, SHOTS, BASE, API, iso, addD, step, finish, prep, synced } from './lib.mjs';

const TODAY = iso(new Date());
const SAN = { id: 'sa1', name: 'Checking', last4: '6429', institution: 'Santander', type: 'depository' };
const CHI = { id: 'ch1', name: 'Checking', last4: '1111', institution: 'Chime', type: 'depository' };
const T = (id, date, desc, amount, account) => ({ id: 'pl:' + id, date, desc, rawDesc: desc, amount, account, status: 'posted', pendingOf: null, counterparty: null, providerCategory: null });
const HOOK_AT = new Date(Date.now() - 12 * 60000).toISOString();

const b = await pw.chromium.launch();
async function newPage(w, h) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  const page = await ctx.newPage(); await prep(page);
  const errs = [], calls = [];
  // A per-bank change log like the Worker's sync objects: rows {seq, txn}; acks drop rows up to the acked seq.
  const mock = {
    log: { enr_s: [], enr_c: [] }, seq: { enr_s: 0, enr_c: 0 }, ignoreAcks: false, fail: false,
    instant: { enr_s: true, enr_c: false }, configured: 0,
    add(item, t) { this.seq[item]++; this.log[item].push({ seq: this.seq[item], txn: t }); },
  };
  mock.add('enr_s', T('s1', addD(TODAY, -1), 'CORNER DELI 44', 12.5, SAN));
  mock.add('enr_s', T('s2', TODAY, 'MYSTERY SHOP 9', 20, SAN));
  mock.add('enr_c', T('c1', TODAY, 'BODEGA 7', 6.25, CHI));
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ m, p, q: u.search, sp: u.searchParams });
    const json = (x, status) => route.fulfill({ status: status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(x) });
    if (p === '/config') return json({ provider: 'plaid', env: 'production', paired: true });
    if (p === '/accounts') return json({ enrollments: [{ id: 'enr_s', institution: 'Santander', accounts: [{ id: 'sa1', name: 'Checking', type: 'depository', subtype: 'checking', last_four: '6429', enabled: true }] },
      { id: 'enr_c', institution: 'Chime', accounts: [{ id: 'ch1', name: 'Checking', type: 'depository', subtype: 'checking', last_four: '1111', enabled: true }] }] });
    if (p === '/sync') {
      if (mock.fail) return json({ error: 'internal error' }, 500);
      const acks = {}; (u.searchParams.get('acks') || '').split(',').filter(Boolean).forEach(x => { const [k, v] = x.split(':'); acks[k] = +v; });
      const only = u.searchParams.get('item'), txns = [], cursors = {};
      for (const it of Object.keys(mock.log)) {
        if (!mock.ignoreAcks && acks[it]) mock.log[it] = mock.log[it].filter(r => r.seq > acks[it]);
        if (only && it !== only) continue;
        mock.log[it].forEach(r => txns.push(r.txn)); cursors[it] = mock.seq[it];
      }
      return json({ txns, removed: [], errors: [], cursors, syncToken: null, syncedAt: new Date().toISOString() });
    }
    if (p === '/status') return json({
      items: ['enr_s', 'enr_c'].map(id => ({ itemId: id, institution: id === 'enr_s' ? 'Santander' : 'Chime', lastSuccessfulUpdate: HOOK_AT, lastFailedUpdate: null, error: null, needsReconnect: false,
        products: ['transactions'], webhook: mock.instant[id] ? 'https://budtracks-worker.atsdsc27.workers.dev/plaid/webhook' : null, instant: mock.instant[id],
        lastWebhook: mock.instant[id] ? { type: 'TRANSACTIONS', code: 'SYNC_UPDATES_AVAILABLE', at: HOOK_AT } : null, itemEvent: null, refresh: null, balance: null })),
      refresh: null, balance: null, webhook: { available: true, configuredAt: null }, env: 'production', at: new Date().toISOString() });
    if (p === '/webhook/configure' && m === 'POST') {
      mock.configured++; mock.instant = { enr_s: true, enr_c: true };
      return json({ ok: true, configured: 2, results: [{ itemId: 'enr_s', institution: 'Santander', ok: true }, { itemId: 'enr_c', institution: 'Chime', ok: true }], at: new Date().toISOString() });
    }
    if (p === '/refresh' && m === 'POST') return json({ refreshed: false, notEnabled: true, results: [] });
    if (p === '/snapshot') return json({ ok: true });
    return json({ error: 'nope' }, 404);
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(([api, from]) => {
    const s = JSON.parse(localStorage.getItem('budtrack.v1'));
    Object.assign(s.bank, { api, seen: {}, rules: {}, links: {}, lastSync: null, inbox: [], autoFrom: from, historyFrom: from, txns: {} });
    localStorage.setItem('budtrack.v1', JSON.stringify(s)); localStorage.setItem('budtrack.bankkey', 'secret-device-key-123');
  }, [API, addD(TODAY, -20)]);
  // Every save of the app state is recorded, to check cursors are only ever saved together with their batch.
  await page.addInitScript(() => {
    const orig = Storage.prototype.setItem; window.__saves = [];
    Storage.prototype.setItem = function (k, v) {
      if (k === 'budtrack.v1') { try { const s = JSON.parse(v); window.__saves.push({ cursors: (s.bank && s.bank.cursors) || {}, ids: Object.keys((s.bank && s.bank.txns) || {}) }); } catch (e) {} }
      return orig.call(this, k, v);
    };
  });
  await page.goto(BASE + '#income', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await synced(page);
  await page.waitForTimeout(250);
  return { ctx, page, errs, mock, calls };
}
const getState = page => page.evaluate(() => JSON.parse(localStorage.getItem('budtrack.v1')));
const syncs = calls => calls.filter(c => c.p === '/sync');
const waitToast = (page, rx) => page.waitForFunction(r => new RegExp(r).test(document.querySelector('#toast').innerText), rx.source, { timeout: 8000 });
const syncNow = async page => {
  await page.click('#bankcard [data-action="bk-sync"]');
  await page.waitForFunction(() => { const b = document.querySelector('#bankcard [data-action="bk-sync"]'); return b && !b.disabled; });
};
const noHScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'horizontal scroll at ' + label);
const inboxIds = s => s.bank.inbox.flatMap(x => (x.parts || [x.txn]).map(t => t.id));

for (const [w, h] of [[390, 844], [1280, 900]]) {
  const { ctx, page, errs, mock, calls } = await newPage(w, h);
  await step(`${w}: first sync sends an empty acks list and saves per-bank cursors with the batch`, async () => {
    const sc = syncs(calls); assert.equal(sc.length, 1);
    assert.equal(sc[0].sp.get('acks'), ''); assert.equal(sc[0].sp.has('ack'), false, 'no legacy token');
    const s = await getState(page);
    assert.deepEqual(s.bank.cursors, { enr_s: 2, enr_c: 1 }); assert.equal(s.bank.syncToken, null);
    assert.ok(['pl:s1', 'pl:s2', 'pl:c1'].every(id => s.bank.txns[id]));
    // No save ever held a cursor ahead of the transactions it covers.
    const saves = await page.evaluate(() => window.__saves);
    for (const sv of saves) if (sv.cursors.enr_s >= 2) assert.ok(['pl:s1', 'pl:s2'].every(id => sv.ids.includes(id)), 'cursor saved before its batch');
  });
  await step(`${w}: next sync acks each bank; a failed sync keeps the cursors; new changes from a webhook arrive once`, async () => {
    await syncNow(page);
    let sc = syncs(calls).at(-1); assert.equal(sc.sp.get('acks'), 'enr_s:2,enr_c:1');
    assert.equal(mock.log.enr_s.length, 0, 'the Worker dropped what the phone saved');
    mock.fail = true; await page.click('#bankcard [data-action="bk-sync"]');
    await waitToast(page, /internal error|could not|error/i); mock.fail = false;
    await page.waitForFunction(() => { const b = document.querySelector('#bankcard [data-action="bk-sync"]'); return b && !b.disabled; });
    assert.deepEqual((await getState(page)).bank.cursors, { enr_s: 2, enr_c: 1 }, 'kept after a failure');
    // A webhook told the Worker about new Santander activity.
    mock.add('enr_s', T('s3', TODAY, 'NEW PLACE 12', 9.99, SAN));
    await syncNow(page);
    sc = syncs(calls).at(-1); assert.equal(sc.sp.get('acks'), 'enr_s:2,enr_c:1');
    const s = await getState(page);
    assert.deepEqual(s.bank.cursors, { enr_s: 3, enr_c: 1 }); assert.ok(s.bank.txns['pl:s3']);
    assert.equal(inboxIds(s).filter(id => id === 'pl:s3').length, 1);
    const saves = await page.evaluate(() => window.__saves);
    for (const sv of saves) if (sv.cursors.enr_s >= 3) assert.ok(sv.ids.includes('pl:s3'), 'cursor 3 saved without pl:s3');
  });
  await step(`${w}: a re-delivered batch (ack lost) creates no duplicates`, async () => {
    const before = await getState(page);
    mock.ignoreAcks = true; mock.log.enr_s = [{ seq: 1, txn: T('s1', addD(TODAY, -1), 'CORNER DELI 44', 12.5, SAN) }, { seq: 3, txn: T('s3', TODAY, 'NEW PLACE 12', 9.99, SAN) }];
    await syncNow(page); await syncNow(page); mock.ignoreAcks = false;
    const s = await getState(page);
    assert.deepEqual(inboxIds(s).sort(), inboxIds(before).sort()); assert.equal(new Set(inboxIds(s)).size, inboxIds(s).length);
    assert.deepEqual(Object.keys(s.bank.seen).sort(), Object.keys(before.bank.seen).sort());
    assert.deepEqual(Object.keys(s.bank.txns).sort(), Object.keys(before.bank.txns).sort());
  });
  await step(`${w}: one-bank sync sends every bank's ack and only updates that bank's cursor`, async () => {
    mock.add('enr_c', T('c2', TODAY, 'BODEGA 8', 3.5, CHI));
    await page.click('#bankcard .bk-enr:has-text("Chime") [data-action="bk-item-sync"]');
    await page.waitForFunction(() => !document.querySelector('#bankcard [data-action="bk-item-sync"][aria-busy="true"]'));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.cursors.enr_c === 2);
    const sc = syncs(calls).at(-1); assert.equal(sc.sp.get('item'), 'enr_c'); assert.match(sc.sp.get('acks'), /enr_s:3/);
    assert.deepEqual((await getState(page)).bank.cursors, { enr_s: 3, enr_c: 2 });
  });
  await step(`${w}: status sheet shows Instant updates On/Off and the last webhook time`, async () => {
    await page.click('#bankcard [data-action="bk-status"]'); await page.waitForSelector('#pstatus');
    await page.waitForFunction(() => document.querySelectorAll('.ps-bank').length === 2 && /Instant updates/.test(document.querySelector('.ps-bank').innerText));
    const san = await page.locator('.ps-bank[data-item="enr_s"]').innerText(), chi = await page.locator('.ps-bank[data-item="enr_c"]').innerText();
    assert.match(san, /Instant updates\s*On \(webhook set\)/); assert.match(san, /Last webhook received\s*\S/); assert.doesNotMatch(san, /Last webhook received\s*None yet/);
    assert.match(chi, /Instant updates\s*Off/); assert.match(chi, /Last webhook received\s*None yet/);
    await page.screenshot({ path: `${SHOTS}/webhooks-status-${w}.png` });
    await page.click('#sheet .actions [data-action="close"]'); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  });
  await step(`${w}: "Turn on instant updates" appears while a bank lacks the webhook, configures, then goes away`, async () => {
    const btn = page.locator('#bankcard [data-action="bk-hooks"]');
    await btn.waitFor(); assert.equal(await btn.innerText(), 'Turn on instant updates');
    await noHScroll(page, w + ' card with hooks button');
    await page.screenshot({ path: `${SHOTS}/webhooks-card-${w}.png` });
    await btn.click();
    await waitToast(page, /Instant updates on for 2 banks/);
    assert.equal(calls.filter(c => c.p === '/webhook/configure' && c.m === 'POST').length, 1);
    await page.waitForFunction(() => !document.querySelector('#bankcard [data-action="bk-hooks"]'));
    await page.click('#bankcard [data-action="bk-status"]'); await page.waitForSelector('#pstatus');
    await page.waitForFunction(() => /Instant updates\s*On/.test((document.querySelector('.ps-bank[data-item="enr_c"]') || {}).innerText || ''));
    await page.click('#sheet .actions [data-action="close"]'); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  });
  await step(`${w}: no page errors`, async () => { assert.deepEqual(errs, []); });
  await ctx.close();
}

// A Worker deployed before this app (no cursors, only syncToken) still works: the token is acked next time.
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await ctx.newPage(); await prep(page);
  const calls = []; let n = 0;
  await page.route('**/worker.test/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname;
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ p, sp: u.searchParams });
    const json = x => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(x) });
    if (p === '/config') return json({ provider: 'plaid', env: 'production', paired: true });
    if (p === '/accounts') return json({ enrollments: [] });
    if (p === '/sync') return json({ txns: [T('o1', TODAY, 'OLD WORKER', 5, SAN)], removed: [], errors: [], syncToken: 'tok-' + (++n), syncedAt: new Date().toISOString() });
    return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{"error":"not found"}' });
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(([api, from]) => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); Object.assign(s.bank, { api, lastSync: null, autoFrom: from, historyFrom: from }); localStorage.setItem('budtrack.v1', JSON.stringify(s)); localStorage.setItem('budtrack.bankkey', 'k'); }, [API, addD(TODAY, -20)]);
  await page.goto(BASE + '#income', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.syncToken === 'tok-1');
  await step('older Worker: token stored, cursors stay empty, next sync sends ack=<token>; no instant-updates button', async () => {
    assert.deepEqual((await getState(page)).bank.cursors, {});
    await page.click('#bankcard [data-action="bk-sync"]');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('budtrack.v1')).bank.syncToken === 'tok-2');
    const sc = calls.filter(c => c.p === '/sync').at(-1); assert.equal(sc.sp.get('ack'), 'tok-1'); assert.equal(sc.sp.get('acks'), '');
    assert.equal(await page.locator('[data-action="bk-hooks"]').count(), 0);
  });
  await ctx.close();
}

await b.close();
finish();
