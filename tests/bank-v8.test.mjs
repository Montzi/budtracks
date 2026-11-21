// Money math for bank-v8: chart group roll-up, skip, one-time vs permanent amounts, savings moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const a = html.indexOf('const BT = (() => {');
const b = html.indexOf('\n})();', a);
const BT = new Function(html.slice(a, b + 5) + '\nreturn BT;')();

const TODAY = '2026-11-21';
const R = { start: '2026-11-19', end: '2026-12-03', view: 'biweekly' };
const sp = (id, category, amount, date) => ({ id, category, desc: category + ' ' + id, amount, date, note: '' });
function fixture(over) {
  return Object.assign({
    since: '2026-10-01', settings: { anchor: '2026-11-19' }, marks: {}, occ: {}, unalloc: [], bank: { seen: {}, rules: {}, links: {} },
    categories: ['Gas', 'Groceries', 'Takeout Food', 'Snacks & Drinks', 'Coffee', 'Other'], billCats: ['Housing', 'Subscriptions'], payVia: [],
    bills: [{ id: 'rent', name: 'Rent', amount: 1000, day: 25, group: 'Fixed', category: 'Housing' },
      { id: 'spot', name: 'Spotify', amount: 12, day: 26, group: 'Subscriptions', category: 'Subscriptions' },
      { id: 'icl', name: 'iCloud', amount: 3, day: 27, group: 'Apple Subscriptions', category: '' }], cards: [{ id: 'visa', name: 'Visa', day: 28, minPayment: 35 }], plans: [],
    perPeriod: [{ id: 'gas', name: 'Gas', amount: 60, category: 'Gas' }, { id: 'groc', name: 'Groceries', amount: 150, category: 'Groceries' }],
    income: [{ id: 'pay', name: 'Payroll', freq: 'biweekly', date: '2026-11-19', amount: 2000, askFrom: '2026-11-19', perCycle: { '2026-11-19': 2000 } }],
    spends: [], account: { balance: 3000, asOf: '2026-11-19', adj: [], auto: false }
  }, over || {});
}
const PARENT = { Groceries: 'Food', 'Takeout Food': 'Food', 'Snacks & Drinks': 'Food', Coffee: 'Food', Gas: 'Transportation', Housing: 'Home', Subscriptions: 'Entertainment' };
const parentOf = c => PARENT[c] || (['Food', 'Transportation', 'Home', 'Entertainment'].includes(c) ? c : 'Other');
const leafOf = x => x.kind === 'bill' && ['Apple Subscriptions', 'Subscriptions'].includes(x.group) ? 'Subscriptions' : x.category || (x.kind === 'bill' ? 'Other bills' : x.kind === 'spend' ? 'Living expenses' : 'Uncategorized');

test('Food group = Groceries budget max(budget, spent) + Takeout + Snacks + Food itself', () => {
  const st = fixture({ spends: [sp('a', 'Groceries', 40, '2026-11-20'), sp('b', 'Takeout Food', 25, '2026-11-20'), sp('c', 'Snacks & Drinks', 5, '2026-11-21'), sp('d', 'Coffee', 4, '2026-11-21'), sp('e', 'Food', 10, '2026-11-21'), sp('f', 'Gas', 20, '2026-11-21')] });
  const s = BT.summary(st, R, TODAY), g = BT.rollup(s.items, leafOf, parentOf), food = g.find(x => x.label === 'Food');
  // Groceries budget 150 > spent 40, so it counts 150; the loose spends count as spent.
  assert.equal(food.value, 150 + 25 + 5 + 4 + 10);
  assert.deepEqual(food.kids.map(k => k.label).sort(), ['Coffee', 'Food', 'Groceries', 'Snacks & Drinks', 'Takeout Food'])
  assert.equal(food.kids.find(k => k.label === 'Groceries').value, 150);
  assert.equal(g.find(x => x.label === 'Transportation').value, 60, 'Gas budget 60 > 20 spent');
  assert.equal(BT.round2(g.reduce((t, x) => t + x.value, 0)), s.needed, 'groups add up to what the cycle needs');
});
test('budget over its amount counts what was spent', () => {
  const st = fixture({ spends: [sp('a', 'Groceries', 120, '2026-11-20'), sp('b', 'Groceries', 80, '2026-11-21')] });
  const g = BT.rollup(BT.summary(st, R, TODAY).items, leafOf, parentOf);
  assert.equal(g.find(x => x.label === 'Food').value, 200);
});
test('subscriptions (incl. Apple) roll up together; unknown categories go under Other, Other last', () => {
  const g = BT.rollup(BT.summary(fixture(), R, TODAY).items, leafOf, parentOf);
  assert.equal(g.find(x => x.label === 'Entertainment').value, 15);
  assert.deepEqual(g.find(x => x.label === 'Entertainment').kids, [{ label: 'Subscriptions', value: 15 }]);
  const other = g.find(x => x.label === 'Other'); assert.equal(other.value, 35); assert.equal(g[g.length - 1].label, 'Other');
});

