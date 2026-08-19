// Settlement. Pure: priced delivery + debt + schedule in, payout out.
//
//   net_payable = gross_value - county cess - debt recovery
//
// Debt recovery is capped three ways and the binding cap is reported, because
// "why was I only paid this much" is the single most common question a farmer
// asks and the answer must be one line, not an investigation.
//
//   share      — never more than the contractual share of ONE delivery
//   owed       — never more than the farmer actually owes
//   cash_floor — never so much that the farmer takes home less than the floor;
//                and if the load is too small to clear the floor at all,
//                recovery drops to zero and the farmer is still paid.
import { applyBp } from './units.js';

/**
 * @param {object} a
 * @param {number} a.grossValueCents   value of the load before deductions
 * @param {number} a.owedCents         farmer's outstanding input credit
 * @param {number} a.cessBp            county cess, basis points (50 = 0.50%)
 * @param {number} a.recoveryShareBp   contractual share of one delivery
 * @param {number} a.cashFloorCents    minimum the farmer must take home
 */
export function settle({
  grossValueCents,
  owedCents,
  cessBp,
  recoveryShareBp,
  cashFloorCents,
}) {
  for (const [name, v] of Object.entries({
    grossValueCents, owedCents, cessBp, recoveryShareBp, cashFloorCents,
  })) {
    if (!Number.isInteger(v)) throw new TypeError(`${name} must be an integer`);
    if (v < 0) throw new RangeError(`${name} must not be negative`);
  }

  const cessCents = applyBp(grossValueCents, cessBp);
  const afterCess = grossValueCents - cessCents;

  // The three caps.
  const shareCap = applyBp(grossValueCents, recoveryShareBp);
  const owedCap = owedCents;
  const floorCap = Math.max(0, afterCess - cashFloorCents);

  const recoveryCents = Math.min(shareCap, owedCap, floorCap);
  const netPayableCents = afterCess - recoveryCents;

  let recoveryCap;
  if (owedCap === 0) recoveryCap = 'none';
  else if (recoveryCents === floorCap && floorCap < owedCap) recoveryCap = 'cash_floor';
  else if (recoveryCents === shareCap && shareCap < owedCap) recoveryCap = 'share';
  else recoveryCap = 'owed';

  return {
    cessCents,
    recoveryCents,
    recoveryCap,
    netPayableCents,
    caps: { shareCap, owedCap, floorCap },
    lines: [
      { label: 'Gross value', kind: 'money', value: grossValueCents },
      { label: `County cess (${(cessBp / 100).toFixed(2)}%)`, kind: 'money', value: -cessCents },
      { label: 'Input credit recovery', kind: 'money', value: -recoveryCents },
      { label: 'Net payable', kind: 'money', value: netPayableCents, total: true },
    ],
    capExplanation: explainCap(recoveryCap, { shareCap, owedCap, floorCap },
      { recoveryShareBp, cashFloorCents }),
  };
}

function explainCap(cap, caps, cfg) {
  switch (cap) {
    case 'none':
      return 'No input credit outstanding, so nothing was recovered.';
    case 'owed':
      return 'Recovered the full outstanding input credit.';
    case 'share':
      return `Capped at the contractual ${(cfg.recoveryShareBp / 100).toFixed(2)}% share of this delivery.`;
    case 'cash_floor':
      return caps.floorCap === 0
        ? 'This load is too small to clear the cash floor, so nothing was recovered and the farmer is paid in full.'
        : `Capped so the farmer still takes home the cash floor of KES ${(cfg.cashFloorCents / 100).toFixed(2)}.`;
    default:
      return '';
  }
}
