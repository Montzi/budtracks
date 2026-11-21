// Chart grouping: pay plan payment 1 stays in its category, payments 2+ go under "Pay later" by provider,
// card payments under "Credit cards" by card. Totals don't change. Run: node --test tests/*.test.mjs
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
const PARENT = { Clothing: 'Shopping', Electronics: 'Shopping', Housing: 'Home', 'Credit cards': 'Bills & Finance' };
const parentOf = c => PARENT[c] || 'Other';
const baseCat = x => x.category || (x.kind === 'bill' ? 'Other bills' : 'Uncategorized');
// The same leaf / group functions the Overview chart uses (chartLeaf / chartGroupOf).
const leafOf = x => { const s = BT.chartSlot(x); return s ? s.leaf : baseCat(x); };
const groupOf = (leaf, x) => { const s = x && BT.chartSlot(x); return s ? s.group : parentOf(leaf); };
const plan = (id, provider, merchant, category, paid, dates, amount) => ({ id, provider, merchant, amount, total: dates.length, paid, freq: 'biweekly', lastDate: dates[Math.max(0, paid - 1)], dates, amounts: dates.map(() => amount), category, autopay: true, purchased: dates[0] });
function fixture(over) {
  return Object.assign({
    since: '2026-10-01', settings: { anchor: '2026-11-19' }, marks: {}, occ: {}, unalloc: [], bank: { seen: {}, rules: {}, links: {} },
    categories: ['Clothing', 'Electronics', 'Other'], billCats: ['Housing'], payVia: [],
    bills: [{ id: 'rent', name: 'Rent', amount: 1000, day: 25, group: 'Fixed', category: 'Housing' }], cards: [], perPeriod: [],
    plans: [
      // New purchase: payment 1 of 4 is due in this cycle.
      plan('new', 'Klarna', 'Zara', 'Clothing', 0, ['2026-11-20', '2026-12-04', '2026-12-18', '2027-01-01'], 30),
      // Older purchases being paid off: payment 3 of 4 (Klarna) and 2 of 4 (Afterpay) fall in this cycle.
      plan('old1', 'Klarna', 'Nike', 'Clothing', 2, ['2026-10-23', '2026-11-06', '2026-11-20', '2026-12-04'], 27.65),
      plan('old2', 'Afterpay', 'Best Buy', 'Electronics', 1, ['2026-11-08', '2026-11-22', '2026-12-06', '2026-12-20'], 50),
      plan('old3', 'Sezzle', 'Shoes', 'Clothing', 1, ['2026-11-09', '2026-11-23', '2026-12-07'], 10)],
    income: [{ id: 'pay', name: 'Payroll', freq: 'biweekly', date: '2026-11-19', amount: 2000 }],
    spends: [], account: null
  }, over || {});
}
const sum = g => BT.round2(g.reduce((t, x) => t + x.value, 0));

test('payment 1 of a new plan stays under its category; payments 2+ go under Pay later by provider', () => {
  const s = BT.summary(fixture(), R, TODAY), g = BT.rollup(s.items, leafOf, groupOf);
  const shop = g.find(x => x.label === 'Shopping'), pl = g.find(x => x.label === 'Pay later');
  assert.deepEqual(shop.kids, [{ label: 'Clothing', value: 30 }], 'only the Zara purchase (1 of 4) counts as Clothing');
  assert.ok(pl, 'Pay later group');
  assert.equal(pl.value, BT.round2(27.65 + 50 + 10));
  assert.deepEqual(pl.kids, [{ label: 'Afterpay', value: 50 }, { label: 'Klarna', value: 27.65 }, { label: 'Other', value: 10 }]);
  assert.ok(!g.some(x => x.label === 'Credit cards'), 'no cards, no Credit cards group');
});
test('chartSlot reads the payment number: 1 → category, 2+ → Pay later; unknown provider → Other', () => {
  assert.equal(BT.chartSlot({ kind: 'plan', key: 'p:a:1', n: 1, provider: 'Klarna' }), null);
  assert.deepEqual(BT.chartSlot({ kind: 'plan', key: 'p:a:2', provider: 'Klarna' }), { group: 'Pay later', leaf: 'Klarna' });
  assert.deepEqual(BT.chartSlot({ kind: 'plan', key: 'p:a:4', n: 4, provider: 'Affirm' }), { group: 'Pay later', leaf: 'Affirm' });
  assert.deepEqual(BT.chartSlot({ kind: 'plan', key: 'p:a:3', n: 3, provider: 'Zip' }), { group: 'Pay later', leaf: 'Other' });
  assert.equal(BT.chartSlot({ kind: 'bill', key: 'b:x:2026-11-25' }), null);
});
test('card payments go under Credit cards with a child per card', () => {
  const st = fixture({ cards: [{ id: 'visa', name: 'Visa', day: 22, minPayment: 35 }, { id: 'amex', name: 'Amex Gold', day: 28, minPayment: 40, category: 'Credit cards' }] });
  const s = BT.summary(st, R, TODAY), g = BT.rollup(s.items, leafOf, groupOf), cc = g.find(x => x.label === 'Credit cards');
  assert.ok(cc); assert.equal(cc.value, 75);
  assert.deepEqual(cc.kids, [{ label: 'Amex Gold', value: 40 }, { label: 'Visa', value: 35 }]);
  assert.ok(!g.some(x => x.label === 'Bills & Finance'), 'cards no longer roll up by their category');
});
test('totals are unchanged: groups add up to what the period needs, in cycle and month ranges', () => {
  const st = fixture({ cards: [{ id: 'visa', name: 'Visa', day: 22, minPayment: 35 }] });
  for (const r of [R, BT.periodRange(st, 'monthly', 0, R.start)]) {
    const s = BT.summary(st, r, TODAY);
    const before = BT.rollup(s.items, baseCat, parentOf), after = BT.rollup(s.items, leafOf, groupOf);
    assert.equal(sum(after), sum(before)); assert.equal(sum(after), s.needed);
  }
  const m = BT.summary(st, BT.periodRange(st, 'monthly', 0, R.start), TODAY), gm = BT.rollup(m.items, leafOf, groupOf);
  assert.ok(gm.find(x => x.label === 'Pay later').value > 0, 'Pay later shows in the month range too');
});
test('the old two-argument groupOf still works (rollup passes the item as a second argument)', () => {
  const s = BT.summary(fixture(), R, TODAY), g = BT.rollup(s.items, baseCat, parentOf);
  assert.ok(g.some(x => x.label === 'Shopping') && !g.some(x => x.label === 'Pay later'));
});
