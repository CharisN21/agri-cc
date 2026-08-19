// Outsourcing: spot purchases and the true cost of a supply run.
//
// Pure. No database, no clock, no randomness.
//
// The point of this file is the question "was that trip worth doing?". You
// cannot answer it from the grain price alone — a lorry hire, the loading gang,
// the field officer's food and their housing allowance are all real money spent
// to get that grain into the store. Those costs attach to the TRIP, so the only
// honest way to express them per tonne is to spread them across everything the
// trip brought back.
import { divRound, applyBp } from './units.js';
import { payableGrams, unitPrice } from './pricing.js';

/**
 * Split an integer amount across weights so the parts sum EXACTLY to the whole.
 *
 * Naive rounding loses or invents cents: three loads sharing KES 100.00 by
 * thirds gives 33.33 x 3 = 99.99 and a missing cent that will haunt a
 * reconciliation. Largest-remainder assigns the leftover cents to the loads
 * with the biggest fractional claim, so the total is always preserved.
 */
export function allocateByWeight(totalCents, weights) {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new RangeError('totalCents must be a non-negative integer');
  }
  const totalW = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (totalW <= 0) return weights.map(() => 0);

  const base = weights.map((w) => Math.floor((totalCents * w) / totalW));
  const remainder = weights.map((w, i) => (totalCents * w) - (base[i] * totalW));
  let left = totalCents - base.reduce((a, b) => a + b, 0);

  // Biggest fractional claim first; ties broken by position so it is deterministic.
  const order = remainder
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r - a.r) || (a.i - b.i));

  const out = base.slice();
  for (let k = 0; left > 0; k += 1, left -= 1) out[order[k % order.length].i] += 1;
  return out;
}

/**
 * Price one spot load.
 *
 * Two prices come out, deliberately:
 *   referencePriceCents — what the spot schedule and the grade say it is worth
 *   agreedPriceCents    — what the field officer actually negotiated
 *
 * Pass agreedPriceCents = null to accept the schedule. Pass a number to
 * override it, and the caller must record a reason (the database enforces that).
 * Keeping both means a negotiated price never stops being auditable.
 */
export function priceSpotPurchase({
  netG, moistureBp, oilBp, foreignBp, damageBp, agreedPriceCents = null,
}, schedule) {
  const weight = payableGrams({ netG, foreignBp });
  const reference = unitPrice({ oilBp, moistureBp, damageBp }, schedule);

  const negotiated = agreedPriceCents !== null && agreedPriceCents !== reference.cents;
  const finalPrice = agreedPriceCents === null ? reference.cents : agreedPriceCents;
  if (!Number.isInteger(finalPrice) || finalPrice < 0) {
    throw new RangeError('agreed price must be a non-negative integer in cents');
  }

  const grossValueCents = divRound(weight.payableG * finalPrice, 1000);
  const cessCents = applyBp(grossValueCents, schedule.cess_bp);
  const netPayableCents = grossValueCents - cessCents;
  const varianceCents = finalPrice - reference.cents;

  return {
    payableG: weight.payableG,
    referencePriceCents: reference.cents,
    agreedPriceCents: finalPrice,
    varianceCents,
    varianceValueCents: divRound(weight.payableG * varianceCents, 1000),
    priceBasis: negotiated ? 'negotiated' : 'schedule',
    grossValueCents,
    cessCents,
    netPayableCents,
    weightLines: weight.lines,
    referenceLines: reference.lines,
    lines: [
      { label: 'Payable weight', kind: 'weight', value: weight.payableG },
      { label: 'Price the grade says', kind: 'money', value: reference.cents },
      ...(negotiated ? [{
        label: `Price agreed at the gate (${varianceCents >= 0 ? 'above' : 'below'} the schedule)`,
        kind: 'money', value: finalPrice, note: true,
      }] : []),
      { label: 'Gross value', kind: 'money', value: grossValueCents },
      { label: `County cess (${(schedule.cess_bp / 100).toFixed(2)}%)`, kind: 'money', value: 0 - cessCents },
      { label: 'Paid to supplier', kind: 'money', value: netPayableCents, total: true },
    ],
  };
}

export const RUN_COST_KINDS = {
  transport: 'Transport / vehicle hire',
  fuel: 'Fuel',
  labour: 'Labour / loading gang',
  loading: 'Loading and offloading',
  field_food: 'Field officer food',
  housing_allowance: 'Housing allowance',
  levy: 'Levies and permits',
  other: 'Other',
};

/**
 * The true cost of one supply run.
 *
 * @param {{payableG:number, netPayableCents:number}[]} purchases what we bought
 * @param {{kind:string, amountCents:number}[]} costs                what the trip cost
 */
export function runCosting(purchases, costs) {
  const purchaseCents = purchases.reduce((s, p) => s + p.netPayableCents, 0);
  const overheadCents = costs.reduce((s, c) => s + c.amountCents, 0);
  const payableG = purchases.reduce((s, p) => s + p.payableG, 0);
  const landedCents = purchaseCents + overheadCents;

  // Spread the trip's overhead across the loads by weight.
  const allocation = allocateByWeight(overheadCents, purchases.map((p) => p.payableG));

  const byKind = Object.keys(RUN_COST_KINDS)
    .map((kind) => ({
      kind,
      label: RUN_COST_KINDS[kind],
      amountCents: costs.filter((c) => c.kind === kind)
        .reduce((s, c) => s + c.amountCents, 0),
    }))
    .filter((r) => r.amountCents > 0);

  return {
    loads: purchases.length,
    payableG,
    purchaseCents,
    overheadCents,
    landedCents,
    // The three numbers the owner actually reads.
    grainPerTonneCents: payableG ? divRound(purchaseCents * 1_000_000, payableG) : 0,
    overheadPerTonneCents: payableG ? divRound(overheadCents * 1_000_000, payableG) : 0,
    landedPerTonneCents: payableG ? divRound(landedCents * 1_000_000, payableG) : 0,
    // Overhead as a share of what we paid for the grain itself.
    overheadBp: purchaseCents ? divRound(overheadCents * 10000, purchaseCents) : 0,
    byKind,
    allocation,
    perLoad: purchases.map((p, i) => ({
      ...p,
      allocatedCostCents: allocation[i],
      landedCents: p.netPayableCents + allocation[i],
      landedPerTonneCents: p.payableG
        ? divRound((p.netPayableCents + allocation[i]) * 1_000_000, p.payableG)
        : 0,
    })),
    lines: [
      { label: `Paid to suppliers (${purchases.length} load(s))`, kind: 'money', value: purchaseCents },
      ...byKind.map((k) => ({ label: k.label, kind: 'money', value: k.amountCents })),
      { label: 'True landed cost of this run', kind: 'money', value: landedCents, total: true },
    ],
  };
}

/**
 * Compare a run's landed cost against what the same tonnage actually cost us
 * from contracted farmers this season. This is the "was outsourcing worth it"
 * number.
 *
 * The baseline is the contracted LANDED cost per tonne, not the base price on
 * the schedule. Contracted grain earns oil premiums too, so its real cost is
 * never the headline price — comparing against the base price flatters or
 * damns a run for no reason. Pass the figure the settlements actually produced.
 */
export function runVsContracted(costing, contractedPerTonneCents) {
  const budgetCents = divRound(costing.payableG * contractedPerTonneCents, 1_000_000);
  return {
    budgetCents,
    differenceCents: budgetCents - costing.landedCents,
    budgetPerTonneCents: contractedPerTonneCents,
    differencePerTonneCents: contractedPerTonneCents - costing.landedPerTonneCents,
  };
}
