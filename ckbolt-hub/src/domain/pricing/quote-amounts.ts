import { BASIS_POINTS_PER_WHOLE, PRICE_SCALE_DECIMALS } from "../../common/constants/pricing.constants";
import { SATS_PER_BTC } from "../../common/constants/protocol.constants";
import { QUOTE_SIDE } from "../../common/constants/swap.constants";
import { ceilDiv } from "../../common/utils/amount.util";
import { baseUnitsPerWhole, toScaledInteger } from "../../common/utils/pricing.util";
import type { Direction, FiberAsset } from "../types";
import { amountsFromLegs, lightningIsIncoming } from "./legs";
import type { AmountRequest, AssetPrice, AssetTerms, ExchangeTerms, QuoteAmounts, SwapLegs } from "./pricing.types";

/**
 * Amount maths of a firm quote, in bigint base units. The fee (hub fee plus option premium) is applied once, as a cut
 * of the outgoing leg's fair value. Rounding always favours the hub: what the user receives is rounded down, what the
 * user pays is rounded up.
 */

/** A non-negative rational number. */
interface Ratio {
  num: bigint;
  den: bigint;
}

/** Throws unless the total fee is a whole number of basis points from 0 to below 100 %. */
export function assertFeeBps(feeBps: number): void {
  if (Number.isInteger(feeBps) && feeBps >= 0 && BigInt(feeBps) < BASIS_POINTS_PER_WHOLE) return;
  throw new RangeError(`A fee of ${feeBps} bps is invalid: it must be a whole number of basis points below ${BASIS_POINTS_PER_WHOLE}.`);
}

/** The terms a quote for `asset` uses at `price` (assetPriceFor), with the hub's total fee. */
export const exchangeTermsFor = (asset: FiberAsset, price: AssetPrice, feeBps: number): ExchangeTerms => ({
  btcUsd: price.btcUsd,
  assetUsd: price.assetUsd,
  assetDecimals: asset.decimals,
  feeBps,
});

/** An asset's terms: what it sets itself, the global `defaults` for the rest. */
export const resolveAssetTerms = (defaults: AssetTerms, own: Partial<AssetTerms> = {}): AssetTerms => ({
  feeBps: own.feeBps ?? defaults.feeBps,
  optionPremiumBps: own.optionPremiumBps ?? defaults.optionPremiumBps,
  minSats: own.minSats ?? defaults.minSats,
  maxSats: own.maxSats ?? defaults.maxSats,
});

function scaledUsd(price: number): bigint {
  const scaled = toScaledInteger(price, PRICE_SCALE_DECIMALS);
  if (scaled > 0n) return scaled;
  throw new RangeError(`A USD price of ${price} is too small to quote with.`);
}

/** Fair value of one sat in Fiber asset base units: (btcUsd / sats per BTC) / (assetUsd / base units per asset). */
const fiberUnitsPerSat = (terms: ExchangeTerms): Ratio => ({
  num: scaledUsd(terms.btcUsd) * baseUnitsPerWhole(terms.assetDecimals),
  den: scaledUsd(terms.assetUsd) * SATS_PER_BTC,
});

/** Outgoing base units the user gets per incoming base unit, after the fee. */
function userRate(direction: Direction, terms: ExchangeTerms): Ratio {
  const fair = fiberUnitsPerSat(terms);
  const oriented = lightningIsIncoming(direction) ? fair : { num: fair.den, den: fair.num };
  return {
    num: oriented.num * (BASIS_POINTS_PER_WHOLE - BigInt(terms.feeBps)),
    den: oriented.den * BASIS_POINTS_PER_WHOLE,
  };
}

/** side=pay fixes the incoming leg and rounds the outgoing one down; side=receive fixes the outgoing leg and rounds the incoming one up. */
function legsFor(amount: bigint, side: AmountRequest["side"], rate: Ratio): SwapLegs {
  return side === QUOTE_SIDE.PAY
    ? { incoming: amount, outgoing: (amount * rate.num) / rate.den }
    : { incoming: ceilDiv(amount * rate.den, rate.num), outgoing: amount };
}

/** Both legs of a quote for `request` at `terms`. */
export function quoteAmounts(request: AmountRequest, terms: ExchangeTerms): QuoteAmounts {
  assertFeeBps(terms.feeBps);
  if (request.amount < 0n) throw new RangeError(`A quote amount cannot be negative: ${request.amount}.`);

  const legs = legsFor(request.amount, request.side, userRate(request.direction, terms));
  return amountsFromLegs(request.direction, legs);
}

/** True when either leg rounds to nothing, so there is nothing to swap. */
export const hasEmptyLeg = (amounts: QuoteAmounts): boolean => amounts.sats <= 0n || amounts.fiberAmount <= 0n;
