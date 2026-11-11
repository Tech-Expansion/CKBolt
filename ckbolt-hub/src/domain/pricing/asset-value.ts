import { ASSET_USD_RULE } from "../../common/constants/assets.constants";
import { PRICED_COIN, type PricedCoin } from "../../common/constants/price-sources.constants";
import { USD_PEG_PRICE } from "../../common/constants/pricing.constants";
import type { AssetUsdRule } from "../types";
import { describeMedianSource } from "./market-price";
import type { AssetPrice, CoinPrice, MarketPrice } from "./pricing.types";

/** The coin whose market price values one whole asset unit under each rule; null for a USD peg. A new rule is one line. */
const VALUING_COIN_BY_RULE: Readonly<Record<AssetUsdRule, PricedCoin | null>> = {
  [ASSET_USD_RULE.CKB_MARKET]: PRICED_COIN.CKB,
  [ASSET_USD_RULE.USD_PEG]: null,
  [ASSET_USD_RULE.BTC_PARITY]: PRICED_COIN.BTC,
};

/** Every source behind these coin prices, each once, in the order first used. */
const sourcesOf = (prices: readonly CoinPrice[]): string[] => [...new Set(prices.flatMap((price) => price.sources))];

/**
 * The prices a quote in an asset with `rule` uses: BTC/USD for the Lightning leg, and the asset's USD value (CKB at its
 * market price, a USD peg at $1, BTC parity at the BTC price). Only the coins the rule needs must have a fresh price, so
 * a usd_peg or btc_parity asset is quoted while the CKB feeds are down. null when a needed coin has none.
 */
export function assetPriceFor(rule: AssetUsdRule, market: MarketPrice): AssetPrice | null {
  const btc = market[PRICED_COIN.BTC];
  if (!btc) return null;
  const valuingCoin = VALUING_COIN_BY_RULE[rule];
  const valuedBy = valuingCoin === null ? null : market[valuingCoin];
  if (valuingCoin !== null && !valuedBy) return null;

  const used = valuedBy ? [btc, valuedBy] : [btc];
  return {
    btcUsd: btc.usd,
    assetUsd: valuedBy ? valuedBy.usd : USD_PEG_PRICE,
    at: Math.min(...used.map((price) => price.at)),
    source: describeMedianSource(sourcesOf(used)),
  };
}
