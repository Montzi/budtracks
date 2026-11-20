import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const a = html.indexOf('const BT = (() => {');
const b = html.indexOf('\n})();', a);
assert.ok(a > 0 && b > a, 'BT module found');
const BT = new Function(html.slice(a, b + 5) + '\nreturn BT;')();

const TODAY = '2026-11-20';
function fixture() {
  return {
    since: '2026-10-01', settings: {}, marks: {}, occ: {}, spends: [], unalloc: [], perPeriod: [],
    categories: ['Gas', 'Subscriptions', 'Groceries', 'Dining Out', 'Takeout Food', 'Personal care', 'Other'],
    billCats: ['Subscriptions', 'Housing', 'Utilities', 'Transportation', 'Other'],
    payVia: [{ bank: 'Chime', last4: '1234', type: 'debit' }],
    bank: { seen: {}, rules: {}, links: {}, lastSync: null },
    bills: [
      { id: 'rent', name: 'Rent', amount: 1050, day: 1, group: 'Fixed', category: 'Housing' },
      { id: 'elec', name: 'Electric', amount: 70, day: 25, group: 'Fixed', category: 'Utilities' },
      { id: 'spot', name: 'Spotify', amount: 13.99, day: 14, group: 'Subscriptions', category: 'Subscriptions' }
    ],
    cards: [{ id: 'visa', name: 'Visa', day: 22, minPayment: 35 }],
    plans: [
      { id: 'k1', provider: 'Klarna', merchant: 'Nike', amount: 27.65, total: 4, paid: 1, freq: 'biweekly', lastDate: '2026-11-06', dates: ['2026-10-23', '2026-11-06', '2026-11-20', '2026-12-04'] },
      { id: 'pp1', provider: 'PayPal', merchant: 'Best Buy', amount: 40, total: 4, paid: 0, freq: 'biweekly', lastDate: '2026-11-21', dates: ['2026-11-21', '2026-12-05', '2026-12-19', '2027-01-02'] }
    ],
    income: [{ id: 'pay', name: 'Payroll', freq: 'biweekly', date: '2026-11-19', amount: 1500, askFrom: '2026-11-19', perCycle: { '2026-11-19': 1500 } }]
  };
}
const T = (o) => Object.assign({ id: 't' + Math.random(), date: '2026-11-20', desc: 'x', amount: 10, account: 'a1', status: 'posted' }, o);

