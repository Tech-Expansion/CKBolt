import type { PriceSource } from "../../../src/application/ports/prices.port";
import { BinancePriceSource } from "../../../src/infrastructure/prices/binance.price-source";
import { CoinGeckoPriceSource } from "../../../src/infrastructure/prices/coingecko.price-source";
import type { JsonHttpClient } from "../../../src/infrastructure/prices/json-http.client";
import { KuCoinPriceSource } from "../../../src/infrastructure/prices/kucoin.price-source";
import { PriceSourceError } from "../../../src/infrastructure/prices/price-source.error";
import { FakeClock } from "../../fakes";

/** Answers GETs from a handler and records every URL asked for, so no test touches the network. */
class FakeHttp implements JsonHttpClient {
  readonly urls: URL[] = [];

  constructor(private readonly answer: (url: URL) => unknown) {}

  async getJson(url: URL): Promise<unknown> {
    this.urls.push(url);
    const body = this.answer(url);
    if (body instanceof Error) throw body;
    return body;
  }
}

const SECOND = 1_000;
/** The same moment the fake clock starts at, as an exchange would state it. */
const clock = new FakeClock();
const NOW = clock.now();
const NOW_S = Math.floor(NOW / SECOND);

/* ------------------------------------------------------------------------------------------- CoinGecko */

/** Shape of https://api.coingecko.com/api/v3/simple/price?ids=...&vs_currencies=usd&include_last_updated_at=true */
const coinGeckoBody = (patch: Record<string, unknown> = {}) => ({
  bitcoin: { usd: 80_123.45, last_updated_at: NOW_S - 30 },
  "nervos-network": { usd: 0.002345, last_updated_at: NOW_S - 90 },
  ...patch,
});

describe("CoinGeckoPriceSource", () => {
  const sourceAnswering = (body: unknown) => {
    const http = new FakeHttp(() => body);
    return { http, source: new CoinGeckoPriceSource(http, clock) };
  };

  it("is named coingecko", () => {
    expect(sourceAnswering(coinGeckoBody()).source.name).toBe("coingecko");
  });

  it("asks the simple price API once for bitcoin and nervos-network in USD, as the web app does", async () => {
    const { http, source } = sourceAnswering(coinGeckoBody());

    await source.fetch();

    expect(http.urls).toHaveLength(1);
    const url = http.urls[0] as URL;
    expect(`${url.origin}${url.pathname}`).toBe("https://api.coingecko.com/api/v3/simple/price");
    expect(url.searchParams.get("ids")?.split(",").sort()).toEqual(["bitcoin", "nervos-network"]);
    expect(url.searchParams.get("vs_currencies")).toBe("usd");
    expect(url.searchParams.get("include_last_updated_at")).toBe("true");
  });

  it("returns each coin's price dated with its own last_updated_at (seconds to ms)", async () => {
    await expect(sourceAnswering(coinGeckoBody()).source.fetch()).resolves.toEqual({
      source: "coingecko",
      btc: { usd: 80_123.45, at: (NOW_S - 30) * SECOND },
      ckb: { usd: 0.002345, at: (NOW_S - 90) * SECOND },
    });
  });

  it("dates a coin that states no time with the injected clock, and the other with its own", async () => {
    const body = coinGeckoBody({ bitcoin: { usd: 80_000 } });

    await expect(sourceAnswering(body).source.fetch()).resolves.toEqual({
      source: "coingecko",
      btc: { usd: 80_000, at: NOW },
      ckb: { usd: 0.002345, at: (NOW_S - 90) * SECOND },
    });
  });

  it("dates with the injected clock when no time is stated", async () => {
    const body = { bitcoin: { usd: 80_000 }, "nervos-network": { usd: 0.002 } };

    await expect(sourceAnswering(body).source.fetch()).resolves.toMatchObject({ btc: { usd: 80_000, at: NOW }, ckb: { usd: 0.002, at: NOW } });
  });

  it("ignores coins it did not ask for", async () => {
    const body = { ...coinGeckoBody(), ethereum: { usd: 3_000 } };

    await expect(sourceAnswering(body).source.fetch()).resolves.toMatchObject({ btc: { usd: 80_123.45 } });
  });

  it.each([
    ["missing", { bitcoin: { usd: 80_000, last_updated_at: NOW_S } }, "ckb"],
    ["without a usd field", coinGeckoBody({ bitcoin: { last_updated_at: NOW_S } }), "btc"],
    ["at a zero price", coinGeckoBody({ bitcoin: { usd: 0 } }), "btc"],
    ["at a negative price", coinGeckoBody({ "nervos-network": { usd: -0.002 } }), "ckb"],
    ["at a non-numeric price", coinGeckoBody({ bitcoin: { usd: "eighty thousand" } }), "btc"],
    ["at a boolean price", coinGeckoBody({ bitcoin: { usd: true } }), "btc"],
    ["with a non-numeric time", coinGeckoBody({ bitcoin: { usd: 80_000, last_updated_at: "yesterday" } }), "btc"],
  ])("leaves out a coin %s and keeps the other one", async (_label, body, dropped) => {
    const prices = await sourceAnswering(body).source.fetch();

    expect(prices[dropped as "btc" | "ckb"]).toBeNull();
    expect(prices[dropped === "btc" ? "ckb" : "btc"]).not.toBeNull();
  });

  it.each([
    ["an empty object", {}],
    ["null", null],
    ["an array", []],
    ["no usable coin", coinGeckoBody({ bitcoin: { usd: 0 }, "nervos-network": { usd: "n/a" } })],
    ["a rate-limit error body", { status: { error_code: 429, error_message: "You've exceeded the Rate Limit." } }],
  ])("rejects %s with a PriceSourceError", async (_label, body) => {
    await expect(sourceAnswering(body).source.fetch()).rejects.toBeInstanceOf(PriceSourceError);
  });

  it("passes on a transport failure", async () => {
    await expect(sourceAnswering(new PriceSourceError("api.coingecko.com answered HTTP 503.")).source.fetch()).rejects.toThrow("503");
  });
});

