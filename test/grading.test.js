import test from 'node:test';
import assert from 'node:assert/strict';
import { grade, gradeReason } from '../src/domain/grading.js';

// A load that would otherwise be grade A, so each test varies one axis only.
const cleanA = { moistureBp: 900, oilBp: 4200, foreignBp: 100, damageBp: 0 };

test('grade A needs oil at or above 41.00% AND moisture at or below 10.00%', () => {
  assert.equal(grade(cleanA), 'A');
  assert.equal(grade({ ...cleanA, oilBp: 4100, moistureBp: 1000 }), 'A', 'both exactly on the line');
});

test('moisture boundary: 14.00% passes, 14.01% rejects', () => {
  assert.notEqual(grade({ ...cleanA, moistureBp: 1400 }), 'REJECT');
  assert.equal(grade({ ...cleanA, moistureBp: 1401 }), 'REJECT');
});

test('foreign matter boundary: 10.00% passes, 10.01% rejects', () => {
  assert.notEqual(grade({ ...cleanA, foreignBp: 1000 }), 'REJECT');
  assert.equal(grade({ ...cleanA, foreignBp: 1001 }), 'REJECT');
});

test('oil boundary for A: 40.99% is not A, 41.00% is', () => {
  assert.notEqual(grade({ ...cleanA, oilBp: 4099 }), 'A');
  assert.equal(grade({ ...cleanA, oilBp: 4100 }), 'A');
});

test('moisture boundary for A: 10.00% is A, 10.01% drops to B', () => {
  assert.equal(grade({ ...cleanA, oilBp: 4100, moistureBp: 1000 }), 'A');
  assert.equal(grade({ ...cleanA, oilBp: 4100, moistureBp: 1001 }), 'B',
    'oil still qualifies for A but moisture disqualifies it');
});

test('oil boundary for B: 37.99% is C, 38.00% is B', () => {
  assert.equal(grade({ ...cleanA, oilBp: 3799 }), 'C');
  assert.equal(grade({ ...cleanA, oilBp: 3800 }), 'B');
});

test('reject beats every other rule', () => {
  // Oil high enough for A, but the load is too wet to buy at all.
  assert.equal(grade({ moistureBp: 1500, oilBp: 4500, foreignBp: 0 }), 'REJECT');
  // Oil high enough for A, but far too dirty.
  assert.equal(grade({ moistureBp: 500, oilBp: 4500, foreignBp: 2000 }), 'REJECT');
});

test('grade is exhaustive: nothing falls through to undefined', () => {
  for (let moistureBp = 0; moistureBp <= 2000; moistureBp += 97) {
    for (let oilBp = 3000; oilBp <= 5000; oilBp += 89) {
      for (const foreignBp of [0, 200, 999, 1000, 1001, 3000]) {
        const g = grade({ moistureBp, oilBp, foreignBp });
        assert.ok(['A', 'B', 'C', 'REJECT'].includes(g), `unexpected grade ${g}`);
      }
    }
  }
});

test('non-integer readings are refused rather than silently truncated', () => {
  assert.throws(() => grade({ moistureBp: 14.5, oilBp: 4200, foreignBp: 0 }), TypeError);
});

test('every grade carries a reason a field officer can read out', () => {
  assert.match(gradeReason({ ...cleanA, moistureBp: 1500 }), /moisture above 14\.00%/);
  assert.match(gradeReason({ ...cleanA, foreignBp: 1500 }), /foreign matter above 10\.00%/);
  assert.match(gradeReason({ ...cleanA, oilBp: 4100, moistureBp: 1200 }), /moisture is above 10\.00%/);
  assert.match(gradeReason({ ...cleanA, oilBp: 3000 }), /below 38\.00%/);
});
