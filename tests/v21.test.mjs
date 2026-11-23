// v21: match late bank lines to past bills of every kind (3+ pay cycles, Show older, late-posting bonus), PayPal/Venmo/Cash App pair detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const a = html.indexOf('const BT = (() => {');
const b = html.indexOf('\n})();', a);
const BT = new Function(html.slice(a, b + 5) + '\nreturn BT;')();

const TODAY = '2026-11-23';                       // pay cycles: [Nov 19, Dec 3), [Nov 5, Nov 19), [Oct 22, Nov 5), [Oct 8, Oct 22) ...
const T = (id, date, desc, amount, account) => ({ id, date, desc, rawDesc: desc, amount, account: account || { id: 'co', institution: 'Capital One', name: 'Quicksilver', last4: '7777' }, status: 'posted', counterparty: null });
const keys = arr => arr.map(r => r.x.key);
const fixture = over => Object.assign({
  since: '2026-11-22', marks: {}, occ: {}, spends: [], unalloc: [], perPeriod: [], cards: [], plans: [],
  categories: ['Subscriptions', 'Groceries', 'Other'], billCats: ['Subscriptions'],
  income: [{ id: 'pay', name: 'Acme', freq: 'biweekly', date: '2026-11-19', amount: 2000 }],
  bills: [{ id: 'dd', name: 'DoorDash DashPass', amount: 9.99, day: 20, group: 'Subscriptions', category: 'Subscriptions', via: 'PayPal' },
    { id: 'mc', name: 'Music Club', amount: 9.99, day: 3, group: 'Subscriptions', category: 'Subscriptions' }],
  bank: { seen: {}, rules: {}, txns: {}, inbox: [], autoFrom: '2026-10-01' },
  account: { balance: 3000, asOf: '2026-11-10', adj: [] }
}, over || {});
const PP = T('pl:pp', '2026-11-23', 'PAYPAL to DoorDash', 9.99);
const all = p => [...p.best, ...p.same, ...p.near, ...p.up, ...p.earlier];

test('a late PayPal $9.99 line lists the assumed-paid DashPass bill due 3 days before (and it was only offered forward before)', () => {
  const st = fixture(), p = BT.pickSections(st, PP, TODAY);
  const dd = all(p).find(r => r.x.key === 'b:dd:2026-11-20');
  assert.ok(dd, 'DashPass listed: ' + keys(all(p)));
  assert.equal(dd.x.paid, true); assert.equal(dd.x.auto, true); assert.equal(BT.diffDays(dd.x.due, PP.date), 3);
  assert.equal(p.best[0].x.key, 'b:dd:2026-11-20', 'name + amount + 3 days late is the best match');
  // marked paid and plainly unpaid ones too
  const st2 = fixture({ marks: { 'b:dd:2026-11-20': true } }); assert.ok(keys(all(BT.pickSections(st2, PP, TODAY))).includes('b:dd:2026-11-20'));
  const st3 = fixture({ since: '2026-10-01' }); assert.ok(keys(all(BT.pickSections(st3, PP, TODAY))).includes('b:dd:2026-11-20'));
});

test('three pay cycles back by default; each "Show older" adds three more; ordered newest first in Earlier', () => {
  const st = fixture();
  const has = (o, k) => BT.pickCandidates(st, PP, TODAY, o).list.some(x => x.key === k);
  // The previous three cycles start Oct 8 (cycle of today Nov 19 minus 42 days = Oct 8).
  assert.ok(has({}, 'b:mc:2026-10-03') === false, 'Oct 3 is older than 3 cycles');
  assert.ok(has({}, 'b:mc:2026-11-03') && has({}, 'b:dd:2026-10-20'), 'Oct 20 and Nov 3 are in range');
  assert.ok(has({ cycles: 6 }, 'b:mc:2026-10-03') && has({ cycles: 6 }, 'b:dd:2026-09-20'), 'one tap further: Oct 3, Sep 20');
  assert.ok(!has({ cycles: 6 }, 'b:dd:2026-08-20') && has({ cycles: 9 }, 'b:dd:2026-08-20'), 'and one more');
  const e = BT.pickSections(st, PP, TODAY, { cycles: 9 }).earlier.map(r => r.x.due);
  assert.deepEqual(e, e.slice().sort().reverse());
  assert.equal(BT.pickCandidates(st, PP, TODAY, { cycles: 99 }).cycles, 30, 'capped');
});

