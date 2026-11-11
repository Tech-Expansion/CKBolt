/**
 * Number and amount helpers for pricing. Pure; usable from every layer.
 */

const DECIMAL_POINT = ".";
const TRAILING_ZEROS = /0+$/;
/** A non-negative number as String() prints it: "80000.12", "1.5e-7", "1e+21". */
const NUMBER_TEXT = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;
const NO_EXPONENT = "0";

/** coefficient x 10^exponent, held exactly. */
interface ExactDecimal {
  coefficient: bigint;
  exponent: number;
}

/** Middle value of a non-empty list; the mean of the two middle values when the count is even. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("Cannot take the median of an empty list.");
  const sorted = [...values].sort((a, b) => a - b);
  const upperMiddle = sorted[Math.floor(sorted.length / 2)] as number;
  if (sorted.length % 2 === 1) return upperMiddle;
  const lowerMiddle = sorted[sorted.length / 2 - 1] as number;
  return (lowerMiddle + upperMiddle) / 2;
}

/** `value` rounded to `decimals` decimal places: (0.0020499999999999997, 12) -> 0.00205. */
export const roundToDecimals = (value: number, decimals: number): number => Number(value.toFixed(decimals));

const powerOfTen = (exponent: number): bigint => 10n ** BigInt(exponent);

/** 10^decimals: base units in one whole unit. */
export const baseUnitsPerWhole = (decimals: number): bigint => powerOfTen(decimals);

/** Non-negative a / b rounded to the nearest integer, halves up. */
const roundHalfUpDiv = (a: bigint, b: bigint): bigint => (2n * a + b) / (2n * b);

/**
 * The decimal a non-negative finite number prints as (its shortest round-trip form), held exactly:
 * 80000.12 -> 8000012 x 10^-2, not the binary value 80000.11999999999534...
 */
function exactDecimalOf(value: number): ExactDecimal {
  const text = String(value);
  const match = NUMBER_TEXT.exec(text);
  if (!match) throw new RangeError(`Cannot read ${text} as a decimal number.`);
  const [, whole = "", fraction = "", exponent = NO_EXPONENT] = match;
  return { coefficient: BigInt(whole + fraction), exponent: Number(exponent) - fraction.length };
}

/**
 * A non-negative finite number as an integer scaled by 10^decimals: (0.0021, 6) -> 2100n. Use it to bring a USD price
 * into bigint maths. It scales the decimal the number prints as (what a quote states and what anyone re-deriving the
 * amounts reads), rounded half up at the last kept digit; scaling the binary value instead would turn a stated
 * $80,000.12 into 80000.119999999995.
 */
export function toScaledInteger(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`Cannot scale ${value}: it must be finite and not negative.`);
  const { coefficient, exponent } = exactDecimalOf(value);
  const shift = exponent + decimals;
  return shift >= 0 ? coefficient * powerOfTen(shift) : roundHalfUpDiv(coefficient, powerOfTen(-shift));
}

/** Base units as an exact decimal of whole units, for messages: (150000000n, 8) -> "1.5". */
export function formatBaseUnits(amount: bigint, decimals: number): string {
  const unit = baseUnitsPerWhole(decimals);
  const whole = amount / unit;
  const fraction = (amount % unit).toString().padStart(decimals, "0").replace(TRAILING_ZEROS, "");
  return fraction ? `${whole}${DECIMAL_POINT}${fraction}` : whole.toString();
}
