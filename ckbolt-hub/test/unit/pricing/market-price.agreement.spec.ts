import {
  aggregateCoinPrice,
  aggregateMarketPrice,
  ANY_FRESH_SAMPLE,
  type PriceAgreement,
  type SourcePrice,
} from "../../../src/domain/pricing";

/**
 * Security review H6: a coin's price is the median of the largest group of fresh samples that agree within
 * `maxSpreadBps` (highest less lowest, in basis points of the group's median), and that group needs at least
 * `minSources` samples. So one wrong or pushed feed can neither set the price, nor move it, nor block it while the others
 * agree. Groups are runs of the samples sorted by price; two equally large groups that share no sample are two markets
 * (null); of overlapping ones, the group whose median is nearest the median of every sample wins. `sources` lists the
 * samples used, in the sources' configured order; `at` is the oldest of them. ANY_FRESH_SAMPLE (the default argument)
 * keeps the old rule: any one fresh sample makes a price, at the median of all of them.
 */

const NOW = Date.UTC(2026, 10, 20, 12);
/** 120 seconds, the default PRICE_MAX_AGE_SECONDS. */
const MAX_PRICE_AGE_MS = 120_000;
const WINDOW = { now: NOW, maxAgeMs: MAX_PRICE_AGE_MS };
/** The defaults: PRICE_MIN_SOURCES=2, PRICE_MAX_SPREAD_BPS=300. */
const AGREEMENT: PriceAgreement = { minSources: 2, maxSpreadBps: 300 };

const BTC_USD = 80_000;
/** 300 bps of BTC_USD: samples this far apart around it are exactly at the default limit. */
const BTC_SPREAD_AT_LIMIT = 2_400;
const CKB_USD = 0.002;

/** One source's prices, both coins `ageMs` old; null leaves a coin out (its feed is down at that source). */
const sample = (source: string, btc: number | null, ckb: number | null = CKB_USD, ageMs = 0): SourcePrice => ({
  source,
  btc: btc === null ? null : { usd: btc, at: NOW - ageMs },
  ckb: ckb === null ? null : { usd: ckb, at: NOW - ageMs },
});

const btcPrice = (samples: SourcePrice[], agreement: PriceAgreement = AGREEMENT) => aggregateCoinPrice(samples, "btc", WINDOW, agreement);

