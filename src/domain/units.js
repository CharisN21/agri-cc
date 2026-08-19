// Unit conversion and integer arithmetic.
//
// The whole system stores money as integer cents, weight as integer grams and
// percentages as integer basis points. Conversion to and from human decimals
// happens ONLY here, and is only ever called at the HTTP and template
// boundaries — never in the middle of a calculation.

/** Integer division rounded half away from zero. The only rounding rule the
 *  system uses, so a farmer with a calculator can reproduce every line. */
export function divRound(numerator, denominator) {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new TypeError('divRound expects integers');
  }
  if (denominator === 0) throw new RangeError('divide by zero');
  const sign = Math.sign(numerator) * Math.sign(denominator) || 1;
  const q = Math.floor((Math.abs(numerator) * 2 + Math.abs(denominator)) /
                       (Math.abs(denominator) * 2));
  const result = sign * q;
  return result === 0 ? 0 : result; // never hand back -0
}

/** Apply a basis-point rate to an integer amount. 50bp of 10000 -> 50. */
export function applyBp(amount, bp) {
  return divRound(amount * bp, 10000);
}

function parseDecimal(input, scale, label) {
  const s = String(input).trim();
  if (s === '') throw new RangeError(`${label} is required`);
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new RangeError(`${label} is not a number: ${input}`);
  const neg = s.startsWith('-');
  const [whole, frac = ''] = (neg ? s.slice(1) : s).split('.');
  const padded = (frac + '0'.repeat(scale)).slice(0, scale);
  const dropped = frac.slice(scale);
  let value = Number(whole) * 10 ** scale + Number(padded || '0');
  if (dropped && Number(dropped[0]) >= 5) value += 1; // round half up
  return neg ? -value : value;
}

function formatDecimal(value, scale) {
  const neg = value < 0;
  const s = String(Math.abs(value)).padStart(scale + 1, '0');
  const out = `${s.slice(0, -scale)}.${s.slice(-scale)}`;
  return neg ? `-${out}` : out;
}

// --- money: KES <-> cents -------------------------------------------------
export const toCents = (kes) => parseDecimal(kes, 2, 'amount');
export const fromCents = (cents) => formatDecimal(cents, 2);

// --- weight: kg <-> grams -------------------------------------------------
export const toGrams = (kg) => parseDecimal(kg, 3, 'weight');
export const fromGrams = (g) => formatDecimal(g, 3);

// --- percentage: % <-> basis points ---------------------------------------
export const toBp = (pct) => parseDecimal(pct, 2, 'percentage');
export const fromBp = (bp) => formatDecimal(bp, 2);

/** Money for display: "58.40" -> "58.40", with thousands separators. */
export function money(cents) {
  const s = fromCents(cents);
  const [whole, frac] = s.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

/** Weight for display in kilograms, three decimals, thousands separated. */
export function kg(grams) {
  const s = fromGrams(grams);
  const [whole, frac] = s.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

export const pct = (bp) => `${fromBp(bp)}%`;