test('Klarna charge auto-matches high', () => {
  const s = BT.classifyTxn(fixture(), T({ desc: 'KLARNA*NIKE', amount: 27.65 }), TODAY);
  assert.equal(s.kind, 'plan'); assert.equal(s.confidence, 'high'); assert.equal(s.pick.planId, 'k1');
});
test('two Klarna plans with same amount are medium with 2 cands', () => {
  const st = fixture();
  st.plans.push({ id: 'k2', provider: 'Klarna', merchant: 'Zara', amount: 27.65, total: 4, paid: 0, freq: 'biweekly', lastDate: '2026-11-21', dates: ['2026-11-21', '2026-12-05', '2026-12-19', '2027-01-02'] });
  const s = BT.classifyTxn(st, T({ desc: 'KLARNA', amount: 27.65 }), TODAY);
  assert.equal(s.confidence, 'medium'); assert.equal(s.cands.length, 2);
});
test('unknown Klarna charge is low and suggests a new plan', () => {
  const s = BT.classifyTxn(fixture(), T({ desc: 'KLARNA*ASOS', amount: 99.99 }), TODAY);
  assert.equal(s.kind, 'plan'); assert.equal(s.confidence, 'low'); assert.equal(s.pick, null); assert.ok(s.newPlan);
});
test('PayPal plan matches', () => {
  const s = BT.classifyTxn(fixture(), T({ desc: 'PAYPAL *BESTBUY', amount: 40 }), TODAY);
  assert.equal(s.pick.planId, 'pp1');
});
test('electric bill 71.20 on day 26 matches medium/high', () => {
  const s = BT.classifyTxn(fixture(), T({ date: '2026-11-26', desc: 'NATIONAL GRID ELECTRIC PMT', amount: 71.2 }), TODAY);
  assert.equal(s.kind, 'bill'); assert.equal(s.pick.key, 'b:elec:2026-11-25'); assert.ok(['medium', 'high'].includes(s.confidence));
});
test('Spotify exact match is high', () => {
  const s = BT.classifyTxn(fixture(), T({ date: '2026-11-14', desc: 'SPOTIFY USA 8885', amount: 13.99 }), TODAY);
  assert.equal(s.kind, 'bill'); assert.equal(s.confidence, 'high');
});
test('bill already linked to a txn is excluded', () => {
  const st = fixture(); st.occ['b:elec:2026-11-25'] = { txn: 'zzz' };
  assert.equal(BT.matchBills(st, T({ date: '2026-11-25', desc: 'ELECTRIC', amount: 70 }), TODAY).length, 0);
});
test('DoorDash is Takeout Food by keyword', () => {
  const g = BT.guessCategory(fixture(), T({ desc: 'DOORDASH*CHIPOTLE 855-973 CA', amount: 18.4 }));
  assert.deepEqual(g, { category: 'Takeout Food', source: 'keyword' });
  const s = BT.classifyTxn(fixture(), T({ desc: 'DOORDASH*CHIPOTLE', amount: 18.4 }), TODAY);
  assert.equal(s.kind, 'spend'); assert.equal(s.confidence, 'medium');
});
test('teller category and default', () => {
  assert.equal(BT.guessCategory(fixture(), T({ desc: 'ACME CORP', tellerCategory: 'fuel' })).category, 'Gas');
  assert.deepEqual(BT.guessCategory(fixture(), T({ desc: 'ACME CORP', tellerCategory: 'zzz' })), { category: 'Other', source: 'default' });
  // category not in the app falls back to Other
  assert.equal(BT.guessCategory(fixture(), T({ desc: 'x', tellerCategory: 'loan' })).category, 'Other');
});
test('learned rule overrides keyword', () => {
  const st = fixture(), t = T({ desc: 'DOORDASH*CHIPOTLE 855-973 CA' });
  BT.learnRule(st, t, 'Groceries');
  const g = BT.guessCategory(st, T({ desc: 'DOORDASH*CHIPOTLE 111-222 NY' }));
  assert.deepEqual(g, { category: 'Groceries', source: 'rule' });
  assert.equal(BT.classifyTxn(st, T({ desc: 'DOORDASH*CHIPOTLE' }), TODAY).confidence, 'high');
});
test('merchantKey normalizes noise', () => {
  assert.equal(BT.merchantKey('POS DEBIT WALMART #1234 BROOKLYN NY'), 'walmart brooklyn');
  assert.equal(BT.merchantKey('WALMART 5678 11/20 xxxx1234'), 'walmart');
});
test('payroll deposit matches income', () => {
  const s = BT.classifyTxn(fixture(), T({ date: '2026-11-20', desc: 'ACME PAYROLL DIRECT DEP', amount: -1500 }), TODAY);
  assert.equal(s.kind, 'income'); assert.equal(s.confidence, 'high'); assert.equal(s.pick.incomeId, 'pay'); assert.equal(s.pick.date, '2026-11-19');
  const m = BT.classifyTxn(fixture(), T({ desc: 'ACME PAYROLL', amount: -1400 }), TODAY);
  assert.equal(m.confidence, 'medium');
});
test('random deposit is a low transfer/refund', () => {
  const s = BT.classifyTxn(fixture(), T({ date: '2026-12-10', desc: 'REFUND AMAZON', amount: -20 }), TODAY);
  assert.equal(s.kind, 'transfer'); assert.equal(s.confidence, 'low');
});
test('credit card payment is a transfer', () => {
  const s = BT.classifyTxn(fixture(), T({ date: '2026-11-22', desc: 'CREDIT CARD PAYMENT', amount: 500 }), TODAY);
  assert.equal(s.kind, 'transfer'); assert.equal(s.pick, null);
  const m = BT.classifyTxn(fixture(), T({ date: '2026-11-22', desc: 'VISA PAYMENT THANK YOU', amount: 35 }), TODAY);
  assert.equal(m.kind, 'transfer'); assert.equal(m.pick.kind, 'card');
});
test('seen, pre-since and pending twins are skipped', () => {
  const st = fixture(); st.bank.seen['s1'] = true;
  const txns = [
    T({ id: 's1', desc: 'COFFEE', amount: 4 }),
    T({ id: 'old', date: '2026-09-01', desc: 'COFFEE', amount: 4 }),
    T({ id: 'p1', status: 'pending', date: '2026-11-18', desc: 'SHELL OIL 123', amount: 40 }),
    T({ id: 'p2', status: 'posted', date: '2026-11-19', desc: 'SHELL OIL 123 BROOKLYN', amount: 40 }),
    T({ id: 'n1', desc: 'TRADER JOES', amount: 22 })
  ];
  const out = BT.classifyBatch(st, txns, TODAY);
  assert.deepEqual(out.map(s => s.txn.id), ['p2', 'n1']);
  assert.equal(out[0].category, 'Gas');
});
test('batch does not double-assign a candidate', () => {
  const st = fixture();
  const out = BT.classifyBatch(st, [
    T({ id: 'a', desc: 'KLARNA', amount: 27.65 }),
    T({ id: 'b', desc: 'KLARNA', amount: 27.65 })
  ], TODAY);
  const keys = out.map(s => s.pick && s.pick.key).filter(Boolean);
  assert.equal(keys.length, 1);
  assert.equal(out.filter(s => !s.pick)[0].confidence, 'low');
  const bills = BT.classifyBatch(st, [
    T({ id: 'c', date: '2026-11-25', desc: 'ELECTRIC CO', amount: 70 }),
    T({ id: 'd', date: '2026-11-25', desc: 'ELECTRIC CO', amount: 70 })
  ], TODAY);
  assert.equal(bills.filter(s => s.kind === 'bill').length, 1);
  assert.equal(bills.filter(s => s.kind === 'spend').length, 1);
});