test('every scheduled kind comes back for past cycles: bills, cards, plan payments (paid or not) and budgets', () => {
  const st = fixture({
    cards: [{ id: 'visa', name: 'Visa', day: 9, minPayment: 9.99, balance: 500, limit: 2000 }],
    plans: [{ id: 'k1', provider: 'PayPal', merchant: 'Lamp', amount: 9.99, total: 4, paid: 1, freq: 'biweekly', lastDate: '2026-10-26', category: 'Other', autopay: true }],
    perPeriod: [{ id: 'groc', name: 'Groceries', amount: 150, category: 'Groceries' }]
  });
  const c = BT.pickCandidates(st, PP, TODAY);
  const ks = c.list.map(x => x.key);
  assert.ok(ks.includes('c:visa:2026-11-09'), 'card payment from the previous cycle: ' + ks);
  assert.ok(ks.includes('p:k1:2') || ks.includes('p:k1:3'), 'plan payments: ' + ks);
  assert.ok(c.list.some(x => x.kind === 'plan' && x.paid && x.past), 'a paid plan payment, tagged past');
  const bn = c.budgets.map(x => x.natural);
  assert.ok(bn.includes('2026-11-19') && bn.includes('2026-11-05') && bn.includes('2026-10-22') && bn.includes('2026-10-08'), 'budgets of this and the 3 earlier cycles: ' + bn);
  assert.equal(bn[0], '2026-11-19', 'the cycle holding the line first');
});

test('only items linked to ANOTHER bank line are left out', () => {
  const st = fixture();
  st.occ['b:dd:2026-11-20'] = { txn: 'pl:other' };
  assert.ok(!BT.pickCandidates(st, PP, TODAY).list.some(x => x.key === 'b:dd:2026-11-20'));
  st.occ['b:dd:2026-11-20'] = { txn: 'pl:pp' };
  assert.ok(BT.pickCandidates(st, PP, TODAY).list.some(x => x.key === 'b:dd:2026-11-20'), 'its own line may be matched again');
});

test('late-posting bonus: a line 0-7 days AFTER the due date ranks above an equally distant future item', () => {
  const t = T('pl:x', '2026-11-23', 'MYSTERY 9.99', 9.99);
  const past = { due: '2026-11-20', amount: 9.99, name: 'Zed' }, future = { due: '2026-11-26', amount: 9.99, name: 'Zed' };
  assert.ok(BT.pairScore(t, past) > BT.pairScore(t, future));
  assert.ok(BT.pairDist(t, past) < BT.pairDist(t, future));
  // 8 days late gets no bonus and ties with 8 days ahead
  assert.equal(BT.pairScore(t, { due: '2026-11-15', amount: 9.99, name: 'Zed' }), BT.pairScore(t, { due: '2026-12-01', amount: 9.99, name: 'Zed' }));
  // Same amount section: the past DashPass (3 days late) comes before a future $9.99 bill 3 days ahead.
  const st = fixture({ bills: [{ id: 'dd', name: 'Alpha', amount: 9.99, day: 20, group: 'Fixed', category: '' }, { id: 'fu', name: 'Omega', amount: 9.99, day: 26, group: 'Fixed', category: '' }] });
  const p = BT.pickSections(st, T('pl:y', '2026-11-23', 'UNRELATED', 9.99), TODAY);
  const order = keys([...p.best, ...p.same]).filter(k => k === 'b:dd:2026-11-20' || k === 'b:fu:2026-11-26');
  assert.deepEqual(order, ['b:dd:2026-11-20', 'b:fu:2026-11-26']);
});

/* ---------- PayPal / Venmo / Cash App pairs ---------- */
const PAYPAL = { id: 'pp1', institution: 'PayPal', name: 'PayPal Balance' }, CHK = { id: 'c1', institution: 'Chime', name: 'Checking', last4: '1111' };
const ids = pairs => pairs.map(p => p.bank.id + '>' + p.app.id);

test('pass-through pairs: both orders of arrival give the same pair; the bank line is the funding leg', () => {
  const app = T('pl:app', '2026-11-20', 'DOORDASH DASHPASS', 9.99, PAYPAL), bank = T('pl:bank', '2026-11-22', 'PAYPAL *DOORDASH', 9.99, CHK);
  assert.deepEqual(ids(BT.passPairs([app, bank])), ['pl:bank>pl:app']);
  assert.deepEqual(ids(BT.passPairs([bank, app])), ['pl:bank>pl:app']);
  assert.equal(BT.passPairs([app, bank])[0].provider, 'PayPal');
  assert.deepEqual(ids(BT.passPairs([T('pl:b2', '2026-11-22', 'PAYPAL INST XFER', 9.99, CHK), app])), ['pl:b2>pl:app'], 'INST XFER');
  assert.deepEqual(ids(BT.passPairs([T('pl:b3', '2026-11-22', 'PAYPAL to Maya', 9.99, CHK), app])), ['pl:b3>pl:app'], 'PAYPAL to <name>');
});