describe("aggregateCoinPrice with an agreement (security review H6)", () => {
  describe("minSources", () => {
    it("gives null for one fresh sample when two are needed", () => {
      expect(btcPrice([sample("a", BTC_USD)])).toBeNull();
    });

    it("gives null for no sample at all", () => {
      expect(btcPrice([])).toBeNull();
    });

    it("gives null for two fresh samples when three are needed, and a price for three", () => {
      const three: PriceAgreement = { ...AGREEMENT, minSources: 3 };
      expect(btcPrice([sample("a", BTC_USD), sample("b", BTC_USD)], three)).toBeNull();
      expect(btcPrice([sample("a", BTC_USD), sample("b", BTC_USD), sample("c", BTC_USD)], three)?.sources).toEqual(["a", "b", "c"]);
    });

    it("prices from exactly the minimum", () => {
      expect(btcPrice([sample("a", BTC_USD), sample("b", BTC_USD)])).toEqual({ usd: BTC_USD, at: NOW, sources: ["a", "b"] });
    });

    it("counts only the sources that have the coin: one with BTC down leaves too few", () => {
      expect(btcPrice([sample("a", BTC_USD), sample("b", null)])).toBeNull();
    });

    it("counts only usable samples: a zero or NaN price is no source", () => {
      expect(btcPrice([sample("a", BTC_USD), sample("zero", 0), sample("nan", Number.NaN)])).toBeNull();
    });
  });

  describe("maxSpreadBps", () => {
    const LOW = BTC_USD - BTC_SPREAD_AT_LIMIT / 2;
    const HIGH = BTC_USD + BTC_SPREAD_AT_LIMIT / 2;

    it("prices samples exactly maxSpreadBps apart (highest less lowest, in bps of the median)", () => {
      expect(btcPrice([sample("low", LOW), sample("mid", BTC_USD), sample("high", HIGH)])?.usd).toBe(BTC_USD);
    });

    it("splits samples one dollar further apart than maxSpreadBps: low and mid agree, nearer the overall median", () => {
      // {low, mid, high} spans 2,401 (300.1 bps): too wide. {low, mid} (median 79,400) and {mid, high} (80,600.5) both
      // agree; the median of all three is 80,000, 600 from the first and 600.5 from the second.
      expect(btcPrice([sample("low", LOW), sample("mid", BTC_USD), sample("high", HIGH + 1)])).toEqual({
        usd: (LOW + BTC_USD) / 2,
        at: NOW,
        sources: ["low", "mid"],
      });
    });

    it("leaves out one outlier among agreeing sources: it cannot move the price, and it is not named", () => {
      expect(btcPrice([sample("a", BTC_USD), sample("b", BTC_USD), sample("pushed", BTC_USD * 2)])).toEqual({ usd: BTC_USD, at: NOW, sources: ["a", "b"] });
    });

    it("measures two sources against their average, the median of two", () => {
      // 79,000 and 81,400: 2,400 apart, about 299 bps of their average, 80,200.
      expect(btcPrice([sample("a", 79_000), sample("b", 81_400)])?.usd).toBe(80_200);
      // 79,000 and 81,500: 2,500 apart, 311 bps of 80,250.
      expect(btcPrice([sample("a", 79_000), sample("b", 81_500)])).toBeNull();
    });

    it("takes identical samples (a spread of 0)", () => {
      expect(btcPrice([sample("a", BTC_USD), sample("b", BTC_USD)], { minSources: 2, maxSpreadBps: 1 })?.usd).toBe(BTC_USD);
    });

    it("judges CKB-sized prices the same way: 1 % apart is in, 4 % apart is out", () => {
      const ckb = (samples: SourcePrice[]) => aggregateCoinPrice(samples, "ckb", WINDOW, AGREEMENT);
      expect(ckb([sample("a", BTC_USD, 0.00199), sample("b", BTC_USD, 0.00201)])?.usd).toBe(CKB_USD);
      expect(ckb([sample("a", BTC_USD, 0.00196), sample("b", BTC_USD, 0.00204)])).toBeNull();
    });

    it("prices CKB-sized samples exactly maxSpreadBps apart", () => {
      const samples = [sample("low", BTC_USD, 0.00197), sample("mid", BTC_USD, CKB_USD), sample("high", BTC_USD, 0.00203)];
      expect(aggregateCoinPrice(samples, "ckb", WINDOW, AGREEMENT)?.usd).toBe(CKB_USD);
    });
  });

  describe("freshness", () => {
    it("ignores a sample older than the max age: it neither counts towards minSources nor appears in sources", () => {
      const stale = sample("stale", BTC_USD * 2, CKB_USD, MAX_PRICE_AGE_MS + 1);
      expect(btcPrice([sample("a", BTC_USD), stale])).toBeNull();
      expect(btcPrice([sample("a", BTC_USD), sample("b", BTC_USD), stale])).toEqual({ usd: BTC_USD, at: NOW, sources: ["a", "b"] });
    });

    it("keeps a sample exactly the max age old, and dates the price with it", () => {
      const price = btcPrice([sample("a", BTC_USD), sample("edge", BTC_USD, CKB_USD, MAX_PRICE_AGE_MS)]);
      expect(price).toEqual({ usd: BTC_USD, at: NOW - MAX_PRICE_AGE_MS, sources: ["a", "edge"] });
    });
  });

  describe("the median, as before", () => {
    it("takes the middle of three agreeing samples, dated with the oldest and naming every source in order", () => {
      const price = btcPrice([sample("a", 80_100, CKB_USD, 5_000), sample("b", 79_900, CKB_USD, 30_000), sample("c", BTC_USD, CKB_USD, 1_000)]);
      expect(price).toEqual({ usd: BTC_USD, at: NOW - 30_000, sources: ["a", "b", "c"] });
    });

    it("averages the two middle samples of an even count", () => {
      expect(btcPrice([sample("a", 79_900), sample("b", 80_000), sample("c", 80_200), sample("d", 80_300)])?.usd).toBe(80_100);
    });
  });
});

