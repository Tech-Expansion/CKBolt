import { Inject, Injectable } from "@nestjs/common";
import type { Clock } from "../../application/ports/clock.port";
import type { PriceSource, UsdPrices } from "../../application/ports/prices.port";
import { CLOCK } from "../../application/ports/tokens";
import { BINANCE_API, PRICE_SOURCE_NAME, type PricedCoin } from "../../common/constants/price-sources.constants";
import { fetchCoinQuotes, toUsdPrices, type CoinQuote } from "./coin-quotes";
import { buildUrl, PRICE_HTTP_CLIENT, type JsonHttpClient } from "./json-http.client";
import { binanceTickerSchema, parsePayload } from "./price-payloads";

/**
 * Binance spot last price against USDT, one request per coin; a coin whose request fails is left out (fetchCoinQuotes).
 * Binance states no time, so `at` is when it answered.
 */
@Injectable()
export class BinancePriceSource implements PriceSource {
  readonly name = PRICE_SOURCE_NAME.BINANCE;

  constructor(
    @Inject(PRICE_HTTP_CLIENT) private readonly http: JsonHttpClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async fetch(): Promise<UsdPrices> {
    const quotes = await fetchCoinQuotes((coin) => this.fetchCoin(coin));
    return toUsdPrices(this.name, quotes, this.clock.now());
  }

  private async fetchCoin(coin: PricedCoin): Promise<CoinQuote> {
    const symbol = BINANCE_API.symbols[coin];
    const payload = await this.http.getJson(buildUrl(BINANCE_API.url, { [BINANCE_API.symbolParam]: symbol }));
    const ticker = parsePayload(binanceTickerSchema(symbol), payload, this.name);
    return { usd: ticker.price, at: null };
  }
}
