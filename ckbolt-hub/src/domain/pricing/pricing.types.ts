import type { PricedCoin } from "../../common/constants/price-sources.constants";
import type { Quote, QuoteRequest, Script } from "../types";

/**
 * Types of the pricing maths. Pure data; the application layer's port types (UsdPrices, FiberChannelBalance) have the
 * same shapes, so they pass in without conversion while the domain stays independent of the application layer.
 */

/** One coin's USD price per whole coin from one source, produced at `at` (ms). */
export interface CoinSample {
  usd: number;
  at: number;
}

/** One source's prices per coin; a coin the source could not price this time is null, and the other still counts. */
export type SourcePrice = { source: string } & { [coin in PricedCoin]: CoinSample | null };

/** Which samples count: those at most `maxAgeMs` old at `now`. */
export interface FreshnessWindow {
  now: number;
  maxAgeMs: number;
}

/** One coin's market price: the median of its fresh samples, timestamped with the oldest one used, and their sources. */
export interface CoinPrice {
  usd: number;
  at: number;
  sources: string[];
}

/** The market price per coin, each worked out on its own; null for a coin no source has a fresh price for. */
export type MarketPrice = { readonly [coin in PricedCoin]: CoinPrice | null };

/**
 * The prices a quote in one asset states: USD per whole BTC and per whole asset unit, from the coins the asset's USD
 * rule needs, timestamped with the oldest of them and labelled with every source used ("median:coingecko,binance").
 */
export interface AssetPrice {
  btcUsd: number;
  assetUsd: number;
  at: number;
  source: string;
}

/**
 * What a swap in one asset costs and how large it may be: the hub fee and the option premium, basis points, and the
 * Lightning leg's bounds, sats. Per asset, with the global values (FEE_BPS, OPTION_PREMIUM_BPS, SWAP_MIN_SATS,
 * SWAP_MAX_SATS) for whatever an asset does not set.
 */
export interface AssetTerms {
  feeBps: number;
  optionPremiumBps: number;
  minSats: bigint;
  maxSats: bigint;
}

/** Everything the amount maths needs: USD per whole BTC and per whole asset unit, and the total fee. */
export interface ExchangeTerms {
  btcUsd: number;
  assetUsd: number;
  assetDecimals: number;
  /** Hub fee plus option premium, basis points, applied once. */
  feeBps: number;
}

export type AmountRequest = Pick<QuoteRequest, "direction" | "side" | "amount">;

/** Both legs of a quote: sats on Lightning, asset base units on Fiber. */
export interface QuoteAmounts {
  sats: bigint;
  fiberAmount: bigint;
}

/** Both legs of a swap as seen from the hub: what comes in from the user and what goes out to the user. */
export interface SwapLegs {
  incoming: bigint;
  outgoing: bigint;
}

/** What the hub can pay out now: sats on Lightning, asset base units on Fiber. */
export interface AssetLiquidity {
  lightningSats: bigint;
  fiberAmount: bigint;
}

/** The parts of a Fiber channel that decide what it can pay out. */
export interface ChannelLiquidity {
  /** null for a CKB channel. */
  udtTypeScript: Script | null;
  ready: boolean;
  localBalance: bigint;
}

/** The hub's balances on both nodes at one moment. */
export interface LiquiditySnapshot {
  lightningSats: bigint;
  fiberChannels: readonly ChannelLiquidity[];
}

/** A quote before it is signed: every field the signature covers. */
export type UnsignedQuote = Omit<Quote, "signature" | "hubPubkey">;
