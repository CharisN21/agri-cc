import test from 'node:test';
import assert from 'node:assert/strict';
import { payableGrams, unitPrice, grossValue, priceDelivery } from '../src/domain/pricing.js';

// The spec defaults, as they are stored in price_schedule.
const schedule = {
  base_price_cents: 5800,          // KES 58.00
  oil_premium_cents: 150,          // KES 1.50 per point
  moisture_discount_cents: 200,    // KES 2.00 per point
  damage_discount_cents: 120,      // KES 1.20 per point
};

test('foreign matter up to 2.00% costs the farmer nothing', () => {
  for (const foreignBp of [0, 100, 200]) {
    const r = payableGrams({ netG: 1_000_000, foreignBp });
    assert.equal(r.payableG, 1_000_000, `FM ${foreignBp}bp should not deduct`);
    assert.equal(r.deductionG, 0);
  }
});

test('foreign matter above 2.00% deducts only the excess', () => {
  // FM 5.00% -> excess 3.00% -> pay for 97% of 1000kg = 970kg
  const r = payableGrams({ netG: 1_000_000, foreignBp: 500 });
  assert.equal(r.excessBp, 300);
  assert.equal(r.payableG, 970_000);
  assert.equal(r.deductionG, 30_000);
});

test('payable weight is never more than net weight', () => {
  for (const foreignBp of [0, 199, 200, 201, 1000]) {
    const r = payableGrams({ netG: 623_450, foreignBp });
    assert.ok(r.payableG <= 623_450);
    assert.ok(r.payableG >= 0);
    assert.ok(Number.isInteger(r.payableG));
  }
});

test('unit price at the reference point is exactly the base price', () => {
  // oil 40.00%, moisture 9.00%, damage 5.00% -> no adjustment at all
  const p = unitPrice({ oilBp: 4000, moistureBp: 900, damageBp: 500 }, schedule);
  assert.equal(p.cents, 5800);
  assert.equal(p.oilAdj, 0);
  assert.equal(p.moistureAdj, 0);
  assert.equal(p.damageAdj, 0);
});

test('oil above the reference pays a premium, below it pays a penalty', () => {
  // +2.00 points x KES 1.50 = +KES 3.00
  assert.equal(unitPrice({ oilBp: 4200, moistureBp: 900, damageBp: 500 }, schedule).cents, 6100);
  // -2.00 points x KES 1.50 = -KES 3.00
  assert.equal(unitPrice({ oilBp: 3800, moistureBp: 900, damageBp: 500 }, schedule).cents, 5500);
});

test('moisture and damage discounts apply only above their free allowances', () => {
  // moisture 12.00% -> 3 points x KES 2.00 = -KES 6.00
  assert.equal(unitPrice({ oilBp: 4000, moistureBp: 1200, damageBp: 500 }, schedule).cents, 5200);
  // damage 10.00% -> 5 points x KES 1.20 = -KES 6.00
  assert.equal(unitPrice({ oilBp: 4000, moistureBp: 900, damageBp: 1000 }, schedule).cents, 5200);
  // at the allowance exactly, nothing is deducted
  assert.equal(unitPrice({ oilBp: 4000, moistureBp: 900, damageBp: 500 }, schedule).cents, 5800);
});

test('unit price floors at zero and never goes negative', () => {
  const brutal = { base_price_cents: 100, oil_premium_cents: 150,
                   moisture_discount_cents: 5000, damage_discount_cents: 5000 };
  const p = unitPrice({ oilBp: 1000, moistureBp: 1400, damageBp: 1000 }, brutal);
  assert.equal(p.cents, 0);
  assert.ok(p.raw < 0, 'the raw arithmetic really did go negative');
  assert.ok(p.lines.some((l) => l.note), 'the working shows that it was floored');
});

test('adjustments are integers, never floats', () => {
  // 41.37% oil is 1.37 points above reference; 1.37 x 150 = 205.5 -> 206
  const p = unitPrice({ oilBp: 4137, moistureBp: 900, damageBp: 500 }, schedule);
  assert.ok(Number.isInteger(p.oilAdj));
  assert.equal(p.oilAdj, 206);
  assert.equal(p.cents, 6006);
});

test('gross value converts grams against a per-kilogram price', () => {
  // 1000.000 kg at KES 58.00 = KES 58,000.00
  assert.equal(grossValue({ payableG: 1_000_000, unitPriceCents: 5800 }), 5_800_000);
  // 0.5 kg at KES 58.00 = KES 29.00
  assert.equal(grossValue({ payableG: 500, unitPriceCents: 5800 }), 2900);
});

test('a full pricing run reports every line of its working', () => {
  const r = priceDelivery(
    { netG: 620_500, moistureBp: 1050, oilBp: 4250, foreignBp: 350, damageBp: 600 },
    schedule,
  );
  // FM 3.50% -> 1.50% excess -> payable 620.500 x 0.985
  assert.equal(r.payableG, 611_193);
  // base 5800 + oil (2.5pt x 150 = 375) - moisture (1.5pt x 200 = 300) - damage (1pt x 120 = 120)
  assert.equal(r.unitPriceCents, 5800 + 375 - 300 - 120);
  assert.equal(r.grossValueCents, Math.round(611_193 * 5755 / 1000));

  // The working is complete enough to re-derive the answer by hand.
  assert.ok(r.weightLines.length >= 3);
  assert.ok(r.priceLines.length >= 5);
  assert.ok(r.valueLines.some((l) => l.total));
});

test('pricing is reproducible: the same inputs always give the same money', () => {
  const args = [{ netG: 812_345, moistureBp: 1137, oilBp: 4013, foreignBp: 271, damageBp: 733 }, schedule];
  const a = priceDelivery(...args);
  const b = priceDelivery(...args);
  assert.deepEqual(a, b);
});
