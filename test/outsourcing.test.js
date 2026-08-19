import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateByWeight, priceSpotPurchase, runCosting, runVsContracted,
} from '../src/domain/outsourcing.js';
import { seedCost, breakEvenGrams } from '../src/domain/seedcost.js';

const spotSchedule = {
  base_price_cents: 5500, oil_premium_cents: 150,
  moisture_discount_cents: 200, damage_discount_cents: 120, cess_bp: 50,
};

// --- allocation ------------------------------------------------------------
test('allocation always sums back to exactly the amount being split', () => {
  const cases = [
    [10000, [1, 1, 1]],
    [100, [1, 1, 1]],
    [1, [1, 1, 1]],
    [123457, [620500, 811230, 94000, 1]],
    [7, [5, 5]],
    [999999, [1]],
  ];
  for (const [total, weights] of cases) {
    const parts = allocateByWeight(total, weights);
    assert.equal(parts.reduce((a, b) => a + b, 0), total,
      `${total} across ${weights} lost or invented money`);
    assert.ok(parts.every(Number.isInteger), 'every part must be an integer');
    assert.ok(parts.every((p) => p >= 0), 'no negative parts');
  }
});

test('the three-way split that naive rounding gets wrong', () => {
  // KES 100.00 across three equal loads. 33.33 x 3 = 99.99 and a lost cent.
  const parts = allocateByWeight(10000, [1000, 1000, 1000]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 10000);
  assert.deepEqual(parts.slice().sort((a, b) => a - b), [3333, 3333, 3334]);
});

test('heavier loads carry more of the trip cost', () => {
  const parts = allocateByWeight(30000, [1000, 2000, 3000]);
  assert.deepEqual(parts, [5000, 10000, 15000]);
});

test('a run with no weight allocates nothing rather than dividing by zero', () => {
  assert.deepEqual(allocateByWeight(5000, [0, 0]), [0, 0]);
  assert.deepEqual(allocateByWeight(5000, []), []);
});

// --- spot pricing ----------------------------------------------------------
test('with no negotiation the schedule price stands and the basis says so', () => {
  const r = priceSpotPurchase(
    { netG: 1_000_000, moistureBp: 900, oilBp: 4000, foreignBp: 100, damageBp: 500 },
    spotSchedule,
  );
  assert.equal(r.referencePriceCents, 5500);
  assert.equal(r.agreedPriceCents, 5500);
  assert.equal(r.priceBasis, 'schedule');
  assert.equal(r.varianceCents, 0);
});

test('a negotiated price is used, and the variance from the grade is recorded', () => {
  const r = priceSpotPurchase(
    { netG: 1_000_000, moistureBp: 900, oilBp: 4000, foreignBp: 100,
      damageBp: 500, agreedPriceCents: 5800 },
    spotSchedule,
  );
  assert.equal(r.referencePriceCents, 5500, 'what the grade said it was worth');
  assert.equal(r.agreedPriceCents, 5800, 'what was actually agreed');
  assert.equal(r.priceBasis, 'negotiated');
  assert.equal(r.varianceCents, 300, 'KES 3.00/kg over the schedule');
  assert.equal(r.varianceValueCents, 300_000, 'KES 3,000 more than the grade justified');
  assert.equal(r.grossValueCents, 5_800_000);
});

test('agreeing exactly the schedule price is not treated as a negotiation', () => {
  const r = priceSpotPurchase(
    { netG: 500_000, moistureBp: 900, oilBp: 4000, foreignBp: 0,
      damageBp: 0, agreedPriceCents: 5500 },
    spotSchedule,
  );
  assert.equal(r.priceBasis, 'schedule');
  assert.equal(r.varianceCents, 0);
});

test('spot loads take the same foreign-matter deduction as contracted ones', () => {
  const r = priceSpotPurchase(
    { netG: 1_000_000, moistureBp: 900, oilBp: 4000, foreignBp: 500, damageBp: 500 },
    spotSchedule,
  );
  assert.equal(r.payableG, 970_000, 'FM 5% minus the 2% allowance');
});

test('no debt is ever recovered from a spot supplier', () => {
  const r = priceSpotPurchase(
    { netG: 1_000_000, moistureBp: 900, oilBp: 4000, foreignBp: 100, damageBp: 500 },
    spotSchedule,
  );
  // They took no seed, so net is simply gross less cess.
  assert.equal(r.netPayableCents, r.grossValueCents - r.cessCents);
  assert.ok(!('recoveryCents' in r));
});

test('a negative agreed price is refused', () => {
  assert.throws(() => priceSpotPurchase(
    { netG: 1000, moistureBp: 900, oilBp: 4000, foreignBp: 0, damageBp: 0,
      agreedPriceCents: -1 }, spotSchedule), RangeError);
});

// --- run costing -----------------------------------------------------------
const purchases = [
  { payableG: 1_000_000, netPayableCents: 5_500_000 },
  { payableG: 500_000, netPayableCents: 2_750_000 },
  { payableG: 500_000, netPayableCents: 2_750_000 },
];
const costs = [
  { kind: 'transport', amountCents: 800_000 },
  { kind: 'labour', amountCents: 200_000 },
  { kind: 'field_food', amountCents: 60_000 },
  { kind: 'housing_allowance', amountCents: 140_000 },
];

test('landed cost is grain plus every real cost of the trip', () => {
  const r = runCosting(purchases, costs);
  assert.equal(r.purchaseCents, 11_000_000);
  assert.equal(r.overheadCents, 1_200_000);
  assert.equal(r.landedCents, 12_200_000);
  assert.equal(r.payableG, 2_000_000);
});

