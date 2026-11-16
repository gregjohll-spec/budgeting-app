// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonth, iso, parseDate, nextPayDate, upcomingPaydays, remainingFor,
  statusOf, setAsidePlan, suggestSplit, leftToSpend, nextUp, addDays,
} from '../budget.js';

const today = new Date(2026, 10, 10); // Nov 10, 2026
const off = n => iso(addDays(today, n));

function sample() {
  return {
    sources: [
      { id: 's1', name: 'Pay A', freq: 'biweekly', amount: 1000, next_date: off(3), limit_kind: null },
      { id: 's2', name: 'Pay B', freq: 'weekly', amount: 400, next_date: off(1), limit_kind: null },
      { id: 's3', name: 'FoodShare', freq: 'monthly', amount: 290, next_date: off(5), limit_kind: 'food' },
    ],
    priorities: [
      { id: 'rent', name: 'Rent', needed: 1200, due_date: off(15), kind: 'housing', sort_order: 0, paid: false },
      { id: 'elec', name: 'Electric', needed: 100, due_date: off(2), kind: 'other', sort_order: 1, paid: false },
      { id: 'food', name: 'Groceries', needed: 600, due_date: null, kind: 'food', sort_order: 2, paid: false },
    ],
    deposits: [
      { id: 'd1', amount: 500, alloc: { rent: 300, food: 100 } },
    ],
  };
}

test('addMonth keeps the day and clamps to the end of short months', () => {
  assert.equal(iso(addMonth(new Date(2026, 0, 31))), '2026-02-28');
  assert.equal(iso(addMonth(new Date(2026, 11, 15))), '2027-01-15');
});

test('nextPayDate rolls a past date forward', () => {
  const s = { freq: 'biweekly', next_date: '2026-10-30' };
  assert.equal(iso(nextPayDate(s, today)), '2026-11-13');
  assert.equal(iso(nextPayDate({ freq: 'monthly', next_date: '2026-10-10' }, today)), '2026-11-10');
});

test('upcomingPaydays counts regular paychecks only, after today', () => {
  const pays = upcomingPaydays(sample().sources, today, parseDate(off(15)));
  // Pay A: day 3; Pay B: days 1, 8, 15. FoodShare is limited, so skipped.
  assert.deepEqual(pays.map(p => iso(p.date)), [off(1), off(3), off(8), off(15)]);
});

test('remaining, status and left to spend', () => {
  const d = sample();
  assert.equal(remainingFor(d.priorities[0], d.deposits), 900);
  assert.equal(statusOf(d.priorities[1], d.deposits, today), 'heads-up');
  assert.equal(statusOf(d.priorities[0], d.deposits, today), 'on-track');
  assert.equal(statusOf({ ...d.priorities[0], paid: true }, d.deposits, today), 'paid');
  assert.equal(leftToSpend(d.deposits), 100);
});

test('setAsidePlan spreads what is left over the paychecks before the due date', () => {
  const d = sample();
  const plan = setAsidePlan(d.priorities[0], d, today);
  assert.equal(plan.count, 4);
  assert.equal(plan.each, 225); // 900 / 4
});

test('limited money only goes to matching priorities', () => {
  const d = sample();
  const alloc = suggestSplit(290, 'food', d, today);
  assert.deepEqual(alloc, { food: 290 });
});

test('regular money: bill due within 3 days is filled first, nothing is over-assigned', () => {
  const d = sample();
  const alloc = suggestSplit(400, null, d, today);
  assert.equal(alloc.elec, 100);
  const total = Object.values(alloc).reduce((a, b) => a + b, 0);
  assert.ok(total <= 400);
  for (const p of d.priorities) assert.ok((alloc[p.id] || 0) <= remainingFor(p, d.deposits));
});

test('a big deposit covers everything still needed and leaves the rest free', () => {
  const d = sample();
  const alloc = suggestSplit(5000, null, d, today);
  assert.deepEqual(alloc, { rent: 900, elec: 100, food: 500 });
});

test('nextUp picks the soonest due unpaid priority', () => {
  assert.equal(nextUp(sample(), today).id, 'elec');
});

test('leftByKind keeps FoodShare leftovers out of free money', async () => {
  const { leftByKind } = await import('../budget.js');
  const d = sample();
  d.deposits.push({ id: 'd2', source_id: 's3', amount: 290, alloc: { food: 200 } });
  assert.deepEqual(leftByKind(d.deposits, d.sources), { any: 100, food: 90, housing: 0 });
});
