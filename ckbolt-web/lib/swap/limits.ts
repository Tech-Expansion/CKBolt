import { API_ERROR_CODE, type AssetDto, type QuoteDto } from "@/lib/hub/contract";
import { estimateSats } from "./amount";

/**
 * Why an amount cannot be swapped: below or above the hub's per-swap limits (sats, on the Lightning leg), more than
 * the hub can pay out now, or out of range on a side the browser cannot size (`range`).
 */
export type LimitIssue = { kind: "min"; sats: string } | { kind: "max"; sats: string } | { kind: "liquidity" } | { kind: "range" };

export interface LimitInput {
  asset: Pick<AssetDto, "minSats" | "maxSats" | "decimals">;
  /**
   * The Lightning leg in whole sats when the page knows it exactly: the BTC typed (ln_to_fiber), or the amount of the
   * visitor's pasted invoice (fiber_to_ln); null otherwise.
   */
  sats: string | null;
  /** fiber_to_ln without an invoice: the typed amount of the Fiber asset, in base units; the hub sizes the Lightning leg. */
  fiberUnits: string | null;
  /** The code of the hub's answer to this amount's quote request, when it refused it. */
  quoteErrorCode: string | null;
  /** Prices the hub quoted this asset with earlier, to tell which limit a refused Fiber amount crossed. */
  knownPrices: QuoteDto["prices"] | null;
}

/** Whole sats compared exactly. */
const below = (sats: bigint | number, limit: string): boolean => BigInt(sats) < BigInt(limit);
const above = (sats: bigint | number, limit: string): boolean => BigInt(sats) > BigInt(limit);

/**
 * The per-swap limit the amount breaks, or null.
 * - Sats the page knows (the BTC typed, or an invoice's amount) are checked here, before any quote is asked for.
 * - A typed Fiber amount (fiber_to_ln): the hub sizes the Lightning leg and refuses it with `validation_failed`; prices
 *   from an earlier quote, when there are some, tell whether the amount was too small or too large.
 * - `insufficient_liquidity` from the hub, either way, means it cannot pay out that much now.
 */
export function checkLimits(input: LimitInput): LimitIssue | null {
  const { asset, sats, fiberUnits, quoteErrorCode, knownPrices } = input;
  if (sats !== null) {
    if (below(BigInt(sats), asset.minSats)) return { kind: "min", sats: asset.minSats };
    if (above(BigInt(sats), asset.maxSats)) return { kind: "max", sats: asset.maxSats };
  } else if (fiberUnits === null) {
    return null;
  }
  if (quoteErrorCode === API_ERROR_CODE.INSUFFICIENT_LIQUIDITY) return { kind: "liquidity" };
  if (sats === null && fiberUnits !== null && quoteErrorCode === API_ERROR_CODE.VALIDATION) {
    const estimate = knownPrices ? estimateSats(fiberUnits, asset.decimals, knownPrices) : null;
    if (estimate !== null && below(estimate, asset.minSats)) return { kind: "min", sats: asset.minSats };
    if (estimate !== null && above(estimate, asset.maxSats)) return { kind: "max", sats: asset.maxSats };
    return { kind: "range" };
  }
  return null;
}

/** The amount may be quoted: there is one, and it breaks no limit the browser can check by itself. */
export const quotable = (input: Omit<LimitInput, "quoteErrorCode">): boolean =>
  (input.sats !== null || input.fiberUnits !== null) && checkLimits({ ...input, quoteErrorCode: null }) === null;