test('Skip this cycle removes a bill, card, or budget from needed; unskip brings it back', () => {
  const st = fixture(), base = BT.summary(st, R, TODAY).needed;
  const keys = BT.summary(st, R, TODAY).items.reduce((m, x) => (m[x.kind] = x.key, m), {});
  st.occ[keys.bill] = { skip: true, skipped: true };
  const s1 = BT.summary(st, R, TODAY); assert.ok(s1.needed < base); assert.ok(!s1.items.some(x => x.key === keys.bill));
  st.occ[keys.card] = { skip: true, skipped: true }; st.occ[keys.spend] = { skip: true, skipped: true };
  const s2 = BT.summary(st, R, TODAY); assert.ok(s2.needed < s1.needed);
  assert.equal(BT.skippedIn(st, R, TODAY).length, 3, 'all three are listed as skipped');
  Object.keys(st.occ).forEach(k => delete st.occ[k].skip);
  assert.equal(BT.summary(st, R, TODAY).needed, base);
});

test('one-time amount changes this cycle only; permanent changes the bill for the cycle and later ones', () => {
  const st = fixture(), rent = BT.summary(st, R, TODAY).items.find(x => x.ref === 'rent');
  st.occ[rent.key] = { amount: 900 };
  assert.equal(BT.summary(st, R, TODAY).items.find(x => x.ref === 'rent').amount, 900);
  const next = { start: '2026-12-17', end: '2026-12-31', view: 'biweekly' }; st.income[0].perCycle['2026-12-17'] = 2000;
  assert.equal(BT.summary(st, next, TODAY).items.find(x => x.ref === 'rent').amount, 1000, 'next cycle keeps the usual amount');
  delete st.occ[rent.key]; st.bills[0].amount = 950;
  assert.equal(BT.summary(st, R, TODAY).items.find(x => x.ref === 'rent').amount, 950);
  assert.equal(BT.summary(st, next, TODAY).items.find(x => x.ref === 'rent').amount, 950);
});
test('budget override for one cycle leaves the base amount', () => {
  const st = fixture(), g = BT.summary(st, R, TODAY).items.find(x => x.kind === 'spend' && x.ref === 'groc');
  st.occ[g.key] = { amount: 200 };
  const x = BT.summary(st, R, TODAY).items.find(x => x.kind === 'spend' && x.ref === 'groc');
  assert.equal(x.budget, 200); assert.equal(st.perPeriod[1].amount, 150);
});

test('savings moves leave checking but are not spending; savedIn is the cycle net', () => {
  const st = fixture({ savings: { on: true, bank: '', tx: [{ id: 's0', type: 'open', amount: 500, date: '2026-10-01' }, { id: 's1', type: 'in', amount: 100, date: '2026-11-20' }, { id: 's2', type: 'in', amount: 50, date: '2026-12-10' }, { id: 's3', type: 'out', amount: 20, date: '2026-11-21' }] } });
  const bal = BT.accountBalance(st, TODAY), spendNeeded = BT.summary(st, R, TODAY).needed;
  assert.equal(bal, BT.round2(3000 + 2000 - 0 - 100 + 20), 'only moves up to today, opening balance ignored');
  assert.equal(BT.summary({ ...st, savings: { on: false, tx: [] } }, R, TODAY).needed, spendNeeded, 'savings never change needed');
  assert.equal(BT.savedIn(st, R), 80); assert.equal(BT.savedIn(st, { start: '2026-12-03', end: '2026-12-17' }), 50);
  assert.equal(BT.savedIn(st, { start: '2026-09-01', end: '2026-10-15' }), 0, 'opening balance is not a move');
  assert.equal(BT.savingsBalance(st), 500 + 100 + 50 - 20);
});
