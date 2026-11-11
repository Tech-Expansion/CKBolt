/** Display helpers of the quote maths. */

export function fmtRate(n: number): string {
  return n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
}
