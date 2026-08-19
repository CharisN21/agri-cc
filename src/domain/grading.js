// Grading. Pure: takes a quality reading in basis points, returns a grade.
//
//   grade = REJECT  if moisture > 14.00% or foreign matter > 10.00%
//           A       if oil >= 41.00% and moisture <= 10.00%
//           B       if oil >= 38.00%
//           C       otherwise
//
// The thresholds are deliberately literal constants rather than configuration:
// they are the buying standard, not a price. Prices live in price_schedule.

export const GRADE_LIMITS = {
  rejectMoistureBp: 1400, // > this is a reject
  rejectForeignBp: 1000,  // > this is a reject
  gradeAOilBp: 4100,      // >= this, with moisture at or under gradeAMoistureBp
  gradeAMoistureBp: 1000,
  gradeBOilBp: 3800,      // >= this
};

/**
 * @param {{moistureBp:number, oilBp:number, foreignBp:number}} q
 * @returns {'A'|'B'|'C'|'REJECT'}
 */
export function grade({ moistureBp, oilBp, foreignBp }) {
  for (const [name, v] of Object.entries({ moistureBp, oilBp, foreignBp })) {
    if (!Number.isInteger(v)) throw new TypeError(`${name} must be an integer in basis points`);
  }
  const L = GRADE_LIMITS;
  if (moistureBp > L.rejectMoistureBp || foreignBp > L.rejectForeignBp) return 'REJECT';
  if (oilBp >= L.gradeAOilBp && moistureBp <= L.gradeAMoistureBp) return 'A';
  if (oilBp >= L.gradeBOilBp) return 'B';
  return 'C';
}

/** Human explanation of why a load graded the way it did. Used on the delivery
 *  screen so the grade is arguable rather than oracular. */
export function gradeReason({ moistureBp, oilBp, foreignBp }) {
  const L = GRADE_LIMITS;
  if (moistureBp > L.rejectMoistureBp) return 'Rejected: moisture above 14.00%';
  if (foreignBp > L.rejectForeignBp) return 'Rejected: foreign matter above 10.00%';
  if (oilBp >= L.gradeAOilBp && moistureBp <= L.gradeAMoistureBp) {
    return 'Grade A: oil at or above 41.00% and moisture at or below 10.00%';
  }
  if (oilBp >= L.gradeBOilBp) {
    return oilBp >= L.gradeAOilBp
      ? 'Grade B: oil qualifies for A but moisture is above 10.00%'
      : 'Grade B: oil at or above 38.00%';
  }
  return 'Grade C: oil below 38.00%';
}
