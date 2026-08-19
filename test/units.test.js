import test from 'node:test';
import assert from 'node:assert/strict';
import {
  divRound, applyBp, toCents, fromCents, toGrams, fromGrams, toBp, fromBp, money, kg,
} from '../src/domain/units.js';

test('money round-trips through cents without floating point', () => {
  assert.equal(toCents('58.40'), 5840);
  assert.equal(toCents('0.01'), 1);
  assert.equal(toCents('1000'), 100000);
  assert.equal(fromCents(5840), '58.40');
  assert.equal(fromCents(1), '0.01');
  assert.equal(fromCents(0), '0.00');
});

test('the classic float trap does not bite', () => {
  // 0.1 + 0.2 !== 0.3 in floating point. In cents it is exact.
  assert.equal(toCents('0.10') + toCents('0.20'), toCents('0.30'));
});

test('weight round-trips through grams', () => {
  assert.equal(toGrams('620.5'), 620500);
  assert.equal(toGrams('1'), 1000);
  assert.equal(fromGrams(620500), '620.500');
});

test('percentages round-trip through basis points', () => {
  assert.equal(toBp('41.20'), 4120);
  assert.equal(toBp('9'), 900);
  assert.equal(fromBp(4120), '41.20');
});

test('divRound rounds half away from zero, in both directions', () => {
  assert.equal(divRound(5, 2), 3);
  assert.equal(divRound(-5, 2), -3);
  assert.equal(divRound(4, 2), 2);
  assert.equal(divRound(1, 3), 0);
  assert.equal(divRound(2, 3), 1);
});

test('divRound refuses non-integers rather than producing a float answer', () => {
  assert.throws(() => divRound(1.5, 2), TypeError);
  assert.throws(() => divRound(3, 0), RangeError);
});

test('applyBp computes a basis-point share as an integer', () => {
  assert.equal(applyBp(100000, 50), 500);      // 0.50% of KES 1,000.00
  assert.equal(applyBp(1, 5000), 1);           // half a cent rounds up to one
  assert.equal(applyBp(0, 5000), 0);
});

test('bad input is refused, not coerced to NaN', () => {
  assert.throws(() => toCents('abc'), RangeError);
  assert.throws(() => toCents(''), RangeError);
  assert.throws(() => toCents('1.2.3'), RangeError);
});

test('excess decimal places round rather than truncate', () => {
  assert.equal(toCents('1.005'), 101);
  assert.equal(toCents('1.004'), 100);
});

test('display helpers group thousands and keep the scale fixed', () => {
  assert.equal(money(123456789), '1,234,567.89');
  assert.equal(money(-5000), '-50.00');
  assert.equal(kg(1234567), '1,234.567');
});
