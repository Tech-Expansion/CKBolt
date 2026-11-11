import type { CoinUsdPrice, UsdPrices } from "../../application/ports/prices.port";
import { PRICED_COINS, type PricedCoin } from "../../common/constants/price-sources.constants";

/** One coin's USD price from a source, and when the source produced it (ms), if it says. */
export interface CoinQuote {
  usd: number;
  at: number | null;
}

/** Each coin's quote; null for a coin the source could not price this time. */
export type CoinQuotes = Record<PricedCoin, CoinQuote | null>;

/**
 * Every coin's quote, fetched in parallel by a source that asks one symbol per request. A coin whose request fails is
 * null, so the other coin still counts; the source fails, with the first coin's error, only when every coin does.
 */
export async function fetchCoinQuotes(fetchCoin: (coin: PricedCoin) => Promise<CoinQuote>): Promise<CoinQuotes> {
  const results = await Promise.allSettled(PRICED_COINS.map((coin) => fetchCoin(coin)));
  const quotes = results.map((result) => (result.status === "fulfilled" ? result.value : null));
  if (quotes.every((quote) => quote === null)) throw (results[0] as PromiseRejectedResult).reason;
  return Object.fromEntries(PRICED_COINS.map((coin, index) => [coin, quotes[index] ?? null])) as CoinQuotes;
}

/** A coin's price dated with the time the source states for it, or `fetchedAt` when it states none (Binance). */
const toCoinUsdPrice = (quote: CoinQuote | null, fetchedAt: number): CoinUsdPrice | null =>
  quote === null ? null : { usd: quote.usd, at: quote.at ?? fetchedAt };

/** The port's UsdPrices: each coin on its own, so its freshness is judged on its own time. */
export const toUsdPrices = (source: string, quotes: CoinQuotes, fetchedAt: number): UsdPrices => ({
  source,
  ...(Object.fromEntries(PRICED_COINS.map((coin) => [coin, toCoinUsdPrice(quotes[coin], fetchedAt)])) as Omit<UsdPrices, "source">),
});