/* --------------------------------------------------------------------------------------------- Binance */

/** Shape of https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT */
const binanceAnswer = (prices: Record<string, unknown>) => (url: URL) => {
  const symbol = url.searchParams.get("symbol") ?? "";
  return symbol in prices ? { symbol, price: prices[symbol] } : new Error(`unexpected symbol ${symbol}`);
};

describe("BinancePriceSource", () => {
  const sourceWith = (answer: (url: URL) => unknown) => {
    const http = new FakeHttp(answer);
    return { http, source: new BinancePriceSource(http, clock) };
  };
  const good = binanceAnswer({ BTCUSDT: "80123.45000000", CKBUSDT: "0.00234500" });

  it("is named binance", () => {
    expect(sourceWith(good).source.name).toBe("binance");
  });

  it("asks the spot ticker for BTCUSDT and CKBUSDT, as the web app does", async () => {
    const { http, source } = sourceWith(good);

    await source.fetch();

    expect(http.urls.map((url) => `${url.origin}${url.pathname}`)).toEqual([
      "https://api.binance.com/api/v3/ticker/price",
      "https://api.binance.com/api/v3/ticker/price",
    ]);
    expect(http.urls.map((url) => url.searchParams.get("symbol")).sort()).toEqual(["BTCUSDT", "CKBUSDT"]);
  });

  it("parses decimal-string prices and dates them with the injected clock (Binance states no time)", async () => {
    await expect(sourceWith(good).source.fetch()).resolves.toEqual({
      source: "binance",
      btc: { usd: 80_123.45, at: NOW },
      ckb: { usd: 0.002345, at: NOW },
    });
  });

  it("accepts a JSON number price too", async () => {
    await expect(sourceWith(binanceAnswer({ BTCUSDT: 80_000, CKBUSDT: 0.002 })).source.fetch()).resolves.toMatchObject({
      btc: { usd: 80_000 },
      ckb: { usd: 0.002 },
    });
  });

  it("rejects an answer for another symbol than the one asked", async () => {
    const swapped = (url: URL) => ({ symbol: "ETHUSDT", price: url.searchParams.get("symbol") === "BTCUSDT" ? "3000" : "1" });

    await expect(sourceWith(swapped).source.fetch()).rejects.toBeInstanceOf(PriceSourceError);
  });

  it.each([
    ["a zero price", "0.00000000"],
    ["a negative price", "-1"],
    ["a non-numeric price", "abc"],
    ["an empty price", ""],
    ["a missing price", undefined],
  ])("leaves out BTC at %s and keeps CKB", async (_label, btcPrice) => {
    await expect(sourceWith(binanceAnswer({ BTCUSDT: btcPrice, CKBUSDT: "0.002" })).source.fetch()).resolves.toEqual({
      source: "binance",
      btc: null,
      ckb: { usd: 0.002, at: NOW },
    });
  });

  it("rejects an answer with no usable coin with a PriceSourceError", async () => {
    await expect(sourceWith(binanceAnswer({ BTCUSDT: "0", CKBUSDT: "abc" })).source.fetch()).rejects.toBeInstanceOf(PriceSourceError);
  });

  it("rejects a Binance error body", async () => {
    await expect(sourceWith(() => ({ code: -1121, msg: "Invalid symbol." })).source.fetch()).rejects.toBeInstanceOf(PriceSourceError);
  });

  it("keeps the coin that answered when the other request fails (the CKB feed down)", async () => {
    const half = (url: URL) =>
      url.searchParams.get("symbol") === "CKBUSDT" ? new PriceSourceError("api.binance.com answered HTTP 503.") : { symbol: "BTCUSDT", price: "80000" };

    await expect(sourceWith(half).source.fetch()).resolves.toEqual({ source: "binance", btc: { usd: 80_000, at: NOW }, ckb: null });
  });

  it("fails with the first error when every request fails (e.g. HTTP 451 for US servers)", async () => {
    await expect(sourceWith(() => new PriceSourceError("api.binance.com answered HTTP 451.")).source.fetch()).rejects.toThrow("451");
  });
});

