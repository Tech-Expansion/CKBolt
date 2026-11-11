/**
 * Public market-data endpoints the hub reads USD prices from, and how each names BTC and CKB. These mirror the CKBolt
 * web app's /api/rate route. Which sources are used, in which order, is config (PRICE_SOURCES); USDT quotes are taken
 * as USD, as the web app does.
 */

/** Names used in PRICE_SOURCES and in `UsdPrices.source`. */
export const PRICE_SOURCE_NAME = {
  COINGECKO: "coingecko",
  BINANCE: "binance",
  KUCOIN: "kucoin",
} as const;

export type PriceSourceName = (typeof PRICE_SOURCE_NAME)[keyof typeof PRICE_SOURCE_NAME];

/** Coins every price source quotes in USD; the keys of `UsdPrices`. */
export const PRICED_COIN = {
  BTC: "btc",
  CKB: "ckb",
} as const;

export type PricedCoin = (typeof PRICED_COIN)[keyof typeof PRICED_COIN];

/** Every priced coin, BTC first. */
export const PRICED_COINS: readonly PricedCoin[] = [PRICED_COIN.BTC, PRICED_COIN.CKB];

/** Request headers for every price API call. */
export const PRICE_HTTP_HEADERS = { accept: "application/json" } as const;

/** CoinGecko simple price API: one request for both coins, with each coin's last update time in seconds. */
export const COINGECKO_API = {
  url: "https://api.coingecko.com/api/v3/simple/price",
  coinIds: { btc: "bitcoin", ckb: "nervos-network" },
  idsParam: "ids",
  idsSeparator: ",",
  fixedParams: { vs_currencies: "usd", include_last_updated_at: "true" },
} as const satisfies { coinIds: Record<PricedCoin, string> } & Record<string, unknown>;

/** Binance spot ticker, one request per symbol, no timestamp. Binance answers HTTP 451 to US-hosted servers. */
export const BINANCE_API = {
  url: "https://api.binance.com/api/v3/ticker/price",
  symbolParam: "symbol",
  symbols: { btc: "BTCUSDT", ckb: "CKBUSDT" },
} as const satisfies { symbols: Record<PricedCoin, string> } & Record<string, unknown>;

/** KuCoin level-1 order book, one request per symbol, with the quote time in ms. */
export const KUCOIN_API = {
  url: "https://api.kucoin.com/api/v1/market/orderbook/level1",
  symbolParam: "symbol",
  symbols: { btc: "BTC-USDT", ckb: "CKB-USDT" },
  successCode: "200000",
} as const satisfies { symbols: Record<PricedCoin, string> } & Record<string, unknown>;
