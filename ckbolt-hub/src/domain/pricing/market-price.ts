import { PRICED_COINS, type PricedCoin } from "../../common/constants/price-sources.constants";
import {
  BASIS_POINTS_PER_WHOLE,
  PRICE_SPREAD_TOLERANCE_BPS,
  MEDIAN_LABEL_SEPARATOR,
  MEDIAN_PRICE_LABEL,
  PRICE_SCALE_DECIMALS,
  PRICE_SOURCE_LIST_SEPARATOR,
} from "../../common/constants/pricing.constants";
import { median, roundToDecimals } from "../../common/utils/pricing.util";
import type { CoinPrice, CoinSample, FreshnessWindow, MarketPrice, PriceAgreement, SourcePrice } from "./pricing.types";

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

/** No agreement rule: any one fresh sample makes a price. The hub's configuration sets a real one (PRICE_MIN_SOURCES). */
export const ANY_FRESH_SAMPLE: PriceAgreement = { minSources: 1, maxSpreadBps: Number.POSITIVE_INFINITY };

type PricedSample = CoinSample & { source: string };

/** Highest less lowest, in basis points of the group's median. */
const spreadBps = (values: readonly number[]): number =>
  ((Math.max(...values) - Math.min(...values)) / median(values)) * Number(BASIS_POINTS_PER_WHOLE);

const agrees = (group: readonly PricedSample[], maxSpreadBps: number): boolean =>
  spreadBps(group.map((sample) => sample.usd)) <= maxSpreadBps + PRICE_SPREAD_TOLERANCE_BPS;

/**
 * The largest group of samples that agree within `maxSpreadBps`, so one wrong or pushed feed among agreeing ones is left
 * out instead of setting or blocking the price. Groups are runs of the samples sorted by price. Two equally large groups
 * that share no sample are two markets, not one: null. Of overlapping ones, the group whose median is nearest the median
 * of every sample wins.
 */
function agreeingGroup(samples: readonly PricedSample[], maxSpreadBps: number): PricedSample[] | null {
  const sorted = [...samples].sort((a, b) => a.usd - b.usd);
  const groups: PricedSample[][] = [];
  for (let start = 0; start < sorted.length; start++) {
    for (let end = start + 1; end <= sorted.length; end++) {
      const group = sorted.slice(start, end);
      if (agrees(group, maxSpreadBps)) groups.push(group);
    }
  }
  const largest = Math.max(...groups.map((group) => group.length));
  const candidates = groups.filter((group) => group.length === largest);
  const disjoint = candidates.some((a) => candidates.some((b) => a !== b && !a.some((sample) => b.includes(sample))));
  if (disjoint) return null;
  const middle = median(sorted.map((sample) => sample.usd));
  const distance = (group: readonly PricedSample[]): number => Math.abs(median(group.map((sample) => sample.usd)) - middle);
  return candidates.reduce((best, group) => (distance(group) < distance(best) ? group : best));
}

/**
 * One coin's market price: the median of the largest group of fresh samples that agree within `agreement.maxSpreadBps`
 * (rounded to PRICE_SCALE_DECIMALS places), timestamped with the oldest sample used so a quote never claims a price is
 * newer than it is. null when that group has fewer than `agreement.minSources` samples, or when no group stands out.
 */
export function aggregateCoinPrice(
  samples: readonly SourcePrice[],
  coin: PricedCoin,
  window: FreshnessWindow,
  agreement: PriceAgreement = ANY_FRESH_SAMPLE,
): CoinPrice | null {
  const fresh = samples.flatMap((sample): PricedSample[] => {
    const coinSample = sample[coin];
    return isFreshSample(coinSample, window) ? [{ ...coinSample, source: sample.source }] : [];
  });
  if (fresh.length === 0 || fresh.length < agreement.minSources) return null;
  const group = agreeingGroup(fresh, agreement.maxSpreadBps);
  if (group === null || group.length < agreement.minSources) return null;
  const used = fresh.filter((sample) => group.includes(sample)); // in the sources' configured order
  return {
    usd: medianPrice(used.map((sample) => sample.usd)),
    at: Math.min(...used.map((sample) => sample.at)),
    sources: used.map((sample) => sample.source),
  };
}

/**
 * The market price a quote uses, per coin and each on its own: a source without a usable CKB price still counts for
 * BTC, so assets valued without CKB stay quotable while the CKB feeds are down.
 */
export const aggregateMarketPrice = (
  samples: readonly SourcePrice[],
  window: FreshnessWindow,
  agreement: PriceAgreement = ANY_FRESH_SAMPLE,
): MarketPrice => Object.fromEntries(PRICED_COINS.map((coin) => [coin, aggregateCoinPrice(samples, coin, window, agreement)])) as MarketPrice;