/* ---------------------------------------------------------------------------------------------- KuCoin */

/** Shape of https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=BTC-USDT */
const kuCoinAnswer = (data: Record<string, unknown>, code = "200000") => (url: URL) => {
  const symbol = url.searchParams.get("symbol") ?? "";
  return symbol in data ? { code, data: data[symbol] } : new Error(`unexpected symbol ${symbol}`);
};
const level1 = (price: unknown, time?: number) => ({ time, sequence: "1", price, size: "0.1", bestBid: price, bestBidSize: "1", bestAsk: price, bestAskSize: "1" });

describe("KuCoinPriceSource", () => {
  const sourceWith = (answer: (url: URL) => unknown) => {
    const http = new FakeHttp(answer);
    return { http, source: new KuCoinPriceSource(http, clock) };
  };
  const good = kuCoinAnswer({ "BTC-USDT": level1("80123.4", NOW - 2_000), "CKB-USDT": level1("0.002345", NOW - 7_000) });

  it("is named kucoin", () => {
    expect(sourceWith(good).source.name).toBe("kucoin");
  });

  it("asks the level-1 order book for BTC-USDT and CKB-USDT, as the web app does", async () => {
    const { http, source } = sourceWith(good);

    await source.fetch();

    expect(new Set(http.urls.map((url) => `${url.origin}${url.pathname}`))).toEqual(new Set(["https://api.kucoin.com/api/v1/market/orderbook/level1"]));
    expect(http.urls.map((url) => url.searchParams.get("symbol")).sort()).toEqual(["BTC-USDT", "CKB-USDT"]);
  });

  it("returns each coin dated with its own stated time (ms)", async () => {
    await expect(sourceWith(good).source.fetch()).resolves.toEqual({
      source: "kucoin",
      btc: { usd: 80_123.4, at: NOW - 2_000 },
      ckb: { usd: 0.002345, at: NOW - 7_000 },
    });
  });

  it("dates with the injected clock when KuCoin states no time", async () => {
    const untimed = kuCoinAnswer({ "BTC-USDT": level1("80000"), "CKB-USDT": level1("0.002") });

    await expect(sourceWith(untimed).source.fetch()).resolves.toMatchObject({ btc: { at: NOW }, ckb: { at: NOW } });
  });

  it.each([
    ["data null (unknown symbol)", kuCoinAnswer({ "BTC-USDT": level1("80000", NOW), "CKB-USDT": null }), "ckb"],
    ["a zero price", kuCoinAnswer({ "BTC-USDT": level1("0", NOW), "CKB-USDT": level1("0.002", NOW) }), "btc"],
    ["a non-numeric price", kuCoinAnswer({ "BTC-USDT": level1("n/a", NOW), "CKB-USDT": level1("0.002", NOW) }), "btc"],
    ["a missing price", kuCoinAnswer({ "BTC-USDT": { time: NOW }, "CKB-USDT": level1("0.002", NOW) }), "btc"],
    ["a non-numeric time", kuCoinAnswer({ "BTC-USDT": { ...level1("80000"), time: "now" }, "CKB-USDT": level1("0.002", NOW) }), "btc"],
  ])("leaves out a coin answered with %s and keeps the other one", async (_label, answer, dropped) => {
    const prices = await sourceWith(answer).source.fetch();

    expect(prices[dropped as "btc" | "ckb"]).toBeNull();
    expect(prices[dropped === "btc" ? "ckb" : "btc"]).toEqual({ usd: dropped === "btc" ? 0.002 : 80_000, at: NOW });
  });

  it("rejects an error code on every coin with a PriceSourceError", async () => {
    const answer = kuCoinAnswer({ "BTC-USDT": level1("80000", NOW), "CKB-USDT": level1("0.002", NOW) }, "400100");

    await expect(sourceWith(answer).source.fetch()).rejects.toBeInstanceOf(PriceSourceError);
  });
});

describe("every price source", () => {
  it.each([
    ["coingecko", (http: JsonHttpClient) => new CoinGeckoPriceSource(http, clock)],
    ["binance", (http: JsonHttpClient) => new BinancePriceSource(http, clock)],
    ["kucoin", (http: JsonHttpClient) => new KuCoinPriceSource(http, clock)],
  ])("%s rejects a non-object body instead of quoting from it", async (_name, make: (http: JsonHttpClient) => PriceSource) => {
    for (const body of ["<html>blocked</html>", 42, null, undefined]) {
      await expect(make(new FakeHttp(() => body)).fetch()).rejects.toBeInstanceOf(PriceSourceError);
    }
  });
});
