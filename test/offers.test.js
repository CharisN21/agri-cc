import test from 'node:test';
import assert from 'node:assert/strict';
import { rankOffers, offerGrainCost, targetProgress, budgetPosition } from '../src/domain/offers.js';

const o = (id, kg, pricePerKg) => ({
  id, code: `OFR-${id}`, offeredG: kg * 1000, askingPriceCents: pricePerKg * 100,
});

test('grain cost is quantity times price, in integer cents', () => {
  assert.equal(offerGrainCost({ offeredG: 1_000_000, askingPriceCents: 5200 }), 5_200_000);
  assert.equal(offerGrainCost({ offeredG: 300_000, askingPriceCents: 5000 }), 1_500_000);
});

// --- the point of the whole file ------------------------------------------
test('the cheapest price per kg is NOT always the cheapest buy', () => {
  // Trip costs KES 12,000 whatever happens.
  //   A: 300 kg at KES 50  -> grain 15,000 + trip 12,000 = 27,000 for 0.3 t
  //                        -> KES 90,000 a tonne
  //   B: 2000 kg at KES 54 -> grain 108,000 + trip 12,000 = 120,000 for 2 t
  //                        -> KES 60,000 a tonne
  const r = rankOffers([o(1, 300, 50), o(2, 2000, 54)], 1_200_000);

  assert.equal(r.cheapestPerKg.id, 1, 'A asks least per kilogram');
  assert.equal(r.bestAlone.id, 2, 'but B is the cheaper buy');
  assert.equal(r.cheapestIsNotBest, true, 'and the screen should say so');

  const a = r.offers.find((x) => x.id === 1);
  const b = r.offers.find((x) => x.id === 2);
  assert.equal(a.aloneLandedPerTonneCents, 9_000_000);
  assert.equal(b.aloneLandedPerTonneCents, 6_000_000);
});

test('when quantities are equal, the cheaper price does win', () => {
  const r = rankOffers([o(1, 1000, 55), o(2, 1000, 50)], 500_000);
  assert.equal(r.cheapestPerKg.id, 2);
  assert.equal(r.bestAlone.id, 2);
  assert.equal(r.cheapestIsNotBest, false);
});

test('filling the vehicle drives the trip cost per tonne down', () => {
  const r = rankOffers([o(1, 500, 50), o(2, 500, 52), o(3, 1000, 54)], 1_200_000);
  const [first, second, third] = r.offers;
  assert.ok(first.cumulativeTripPerTonneCents > second.cumulativeTripPerTonneCents);
  assert.ok(second.cumulativeTripPerTonneCents > third.cumulativeTripPerTonneCents);
  assert.equal(third.cumulativeG, 2_000_000, 'two tonnes on board by the end');
});

test('offers are ranked cheapest grain first', () => {
  const r = rankOffers([o(1, 100, 60), o(2, 100, 50), o(3, 100, 55)], 100_000);
  assert.deepEqual(r.offers.map((x) => x.id), [2, 3, 1]);
  assert.deepEqual(r.offers.map((x) => x.rank), [1, 2, 3]);
});

test('the best stopping point is where landed cost per tonne bottoms out', () => {
  // Three cheap tonnes, then a very expensive small one that would drag the
  // average back up. Stop before it.
  const r = rankOffers([o(1, 1000, 50), o(2, 1000, 51), o(3, 100, 200)], 1_000_000);
  assert.equal(r.bestStop.id, 2, 'take the first two, leave the dear one');
  const third = r.offers.find((x) => x.id === 3);
  assert.ok(third.cumulativeLandedPerTonneCents > r.bestStop.cumulativeLandedPerTonneCents);
});

test('grain already on the vehicle spreads the trip cost thinner', () => {
  const empty = rankOffers([o(1, 500, 50)], 1_200_000);
  const loaded = rankOffers([o(1, 500, 50)], 1_200_000,
    { boughtG: 1_500_000, boughtCents: 7_500_000 }); // 1.5 t already, at KES 50/kg

  assert.ok(
    loaded.offers[0].aloneTripPerTonneCents < empty.offers[0].aloneTripPerTonneCents,
    'the trip cost is carried by more tonnes, so it hurts less per tonne',
  );
  assert.equal(empty.offers[0].aloneTripPerTonneCents, 2_400_000, 'KES 24,000/t on half a tonne');
  assert.equal(loaded.offers[0].aloneTripPerTonneCents, 600_000, 'KES 6,000/t on two tonnes');
});

