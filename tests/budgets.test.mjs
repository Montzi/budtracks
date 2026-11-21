// Pure money math for per-paycheck budgets (Gas, Groceries). Run: node --test tests/*.test.mjs
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
function fixture(spends) {
  return {
    since: '2026-10-01', settings: { anchor: '2026-11-19' }, marks: {}, occ: {}, unalloc: [], bank: { seen: {}, rules: {}, links: {} },
    categories: ['Gas', 'Groceries', 'Other'], billCats: ['Housing'], payVia: [],
    bills: [{ id: 'rent', name: 'Rent', amount: 1000, day: 25, group: 'Fixed', category: 'Housing' }], cards: [], plans: [],
    perPeriod: [{ id: 'gas', name: 'Gas', amount: 60, category: 'Gas' }, { id: 'groc', name: 'Groceries', amount: 150, category: 'Groceries' }],
    income: [{ id: 'pay', name: 'Payroll', freq: 'biweekly', date: '2026-11-19', amount: 2000, askFrom: '2026-11-19', perCycle: { '2026-11-19': 2000 } }],
    spends: spends || [], account: { balance: 3000, asOf: '2026-11-19', adj: [], auto: false }
  };
}
const budget = (s, name) => s.items.find(x => x.kind === 'spend' && x.name === name);

test('an unspent budget is reserved in needed and left in paycheck', () => {
  const s = BT.summary(fixture(), R, TODAY);
  assert.equal(s.needed, 1000 + 60 + 150); assert.equal(s.paid, 0); assert.equal(s.left, 2000 - 1210);
  const g = budget(s, 'Groceries'); assert.equal(g.spent, 0); assert.equal(g.paid, false);
});
test('purchases count inside the budget once: needed = max(budget, spent), paid = spent', () => {
  const st = fixture([sp('a', 'Groceries', 40, '2026-11-20'), sp('b', 'Groceries', 30, '2026-11-21'), sp('c', 'Gas', 25, '2026-11-21'), sp('o', 'Other', 12, '2026-11-21')]);
  const s = BT.summary(st, R, TODAY);
  assert.equal(budget(s, 'Groceries').spent, 70); assert.equal(budget(s, 'Gas').spent, 25);
  assert.equal(s.needed, 1000 + 150 + 60 + 12); assert.equal(s.paid, 70 + 25 + 12);
  assert.equal(s.items.filter(x => x.kind === 'extra').length, 1, 'only the Other spend stays a separate item');
  assert.equal(s.claimed.length, 3);
  assert.equal(s.left, 2000 - (1000 + 150 + 60 + 12));
});
test('overspending: needed grows to the spend, left in paycheck shrinks', () => {
  const st = fixture([sp('a', 'Groceries', 40, '2026-11-20'), sp('b', 'Groceries', 30, '2026-11-21'), sp('c', 'Groceries', 100, '2026-11-21')]);
  const s = BT.summary(st, R, TODAY), g = budget(s, 'Groceries');
  assert.equal(g.spent, 170); assert.equal(g.budget, 150); assert.equal(g.amount, 170);
  assert.equal(s.needed, 1000 + 60 + 170); assert.equal(s.paid, 170); assert.equal(s.due, 1060);
});
test('spends outside the cycle do not count; the next cycle has its own budget', () => {
  const st = fixture([sp('old', 'Groceries', 80, '2026-11-18'), sp('in', 'Groceries', 20, '2026-11-25')]);
  assert.equal(budget(BT.summary(st, R, TODAY), 'Groceries').spent, 20);
  const prev = BT.summary(st, { start: '2026-11-05', end: '2026-11-19', view: 'biweekly' }, TODAY);
  assert.equal(budget(prev, 'Groceries').spent, 80);
});
test('account balance subtracts each real spend once and never the envelope', () => {
  const st = fixture([sp('a', 'Groceries', 40, '2026-11-20'), sp('b', 'Groceries', 30, '2026-11-21')]);
  const before = BT.accountBalance(fixture(), TODAY);
  assert.equal(before, 3000 + 2000);
  assert.equal(BT.accountBalance(st, TODAY), 5000 - 70);
  // old checkmarks on per-paycheck keys are harmless
  const marked = fixture([sp('a', 'Groceries', 40, '2026-11-20')]);
  BT.occurrences(marked, R, TODAY, true).filter(x => x.kind === 'spend').forEach(x => { marked.marks[x.key] = true; });
  assert.equal(BT.accountBalance(marked, TODAY), 5000 - 40);
  assert.equal(BT.summary(marked, R, TODAY).paid, 40);
});
test('budget at 0 or inactive claims nothing', () => {
  const st = fixture([sp('a', 'Groceries', 40, '2026-11-20')]);
  st.perPeriod[1].amount = 0; st.perPeriod[0].active = false;
  const s = BT.summary(st, R, TODAY);
  assert.equal(budget(s, 'Groceries').on, false); assert.equal(budget(s, 'Gas').on, false);
  assert.equal(s.needed, 1000 + 40); assert.equal(s.items.filter(x => x.kind === 'extra').length, 1);
});
test('a category shared by two budgets: the first one listed wins, no double count', () => {
  const st = fixture([sp('a', 'Groceries', 40, '2026-11-20')]);
  st.perPeriod.push({ id: 'g2', name: 'Costco', amount: 100, category: 'Groceries' });
  const s = BT.summary(st, R, TODAY);
  assert.equal(budget(s, 'Groceries').spent, 40); assert.equal(budget(s, 'Costco').spent, 0);
  assert.equal(s.needed, 1000 + 60 + 150 + 100);
});
test('a spend that is unticked is not counted toward the budget', () => {
  const st = fixture([sp('a', 'Groceries', 40, '2026-11-20')]); st.marks['x:a'] = false;
  const s = BT.summary(st, R, TODAY);
  assert.equal(budget(s, 'Groceries').spent, 0); assert.equal(s.items.filter(x => x.kind === 'extra').length, 1);
});
test('likelyPaid ignores budgets', () => {
  const st = fixture(), item = BT.occurrences(st, R, TODAY).find(x => x.kind === 'spend' && x.name === 'Groceries');
  const tx = { id: 't1', date: '2026-11-20', desc: 'GROCERIES', amount: 150, status: 'posted' };
  assert.equal(BT.likelyPaid(st, item, [tx], TODAY), null);
  assert.equal(BT.likelyPaidAll(st, [item], [tx], TODAY).size, 0);
});
test('weekly view keeps spends out of a budget that is not in that week', () => {
  const st = fixture([sp('a', 'Groceries', 40, '2026-11-27')]);
  const s = BT.summary(st, { start: '2026-11-26', end: '2026-12-03', view: 'weekly' }, TODAY);
  assert.equal(s.items.filter(x => x.kind === 'spend').length, 0);
  assert.equal(s.items.filter(x => x.kind === 'extra').length, 1);
});