test('pass-through pairs: not paired outside +-3 days, with another amount, on the same side or for another app', () => {
  const app = T('pl:app', '2026-11-18', 'DOORDASH', 9.99, PAYPAL);
  assert.deepEqual(BT.passPairs([app, T('pl:b', '2026-11-22', 'PAYPAL *DOORDASH', 9.99, CHK)]), [], '4 days apart');
  assert.deepEqual(ids(BT.passPairs([app, T('pl:b', '2026-11-21', 'PAYPAL *DOORDASH', 9.99, CHK)])), ['pl:b>pl:app'], '3 days apart');
  assert.deepEqual(ids(BT.passPairs([app, T('pl:b', '2026-11-15', 'PAYPAL *DOORDASH', 9.99, CHK)])), ['pl:b>pl:app'], 'bank line 3 days before');
  assert.deepEqual(BT.passPairs([app, T('pl:b', '2026-11-19', 'PAYPAL *DOORDASH', 10.99, CHK)]), [], 'another amount');
  assert.deepEqual(BT.passPairs([app, T('pl:b', '2026-11-19', 'SHOPRITE 123', 9.99, CHK)]), [], 'a bank line that is not a PayPal one');
  assert.deepEqual(BT.passPairs([app, T('pl:b', '2026-11-19', 'VENMO PAYMENT', 9.99, CHK)]), [], 'another app');
  assert.deepEqual(BT.passPairs([T('pl:a1', '2026-11-19', 'PAYPAL *A', 9.99, CHK), T('pl:a2', '2026-11-19', 'PAYPAL *B', 9.99, CHK)]), [], 'two bank lines');
});

test('pass-through pairs: one to one, nearest date first; Venmo and Cash App pair with their own app', () => {
  const a1 = T('pl:a1', '2026-11-20', 'X', 9.99, PAYPAL), a2 = T('pl:a2', '2026-11-22', 'Y', 9.99, PAYPAL);
  const b1 = T('pl:b1', '2026-11-20', 'PAYPAL *X', 9.99, CHK), b2 = T('pl:b2', '2026-11-22', 'PAYPAL *Y', 9.99, CHK);
  assert.deepEqual(ids(BT.passPairs([a1, a2, b1, b2])).sort(), ['pl:b1>pl:a1', 'pl:b2>pl:a2']);
  assert.deepEqual(ids(BT.passPairs([a1, b1, b2])), ['pl:b1>pl:a1'], 'a second bank line finds nobody');
  assert.deepEqual(ids(BT.passPairs([a1, b1], new Set(['pl:a1']))), [], 'already paired legs stay');
  const v = T('pl:v', '2026-11-20', 'Maya', 25, { id: 'v', institution: 'Venmo' }), vb = T('pl:vb', '2026-11-21', 'VENMO PAYMENT 1234', 25, CHK);
  assert.deepEqual(ids(BT.passPairs([v, vb])), ['pl:vb>pl:v']);
  const c = T('pl:c', '2026-11-20', 'Sam', 12, { id: 'c', institution: 'Cash App' }), cb = T('pl:cb', '2026-11-20', 'CASH APP*SAM', 12, CHK);
  assert.deepEqual(ids(BT.passPairs([c, cb])), ['pl:cb>pl:c']);
  assert.equal(BT.passApp(PP), null); assert.equal(BT.passLine(c), null, 'the app side is never a funding line');
});

test('"PAYPAL to <your own name>" is a transfer of your own money, not a purchase or a plan; other names and amounts in are not', () => {
  const st = fixture({ displayName: 'Jordan Smith' });
  const k = d => BT.classifyTxn(st, T('pl:o', '2026-11-23', d, 50), TODAY).kind;
  assert.equal(k('PAYPAL to Jordan Smith'), 'transfer');
  assert.equal(k('PAYPAL TO JORDAN SMITH 4029357733'), 'transfer');
  assert.equal(k('PAYPAL to Maria Lopez'), 'plan', 'someone else: still a PayPal line');
  assert.equal(k('PAYPAL *SPOTIFY'), 'plan');
  assert.equal(k('SHOPRITE Jordan Smith'), 'spend', 'no PayPal wording');
  assert.equal(BT.classifyTxn(fixture(), T('pl:o', '2026-11-23', 'PAYPAL to Jordan Smith', 50), TODAY).kind, 'plan', 'no name set');
});
