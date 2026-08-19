// Pricing. Pure: physical facts plus a price schedule version in, money out.
//
//   payable_kg  = net_kg x (1 - max(0, FM% - 2.00%))
//   unit_price  = base_price
//               + (oil% - 40.00%)             x oil premium per point
//               - max(0, moisture% - 9.00%)   x moisture discount per point
//               - max(0, damage%   - 5.00%)   x damage discount per point
//               (floored at zero)
//   gross_value = payable_kg x unit_price
//
// Every function returns its working as well as its answer. The delivery screen
// renders that working line by line so a farmer holding a calculator can
// reproduce the figure, and so can an auditor a year later.
import { divRound } from './units.js';

export const PRICING_REFERENCE = {
  foreignFreeBp: 200,    // FM up to 2.00% costs nothing
  oilReferenceBp: 4000,  // premium and penalty pivot around 40.00% oil
  moistureFreeBp: 900,   // moisture up to 9.00% costs nothing
  damageFreeBp: 500,     // damage up to 5.00% costs nothing
  pointBp: 100,          // one "point" is one percentage point
};

/**
 * Weight we actually pay for, after the foreign-matter deduction.
 * Deduction is the FM percentage in EXCESS of the 2.00% free allowance.
 */
export function payableGrams({ netG, foreignBp }) {
  if (!Number.isInteger(netG) || netG < 0) throw new RangeError('netG must be a non-negative integer');
  const excessBp = Math.max(0, foreignBp - PRICING_REFERENCE.foreignFreeBp);
  const payableG = divRound(netG * (10000 - excessBp), 10000);
  return {
    payableG,
    deductionG: netG - payableG,
    excessBp,
    lines: [
      { label: 'Net weight', kind: 'weight', value: netG },
      { label: `Foreign matter deduction (${(excessBp / 100).toFixed(2)}% above the 2.00% allowance)`,
        kind: 'weight', value: 0 - (netG - payableG) },
      { label: 'Payable weight', kind: 'weight', value: payableG, total: true },
    ],
  };
}

/**
 * Unit price in cents per kilogram, floored at zero.
 * @param {{oilBp:number, moistureBp:number, damageBp:number}} q
 * @param {{base_price_cents:number, oil_premium_cents:number,
 *          moisture_discount_cents:number, damage_discount_cents:number}} schedule
 */
export function unitPrice({ oilBp, moistureBp, damageBp }, schedule) {
  const R = PRICING_REFERENCE;
  const base = schedule.base_price_cents;

  const oilDeltaBp = oilBp - R.oilReferenceBp;
  const oilAdj = divRound(oilDeltaBp * schedule.oil_premium_cents, R.pointBp);

  const moistureExcessBp = Math.max(0, moistureBp - R.moistureFreeBp);
  const moistureAdj = 0 - divRound(moistureExcessBp * schedule.moisture_discount_cents, R.pointBp);

  const damageExcessBp = Math.max(0, damageBp - R.damageFreeBp);
  const damageAdj = 0 - divRound(damageExcessBp * schedule.damage_discount_cents, R.pointBp);

  const raw = base + oilAdj + moistureAdj + damageAdj;
  const cents = Math.max(0, raw);

  const lines = [
    { label: 'Base price per kg', kind: 'money', value: base },
    { label: `Oil ${oilDeltaBp >= 0 ? 'premium' : 'penalty'} (${(oilDeltaBp / 100).toFixed(2)} points from the 40.00% reference)`,
      kind: 'money', value: oilAdj },
    { label: `Moisture discount (${(moistureExcessBp / 100).toFixed(2)} points above 9.00%)`,
      kind: 'money', value: moistureAdj },
    { label: `Damage discount (${(damageExcessBp / 100).toFixed(2)} points above 5.00%)`,
      kind: 'money', value: damageAdj },
  ];
  if (raw < 0) {
    lines.push({ label: 'Floored at zero', kind: 'money', value: -raw, note: true });
  }
  lines.push({ label: 'Unit price per kg', kind: 'money', value: cents, total: true });

  return { cents, raw, oilAdj, moistureAdj, damageAdj, lines };
}

/** Gross value in cents. Weight is grams, price is cents per kilogram. */
export function grossValue({ payableG, unitPriceCents }) {
  return divRound(payableG * unitPriceCents, 1000);
}

/**
 * The whole priced picture for one delivery. Returns the number and the
 * working that produced it.
 */
export function priceDelivery({ netG, moistureBp, oilBp, foreignBp, damageBp }, schedule) {
  const weight = payableGrams({ netG, foreignBp });
  const price = unitPrice({ oilBp, moistureBp, damageBp }, schedule);
  const grossValueCents = grossValue({ payableG: weight.payableG, unitPriceCents: price.cents });
  return {
    payableG: weight.payableG,
    unitPriceCents: price.cents,
    grossValueCents,
    weightLines: weight.lines,
    priceLines: price.lines,
    valueLines: [
      { label: 'Payable weight', kind: 'weight', value: weight.payableG },
      { label: 'Unit price per kg', kind: 'money', value: price.cents },
      { label: 'Gross value', kind: 'money', value: grossValueCents, total: true },
    ],
  };
}
