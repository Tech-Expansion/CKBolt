import { Inject, Injectable } from "@nestjs/common";
import type { Clock } from "../../application/ports/clock.port";
import type { PriceSource, UsdPrices } from "../../application/ports/prices.port";
import { CLOCK } from "../../application/ports/tokens";
import { KUCOIN_API, PRICE_SOURCE_NAME, type PricedCoin } from "../../common/constants/price-sources.constants";
import { fetchCoinQuotes, toUsdPrices, type CoinQuote } from "./coin-quotes";
import { buildUrl, PRICE_HTTP_CLIENT, type JsonHttpClient } from "./json-http.client";
import { kuCoinLevel1Schema, parsePayload } from "./price-payloads";

/**
 * KuCoin spot last price against USDT, one request per coin, with the time KuCoin states; a coin whose request fails is
 * left out (fetchCoinQuotes). A fallback when Binance blocks.
 */
@Injectable()
export class KuCoinPriceSource implements PriceSource {
  readonly name = PRICE_SOURCE_NAME.KUCOIN;

  constructor(
    @Inject(PRICE_HTTP_CLIENT) private readonly http: JsonHttpClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async fetch(): Promise<UsdPrices> {
    const quotes = await fetchCoinQuotes((coin) => this.fetchCoin(coin));
    return toUsdPrices(this.name, quotes, this.clock.now());
  }

  private async fetchCoin(coin: PricedCoin): Promise<CoinQuote> {
    const payload = await this.http.getJson(buildUrl(KUCOIN_API.url, { [KUCOIN_API.symbolParam]: KUCOIN_API.symbols[coin] }));
    const { data } = parsePayload(kuCoinLevel1Schema, payload, this.name);
    return { usd: data.price, at: data.time ?? null };
  }
}
