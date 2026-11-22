// v13: "Bills & Finance" split (cats-v5), user sub-categories, and matching late bank lines to past (assumed or marked paid) bills.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const a = html.indexOf('const BT = (() => {');
const b = html.indexOf('\n})();', a);
const BT = new Function(html.slice(a, b + 5) + '\nreturn BT;')();
const clone = o => JSON.parse(JSON.stringify(o));

/* ---------- categories ---------- */
const oldState = over => Object.assign({
  categories: ['Gas', 'Groceries', 'Fees', 'Bills & Finance', 'Bank charges', 'Other'], billCats: ['Housing', 'Phone & Internet', 'Loans', 'Taxes', 'Other'],
  catParents: { Groceries: 'Food', Gas: 'Transportation', 'Phone & Internet': 'Bills & Finance', Loans: 'Bills & Finance', Taxes: 'Bills & Finance', Fees: 'Bills & Finance', 'Bank charges': 'Bills & Finance' },
  spends: [], bills: [], plans: [], perPeriod: [], cards: [], bank: { rules: {}, inbox: [] }
}, over || {});

test('CAT_TREE has no "Bills & Finance"; Phone & Internet, Loans, Taxes and Fees are groups', () => {
  const tops = BT.CAT_TREE.map(x => x[0]);
  assert.ok(!tops.includes('Bills & Finance'));
  ['Phone & Internet', 'Loans', 'Taxes', 'Fees'].forEach(g => { assert.ok(tops.includes(g), g); assert.deepEqual(BT.CAT_TREE.find(x => x[0] === g)[1], []); });
  assert.equal(tops.at(-1), 'Other');
  assert.equal(BT.DEFAULT_PARENT['Phone & Internet'], undefined);
});

test('cats-v5: children of Bills & Finance become their own groups; the unused old group is removed', () => {
  const o = BT.migrateCats5(oldState());
  ['Phone & Internet', 'Loans', 'Taxes', 'Fees'].forEach(c => { assert.ok(!(c in o.catParents), c + ' mapping removed'); assert.equal(BT.parentOf(o, c), c); });
  assert.equal(o.catParents['Bank charges'], 'Bank charges', 'a user category under the old group becomes its own group');
  assert.equal(BT.parentOf(o, 'Bank charges'), 'Bank charges');
  const ps = BT.parentNames(o);
  ['Phone & Internet', 'Loans', 'Taxes', 'Fees', 'Bank charges'].forEach(g => assert.ok(ps.includes(g), g));
  assert.ok(!ps.includes('Bills & Finance')); assert.equal(ps.at(-1), 'Other');
  assert.ok(!o.categories.includes('Bills & Finance') && !o.billCats.includes('Bills & Finance'));
  assert.equal(BT.parentOf(o, 'Groceries'), 'Food'); assert.equal(BT.parentOf(o, 'Gas'), 'Transportation');
  // Running it again changes nothing.
  assert.deepEqual(BT.migrateCats5(clone(o)), o);
});

test('cats-v5: "Bills & Finance" still in use stays, as its own group', () => {
  for (const over of [{ bills: [{ id: 'b', name: 'Bank fee', amount: 5, day: 3, category: 'Bills & Finance' }] }, { spends: [{ id: 'x', category: 'Bills & Finance', amount: 4, date: '2026-11-01' }] },
    { bank: { rules: { 'acme fee': 'Bills & Finance' }, inbox: [] } }]) {
    const o = BT.migrateCats5(oldState(over));
    assert.ok(o.categories.includes('Bills & Finance'));
    assert.equal(o.catParents['Bills & Finance'], 'Bills & Finance');
    assert.ok(BT.parentNames(o).includes('Bills & Finance'));
    assert.equal(BT.parentOf(o, 'Loans'), 'Loans', 'the split still happens');
  }
});

test('user sub-categories: "Toll tags" under Transportation, new group "Pets" with "Vet", and moving an empty group', () => {
  const st = BT.migrateCats5(oldState());
  st.categories.push('Toll tags', 'Pets', 'Vet');
  Object.assign(st.catParents, { 'Toll tags': 'Transportation', Pets: 'Pets', Vet: 'Pets' });
  const ps = BT.parentNames(st);
  assert.ok(ps.includes('Pets')); assert.ok(!ps.includes('Vet')); assert.ok(!ps.includes('Toll tags'));
  assert.ok(ps.indexOf('Pets') < ps.indexOf('Other'), 'user groups come before Other');
  assert.equal(BT.parentOf(st, 'Toll tags'), 'Transportation'); assert.equal(BT.parentOf(st, 'Vet'), 'Pets'); assert.equal(BT.parentOf(st, 'Pets'), 'Pets');
  // A default group with nothing under it can be moved under another group, and back.
  st.catParents.Fees = 'Home';
  assert.ok(!BT.parentNames(st).includes('Fees')); assert.equal(BT.parentOf(st, 'Fees'), 'Home');
  st.catParents.Fees = 'Fees';
  assert.equal(BT.parentOf(st, 'Fees'), 'Fees');
  // A parent that is no longer a group falls back to the default parent, then Other.
  st.catParents.Pets = 'Home';
  assert.equal(BT.parentOf(st, 'Vet'), 'Other');
});

