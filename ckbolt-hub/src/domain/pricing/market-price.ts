import { PRICED_COINS, type PricedCoin } from "../../common/constants/price-sources.constants";
import {
  MEDIAN_LABEL_SEPARATOR,
  MEDIAN_PRICE_LABEL,
  PRICE_SCALE_DECIMALS,
  PRICE_SOURCE_LIST_SEPARATOR,
} from "../../common/constants/pricing.constants";
import { median, roundToDecimals } from "../../common/utils/pricing.util";
import type { CoinPrice, CoinSample, FreshnessWindow, MarketPrice, SourcePrice } from "./pricing.types";

const isUsablePrice = (value: number): boolean => Number.isFinite(value) && value > 0;

/** Median rounded to the precision the amount maths keeps, so a quote states exactly the price its amounts use. */
const medianPrice = (values: readonly number[]): number => roundToDecimals(median(values), PRICE_SCALE_DECIMALS);

/** A coin's sample counts when its price is positive and finite and it is at most `maxAgeMs` old at `now`. */
export const isFreshSample = (sample: CoinSample | null, window: FreshnessWindow): sample is CoinSample =>
  sample !== null && isUsablePrice(sample.usd) && Number.isFinite(sample.at) && window.now - sample.at <= window.maxAgeMs;

/** A market price is still usable while every coin it has is at most `maxAgeMs` old at `now`. */
export const isFreshMarketPrice = (price: MarketPrice, window: FreshnessWindow): boolean =>
  PRICED_COINS.every((coin) => {
    const coinPrice = price[coin];
    return coinPrice === null || window.now - coinPrice.at <= window.maxAgeMs;
  });

/** True when at least one coin has a price, so some asset can be quoted. */
export const hasAnyCoinPrice = (price: MarketPrice): boolean => PRICED_COINS.some((coin) => price[coin] !== null);

/** `Quote.priceSource` for a median of these sources: "median:coingecko,binance". */
export const describeMedianSource = (sources: readonly string[]): string =>
  `${MEDIAN_PRICE_LABEL}${MEDIAN_LABEL_SEPARATOR}${sources.join(PRICE_SOURCE_LIST_SEPARATOR)}`;

/**
 * One coin's market price: the median of the sources' fresh samples of it (rounded to PRICE_SCALE_DECIMALS places),
 * timestamped with the oldest sample used so a quote never claims a price is newer than it is. null when no sample of
 * the coin is fresh.
 */
export function aggregateCoinPrice(samples: readonly SourcePrice[], coin: PricedCoin, window: FreshnessWindow): CoinPrice | null {
  const fresh = samples.flatMap((sample) => {
    const coinSample = sample[coin];
    return isFreshSample(coinSample, window) ? [{ ...coinSample, source: sample.source }] : [];
  });
  if (fresh.length === 0) return null;

  return {
    usd: medianPrice(fresh.map((sample) => sample.usd)),
    at: Math.min(...fresh.map((sample) => sample.at)),
    sources: fresh.map((sample) => sample.source),
  };
}

/**
 * The market price a quote uses, per coin and each on its own: a source without a usable CKB price still counts for
 * BTC, so assets valued without CKB stay quotable while the CKB feeds are down.
 */
export const aggregateMarketPrice = (samples: readonly SourcePrice[], window: FreshnessWindow): MarketPrice =>
  Object.fromEntries(PRICED_COINS.map((coin) => [coin, aggregateCoinPrice(samples, coin, window)])) as MarketPrice;
