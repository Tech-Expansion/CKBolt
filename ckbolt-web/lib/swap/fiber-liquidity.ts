import type { Direction, FiberAssetId } from "@/lib/hub/contract";

/** What a Fiber node can move now over its ready channels, per asset, in base units (the wallets part reports it). */
export type NodeLiquidity = Partial<Record<FiberAssetId, { send: string; receive: string }>>;

export type LiquiditySide = "send" | "receive";

/** The side on which the user's browser node is short for this swap; "no-channel" when it cannot receive the asset at all. */
export type FiberShortfall = LiquiditySide | "no-channel";

const DIGITS = /^\d+$/;
const units = (value: string | undefined): bigint => (value && DIGITS.test(value) ? BigInt(value) : BigInt(0));

/** What the node can send or receive in `asset` now; an asset it has no channel for counts as zero. */
export const nodeCan = (liquidity: NodeLiquidity, asset: FiberAssetId, side: LiquiditySide): bigint => units(liquidity[asset]?.[side]);

export interface ShortfallInput {
  direction: Direction;
  /** The node's liquidity; null when unknown (own node, or the browser node did not answer yet): nothing is blocked. */
  liquidity: NodeLiquidity | null;
  asset: FiberAssetId;
  /** fiber_to_ln: the typed pay amount, base units. */
  payUnits: string | null;
  /** ln_to_fiber: the quote's receive amount, base units; null before a quote. */
  receiveUnits: string | null;
}

/**
 * Whether the browser node cannot carry this swap: it pays the asset (fiber_to_ln) and cannot send that much, or it
 * receives the payout (ln_to_fiber) and cannot receive that much ("no-channel" when it can receive none of the asset).
 * Null when it can, or when that is not known yet.
 */
export function fiberShortfall(input: ShortfallInput): FiberShortfall | null {
  const { direction, liquidity, asset, payUnits, receiveUnits } = input;
  if (!liquidity) return null;
  if (direction === "fiber_to_ln") return payUnits !== null && nodeCan(liquidity, asset, "send") < BigInt(payUnits) ? "send" : null;
  if (receiveUnits === null) return null;
  const room = nodeCan(liquidity, asset, "receive");
  if (room >= BigInt(receiveUnits)) return null;
  return room === BigInt(0) ? "no-channel" : "receive";
}