/* ---------- match picker: late bank lines and past bills ---------- */
const TODAY = '2026-11-22';
const T = (id, date, desc, amount) => ({ id, date, desc, rawDesc: desc, amount, account: { id: 'chk', institution: 'Santander' } });
const fixture = over => Object.assign({
  since: '2026-11-18', settings: { anchor: '2026-11-19' }, marks: {}, occ: {}, unalloc: [], payVia: [], spends: [], cards: [], plans: [], perPeriod: [],
  categories: ['Groceries', 'Other'], billCats: ['Subscriptions', 'Housing'], catParents: {},
  bills: [{ id: 'uhf', name: 'UHF IPVT Player', amount: 1.99, day: 17, group: 'Apple Subscriptions', category: '' },
    { id: 'icl', name: 'iCloud+', amount: 2.99, day: 20, group: 'Apple Subscriptions', category: '' },
    { id: 'rent', name: 'Rent', amount: 1000, day: 25, group: 'Fixed', category: 'Housing' }],
  income: [{ id: 'pay', name: 'Payroll', freq: 'biweekly', date: '2026-11-19', amount: 2000 }],
  bank: { seen: {}, rules: {}, links: {}, txns: {} },
  account: { balance: 3000, asOf: '2026-11-10', adj: [] }
}, over || {});
const APPLE = T('pl:apple', '2026-11-21', 'APPLE.COM/BILL', 1.99);
const keys = arr => arr.map(r => r.x.key);

test('picker: a $1.99 Apple line on Nov 21 offers the assumed-paid Nov 17 UHF first, 4 days late', () => {
  const st = fixture(), p = BT.pickSections(st, APPLE, TODAY);
  assert.equal(p.best[0].x.key, 'b:uhf:2026-11-17', 'best match: ' + keys(p.best));
  const x = p.best[0].x;
  assert.equal(x.paid, true); assert.equal(x.auto, true); assert.ok(!(x.key in st.marks), 'assumed paid (before tracking started), not marked');
  assert.equal(x.past, true); assert.equal(BT.diffDays(x.due, APPLE.date), 4, '4 days late');
  // A second $1.99 bill due after the line ranks below it, under Same amount.
  const st2 = fixture(); st2.bills.push({ id: 'tv', name: 'TV app', amount: 1.99, day: 30, group: 'Apple Subscriptions', category: '' });
  const p2 = BT.pickSections(st2, APPLE, TODAY);
  assert.equal(p2.best[0].x.key, 'b:uhf:2026-11-17'); assert.ok(keys(p2.same).includes('b:tv:2026-11-30'), keys(p2.same).join());
  assert.ok(!keys(p.near).includes('b:uhf:2026-11-17'));
  const all = [...p.best, ...p.same, ...p.near, ...p.up, ...p.earlier].map(r => r.x.key);
  assert.equal(new Set(all).size, all.length, 'each item once');
});

test('picker: Earlier lists the previous two pay cycles (paid, assumed paid and unpaid) newest first; not already-linked ones', () => {
  const st = fixture({ since: '2026-10-01' });
  st.bills.push({ id: 'gym', name: 'Gym', amount: 30, day: 28, group: 'Fixed', category: '' });
  st.marks['b:icl:2026-11-20'] = true;                      // marked paid, before the bank line
  st.marks['b:uhf:2026-11-17'] = true; st.occ['b:uhf:2026-11-17'] = { paidOn: '2026-11-17' };
  st.occ['b:rent:2026-10-25'] = { txn: 'pl:rent-oct' };     // linked to another line: never offered
  const p = BT.pickSections(st, T('pl:x', '2026-11-21', 'MYSTERY', 7.5), TODAY);
  const e = keys(p.earlier);
  // Previous two cycles: Oct 22 - Nov 19. Oct 17 is older than that.
  assert.ok(e.includes('b:icl:2026-11-20') && e.includes('b:uhf:2026-11-17') && e.includes('b:gym:2026-10-28'), e.join());
  assert.ok(!e.includes('b:uhf:2026-10-17'), 'older than the previous two cycles');
  assert.ok(!e.includes('b:rent:2026-10-25') && ![...p.same, ...p.near, ...p.up].some(r => r.x.key === 'b:rent:2026-10-25'));
  const due = p.earlier.map(r => r.x.due); assert.deepEqual(due, due.slice().sort().reverse());
  // Paid items after the bank line still need "Show paid items too".
  st.marks['b:icl:2026-11-20'] = false; st.marks['b:rent:2026-11-25'] = true;
  assert.ok(!BT.pickCandidates(st, APPLE, TODAY).list.some(x => x.key === 'b:rent:2026-11-25'));
  assert.ok(BT.pickCandidates(st, APPLE, TODAY, { paid: true }).list.some(x => x.key === 'b:rent:2026-11-25'));
});

