import { Inject, Injectable } from "@nestjs/common";
import type { Clock } from "../../application/ports/clock.port";
import type { PriceSource, UsdPrices } from "../../application/ports/prices.port";
import { CLOCK } from "../../application/ports/tokens";
import { COINGECKO_API, PRICE_SOURCE_NAME, PRICED_COINS } from "../../common/constants/price-sources.constants";
import { secondsToMs } from "../../common/utils/time.util";
import { toUsdPrices, type CoinQuote, type CoinQuotes } from "./coin-quotes";
import { buildUrl, PRICE_HTTP_CLIENT, type JsonHttpClient } from "./json-http.client";
import { coinGeckoCoinSchema, coinGeckoPayloadSchema, parsePayload, unexpectedPayload } from "./price-payloads";

const simplePriceUrl = (): URL =>
  buildUrl(COINGECKO_API.url, {
    [COINGECKO_API.idsParam]: Object.values(COINGECKO_API.coinIds).join(COINGECKO_API.idsSeparator),
    ...COINGECKO_API.fixedParams,
  });

/** One coin's entry of the answer, or null when it is missing or unusable. */
function toCoinQuote(entry: unknown): CoinQuote | null {
  const coin = coinGeckoCoinSchema.safeParse(entry);
  if (!coin.success) return null;
  return { usd: coin.data.usd, at: coin.data.last_updated_at === undefined ? null : secondsToMs(coin.data.last_updated_at) };
}

/**
 * CoinGecko's aggregated USD price for BTC and CKB, in one request. A coin missing from the answer, or unusable, is
 * left out and the other still counts; an answer with no usable coin is refused.
 */
@Injectable()
export class CoinGeckoPriceSource implements PriceSource {
  readonly name = PRICE_SOURCE_NAME.COINGECKO;

  constructor(
    @Inject(PRICE_HTTP_CLIENT) private readonly http: JsonHttpClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async fetch(): Promise<UsdPrices> {
    const payload = parsePayload(coinGeckoPayloadSchema, await this.http.getJson(simplePriceUrl()), this.name);
    const quotes = Object.fromEntries(PRICED_COINS.map((coin) => [coin, toCoinQuote(payload[COINGECKO_API.coinIds[coin]])])) as CoinQuotes;
    if (PRICED_COINS.every((coin) => quotes[coin] === null)) throw unexpectedPayload(this.name);
    return toUsdPrices(this.name, quotes, this.clock.now());
  }
}
