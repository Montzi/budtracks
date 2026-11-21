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
test('provider category and default', () => {
  assert.equal(BT.guessCategory(fixture(), T({ desc: 'ACME CORP', providerCategory: 'fuel' })).category, 'Gas');
  assert.deepEqual(BT.guessCategory(fixture(), T({ desc: 'ACME CORP', providerCategory: 'zzz' })), { category: 'Other', source: 'default' });
  // category not in the app falls back to Other
  assert.equal(BT.guessCategory(fixture(), T({ desc: 'x', providerCategory: 'loan' })).category, 'Other');
});
test('provider category sets source and electronics falls back to Other', () => {
  assert.deepEqual(BT.guessCategory(fixture(), T({ desc: 'ACME CORP', providerCategory: 'fuel' })), { category: 'Gas', source: 'provider' });
  assert.equal(BT.guessCategory(fixture(), T({ desc: 'GADGET SHOP', providerCategory: 'electronics' })).category, 'Other');
});
test('provider category transfer (money out) is a transfer, not spending', () => {
  const s = BT.classifyTxn(fixture(), T({ desc: 'ONLINE PMT 8841', amount: 120, providerCategory: 'transfer' }), TODAY);
  assert.equal(s.kind, 'transfer'); assert.equal(s.confidence, 'medium');
  assert.equal(BT.classifyTxn(fixture(), T({ desc: 'ONLINE PMT 8841', amount: 120, providerCategory: 'general' }), TODAY).kind, 'spend');
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

test('cleanDesc strips bank noise from real sandbox descriptions', () => {
  const c = BT.cleanDesc;
  assert.equal(c('PURCHASE AUTHORIZED ON 05/27 ROYAL FARMS 100 MONUMENT AVE A P NATIONAL HARBOR MD 0846248421604 CARD 44'), 'ROYAL FARMS 100 MONUMENT AVE A P NATIONAL HARBOR MD');
  assert.equal(c('INTERAC PURCHASE - 67200 TARGET #052'), 'TARGET');
  assert.equal(c('CHECKCARD 538036 CLEO AI IN MOUNTAIN VIEWCA 172788892 RECURRING'), 'CLEO AI IN MOUNTAIN VIEWCA');
  assert.equal(c("5 PURCHASE-SIG DENNY'S 366992 EUGENE OR 6 039488"), "DENNY'S");
  assert.equal(c('TST*TACO ROCK - LORTON'), 'TACO ROCK - LORTON');
  assert.equal(c('LIDL #XXXX'), 'LIDL');
  assert.equal(c('CARD PURCHASE PAYBYPHONE 804665947 11/19'), 'PAYBYPHONE');
  assert.equal(c({ desc: '', rawDesc: 'POS PURCHASE SHEETZ #12' }), 'SHEETZ');
  assert.equal(c({ desc: 'Spotify', rawDesc: 'SPOTIFY USA 8885' }), 'Spotify');
});

test('keyword rules cover real sandbox merchants', () => {
  const st = fixture(); st.categories = ['Gas', 'Subscriptions', 'Groceries', 'Gaming', 'Household', 'Dining Out', 'Takeout Food', 'Personal care', 'Other'];
  const cat = d => BT.guessCategory(st, T({ desc: d })).category;
  assert.equal(cat('LIDL #XXXX'), 'Groceries');
  assert.equal(cat('CREDIT CARD PURCHASE SMART AND FINAL #1 ANAHEIM CA DATE 12/14'), 'Groceries');
  assert.equal(cat('INTERAC PURCHASE - 67200 TARGET #052'), 'Household');
  assert.equal(cat('PURCHASE AUTHORIZED ON 05/27 ROYAL FARMS 100 MONUMENT AVE'), 'Gas');
  assert.equal(cat('X-ELEVEN XXXXX'), 'Gas');
  assert.equal(cat('TST*AMBAR - CLARENDON'), 'Dining Out');
  assert.equal(cat('OPENAI *CHATGPT SUBSCR'), 'Subscriptions');
  assert.equal(cat('Prime Video Channels'), 'Subscriptions');
  assert.equal(cat('INOVA HC SVCS-MYCHART'), 'Personal care');
  assert.equal(cat('UBER 588639690 RIDE 05/12 CA 12095'), 'Transportation');
  assert.equal(cat('Uber Eats'), 'Takeout Food');
  assert.equal(cat('DOORDASH*WENDYS'), 'Takeout Food');
  assert.equal(BT.guessCategory(st, T({ desc: 'garbled', rawDesc: 'garbled' })).source, 'default');
});

test('CREDIT CARD PURCHASE is a spend, never a transfer, even when the provider says transfer', () => {
  const st = fixture();
  const s = BT.classifyTxn(st, T({ desc: 'CREDIT CARD PURCHASE SMART AND FINAL #1 ANAHEIM CA DATE 12/14 CARD 5', amount: 48.25, providerCategory: 'transfer' }), TODAY);
  assert.equal(s.kind, 'spend'); assert.equal(s.category, 'Groceries');
  assert.equal(BT.classifyTxn(st, T({ desc: 'Payment Thank You-Mobile', amount: 300, providerCategory: 'transfer' }), TODAY).kind, 'transfer');
  assert.equal(BT.classifyTxn(st, T({ desc: 'ONLINE TRANSFER TO SAVINGS', amount: 100 }), TODAY).kind, 'transfer');
  assert.equal(BT.classifyTxn(st, T({ desc: 'TRANSFER PAYPAL ADD TO BALANCE INTERNET PAYMENT', amount: 89 }), TODAY).kind, 'plan');
});

test('P2P transfers carry the p2p flag', () => {
  const st = fixture();
  assert.equal(BT.classifyTxn(st, T({ desc: 'CASH APP TRANSFER', amount: 20, providerCategory: 'transfer' }), TODAY).p2p, true);
  assert.equal(BT.classifyTxn(st, T({ desc: 'Venmo', amount: 145.09, providerCategory: 'transfer' }), TODAY).p2p, true);
  assert.equal(BT.classifyTxn(st, T({ desc: 'CREDIT CARD PAYMENT', amount: 500 }), TODAY).p2p, false);
});

/* ---------- Split paychecks: several deposits on payday are one paycheck ---------- */
const acctOf = (name, last4) => ({ id: name, name: 'Checking', last4, institution: name, type: 'depository' });
const splitIncome = () => { const st = fixture(); st.income = [{ id: 'pay', name: 'Stat Delivery', freq: 'biweekly', date: '2026-11-20', amount: 0, askFrom: '2026-11-06', perCycle: {} }]; return st; };
const P = (id, date, desc, amount, account) => T({ id, date, desc, amount, account });
const trio = () => [
  P('p1', '2026-11-20', 'STAT DELIVERY SE PAYROLL', -100, acctOf('Santander', '6429')),
  P('p2', '2026-11-19', 'STAT DELIVERY SE', -300, acctOf('Santander', '6429')),
  P('p3', '2026-11-19', 'STAT DELIVERY SE PAYROLL CITIZENS PAID EARLY', -1873.31, acctOf('Citizens', '4417'))
];

test('split paycheck: three deposits around payday become ONE income suggestion', () => {
  const st = splitIncome(), zelle = P('z1', '2026-11-20', 'ZELLE FROM JOHN', -250, acctOf('Santander', '6429'));
  const out = BT.classifyBatch(st, trio().concat([zelle]), TODAY);
  const inc = out.filter(s => s.kind === 'income' && s.parts);
  assert.equal(inc.length, 1, JSON.stringify(out.map(s => [s.txn.id, s.kind, !!s.parts])));
  const s = inc[0];
  assert.deepEqual(s.parts.map(p => p.id).sort(), ['p1', 'p2', 'p3']);
  assert.equal(s.amount, 2273.31); assert.equal(s.pick.amount, 2273.31); assert.equal(s.pick.incomeId, 'pay'); assert.equal(s.pick.date, '2026-11-20');
  assert.equal(s.txn.id, 'p3', 'largest part is the representative txn'); assert.equal(s.confidence, 'high');
  // the non-payroll deposit from a different payer is NOT part of the paycheck
  assert.ok(!s.parts.some(p => p.id === 'z1'));
  const z = out.find(x => x.txn.id === 'z1'); assert.ok(z && !z.parts);
  assert.equal(out.length, 2);
});

test('split paycheck: a payer-less partial deposit set without any payroll hint is not grouped', () => {
  const st = splitIncome();
  const out = BT.classifyBatch(st, [P('a', '2026-11-20', 'ZELLE FROM JOHN', -50, acctOf('Santander', '6429')), P('b', '2026-11-19', 'MOBILE DEPOSIT', -70, acctOf('Citizens', '4417'))], TODAY);
  assert.ok(out.every(s => !s.parts));
});

test('payer learning: merchant key is a token prefix match ("STAT DELIVERY SE" ~ "STAT DELIVERY SE PAYROLL")', () => {
  const st = splitIncome(); BT.learnPayer(st, 'pay', trio());
  assert.ok(st.income[0].payer && st.income[0].payer.startsWith('stat delivery'), st.income[0].payer);
  assert.ok(BT.payerMatch(st.income[0], 'STAT DELIVERY SE')); assert.ok(BT.payerMatch(st.income[0], 'STAT DELIVERY SE PAYROLL CITIZENS PAID EARLY'));
  assert.ok(!BT.payerMatch(st.income[0], 'ZELLE FROM JOHN'));
  const keep = st.income[0].payer; BT.learnPayer(st, 'pay', [P('q', '2026-11-20', 'OTHER CO', -1)]); assert.equal(st.income[0].payer, keep, 'never overwritten');
  // with the payer known, a deposit with no payroll word joins by payer alone
  const out = BT.classifyBatch(st, [P('x1', '2026-11-19', 'STAT DELIVERY SE', -300), P('x2', '2026-11-20', 'STAT DELIVERY SE', -100)], TODAY);
  assert.equal(out.length, 1); assert.equal(out[0].amount, 400);
});

test('late part: a deposit that shows up after the paycheck was applied joins it', () => {
  const st = splitIncome(); BT.learnPayer(st, 'pay', trio());
  st.income[0].perCycle['2026-11-20'] = 2273.31;
  trio().forEach(t => { st.bank.seen[t.id] = { res: 'income', incomeId: 'pay', payDate: '2026-11-20', date: t.date, amount: t.amount, desc: t.desc, part: true, prev: null, src: 'sync', at: '2026-11-20T10:00:00Z' }; });
  const late = P('late', '2026-11-21', 'STAT DELIVERY SE', -50, acctOf('Santander', '6429'));
  const out = BT.classifyBatch(st, [late, P('z2', '2026-11-21', 'ZELLE FROM JOHN', -25)], TODAY);
  const s = out.find(x => x.txn.id === 'late');
  assert.equal(s.kind, 'income'); assert.equal(s.join, true); assert.equal(s.confidence, 'high'); assert.equal(s.pick.date, '2026-11-20'); assert.equal(s.amount, 50);
  assert.ok(!out.find(x => x.txn.id === 'z2').join, 'unrelated deposit does not join');
  // too far from payday: does not join
  const far = BT.classifyBatch(st, [P('far', '2026-11-23', 'STAT DELIVERY SE', -50)], TODAY);
  assert.ok(!far[0].join);
});

/* ---------- Grouping guard: only the employer's deposits join a paycheck ---------- */
test('guard: an unrelated $280 deposit on payday never joins (same batch) and is never an income suggestion', () => {
  const st = splitIncome();
  const odd = P('odd', '2026-11-20', 'VENMO CASHOUT', -280, acctOf('Santander', '6429'));
  const out = BT.classifyBatch(st, trio().concat([odd]), TODAY);
  const grp = out.find(s => s.parts && s.parts.length > 1);
  assert.deepEqual(grp.parts.map(p => p.id).sort(), ['p1', 'p2', 'p3']); assert.equal(grp.amount, 2273.31);
  const o = out.find(s => s.txn.id === 'odd');
  assert.equal(o.kind, 'transfer'); assert.equal(o.pick, null); assert.ok(!o.parts);
});
test('guard: after the payer is learned, a payroll keyword from ANOTHER payer does not join or count', () => {
  const st = splitIncome(); BT.learnPayer(st, 'pay', trio());
  const other = P('o2', '2026-11-20', 'ACME CORP PAYROLL', -280), mate = P('m1', '2026-11-20', 'STAT DELIVERY SE', -400);
  const out = BT.classifyBatch(st, [other, mate, P('m2', '2026-11-19', 'STAT DELIVERY SE', -100)], TODAY);
  const grp = out.find(s => s.parts); assert.equal(grp.amount, 500); assert.ok(!grp.parts.some(p => p.id === 'o2'));
  const o = out.find(s => s.txn.id === 'o2'); assert.equal(o.kind, 'transfer'); assert.equal(o.pick, null);
});
test('guard: a later sync with parts already applied keeps the stranger out', () => {
  const st = splitIncome(); BT.learnPayer(st, 'pay', trio()); st.income[0].perCycle['2026-11-20'] = 2273.31;
  trio().forEach(t => { st.bank.seen[t.id] = { res: 'income', incomeId: 'pay', payDate: '2026-11-20', date: t.date, amount: t.amount, desc: t.desc, part: true, prev: null, src: 'sync', at: '2026-11-20T10:00:00Z' }; });
  const out = BT.classifyBatch(st, [P('odd', '2026-11-20', 'ZELLE FROM BOB', -280)], TODAY);
  assert.equal(out[0].kind, 'transfer'); assert.ok(!out[0].join && !out[0].parts);
});
test('guard: deposits more than a day from payday do not group even with the right payer', () => {
  const st = splitIncome(); BT.learnPayer(st, 'pay', trio());
  const out = BT.classifyBatch(st, [P('a', '2026-11-20', 'STAT DELIVERY SE', -100), P('b', '2026-11-22', 'STAT DELIVERY SE', -300)], TODAY);
  assert.ok(!out.some(s => s.parts && s.parts.some(p => p.id === 'b')));
});
test('guard: a part removed from the paycheck (notPay) comes back as transfer or refund, not income', () => {
  const st = splitIncome(); BT.learnPayer(st, 'pay', trio()); st.bank.notPay = { p2: true };
  const out = BT.classifyBatch(st, trio(), TODAY);
  assert.deepEqual(out.find(s => s.parts).parts.map(p => p.id).sort(), ['p1', 'p3']);
  const s2 = out.find(s => s.txn.id === 'p2'); assert.equal(s2.kind, 'transfer'); assert.equal(s2.pick, null);
});
