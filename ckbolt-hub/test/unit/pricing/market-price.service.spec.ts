import { Logger } from "@nestjs/common";
import { MarketPriceService } from "../../../src/application/pricing/market-price.service";
import type { PriceSource, UsdPrices } from "../../../src/application/ports/prices.port";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { HubError } from "../../../src/common/errors/hub.error";
import { loadHubConfig } from "../../../src/config/hub.config";
import { FakeClock, FakePriceSource } from "../../fakes";

const BTC_USD = 80_000;
const CKB_USD = 0.002;
/** 120 seconds, the default PRICE_MAX_AGE_SECONDS. */
const MAX_PRICE_AGE_MS = 120_000;
const MS_PER_SECOND = 1_000;
/** The default agreement: PRICE_MIN_SOURCES=2, PRICE_MAX_SPREAD_BPS=300. */
const MIN_SOURCES = 2;
const MAX_SPREAD_BPS = 300;
/** Prices the sources move to between two calls in these specs. */
const NEW_PRICES = { btc: 90_000, ckb: 0.003 };

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

  const serviceWith = (sources: PriceSource[], maxPriceAgeMs = MAX_PRICE_AGE_MS, priceCacheMs = 0, env: Record<string, string> = {}) =>
    new MarketPriceService(
      sources,
      clock,
      loadHubConfig({ PRICE_MAX_AGE_SECONDS: String(maxPriceAgeMs / MS_PER_SECOND), PRICE_CACHE_MS: String(priceCacheMs), ...env }),
    );
  /** As many sources as a price needs (PRICE_MIN_SOURCES), all at the same prices, so they always agree. */
  const agreeingSources = (prices?: FakePriceSource["prices"]): FakePriceSource[] =>
    ["coingecko", "binance"].map((name) => new FakePriceSource(name, clock, prices && { ...prices }));
  const setAll = (sources: FakePriceSource[], prices: FakePriceSource["prices"]): void => {
    for (const source of sources) source.prices = { ...prices };
  };
  const fetchSpies = (sources: FakePriceSource[]) => sources.map((source) => jest.spyOn(source, "fetch"));
  const expectFetchedTimes = (spies: jest.SpyInstance[], times: number): void => {
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(times);
  };

  beforeEach(() => {
    clock = new FakeClock();
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("returns each coin's median over every source, dated and labelled per coin", async () => {
    const sources = [
      new FakePriceSource("coingecko", clock, { btc: 80_000, ckb: 0.002 }),
      new FakePriceSource("binance", clock, { btc: 82_000, ckb: 0.00202 }),
      new FakePriceSource("kucoin", clock, { btc: 81_000, ckb: 0.00199 }),
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
    const both = new FakePriceSource("kucoin", clock, { btc: BTC_USD, ckb: CKB_USD });

    expect(await serviceWith([zeroBtc, nanCkb, both]).current()).toEqual({
      btc: { usd: BTC_USD, at: clock.now(), sources: ["binance", "kucoin"] },
      ckb: { usd: CKB_USD, at: clock.now(), sources: ["coingecko", "kucoin"] },
    });
  });

  it("asks every source on every call when the cache is off (PRICE_CACHE_MS=0)", async () => {
    const sources = agreeingSources();
    const fetches = fetchSpies(sources);
    const service = serviceWith(sources);

    await service.current();
    setAll(sources, NEW_PRICES);
    const second = await service.current();

    expectFetchedTimes(fetches, 2);
    expect([second.btc?.usd, second.ckb?.usd]).toEqual([NEW_PRICES.btc, NEW_PRICES.ckb]);
  });

  describe("price cache (config.pricing.priceCacheMs)", () => {
    const CACHE_MS = 15_000;

    it("reuses a fetched price within the cache window and fetches again once it has passed", async () => {
      const sources = agreeingSources();
      const fetches = fetchSpies(sources);
      const service = serviceWith(sources, MAX_PRICE_AGE_MS, CACHE_MS);

      const first = await service.current();
      setAll(sources, NEW_PRICES);
      clock.advance(CACHE_MS - 1);
      expect(await service.current()).toEqual(first);
      expectFetchedTimes(fetches, 1);

      clock.advance(1);
      expect((await service.current()).btc?.usd).toBe(NEW_PRICES.btc);
      expectFetchedTimes(fetches, 2);
    });

    it("reuses a price without CKB too, so a CKB outage does not hammer the sources", async () => {
      const sources = agreeingSources({ btc: BTC_USD, ckb: null });
      const fetches = fetchSpies(sources);
      const service = serviceWith(sources, MAX_PRICE_AGE_MS, CACHE_MS);

      await service.current();
      setAll(sources, { btc: BTC_USD, ckb: CKB_USD });
      expect((await service.current()).ckb).toBeNull();
      clock.advance(CACHE_MS);
      expect((await service.current()).ckb?.usd).toBe(CKB_USD);
      expectFetchedTimes(fetches, 2);
    });

    it("shares one round of source requests between concurrent calls", async () => {
      const sources = agreeingSources();
      const fetches = fetchSpies(sources);
      const service = serviceWith(sources, MAX_PRICE_AGE_MS, CACHE_MS);

      const prices = await Promise.all([service.current(), service.current(), service.current()]);

      expectFetchedTimes(fetches, 1);
      expect(prices[1]).toBe(prices[0]);
      expect(prices[2]).toBe(prices[0]);
    });

    it("does not reuse a cached price once a coin in it is older than maxPriceAgeMs", async () => {
      const AGE_BEFORE_STALE_MS = 1_000;
      const sources = agreeingSources({ btc: BTC_USD, ckb: CKB_USD, ageMs: MAX_PRICE_AGE_MS - AGE_BEFORE_STALE_MS });
      const fetches = fetchSpies(sources);
      const service = serviceWith(sources, MAX_PRICE_AGE_MS, CACHE_MS);

      await service.current();
      clock.advance(AGE_BEFORE_STALE_MS + 1);
      setAll(sources, NEW_PRICES);

      expect((await service.current()).btc?.usd).toBe(NEW_PRICES.btc);
      expectFetchedTimes(fetches, 2);
    });

    it("caches no failure: the next call asks the sources again", async () => {
      const sources = agreeingSources();
      for (const source of sources) source.failing = true;
      const service = serviceWith(sources, MAX_PRICE_AGE_MS, CACHE_MS);

      await expectQuoteUnavailable(() => service.current());
      for (const source of sources) source.failing = false;

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

    const market = await serviceWith([broken, new FakePriceSource("coingecko", clock), new FakePriceSource("kucoin", clock)]).current();

    expect(market.ckb?.sources).toEqual(["coingecko", "kucoin"]);
  });

  it("judges age per coin against the injected clock: a source stuck on an old price goes stale", async () => {
    const stuckAt = clock.now();
    const stuckSource = (name: string): PriceSource => ({
      name,
      fetch: async (): Promise<UsdPrices> => ({ source: name, btc: { usd: BTC_USD, at: stuckAt }, ckb: { usd: CKB_USD, at: stuckAt } }),
    });
    const service = serviceWith([stuckSource("stuck-a"), stuckSource("stuck-b")]);

    expect((await service.current()).btc?.at).toBe(stuckAt);
    clock.advance(MAX_PRICE_AGE_MS);
    expect((await service.current()).btc?.at).toBe(stuckAt);
    clock.advance(1);
    await expectQuoteUnavailable(() => service.current());
  });

  it.each([
    ["every source fails", () => ["coingecko", "binance"].map((name) => Object.assign(new FakePriceSource(name, clock), { failing: true }))],
    ["every source is stale", () => agreeingSources({ btc: BTC_USD, ckb: CKB_USD, ageMs: MAX_PRICE_AGE_MS + 1 })],
    ["there are no sources", () => []],
  ])("throws QUOTE_UNAVAILABLE (503) when %s", async (_label, sources: () => PriceSource[]) => {
    await expectQuoteUnavailable(() => serviceWith(sources()).current());
  });

  describe("agreement between sources (PRICE_MIN_SOURCES, PRICE_MAX_SPREAD_BPS: security review H6)", () => {
    const unagreedWarnings = (): string[] =>
      warn.mock.calls.map(([message]) => String(message)).filter((message) => message.startsWith("No agreed"));

    it("prices no coin from a single fresh source: 503, with a warning naming both coins and the rule", async () => {
      const down = new FakePriceSource("binance", clock);
      down.failing = true;

      await expectQuoteUnavailable(() => serviceWith([new FakePriceSource("coingecko", clock), down]).current());
      expect(unagreedWarnings()).toEqual([
        `No agreed btc, ckb price: fewer than ${MIN_SOURCES} fresh sources, or they differ by more than ${MAX_SPREAD_BPS} bps`,
      ]);
    });

    it("leaves out only the coin whose sources differ by more than PRICE_MAX_SPREAD_BPS, and warns about that coin", async () => {
      const sources = [
        new FakePriceSource("coingecko", clock, { btc: BTC_USD, ckb: CKB_USD }),
        new FakePriceSource("binance", clock, { btc: BTC_USD, ckb: NEW_PRICES.ckb }),
      ];

      const market = await serviceWith(sources).current();

      expect(market).toEqual({ btc: { usd: BTC_USD, at: clock.now(), sources: ["coingecko", "binance"] }, ckb: null });
      expect(unagreedWarnings()).toEqual([expect.stringContaining("No agreed ckb price:")]);
    });

    it("warns about nothing when every coin has an agreed price", async () => {
      await serviceWith(agreeingSources()).current();

      expect(unagreedWarnings()).toEqual([]);
    });

    it("passes PRICE_MIN_SOURCES through: with 3, two agreeing sources are not enough and three are", async () => {
      const env = { PRICE_MIN_SOURCES: "3" };
      await expectQuoteUnavailable(() => serviceWith(agreeingSources(), MAX_PRICE_AGE_MS, 0, env).current());
      expect(unagreedWarnings()).toEqual([expect.stringContaining("fewer than 3 fresh sources")]);

      const three = [...agreeingSources(), new FakePriceSource("kucoin", clock)];
      expect((await serviceWith(three, MAX_PRICE_AGE_MS, 0, env).current()).btc?.sources).toEqual(["coingecko", "binance", "kucoin"]);
    });

    it("passes PRICE_MAX_SPREAD_BPS through: a spread the default takes is refused under a narrower limit", async () => {
      // 80,000 and 81,600: 1,600 apart, about 198 bps of their median (80,800).
      const NARROW_SPREAD_BPS = "100";
      const sources = () => [new FakePriceSource("coingecko", clock, { btc: 80_000, ckb: CKB_USD }), new FakePriceSource("binance", clock, { btc: 81_600, ckb: CKB_USD })];

      expect((await serviceWith(sources()).current()).btc?.usd).toBe(80_800);
      expect((await serviceWith(sources(), MAX_PRICE_AGE_MS, 0, { PRICE_MAX_SPREAD_BPS: NARROW_SPREAD_BPS }).current()).btc).toBeNull();
    });

    it("passes PRICE_MAX_SPREAD_BPS through: a spread the default refuses is taken under a wider limit", async () => {
      // 80,000 and 88,000: 8,000 apart, about 952 bps of their median (84,000).
      const WIDE_SPREAD_BPS = "1000";
      const sources = () => [new FakePriceSource("coingecko", clock, { btc: 80_000, ckb: CKB_USD }), new FakePriceSource("binance", clock, { btc: 88_000, ckb: CKB_USD })];

      expect((await serviceWith(sources()).current()).btc).toBeNull();
      expect((await serviceWith(sources(), MAX_PRICE_AGE_MS, 0, { PRICE_MAX_SPREAD_BPS: WIDE_SPREAD_BPS }).current()).btc?.usd).toBe(84_000);
    });

    it("prices from one source only when PRICE_MIN_SOURCES=1 says so", async () => {
      const market = await serviceWith([new FakePriceSource("kucoin", clock)], MAX_PRICE_AGE_MS, 0, { PRICE_MIN_SOURCES: "1" }).current();

      expect(market.btc).toEqual({ usd: BTC_USD, at: clock.now(), sources: ["kucoin"] });
    });
  });
});
