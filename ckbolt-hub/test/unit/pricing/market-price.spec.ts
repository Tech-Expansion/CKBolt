import { aggregateCoinPrice, aggregateMarketPrice, describeMedianSource, hasAnyCoinPrice, isFreshMarketPrice, isFreshSample, type SourcePrice } from "../../../src/domain/pricing";

const NOW = Date.UTC(2026, 9, 23, 12);
/** 10 minutes, the default PRICE_MAX_AGE_SECONDS. */
const MAX_PRICE_AGE_MS = 10 * 60_000;
const window = { now: NOW, maxAgeMs: MAX_PRICE_AGE_MS };

/** One source's prices, both coins `ageMs` old; null leaves a coin out (its feed is down at that source). */
const sample = (source: string, btc: number | null, ckb: number | null, ageMs = 0): SourcePrice => ({
  source,
  btc: btc === null ? null : { usd: btc, at: NOW - ageMs },
  ckb: ckb === null ? null : { usd: ckb, at: NOW - ageMs },
});

describe("domain pricing: market price (per coin, median of fresh sources)", () => {
  it("takes the median of each coin independently", () => {
    const market = aggregateMarketPrice([sample("a", 80_000, 0.0025), sample("b", 90_000, 0.002), sample("c", 81_000, 0.0021)], window);

    expect(market.btc?.usd).toBe(81_000);
    expect(market.ckb?.usd).toBe(0.0021);
  });

  it("averages the two middle values when an even number of sources is fresh", () => {
    const market = aggregateMarketPrice([sample("a", 80_000, 0.002), sample("b", 81_000, 0.003)], window);

    expect(market.btc?.usd).toBe(80_500);
    expect(market.ckb?.usd).toBe(0.0025);
  });

  it("uses a single fresh source on its own", () => {
    expect(aggregateMarketPrice([sample("only", 80_000, 0.002)], window)).toEqual({
      btc: { usd: 80_000, at: NOW, sources: ["only"] },
      ckb: { usd: 0.002, at: NOW, sources: ["only"] },
    });
  });

  it("is not moved by one outlier among three sources", () => {
    const market = aggregateMarketPrice([sample("a", 80_000, 0.002), sample("b", 80_100, 0.00201), sample("evil", 1_000_000, 10)], window);

    expect([market.btc?.usd, market.ckb?.usd]).toEqual([80_100, 0.00201]);
  });

  it("ignores samples older than maxPriceAgeMs, and accepts one exactly that old", () => {
    const market = aggregateMarketPrice([sample("fresh", 80_000, 0.002, MAX_PRICE_AGE_MS), sample("stale", 10, 10, MAX_PRICE_AGE_MS + 1)], window);

    expect(market.btc).toEqual({ usd: 80_000, at: NOW - MAX_PRICE_AGE_MS, sources: ["fresh"] });
    expect(market.ckb?.sources).toEqual(["fresh"]);
  });

  it("gives null per coin when no sample of it is fresh, or there are none", () => {
    expect(aggregateMarketPrice([], window)).toEqual({ btc: null, ckb: null });
    expect(aggregateMarketPrice([sample("old", 80_000, 0.002, MAX_PRICE_AGE_MS * 2)], window)).toEqual({ btc: null, ckb: null });
  });

  describe("a coin missing at every source does not take the other coin away (CKB feeds down)", () => {
    const ckbDown = [sample("coingecko", 80_000, null), sample("binance", 80_200, null), sample("kucoin", 80_100, null)];

    it("still prices BTC from every source, and leaves CKB null", () => {
      expect(aggregateMarketPrice(ckbDown, window)).toEqual({ btc: { usd: 80_100, at: NOW, sources: ["coingecko", "binance", "kucoin"] }, ckb: null });
    });

    it("counts as a usable market price", () => {
      expect(hasAnyCoinPrice(aggregateMarketPrice(ckbDown, window))).toBe(true);
      expect(hasAnyCoinPrice({ btc: null, ckb: null })).toBe(false);
    });
  });

  it("takes each coin's median from the sources that have it, so one source's missing coin narrows only that coin", () => {
    const market = aggregateMarketPrice([sample("a", 80_000, null), sample("b", 82_000, 0.002), sample("c", null, 0.004)], window);

    expect(market.btc).toEqual({ usd: 81_000, at: NOW, sources: ["a", "b"] });
    expect(market.ckb).toEqual({ usd: 0.003, at: NOW, sources: ["b", "c"] });
  });

  it("judges freshness per coin: a stale CKB price at a source keeps its fresh BTC price", () => {
    const mixed: SourcePrice = { source: "coingecko", btc: { usd: 80_000, at: NOW - 1_000 }, ckb: { usd: 0.002, at: NOW - MAX_PRICE_AGE_MS - 1 } };

    expect(aggregateMarketPrice([mixed], window)).toEqual({ btc: { usd: 80_000, at: NOW - 1_000, sources: ["coingecko"] }, ckb: null });
  });

  it.each([
    ["zero", 0],
    ["negative", -0.002],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("never uses a %s price, and keeps the other coin of the same source", (_label, bad) => {
    expect(isFreshSample({ usd: bad, at: NOW }, window)).toBe(false);
    expect(aggregateMarketPrice([sample("bad", 80_000, bad)], window)).toEqual({ btc: { usd: 80_000, at: NOW, sources: ["bad"] }, ckb: null });
    expect(aggregateCoinPrice([sample("bad", bad, 0.002), sample("good", 80_000, 0.002)], "btc", window)?.sources).toEqual(["good"]);
  });

  it("never uses a sample whose time is not a number, nor a missing one", () => {
    expect(isFreshSample({ usd: 1, at: Number.NaN }, window)).toBe(false);
    expect(isFreshSample(null, window)).toBe(false);
  });

  it("dates each coin with its oldest fresh sample, so a quote never claims a newer price than it used", () => {
    const market = aggregateMarketPrice(
      [sample("a", 80_000, 0.002, 5_000), sample("b", 80_000, 0.002, 60_000), sample("stale", 80_000, 0.002, MAX_PRICE_AGE_MS + 1)],
      window,
    );

    expect([market.btc?.at, market.ckb?.at]).toEqual([NOW - 60_000, NOW - 60_000]);
  });

  it("names every source it used for a coin and only those", () => {
    const market = aggregateMarketPrice(
      [sample("coingecko", 80_000, 0.002), sample("binance", 80_000, 0.002), sample("kucoin", 80_000, 0.002, MAX_PRICE_AGE_MS + 1)],
      window,
    );

    expect(market.btc?.sources).toEqual(["coingecko", "binance"]);
    expect(describeMedianSource(market.btc?.sources ?? [])).toBe("median:coingecko,binance");
  });

  it("rounds away float noise so the stated price is the price the amounts use", () => {
    expect(aggregateMarketPrice([sample("a", 80_000, 0.0021), sample("b", 80_000, 0.002)], window).ckb?.usd).toBe(0.00205);
  });

  it("is fresh while every coin it has is within maxPriceAgeMs; a missing coin does not make it stale", () => {
    const market = aggregateMarketPrice([sample("a", 80_000, null, 1_000)], window);

    expect(isFreshMarketPrice(market, window)).toBe(true);
    expect(isFreshMarketPrice(market, { ...window, now: NOW + MAX_PRICE_AGE_MS - 1_000 })).toBe(true);
    expect(isFreshMarketPrice(market, { ...window, now: NOW + MAX_PRICE_AGE_MS })).toBe(false);
  });

  it("does not mutate its inputs", () => {
    const samples = Object.freeze([Object.freeze(sample("b", 2, 2)), Object.freeze(sample("a", 1, 1))]);

    expect(() => aggregateMarketPrice(samples, Object.freeze({ ...window }))).not.toThrow();
    expect(samples.map((s) => s.source)).toEqual(["b", "a"]);
  });
});
