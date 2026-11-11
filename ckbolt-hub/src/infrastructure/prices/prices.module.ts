import { Global, Module } from "@nestjs/common";
import type { PriceSource } from "../../application/ports/prices.port";
import { HUB_CONFIG, PRICE_SOURCES } from "../../application/ports/tokens";
import type { HubConfig } from "../../config/hub.config";
import { BinancePriceSource } from "./binance.price-source";
import { CoinGeckoPriceSource } from "./coingecko.price-source";
import { FetchJsonHttpClient, PRICE_HTTP_CLIENT } from "./json-http.client";
import { KuCoinPriceSource } from "./kucoin.price-source";
import { selectPriceSources } from "./price-source.selection";

/** Every price source adapter. A new source is a new adapter class added here and its name in PRICE_SOURCES. */
const PRICE_SOURCE_ADAPTERS = [CoinGeckoPriceSource, BinancePriceSource, KuCoinPriceSource];

/** Provides PRICE_SOURCES: the adapters named in config.pricing.sources, in that order. */
@Global()
@Module({
  providers: [
    { provide: PRICE_HTTP_CLIENT, useClass: FetchJsonHttpClient },
    ...PRICE_SOURCE_ADAPTERS,
    {
      provide: PRICE_SOURCES,
      useFactory: (config: HubConfig, ...adapters: PriceSource[]): PriceSource[] => selectPriceSources(config.pricing.sources, adapters),
      inject: [HUB_CONFIG, ...PRICE_SOURCE_ADAPTERS],
    },
  ],
  exports: [PRICE_SOURCES],
})
export class PricesModule {}
