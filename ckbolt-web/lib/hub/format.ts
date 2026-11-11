import { formatBaseUnits } from "@/lib/amount";
import type { LegDto } from "./contract";
import { BASIS_POINTS_PER_PERCENT, MS_PER_SECOND } from "./constants";

/** Unit shown for the Lightning leg, which the hub counts in sats. */
export const SATS_UNIT = "sats";

const groupThousands = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Exact base units as a grouped decimal: "1234567890" with 8 decimals is "12.3456789". */
export function formatUnits(amount: string, decimals: number): string {
  const [int, frac] = formatBaseUnits(BigInt(amount), decimals).split(".");
  return frac ? `${groupThousands(int)}.${frac}` : groupThousands(int);
}

/** A leg's amount without the Fiber symbol: "24,750 sats" on Lightning, "19,800.5" on Fiber. */
const legAmount = (leg: LegDto): string =>
  leg.network === "lightning" ? `${groupThousands(leg.amount)} ${SATS_UNIT}` : formatUnits(leg.amount, leg.decimals);

/** A leg's amount with its unit: sats on Lightning, the asset's symbol on Fiber. */
export const formatLeg = (leg: LegDto, symbol: string = leg.asset): string =>
  leg.network === "lightning" ? legAmount(leg) : `${legAmount(leg)} ${symbol}`;

/**
 * A typed amount as base units, rounded to the asset's decimals; null when that is not a positive amount.
 * `toFixed` keeps every digit the number holds, so 100000.5 CKB is exactly 10000050000000 shannons.
 */
export function toBaseUnits(value: number, decimals: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const units = value.toFixed(decimals).replace(".", "").replace(/^0+(?=\d)/, "");
  return /^[1-9]\d*$/.test(units) ? units : null;
}

/** The hub's fee in percent, such as "1%" for 100 bps. */
export const feePercent = (feeBps: number): string => `${feeBps / BASIS_POINTS_PER_PERCENT}%`;

/** Whole seconds left until an ISO time, never negative. */
export function secondsUntil(iso: string, nowMs: number): number {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - nowMs) / MS_PER_SECOND)) : 0;
}

export const lightningNetworkLabel = (network: string | null | undefined): string => (network ? `Bitcoin ${network}` : "Bitcoin test network");

/** A clock time for hub timestamps, in the app's date style. */
export const formatTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
