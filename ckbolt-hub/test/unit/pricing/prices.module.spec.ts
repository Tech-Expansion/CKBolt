import "reflect-metadata";
import { Inject, Injectable, Module } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import type { PriceSource } from "../../../src/application/ports/prices.port";
import { CLOCK, HUB_CONFIG, PRICE_SOURCES } from "../../../src/application/ports/tokens";
import { HubConfigModule } from "../../../src/config/config.module";
import { BinancePriceSource } from "../../../src/infrastructure/prices/binance.price-source";
import { CoinGeckoPriceSource } from "../../../src/infrastructure/prices/coingecko.price-source";
import { PRICE_HTTP_CLIENT, type JsonHttpClient } from "../../../src/infrastructure/prices/json-http.client";
import { KuCoinPriceSource } from "../../../src/infrastructure/prices/kucoin.price-source";
import { selectPriceSources } from "../../../src/infrastructure/prices/price-source.selection";
import { PricesModule } from "../../../src/infrastructure/prices/prices.module";
import { FakeClock } from "../../fakes";
import { hubConfig } from "./pricing.fixtures";

const named = (name: string): PriceSource => ({ name, fetch: () => Promise.reject(new Error("not used")) });
const AVAILABLE = [named("coingecko"), named("binance"), named("kucoin")];

describe("selectPriceSources", () => {
  it("keeps the sources named in config, in config order", () => {
    expect(selectPriceSources(["kucoin", "coingecko"], AVAILABLE).map((s) => s.name)).toEqual(["kucoin", "coingecko"]);
    expect(selectPriceSources(["binance"], AVAILABLE).map((s) => s.name)).toEqual(["binance"]);
  });

  it("ignores case, spaces, empty entries and duplicates", () => {
    expect(selectPriceSources([" KuCoin ", "", "kucoin", "BINANCE"], AVAILABLE).map((s) => s.name)).toEqual(["kucoin", "binance"]);
  });

  it("refuses an empty list, so the hub never starts with no prices", () => {
    expect(() => selectPriceSources([], AVAILABLE)).toThrow(/PRICE_SOURCES/);
    expect(() => selectPriceSources(["", "  "], AVAILABLE)).toThrow(/PRICE_SOURCES/);
  });

  it("refuses an unknown name and lists the known ones", () => {
    expect(() => selectPriceSources(["coingecko", "coinmarketcap"], AVAILABLE)).toThrow(/coinmarketcap.*coingecko, binance, kucoin/);
  });
});

/** Injects PRICE_SOURCES without importing PricesModule, as the pricing module does. */
@Injectable()
class SourcesReader {
  constructor(@Inject(PRICE_SOURCES) readonly sources: PriceSource[]) {}
}

@Module({ providers: [SourcesReader] })
class ConsumerModule {}

describe("PricesModule", () => {
  let moduleRef: TestingModule | undefined;
  const clock = new FakeClock();

  const compile = async (sources: string[], http?: JsonHttpClient): Promise<TestingModule> => {
    let builder = Test.createTestingModule({ imports: [HubConfigModule, PricesModule, ConsumerModule] })
      .overrideProvider(HUB_CONFIG)
      .useValue(hubConfig({ pricing: { sources } }))
      .overrideProvider(CLOCK)
      .useValue(clock);
    if (http) builder = builder.overrideProvider(PRICE_HTTP_CLIENT).useValue(http);
    moduleRef = await builder.compile();
    return moduleRef;
  };

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it("provides every adapter, in the default config order", async () => {
    const sources = (await compile(["coingecko", "binance", "kucoin"])).get<PriceSource[]>(PRICE_SOURCES);

    expect(sources.map((s) => s.name)).toEqual(["coingecko", "binance", "kucoin"]);
    expect(sources[0]).toBeInstanceOf(CoinGeckoPriceSource);
    expect(sources[1]).toBeInstanceOf(BinancePriceSource);
    expect(sources[2]).toBeInstanceOf(KuCoinPriceSource);
  });

  it("filters and orders PRICE_SOURCES by config.pricing.sources", async () => {
    const sources = (await compile(["kucoin", "coingecko"])).get<PriceSource[]>(PRICE_SOURCES);

    expect(sources.map((s) => s.name)).toEqual(["kucoin", "coingecko"]);
  });

  it("is global: another module injects PRICE_SOURCES without importing it", async () => {
    const reader = (await compile(["binance"])).get(SourcesReader);

    expect(reader.sources.map((s) => s.name)).toEqual(["binance"]);
  });

  it("fails to start with an unknown source name", async () => {
    await expect(compile(["coingecko", "nope"])).rejects.toThrow(/nope/);
  });

  it("wires the adapters to the injected HTTP client and clock", async () => {
    const urls: string[] = [];
    const http: JsonHttpClient = {
      getJson: async (url) => {
        urls.push(url.host);
        return { symbol: url.searchParams.get("symbol"), price: "80000" };
      },
    };
    const [binance] = (await compile(["binance"], http)).get<PriceSource[]>(PRICE_SOURCES);

    await expect(binance?.fetch()).resolves.toEqual({ source: "binance", btc: { usd: 80_000, at: clock.now() }, ckb: { usd: 80_000, at: clock.now() } });
    expect(urls).toEqual(["api.binance.com", "api.binance.com"]);
  });
});
