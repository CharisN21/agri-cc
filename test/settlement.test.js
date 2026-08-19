import test from 'node:test';
import assert from 'node:assert/strict';
import { settle } from '../src/domain/settlement.js';

const base = {
  cessBp: 50,              // 0.50% county cess
  recoveryShareBp: 5000,   // half of one delivery
  cashFloorCents: 200_000, // KES 2,000.00
};

test('net = gross - cess - recovery, for a wide range of values', () => {
  for (let gross = 0; gross <= 5_000_000; gross += 37_119) {
    for (const owed of [0, 1_000, 250_000, 9_000_000]) {
      const r = settle({ ...base, grossValueCents: gross, owedCents: owed });
      assert.equal(
        r.netPayableCents,
        gross - r.cessCents - r.recoveryCents,
        `gross=${gross} owed=${owed}`,
      );
    }
  }
});

test('net payable is never negative, however large the debt', () => {
  for (let gross = 0; gross <= 1_000_000; gross += 8_191) {
    const r = settle({ ...base, grossValueCents: gross, owedCents: 999_999_999 });
    assert.ok(r.netPayableCents >= 0, `gross=${gross} produced ${r.netPayableCents}`);
    assert.ok(r.recoveryCents >= 0);
  }
});

test('cap 1 — the contractual share: a big debt takes only half of one delivery', () => {
  // gross 100,000.00; cess 500.00; owed far more than the share allows
  const r = settle({ ...base, grossValueCents: 10_000_000, owedCents: 90_000_000 });
  assert.equal(r.recoveryCap, 'share');
  assert.equal(r.recoveryCents, 5_000_000);          // 50% of gross
  assert.equal(r.cessCents, 50_000);                 // 0.50% of gross
  assert.equal(r.netPayableCents, 10_000_000 - 50_000 - 5_000_000);
});

test('cap 2 — what is owed: we never recover more than the debt', () => {
  const r = settle({ ...base, grossValueCents: 10_000_000, owedCents: 120_000 });
  assert.equal(r.recoveryCap, 'owed');
  assert.equal(r.recoveryCents, 120_000);
});

test('cap 3 — the cash floor: the farmer still goes home with the floor', () => {
  // gross 300,000 (KES 3,000). Cess 1,500 -> 298,500 after cess.
  // Share cap would take 150,000, leaving 148,500 — below the 200,000 floor.
  const r = settle({ ...base, grossValueCents: 300_000, owedCents: 5_000_000 });
  assert.equal(r.recoveryCap, 'cash_floor');
  assert.equal(r.recoveryCents, 98_500);
  assert.equal(r.netPayableCents, 200_000, 'farmer takes home exactly the floor');
});

test('a load too small to carry the floor recovers nothing and is still paid', () => {
  // gross 150,000 (KES 1,500) is under the floor before any recovery at all.
  const r = settle({ ...base, grossValueCents: 150_000, owedCents: 5_000_000 });
  assert.equal(r.recoveryCents, 0);
  assert.equal(r.recoveryCap, 'cash_floor');
  assert.equal(r.netPayableCents, 150_000 - r.cessCents);
  assert.ok(r.netPayableCents > 0, 'the farmer is still paid');
  assert.match(r.capExplanation, /too small/);
});

test('no debt means no recovery and the cap is reported as none', () => {
  const r = settle({ ...base, grossValueCents: 10_000_000, owedCents: 0 });
  assert.equal(r.recoveryCents, 0);
  assert.equal(r.recoveryCap, 'none');
  assert.equal(r.netPayableCents, 10_000_000 - 50_000);
});

test('recovery never exceeds any of the three caps, exhaustively', () => {
  for (let gross = 0; gross <= 2_000_000; gross += 13_337) {
    for (const owed of [0, 50_000, 500_000, 5_000_000]) {
      const r = settle({ ...base, grossValueCents: gross, owedCents: owed });
      assert.ok(r.recoveryCents <= r.caps.shareCap, 'share cap breached');
      assert.ok(r.recoveryCents <= r.caps.owedCap, 'owed cap breached');
      assert.ok(r.recoveryCents <= r.caps.floorCap, 'floor cap breached');
    }
  }
});

test('the reported cap is the one that actually bound', () => {
  const r = settle({ ...base, grossValueCents: 10_000_000, owedCents: 90_000_000 });
  assert.equal(r.recoveryCents, r.caps[`${r.recoveryCap}Cap`.replace('cash_floorCap', 'floorCap')]);
});

test('every figure returned is an integer', () => {
  const r = settle({ ...base, grossValueCents: 1_234_567, owedCents: 987_654 });
  for (const k of ['cessCents', 'recoveryCents', 'netPayableCents']) {
    assert.ok(Number.isInteger(r[k]), `${k} is not an integer`);
  }
});

test('negative or fractional input is refused rather than absorbed', () => {
  assert.throws(() => settle({ ...base, grossValueCents: -1, owedCents: 0 }), RangeError);
  assert.throws(() => settle({ ...base, grossValueCents: 1.5, owedCents: 0 }), TypeError);
});

test('the settlement shows its working as a readable set of lines', () => {
  const r = settle({ ...base, grossValueCents: 10_000_000, owedCents: 120_000 });
  const total = r.lines.filter((l) => !l.total).reduce((s, l) => s + l.value, 0);
  assert.equal(total, r.netPayableCents, 'the lines add up to the answer');
});
