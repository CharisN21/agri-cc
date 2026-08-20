// Comparing offers on a supply run. Pure.
//
// The naive comparison is "who is asking least per kilogram", and it is wrong.
//
// The cost of the trip is FIXED. The lorry costs the same whether it comes home
// with 300kg or 3 tonnes. So the real cost of an offer is:
//
//     landed per tonne = grain cost per tonne + (firm cost / tonnes collected)
//
// which means quantity changes the ranking. A farm asking KES 54/kg for two
// tonnes can be a cheaper buy than one asking KES 50/kg for three hundred
// kilos, because the second one leaves the vehicle empty and the whole trip
// cost lands on a small load.
//
// This file exists so that judgement is made on screen from the numbers, rather
// than in someone's head at the roadside.
import { divRound } from './units.js';

const perTonne = (cents, grams) => (grams > 0 ? divRound(cents * 1_000_000, grams) : 0);

/** What one offer costs in grain alone. */
export function offerGrainCost({ offeredG, askingPriceCents }) {
  return divRound(offeredG * askingPriceCents, 1000);
}

/**
 * Rank offers by what they would ACTUALLY cost, given a fixed trip cost.
 *
 * Two readings are produced for each offer:
 *
 *   alone       — take only this offer. The whole firm cost lands on it.
 *   cumulative  — take this offer and every cheaper one before it. This is the
 *                 reading that matters, because filling the vehicle is how the
 *                 firm cost stops hurting.
 *
 * @param {{id:*, code:*, offeredG:number, askingPriceCents:number}[]} offers
 * @param {number} firmCostCents  the trip's cost, fixed regardless of tonnage
 * @param {{boughtG:number, boughtCents:number}} [onBoard] what the vehicle is
 *        already carrying, and what that grain cost. BOTH are needed: dividing
 *        by weight already loaded while ignoring its cost understates the
 *        answer badly, and this screen exists to be trusted.
 */
export function rankOffers(offers, firmCostCents, onBoard = {}) {
  const alreadyBoughtG = onBoard.boughtG ?? 0;
  const alreadyBoughtCents = onBoard.boughtCents ?? 0;
  if (!Number.isInteger(firmCostCents) || firmCostCents < 0) {
    throw new RangeError('firmCostCents must be a non-negative integer');
  }

  // Cheapest grain first — that is the order a buyer would work down.
  const sorted = [...offers].sort(
    (a, b) => a.askingPriceCents - b.askingPriceCents || a.offeredG - b.offeredG,
  );

  let runningG = alreadyBoughtG;
  let runningGrainCents = alreadyBoughtCents;

  const ranked = sorted.map((o, i) => {
    const grainCents = offerGrainCost(o);
    const aloneG = alreadyBoughtG + o.offeredG;

    runningG += o.offeredG;
    runningGrainCents += grainCents;

    return {
      ...o,
      rank: i + 1,
      grainCents,
      grainPerTonneCents: perTonne(grainCents, o.offeredG),

      // Taking this offer and nothing else — the whole vehicle, including
      // whatever is already on it and what that cost.
      aloneLandedCents: alreadyBoughtCents + grainCents + firmCostCents,
      aloneLandedPerTonneCents: perTonne(alreadyBoughtCents + grainCents + firmCostCents, aloneG),
      aloneTripPerTonneCents: perTonne(firmCostCents, aloneG),

      // Taking everything down to and including this offer.
      cumulativeG: runningG,
      cumulativeGrainCents: runningGrainCents,
      cumulativeLandedCents: runningGrainCents + firmCostCents,
      cumulativeLandedPerTonneCents: perTonne(runningGrainCents + firmCostCents, runningG),
      cumulativeTripPerTonneCents: perTonne(firmCostCents, runningG),
    };
  });

  // The best stopping point: where landed cost per tonne is lowest. Taking one
  // more offer is only worth it while it keeps pulling the average down.
  let best = null;
  for (const r of ranked) {
    if (!best || r.cumulativeLandedPerTonneCents < best.cumulativeLandedPerTonneCents) best = r;
  }

  // The offer that looks cheapest per kilogram, which is not always the best
  // buy — worth naming so the screen can say so out loud.
  const cheapestPerKg = ranked.length
    ? ranked.reduce((a, b) => (a.askingPriceCents <= b.askingPriceCents ? a : b))
    : null;

  const bestAlone = ranked.length
    ? ranked.reduce((a, b) =>
      (a.aloneLandedPerTonneCents <= b.aloneLandedPerTonneCents ? a : b))
    : null;

  return {
    offers: ranked,
    firmCostCents,
    alreadyBoughtG,
    alreadyBoughtCents,
    bestStop: best,
    bestAlone,
    cheapestPerKg,
    // True when the headline-cheapest offer is NOT the one to take on its own.
    cheapestIsNotBest: Boolean(
      bestAlone && cheapestPerKg && bestAlone.id !== cheapestPerKg.id,
    ),
  };
}

/**
 * How a run is tracking against the tonnage it set out to collect.
 */
export function targetProgress({ targetG, boughtG, offeredG = 0 }) {
  const remainingG = Math.max(0, targetG - boughtG);
  return {
    targetG,
    boughtG,
    remainingG,
    offeredG,
    achievedBp: targetG > 0 ? divRound(boughtG * 10000, targetG) : 0,
    // Can the offers still on the table close the gap?
    coverableBp: targetG > 0 ? divRound((boughtG + offeredG) * 10000, targetG) : 0,
    shortfallAfterOffersG: Math.max(0, targetG - boughtG - offeredG),
    met: targetG > 0 && boughtG >= targetG,
  };
}

/**
 * Projected firm cost against what was actually spent.
 *
 * Over budget is a supplementary request; under budget is a saving that another
 * trip can use. Reporting both from one place stops the two being argued about
 * separately.
 */
export function budgetPosition({ projectedCents, actualCents, approvedSupplementaryCents = 0 }) {
  const allowedCents = projectedCents + approvedSupplementaryCents;
  const varianceCents = allowedCents - actualCents;
  return {
    projectedCents,
    approvedSupplementaryCents,
    allowedCents,
    actualCents,
    varianceCents,
    overBy: varianceCents < 0 ? -varianceCents : 0,
    savedBy: varianceCents > 0 ? varianceCents : 0,
    state: varianceCents < 0 ? 'over' : varianceCents > 0 ? 'under' : 'on budget',
    usedBp: allowedCents > 0 ? divRound(actualCents * 10000, allowedCents) : 0,
  };
}
