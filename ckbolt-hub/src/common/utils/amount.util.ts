/**
 * Amount helpers shared by every layer. Amounts are bigint base units; these convert at the edges
 * (JSON-RPC hex, API decimal strings, display).
 */

const DECIMAL_INTEGER = /^\d+$/;

/** bigint -> "0x..." (Fiber JSON-RPC u64/u128 encoding). */
export const toHexQuantity = (value: bigint | number): string => `0x${BigInt(value).toString(16)}`;

/** "0x..." -> bigint. Throws on anything else. */
export function fromHexQuantity(value: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`Not a hex quantity: ${value}`);
  return BigInt(value);
}

/** bigint -> decimal string, for API bodies (JSON has no bigint). */
export const toDecimalString = (value: bigint): string => value.toString(10);

/** Decimal string from an API body -> bigint. Throws on signs, decimals, exponents or empty input. */
export function fromDecimalString(value: string): bigint {
  if (!DECIMAL_INTEGER.test(value)) throw new Error(`Not a non-negative integer: ${value}`);
  return BigInt(value);
}

/** Ceiling division for non-negative bigints. */
export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export const minBigint = (...values: bigint[]): bigint => values.reduce((m, v) => (v < m ? v : m));
export const maxBigint = (...values: bigint[]): bigint => values.reduce((m, v) => (v > m ? v : m));

/** Sum of bigint amounts; 0 for an empty list. */
export const sumOf = (values: readonly bigint[]): bigint => values.reduce((total, value) => total + value, 0n);

/** Base units -> whole units as a number, for price maths only (never for amounts that are paid). */
export const toWholeUnits = (baseUnits: bigint, decimals: number): number => Number(baseUnits) / 10 ** decimals;