describe("aggregateCoinPrice: the largest agreeing group (security review H6)", () => {
  it("lets the agreeing majority set the price, with an outlier above it left out", () => {
    const samples = [sample("a", 80_000), sample("b", 80_100), sample("c", 79_900), sample("pushed", 90_000)];
    expect(btcPrice(samples)).toEqual({ usd: 80_000, at: NOW, sources: ["a", "b", "c"] });
  });

  it("leaves out an outlier below the majority the same way", () => {
    const samples = [sample("dumped", 40_000), sample("a", 80_000), sample("b", 80_100), sample("c", 79_900)];
    expect(btcPrice(samples)?.sources).toEqual(["a", "b", "c"]);
  });

  it("dates the price with the oldest sample used, not with an older outlier left out", () => {
    const samples = [sample("a", BTC_USD, CKB_USD, 10_000), sample("b", BTC_USD, CKB_USD, 20_000), sample("old-outlier", BTC_USD * 2, CKB_USD, 90_000)];
    expect(btcPrice(samples)?.at).toBe(NOW - 20_000);
  });

  it("gives null for two equally large groups far apart that share no sample: two markets, not one", () => {
    const samples = [sample("a", 80_000), sample("b", 80_100), sample("c", 120_000), sample("d", 120_100)];
    expect(btcPrice(samples)).toBeNull();
  });

  it("gives null for three sources that all disagree, even with minSources 1: three markets of one", () => {
    expect(btcPrice([sample("a", 80_000), sample("b", 120_000), sample("c", 160_000)], { minSources: 1, maxSpreadBps: AGREEMENT.maxSpreadBps })).toBeNull();
  });

  it("takes the larger of two groups far apart", () => {
    const samples = [sample("a", 80_000), sample("b", 80_100), sample("c", 79_900), sample("d", 120_000), sample("e", 120_100)];
    expect(btcPrice(samples)).toEqual({ usd: 80_000, at: NOW, sources: ["a", "b", "c"] });
  });

  describe("overlapping groups of the same size: the one whose median is nearest the median of every sample", () => {
    // In both cases a and c are more than 300 bps apart, so no group of three agrees; {a, b} and {b, c} both do and
    // share b, whose price (80,000) is the median of all three.
    it("picks {b, c} when it lies nearer: 80,250 is 250 from 80,000, 79,000 is 1,000 away", () => {
      expect(btcPrice([sample("a", 78_000), sample("b", 80_000), sample("c", 80_500)])).toEqual({ usd: 80_250, at: NOW, sources: ["b", "c"] });
    });

    it("picks {a, b} when it lies nearer: 79,750 is 250 from 80,000, 81,000 is 1,000 away", () => {
      expect(btcPrice([sample("a", 79_500), sample("b", 80_000), sample("c", 82_000)])).toEqual({ usd: 79_750, at: NOW, sources: ["a", "b"] });
    });
  });

  it("gives null for a chain of overlapping pairs whose two ends share no sample", () => {
    // 125 bps steps: every neighbouring pair agrees, no three do, and {a, b} and {c, d} are disjoint.
    const NARROW: PriceAgreement = { minSources: 2, maxSpreadBps: 150 };
    expect(btcPrice([sample("a", 79_000), sample("b", 80_000), sample("c", 81_000), sample("d", 82_000)], NARROW)).toBeNull();
  });

  describe("minSources applies to the group, not to the fresh samples", () => {
    it("gives null when three are needed and only two of three fresh samples agree", () => {
      const three: PriceAgreement = { ...AGREEMENT, minSources: 3 };
      expect(btcPrice([sample("a", BTC_USD), sample("b", BTC_USD), sample("pushed", BTC_USD * 2)], three)).toBeNull();
    });

    it("prices from a group of exactly minSources among more fresh samples", () => {
      expect(btcPrice([sample("a", BTC_USD), sample("b", BTC_USD), sample("pushed", BTC_USD * 2)])?.sources).toEqual(["a", "b"]);
    });
  });

  it("lists the sources used in their configured order, not by price", () => {
    const samples = [sample("kucoin", 80_100), sample("pushed", 90_000), sample("coingecko", 79_900), sample("binance", 80_000)];
    expect(btcPrice(samples)?.sources).toEqual(["kucoin", "coingecko", "binance"]);
  });

  it("prices CKB-sized samples exactly maxSpreadBps apart as one group of three", () => {
    const samples = [sample("high", BTC_USD, 0.00203), sample("low", BTC_USD, 0.00197), sample("mid", BTC_USD, CKB_USD)];
    expect(aggregateCoinPrice(samples, "ckb", WINDOW, AGREEMENT)).toEqual({ usd: CKB_USD, at: NOW, sources: ["high", "low", "mid"] });
  });
});