test('autopay plan payments assumed paid by date are offered as past items', () => {
  const st = fixture({ since: '2026-10-01', plans: [{ id: 'k1', provider: 'Klarna', merchant: 'Nike', amount: 27.65, total: 4, paid: 1, freq: 'biweekly', lastDate: '2026-11-02', category: 'Other' }] });
  const p = BT.pickSections(st, T('pl:k', '2026-11-19', 'KLARNA*NIKE', 27.65), TODAY);
  const x = [...p.best, ...p.same].find(r => r.x.key === 'p:k1:2')?.x;
  assert.ok(x, 'payment 2 (due Nov 16, autopay) offered: ' + keys(p.best).concat(keys(p.same)));
  assert.equal(x.paid, true); assert.equal(x.auto, true); assert.equal(x.past, true);
});

test('linking a late line to an assumed-paid bill only links it: no new spending, totals unchanged', () => {
  const st = fixture(), key = 'b:uhf:2026-11-17';
  const R = { start: '2026-11-05', end: '2026-12-03', view: 'biweekly' };
  const before = { sum: BT.summary(st, R, TODAY), bal: BT.accountBalance(st, TODAY), spends: st.spends.length, marks: clone(st.marks) };
  const prev = BT.linkPaidOcc(st, key, APPLE);
  assert.deepEqual(prev, { mark: null, occ: null });
  assert.equal(st.occ[key].txn, 'pl:apple'); assert.equal(st.occ[key].paidOn, '2026-11-21', 'paid date becomes the bank date');
  assert.ok(!('checkedOn' in st.occ[key])); assert.deepEqual(st.marks, before.marks, 'marks untouched');
  const after = BT.summary(st, R, TODAY);
  assert.equal(after.needed, before.sum.needed); assert.equal(after.paid, before.sum.paid); assert.equal(st.spends.length, before.spends);
  assert.equal(after.items.filter(x => x.key === key).length, 1, 'still one occurrence');
  assert.equal(BT.accountBalance(st, TODAY), before.bal, 'balance counts it once (as of before both dates)');
  // The linked occurrence is no longer a candidate for any other line.
  assert.ok(!BT.pickCandidates(st, T('pl:y', '2026-11-21', 'APPLE.COM/BILL', 1.99), TODAY).list.some(x => x.key === key));
});

test('balance set between the due date and the bank date: the late payment is subtracted once, not twice', () => {
  const st = fixture({ account: { balance: 3000, asOf: '2026-11-19', adj: [] } }), key = 'b:uhf:2026-11-17';
  const before = BT.accountBalance(st, TODAY);
  BT.linkPaidOcc(st, key, APPLE);
  // Assumed paid before tracking started, it really left the account on Nov 21, after the balance was set: one subtraction.
  assert.equal(BT.round2(before - BT.accountBalance(st, TODAY)), 1.99);
  assert.equal(st.spends.length, 0);
});

test('linking to a marked-paid bill keeps the paid date the user gave', () => {
  const st = fixture({ since: '2026-10-01' }), key = 'b:uhf:2026-11-17';
  st.marks[key] = true; st.occ[key] = { paidOn: '2026-11-17', checkedOn: '2026-11-17' };
  const bal = BT.accountBalance(st, TODAY);
  const prev = BT.linkPaidOcc(st, key, APPLE);
  assert.deepEqual(prev, { mark: true, occ: { paidOn: '2026-11-17', checkedOn: '2026-11-17' } });
  assert.deepEqual(st.occ[key], { paidOn: '2026-11-17', checkedOn: '2026-11-17', txn: 'pl:apple' });
  assert.equal(BT.accountBalance(st, TODAY), bal);
});

test('likelyPaid looks both ways within 4 days, so a late line matches a past-cycle unpaid bill', () => {
  const st = fixture({ since: '2026-10-01' });
  const occ = BT.occurrences(st, { start: '2026-11-05', end: '2026-11-19', view: 'biweekly' }, TODAY).find(x => x.key === 'b:uhf:2026-11-17');
  assert.equal(occ.paid, false);
  assert.equal(BT.likelyPaid(st, occ, [APPLE], TODAY)?.id, 'pl:apple');
  assert.equal(BT.likelyPaid(st, occ, [T('pl:far', '2026-11-22', 'APPLE.COM/BILL', 1.99)], TODAY), null, '5 days is too far');
});
