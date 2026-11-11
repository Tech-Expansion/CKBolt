import { formatBaseUnits, LIMITS, parseAmountInput, parseSatsInput, type DecimalMark } from "@/lib/amount";
import { SATS_PER_BTC } from "@/lib/hub/constants";
import type { LegDto, QuoteDto } from "@/lib/hub/contract";
import { toBaseUnits } from "@/lib/hub/format";

/**
 * The amount the user types on the card: always the pay side (quotes with `side: "pay"`), in whole sats when BTC is
 * paid on Lightning and in token units when a Fiber asset is paid.
 */

/** The unit of the pay side: whole sats on Lightning, token units with the asset's decimals on Fiber. */
export interface PayUnit {
  network: LegDto["network"];
  /** The Fiber asset's decimals; unused on Lightning. */
  decimals: number;
}

export type PayAmount =
  | { status: "empty" }
  | { status: "zero" }
  | { status: "invalid" }
  /** `units` are base units: sats, or the asset's smallest unit. */
  | { status: "ok"; units: string };

const EMPTY: PayAmount = { status: "empty" };
const ZERO: PayAmount = { status: "zero" };
const INVALID: PayAmount = { status: "invalid" };

/** Characters an amount can hold: digits, the two separators and spaces between groups. */
const NOT_AMOUNT_CHARS = /[^\d.,\s]/g;

/** What the user typed, without characters an amount never has (letters, signs). */
export const sanitizeAmountText = (text: string): string => text.replace(NOT_AMOUNT_CHARS, "");

/** Reads the typed pay amount in its unit, as base units for the quote request. */
export function readPayAmount(text: string, unit: PayUnit, decimalMark: DecimalMark): PayAmount {
  if (!text.trim()) return EMPTY;
  if (unit.network === "lightning") {
    const sats = parseSatsInput(text);
    if (sats === null || sats > LIMITS.maxSats) return INVALID;
    return sats === 0 ? ZERO : { status: "ok", units: String(sats) };
  }
  const value = parseAmountInput(text, decimalMark);
  if (value === null || value > LIMITS.maxTokenAmount) return INVALID;
  if (value === 0) return ZERO;
  const units = toBaseUnits(value, unit.decimals);
  return units === null ? ZERO : { status: "ok", units };
}

/**
 * Base units as the text the amount input takes: sats as they are, token units as an exact plain decimal written
 * with the locale's decimal mark, so `readPayAmount` reads it back to the same units ("1.234" is 1234 where "," is
 * the decimal mark).
 */
export function unitsToInputText(units: string, unit: PayUnit, decimalMark: DecimalMark): string {
  if (unit.network === "lightning") return units;
  const text = formatBaseUnits(BigInt(units), unit.decimals);
  return decimalMark === "." ? text : text.replace(".", decimalMark);
}

/** A leg's amount in whole units of its asset: BTC for sats, tokens for base units. */
export const legWholeUnits = (leg: LegDto): number =>
  leg.network === "lightning" ? Number(leg.amount) / SATS_PER_BTC : Number(formatBaseUnits(BigInt(leg.amount), leg.decimals));

/** The USD value of a leg at the prices the hub quoted with. */
export const legUsd = (leg: LegDto, prices: QuoteDto["prices"]): number =>
  legWholeUnits(leg) * (leg.network === "lightning" ? prices.btcUsd : prices.assetUsd);

/**
 * About how many sats `units` of a Fiber asset are worth at prices the hub quoted with earlier, fee left out. Only
 * used to say which per-swap limit a refused amount crossed; the hub's quote sets the real amount.
 */
export function estimateSats(units: string, decimals: number, prices: QuoteDto["prices"]): number | null {
  if (!(prices.btcUsd > 0) || !(prices.assetUsd > 0)) return null;
  const whole = Number(formatBaseUnits(BigInt(units), decimals));
  return Math.round(((whole * prices.assetUsd) / prices.btcUsd) * SATS_PER_BTC);
}