describe("aggregateMarketPrice with an agreement (security review H6)", () => {
  it("applies the agreement to each coin on its own: BTC agreed, CKB not", () => {
    const market = aggregateMarketPrice([sample("a", BTC_USD, CKB_USD), sample("b", BTC_USD, CKB_USD * 2)], WINDOW, AGREEMENT);
    expect(market).toEqual({ btc: { usd: BTC_USD, at: NOW, sources: ["a", "b"] }, ckb: null });
  });

  it("gives null for both coins with one source", () => {
    expect(aggregateMarketPrice([sample("only", BTC_USD)], WINDOW, AGREEMENT)).toEqual({ btc: null, ckb: null });
  });
});

describe("ANY_FRESH_SAMPLE (no agreement: the default argument)", () => {
  it("needs one source and allows any spread", () => {
    expect(ANY_FRESH_SAMPLE).toEqual({ minSources: 1, maxSpreadBps: Number.POSITIVE_INFINITY });
  });

  it("is what aggregateCoinPrice and aggregateMarketPrice use without an agreement", () => {
    const samples = [sample("a", BTC_USD), sample("pushed", BTC_USD * 10)];
    expect(aggregateCoinPrice(samples, "btc", WINDOW)).toEqual(aggregateCoinPrice(samples, "btc", WINDOW, ANY_FRESH_SAMPLE));
    expect(aggregateMarketPrice(samples, WINDOW)).toEqual(aggregateMarketPrice(samples, WINDOW, ANY_FRESH_SAMPLE));
  });

  it("prices from a single fresh sample", () => {
    expect(btcPrice([sample("only", BTC_USD)], ANY_FRESH_SAMPLE)).toEqual({ usd: BTC_USD, at: NOW, sources: ["only"] });
  });

  it("prices samples however far apart, at their median", () => {
    expect(btcPrice([sample("a", BTC_USD), sample("b", BTC_USD * 3)], ANY_FRESH_SAMPLE)?.usd).toBe(BTC_USD * 2);
  });

  it("keeps an outlier in the group, as before: the median of every sample, naming every source", () => {
    const samples = [sample("a", 80_000), sample("evil", 1_000_000), sample("c", 81_000)];
    expect(btcPrice(samples, ANY_FRESH_SAMPLE)).toEqual({ usd: 81_000, at: NOW, sources: ["a", "evil", "c"] });
  });

  it("still gives null when no sample is fresh", () => {
    expect(btcPrice([sample("old", BTC_USD, CKB_USD, MAX_PRICE_AGE_MS + 1)], ANY_FRESH_SAMPLE)).toBeNull();
  });
});