test('the cost of grain already on board is counted, not silently ignored', () => {
  // 1.5 t already bought at KES 50/kg = KES 75,000, plus 500 kg at KES 50 =
  // KES 25,000, plus a KES 12,000 trip = KES 112,000 over 2 tonnes.
  const r = rankOffers([o(1, 500, 50)], 1_200_000,
    { boughtG: 1_500_000, boughtCents: 7_500_000 });
  assert.equal(r.offers[0].aloneLandedCents, 11_200_000);
  assert.equal(r.offers[0].aloneLandedPerTonneCents, 5_600_000, 'KES 56,000 a tonne');

  // Dividing by the loaded weight while ignoring its cost would have produced a
  // far lower and completely false figure.
  const wrong = (2_500_000 + 1_200_000) * 1_000_000 / 2_000_000;
  assert.notEqual(r.offers[0].aloneLandedPerTonneCents, wrong);
});

test('a free trip makes landed cost equal to grain cost', () => {
  const r = rankOffers([o(1, 1000, 50)], 0);
  assert.equal(r.offers[0].aloneLandedPerTonneCents, r.offers[0].grainPerTonneCents);
  assert.equal(r.offers[0].aloneTripPerTonneCents, 0);
});

test('no offers is not an error', () => {
  const r = rankOffers([], 1_200_000);
  assert.deepEqual(r.offers, []);
  assert.equal(r.bestStop, null);
  assert.equal(r.cheapestPerKg, null);
  assert.equal(r.cheapestIsNotBest, false);
});

test('every figure returned is an integer', () => {
  const r = rankOffers([o(1, 337, 53), o(2, 811, 49)], 733_100);
  for (const x of r.offers) {
    for (const k of ['grainCents', 'aloneLandedCents', 'aloneLandedPerTonneCents',
                     'cumulativeLandedPerTonneCents', 'cumulativeTripPerTonneCents']) {
      assert.ok(Number.isInteger(x[k]), `${k} is not an integer`);
    }
  }
});

test('a negative trip cost is refused', () => {
  assert.throws(() => rankOffers([], -1), RangeError);
});

// --- target progress -------------------------------------------------------
test('progress against the tonnage the trip set out to collect', () => {
  const p = targetProgress({ targetG: 3_000_000, boughtG: 1_200_000, offeredG: 1_000_000 });
  assert.equal(p.remainingG, 1_800_000);
  assert.equal(p.achievedBp, 4000, '40.00%');
  assert.equal(p.coverableBp, 7333, 'offers on the table would reach 73.33%');
  assert.equal(p.shortfallAfterOffersG, 800_000, 'still short even if all are taken');
  assert.equal(p.met, false);
});

test('a met target reports met, and never a negative remainder', () => {
  const p = targetProgress({ targetG: 1_000_000, boughtG: 1_400_000 });
  assert.equal(p.met, true);
  assert.equal(p.remainingG, 0);
  assert.equal(p.achievedBp, 14000);
});

test('a run with no target does not divide by zero', () => {
  const p = targetProgress({ targetG: 0, boughtG: 500_000 });
  assert.equal(p.achievedBp, 0);
  assert.equal(p.met, false);
});

// --- budget ----------------------------------------------------------------
test('spending less than projected is a saving', () => {
  const b = budgetPosition({ projectedCents: 1_200_000, actualCents: 900_000 });
  assert.equal(b.state, 'under');
  assert.equal(b.savedBy, 300_000);
  assert.equal(b.overBy, 0);
  assert.equal(b.usedBp, 7500);
});

test('spending more than projected is an overrun', () => {
  const b = budgetPosition({ projectedCents: 1_200_000, actualCents: 1_500_000 });
  assert.equal(b.state, 'over');
  assert.equal(b.overBy, 300_000);
  assert.equal(b.savedBy, 0);
});

test('an approved supplementary raises what was allowed, and can clear the overrun', () => {
  const before = budgetPosition({ projectedCents: 1_200_000, actualCents: 1_500_000 });
  assert.equal(before.state, 'over');

  const after = budgetPosition({
    projectedCents: 1_200_000, actualCents: 1_500_000, approvedSupplementaryCents: 300_000,
  });
  assert.equal(after.allowedCents, 1_500_000);
  assert.equal(after.state, 'on budget');
  assert.equal(after.overBy, 0);
});

test('a run with no budget set reports no false overrun', () => {
  const b = budgetPosition({ projectedCents: 0, actualCents: 0 });
  assert.equal(b.state, 'on budget');
  assert.equal(b.usedBp, 0);
});
