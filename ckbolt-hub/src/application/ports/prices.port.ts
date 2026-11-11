import type { PricedCoin } from "../../common/constants/price-sources.constants";

/** One coin's USD price per whole coin from a source, and when the source produced it, ms. */
export interface CoinUsdPrice {
  usd: number;
  at: number;
}

/**
 * USD prices from one source, per coin. A coin the source could not price this time is null, so one coin's feed going
 * down leaves the other usable; a source that can price no coin throws instead. RUSD is valued at its $1 peg and cWBTC at
 * 1:1 with BTC by the pricing module, so they need only BTC.
 */
export type UsdPrices = { source: string } & { [coin in PricedCoin]: CoinUsdPrice | null };

export interface PriceSource {
  readonly name: string;
  fetch(): Promise<UsdPrices>;
}