test('overhead per tonne is the number the grain price alone hides', () => {
  const r = runCosting(purchases, costs);
  // 2 tonnes collected, KES 12,000 of trip cost -> KES 6,000/tonne
  assert.equal(r.grainPerTonneCents, 5_500_000);
  assert.equal(r.overheadPerTonneCents, 600_000);
  assert.equal(r.landedPerTonneCents, 6_100_000);
  assert.equal(r.overheadBp, 1091, 'overhead is 10.91% on top of the grain');
});

test('every load carries its share and the shares add up to the overhead', () => {
  const r = runCosting(purchases, costs);
  assert.equal(r.allocation.reduce((a, b) => a + b, 0), r.overheadCents);
  assert.equal(r.perLoad[0].allocatedCostCents, 600_000, 'half the weight, half the cost');
  assert.equal(r.perLoad[1].allocatedCostCents, 300_000);
  assert.equal(r.perLoad[2].allocatedCostCents, 300_000);
  for (const l of r.perLoad) {
    assert.equal(l.landedCents, l.netPayableCents + l.allocatedCostCents);
  }
});

test('a run with costs but no loads does not explode or divide by zero', () => {
  const r = runCosting([], costs);
  assert.equal(r.payableG, 0);
  assert.equal(r.landedPerTonneCents, 0);
  assert.equal(r.overheadCents, 1_200_000);
  assert.equal(r.loads, 0);
});

test('a run with loads but no costs is just the grain', () => {
  const r = runCosting(purchases, []);
  assert.equal(r.overheadCents, 0);
  assert.equal(r.landedCents, r.purchaseCents);
  assert.equal(r.landedPerTonneCents, r.grainPerTonneCents);
});

test('costs are grouped by kind for the owner to read', () => {
  const r = runCosting(purchases, [...costs, { kind: 'transport', amountCents: 50_000 }]);
  const transport = r.byKind.find((k) => k.kind === 'transport');
  assert.equal(transport.amountCents, 850_000, 'two transport lines added together');
  assert.ok(!r.byKind.some((k) => k.amountCents === 0), 'empty categories are not shown');
});

test('was the trip worth it, against what contracted grain actually cost', () => {
  const r = runCosting(purchases, costs);
  // The baseline is contracted LANDED cost per tonne, not the headline base
  // price — contracted grain earns oil premiums too, so the base price would
  // flatter the run.
  const v = runVsContracted(r, 5_800_000); // KES 58,000.00 per tonne
  assert.equal(v.budgetCents, 11_600_000, '2 tonnes at KES 58,000/t');
  assert.equal(v.differenceCents, 11_600_000 - 12_200_000);
  assert.ok(v.differenceCents < 0, 'this run cost MORE than contracted grain');
  assert.equal(v.differencePerTonneCents, 5_800_000 - r.landedPerTonneCents);
});

test('a cheap trip on a decent tonnage genuinely beats contracted grain', () => {
  const r = runCosting(
    [{ payableG: 2_400_000, netPayableCents: 12_480_000 }],   // 2.4t at KES 52/kg
    [{ kind: 'transport', amountCents: 450_000 },
     { kind: 'labour', amountCents: 120_000 }],
  );
  const v = runVsContracted(r, 5_663_629);                    // contracted actual
  assert.ok(v.differenceCents > 0, 'this run saved money');
  assert.ok(r.landedPerTonneCents < 5_663_629);
});

test('all run figures are integers', () => {
  const r = runCosting(purchases, costs);
  for (const k of ['purchaseCents', 'overheadCents', 'landedCents',
                   'grainPerTonneCents', 'overheadPerTonneCents', 'landedPerTonneCents']) {
    assert.ok(Number.isInteger(r[k]), `${k} is not an integer`);
  }
});

// --- seed cost calculator --------------------------------------------------
test('seed cost for a plot at a given rate', () => {
  // 2.5 acres at 4 kg/acre = 10 kg; at KES 320/kg = KES 3,200
  const r = seedCost({ acreageBp: 25_000, gPerAcre: 4000, unitCostCents: 32_000 });
  assert.equal(r.qtyG, 10_000);
  assert.equal(r.valueCents, 320_000);
});

test('seed cost scales and stays integer on awkward plot sizes', () => {
  const r = seedCost({ acreageBp: 7_777, gPerAcre: 4000, unitCostCents: 32_000 });
  assert.ok(Number.isInteger(r.qtyG));
  assert.ok(Number.isInteger(r.valueCents));
  assert.equal(r.qtyG, 3111);
});

test('a zero-acre plot costs nothing rather than erroring', () => {
  const r = seedCost({ acreageBp: 0, gPerAcre: 4000, unitCostCents: 32_000 });
  assert.equal(r.qtyG, 0);
  assert.equal(r.valueCents, 0);
});

test('break-even tells the farmer how much grain clears the seed debt', () => {
  // KES 3,200 of seed at KES 58.00/kg -> about 55.172 kg
  assert.equal(breakEvenGrams({ valueCents: 320_000, expectedPriceCents: 5800 }), 55_172);
  assert.equal(breakEvenGrams({ valueCents: 320_000, expectedPriceCents: 0 }), 0);
});

test('the calculator refuses nonsense rather than returning NaN', () => {
  assert.throws(() => seedCost({ acreageBp: 1.5, gPerAcre: 4000, unitCostCents: 100 }), TypeError);
  assert.throws(() => seedCost({ acreageBp: -1, gPerAcre: 4000, unitCostCents: 100 }), RangeError);
});
