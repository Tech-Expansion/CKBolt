import { Logger } from "@nestjs/common";
import { MarketPriceService } from "../../../src/application/pricing/market-price.service";
import type { PriceSource, UsdPrices } from "../../../src/application/ports/prices.port";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { HubError } from "../../../src/common/errors/hub.error";
import { loadHubConfig } from "../../../src/config/hub.config";
import { FakeClock, FakePriceSource } from "../../fakes";

const BTC_USD = 80_000;
const CKB_USD = 0.002;
/** 10 minutes, the default PRICE_MAX_AGE_SECONDS. */
const MAX_PRICE_AGE_MS = 10 * 60_000;
const MS_PER_SECOND = 1_000;

/** The action throws a 503 quote_unavailable HubError. */
async function expectQuoteUnavailable(action: () => Promise<unknown>): Promise<void> {
  const thrown = await action().then(
    () => null,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(HubError);
  expect({ status: (thrown as HubError).status, code: (thrown as HubError).code }).toEqual({ status: 503, code: API_ERROR_CODE.QUOTE_UNAVAILABLE });
}

describe("MarketPriceService (per coin)", () => {
  let clock: FakeClock;
  let warn: jest.SpyInstance;

  const serviceWith = (sources: PriceSource[], maxPriceAgeMs = MAX_PRICE_AGE_MS, priceCacheMs = 0) =>
    new MarketPriceService(
      sources,
      clock,
      loadHubConfig({ PRICE_MAX_AGE_SECONDS: String(maxPriceAgeMs / MS_PER_SECOND), PRICE_CACHE_MS: String(priceCacheMs) }),
    );

  beforeEach(() => {
    clock = new FakeClock();
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("returns each coin's median over every source, dated and labelled per coin", async () => {
    const sources = [
      new FakePriceSource("coingecko", clock, { btc: 80_000, ckb: 0.002 }),
      new FakePriceSource("binance", clock, { btc: 82_000, ckb: 0.0024 }),
      new FakePriceSource("kucoin", clock, { btc: 81_000, ckb: 0.0019 }),
    ];

    expect(await serviceWith(sources).current()).toEqual({
      btc: { usd: 81_000, at: clock.now(), sources: ["coingecko", "binance", "kucoin"] },
      ckb: { usd: 0.002, at: clock.now(), sources: ["coingecko", "binance", "kucoin"] },
    });
  });

  describe("with the CKB feeds down at every source", () => {
    const ckbDown = () => ["coingecko", "binance", "kucoin"].map((name) => new FakePriceSource(name, clock, { btc: BTC_USD, ckb: null }));

    it("still answers with BTC, and CKB null, instead of failing", async () => {
      expect(await serviceWith(ckbDown()).current()).toEqual({
        btc: { usd: BTC_USD, at: clock.now(), sources: ["coingecko", "binance", "kucoin"] },
        ckb: null,
      });
    });

    it("logs which source has no CKB price", async () => {
      await serviceWith(ckbDown()).current();

      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/binance has no ckb price/));
    });
  });

  it("uses each coin from the sources that price it usably", async () => {
    const zeroBtc = new FakePriceSource("coingecko", clock, { btc: 0, ckb: CKB_USD });
    const nanCkb = new FakePriceSource("binance", clock, { btc: BTC_USD, ckb: Number.NaN });

    expect(await serviceWith([zeroBtc, nanCkb]).current()).toEqual({
      btc: { usd: BTC_USD, at: clock.now(), sources: ["binance"] },
      ckb: { usd: CKB_USD, at: clock.now(), sources: ["coingecko"] },
    });
  });

  it("asks every source on every call when the cache is off (PRICE_CACHE_MS=0)", async () => {
    const source = new FakePriceSource("coingecko", clock);
    const fetch = jest.spyOn(source, "fetch");
    const service = serviceWith([source]);

    await service.current();
    source.prices = { btc: 90_000, ckb: 0.003 };
    const second = await service.current();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect([second.btc?.usd, second.ckb?.usd]).toEqual([90_000, 0.003]);
  });

  describe("price cache (config.pricing.priceCacheMs)", () => {
    const CACHE_MS = 15_000;

    it("reuses a fetched price within the cache window and fetches again once it has passed", async () => {
      const source = new FakePriceSource("coingecko", clock);
      const fetch = jest.spyOn(source, "fetch");
      const service = serviceWith([source], MAX_PRICE_AGE_MS, CACHE_MS);

      const first = await service.current();
      source.prices = { btc: 90_000, ckb: 0.003 };
      clock.advance(CACHE_MS - 1);
      expect(await service.current()).toEqual(first);
      expect(fetch).toHaveBeenCalledTimes(1);

      clock.advance(1);
      expect((await service.current()).btc?.usd).toBe(90_000);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("reuses a price without CKB too, so a CKB outage does not hammer the sources", async () => {
      const source = new FakePriceSource("coingecko", clock, { btc: BTC_USD, ckb: null });
      const fetch = jest.spyOn(source, "fetch");
      const service = serviceWith([source], MAX_PRICE_AGE_MS, CACHE_MS);

      await service.current();
      source.prices = { btc: BTC_USD, ckb: CKB_USD };
      expect((await service.current()).ckb).toBeNull();
      clock.advance(CACHE_MS);
      expect((await service.current()).ckb?.usd).toBe(CKB_USD);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("shares one round of source requests between concurrent calls", async () => {
      const source = new FakePriceSource("coingecko", clock);
      const fetch = jest.spyOn(source, "fetch");
      const service = serviceWith([source], MAX_PRICE_AGE_MS, CACHE_MS);

      const prices = await Promise.all([service.current(), service.current(), service.current()]);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(prices[1]).toBe(prices[0]);
      expect(prices[2]).toBe(prices[0]);
    });

    it("does not reuse a cached price once a coin in it is older than maxPriceAgeMs", async () => {
      const source = new FakePriceSource("coingecko", clock, { btc: BTC_USD, ckb: CKB_USD, ageMs: MAX_PRICE_AGE_MS - 1_000 });
      const fetch = jest.spyOn(source, "fetch");
      const service = serviceWith([source], MAX_PRICE_AGE_MS, CACHE_MS);

      await service.current();
      clock.advance(1_001);
      source.prices = { btc: 90_000, ckb: 0.003 };

      expect((await service.current()).btc?.usd).toBe(90_000);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("caches no failure: the next call asks the sources again", async () => {
      const source = new FakePriceSource("coingecko", clock);
      source.failing = true;
      const service = serviceWith([source], MAX_PRICE_AGE_MS, CACHE_MS);

      await expectQuoteUnavailable(() => service.current());
      source.failing = false;

      expect((await service.current()).btc?.usd).toBe(BTC_USD);
    });
  });

  it("skips a failing source, logs it, and prices from the others", async () => {
    const down = new FakePriceSource("binance", clock, { btc: 1, ckb: 1 });
    down.failing = true;

    const market = await serviceWith([new FakePriceSource("coingecko", clock), down, new FakePriceSource("kucoin", clock)]).current();

    expect(market.btc).toEqual({ usd: BTC_USD, at: clock.now(), sources: ["coingecko", "kucoin"] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("binance"));
  });

  it("skips a source that throws before returning a promise", async () => {
    const broken: PriceSource = {
      name: "broken",
      fetch: () => {
        throw new Error("misconfigured adapter");
      },
    };

    expect((await serviceWith([broken, new FakePriceSource("kucoin", clock)]).current()).ckb?.sources).toEqual(["kucoin"]);
  });

  it("judges age per coin against the injected clock: a source stuck on an old price goes stale", async () => {
    const stuckAt = clock.now();
    const stuck: PriceSource = {
      name: "stuck",
      fetch: async (): Promise<UsdPrices> => ({ source: "stuck", btc: { usd: BTC_USD, at: stuckAt }, ckb: { usd: CKB_USD, at: stuckAt } }),
    };
    const service = serviceWith([stuck]);

    expect((await service.current()).btc?.at).toBe(stuckAt);
    clock.advance(MAX_PRICE_AGE_MS);
    expect((await service.current()).btc?.at).toBe(stuckAt);
    clock.advance(1);
    await expectQuoteUnavailable(() => service.current());
  });

  it.each([
    ["every source fails", () => ["coingecko", "binance"].map((name) => Object.assign(new FakePriceSource(name, clock), { failing: true }))],
    ["every source is stale", () => [new FakePriceSource("coingecko", clock, { btc: BTC_USD, ckb: CKB_USD, ageMs: MAX_PRICE_AGE_MS + 1 })]],
    ["there are no sources", () => []],
  ])("throws QUOTE_UNAVAILABLE (503) when %s", async (_label, sources: () => PriceSource[]) => {
    await expectQuoteUnavailable(() => serviceWith(sources()).current());
  });
});
