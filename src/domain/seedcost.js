// Seed cost calculator. Pure.
//
// Used by the owner to plan a season and by a field officer standing in front
// of a farmer working out what the seed for their plot will cost. Both need the
// same answer, so both call this.
//
// The seeding rate is data (the `seeding_rate` table), not a constant in code,
// because it is an agronomic assumption the owner should be able to change
// without a developer.
import { divRound } from './units.js';

/**
 * @param {object} a
 * @param {number} a.acreageBp     plot size, acres x 10000
 * @param {number} a.gPerAcre      seeding rate in grams per acre
 * @param {number} a.unitCostCents what a kilogram of this seed cost us
 */
export function seedCost({ acreageBp, gPerAcre, unitCostCents }) {
  for (const [name, v] of Object.entries({ acreageBp, gPerAcre, unitCostCents })) {
    if (!Number.isInteger(v)) throw new TypeError(`${name} must be an integer`);
    if (v < 0) throw new RangeError(`${name} must not be negative`);
  }
  const qtyG = divRound(acreageBp * gPerAcre, 10000);
  const valueCents = divRound(qtyG * unitCostCents, 1000);
  return {
    qtyG,
    valueCents,
    lines: [
      { label: 'Plot size', kind: 'acres', value: acreageBp },
      { label: 'Seeding rate', kind: 'rate', value: gPerAcre },
      { label: 'Seed required', kind: 'weight', value: qtyG, total: false },
      { label: 'Cost per kg', kind: 'money', value: unitCostCents },
      { label: 'Cost of seed', kind: 'money', value: valueCents, total: true },
    ],
  };
}

/**
 * What that seed debt means at harvest: how many kilograms of grain the farmer
 * must deliver just to clear it. Field officers get asked this constantly and
 * guessing at it is how farmers end up feeling cheated.
 */
export function breakEvenGrams({ valueCents, expectedPriceCents }) {
  if (expectedPriceCents <= 0) return 0;
  return divRound(valueCents * 1000, expectedPriceCents);
}
