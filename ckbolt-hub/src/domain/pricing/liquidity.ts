import { BASIS_POINTS_PER_WHOLE, PERCENT_PER_WHOLE } from "../../common/constants/pricing.constants";
import { AWAITING_PAYOUT_SWAP_STATES, SWAP_DIRECTION, SWAP_STATE } from "../../common/constants/swap.constants";
import { sumOf } from "../../common/utils/amount.util";
import { basisPointsOfCeil } from "../../common/utils/basis-points.util";
import { sameAssetScript } from "../../common/utils/script.util";
import type { Direction, FiberAsset, FiberAssetId, Swap } from "../types";
import { lightningIsIncoming, payoutAmount } from "./legs";
import type { AssetLiquidity, ChannelLiquidity, LiquiditySnapshot } from "./pricing.types";

/** Which balance a payout comes from: the direction and asset of a quote or swap. */
export type PayoutSide = { direction: Direction; asset: FiberAssetId };

/** The parts of an open swap that decide what it still takes from the hub's balance. */
export type PayoutReservation = PayoutSide & Pick<Swap, "state" | "sats" | "fiberAmount">;

/** A channel carries `asset` when both are CKB (no type script) or their UDT type scripts are equal. */
const carriesAsset = (channel: ChannelLiquidity, asset: FiberAsset): boolean => sameAssetScript(channel.udtTypeScript, asset.udtTypeScript);

/** What the hub can pay out in `asset` on Fiber: local balance of its ready channels in that asset. */
export const fiberLiquidity = (channels: readonly ChannelLiquidity[], asset: FiberAsset): bigint =>
  sumOf(channels.filter((channel) => channel.ready && carriesAsset(channel, asset)).map((channel) => channel.localBalance));

/** What the hub can pay out for `asset` on both sides. */
export const assetLiquidity = (snapshot: LiquiditySnapshot, asset: FiberAsset): AssetLiquidity => ({
  lightningSats: snapshot.lightningSats,
  fiberAmount: fiberLiquidity(snapshot.fiberChannels, asset),
});

/** The side that pays out: Fiber for ln_to_fiber, Lightning for fiber_to_ln. */
export const payoutCapacity = (direction: Direction, liquidity: AssetLiquidity): bigint =>
  lightningIsIncoming(direction) ? liquidity.fiberAmount : liquidity.lightningSats;

/** What one payout ties up: its amount plus the most the hub may spend routing it (`maxFeeBps` of it, rounded up). */
export const payoutWithFeeBudget = (amount: bigint, maxFeeBps: number): bigint => amount + basisPointsOfCeil(amount, maxFeeBps);

/** The largest payout whose amount plus fee budget fits in `available`; 0 when nothing is available. */
export const largestPayoutWithin = (available: bigint, maxFeeBps: number): bigint =>
  available <= 0n ? 0n : (available * BASIS_POINTS_PER_WHOLE) / (BASIS_POINTS_PER_WHOLE + BigInt(maxFeeBps));

/** Two payouts share a balance: every fiber_to_ln payout uses the Lightning channels, ln_to_fiber the asset's Fiber channels. */
const sharesPayoutBalance = (a: PayoutSide, b: PayoutSide): boolean =>
  a.direction === b.direction && (!lightningIsIncoming(a.direction) || a.asset === b.asset);

/**
 * What open swaps whose payout is not sent yet will still take from the balance a new payout on `side` uses, fee
 * budgets included. Payouts already sent are out of the channel balance by then.
 */
export const reservedPayouts = (openSwaps: readonly PayoutReservation[], side: PayoutSide, maxFeeBps: number): bigint =>
  sumOf(
    openSwaps
      .filter((swap) => AWAITING_PAYOUT_SWAP_STATES.includes(swap.state) && sharesPayoutBalance(swap, side))
      .map((swap) => payoutWithFeeBudget(payoutAmount(swap.direction, swap), maxFeeBps)),
  );

/**
 * The largest payout a new quote on `side` can get: the payout balance less what open swaps have reserved, leaving room
 * for its own routing fee budget.
 */
export const availablePayout = (
  liquidity: AssetLiquidity,
  openSwaps: readonly PayoutReservation[],
  side: PayoutSide,
  maxFeeBps: number,
): bigint => largestPayoutWithin(payoutCapacity(side.direction, liquidity) - reservedPayouts(openSwaps, side, maxFeeBps), maxFeeBps);

/** A swap still waiting for the user's payment: it reserves its payout although the user has not paid anything yet. */
const isUnpaid = (swap: PayoutReservation): boolean => swap.state === SWAP_STATE.PENDING;

/**
 * How much more swaps waiting for their payment may reserve on `side`, fee budgets included: `maxSharePercent` of the
 * side's payout balance less what paid swaps still need, less what unpaid swaps reserve already. Negative when they
 * hold more than that already. Unpaid swaps cost nothing to make, so without this share a few clients could lock all of
 * a direction's payout liquidity until their quotes expire.
 */
export const unpaidPayoutRoom = (
  liquidity: AssetLiquidity,
  openSwaps: readonly PayoutReservation[],
  side: PayoutSide,
  maxFeeBps: number,
  maxSharePercent: number,
): bigint => {
  const paid = openSwaps.filter((swap) => !isUnpaid(swap));
  const available = payoutCapacity(side.direction, liquidity) - reservedPayouts(paid, side, maxFeeBps);
  const share = (available * BigInt(maxSharePercent)) / BigInt(PERCENT_PER_WHOLE);
  return share - reservedPayouts(openSwaps.filter(isUnpaid), side, maxFeeBps);
};

/**
 * The largest ln_to_fiber payout in `asset` a new quote could get from these Fiber channels (what GET /v1/assets reports
 * as `fiberAmount`): their ready local balance in the asset, less what open swaps have reserved, leaving room for the
 * payout's own routing fee budget.
 */
export const availableFiberPayout = (
  channels: readonly ChannelLiquidity[],
  openSwaps: readonly PayoutReservation[],
  asset: FiberAsset,
  maxFeeBps: number,
): bigint => {
  const reserved = reservedPayouts(openSwaps, { direction: SWAP_DIRECTION.LN_TO_FIBER, asset: asset.id }, maxFeeBps);
  return largestPayoutWithin(fiberLiquidity(channels, asset) - reserved, maxFeeBps);
};
