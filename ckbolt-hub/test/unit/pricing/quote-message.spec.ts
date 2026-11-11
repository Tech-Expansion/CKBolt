import { QUOTE_MESSAGE_PREFIX } from "../../../src/common/constants/pricing.constants";
import { canonicalQuoteMessage } from "../../../src/domain/pricing";
import type { Quote } from "../../../src/domain/types";
import { sampleQuote } from "./pricing.fixtures";

const UNSIGNED_FIELDS = (Object.keys(sampleQuote()) as (keyof Quote)[]).filter((key) => key !== "signature" && key !== "hubPubkey");

const bodyOf = (message: string): Record<string, unknown> => {
  expect(message.startsWith(QUOTE_MESSAGE_PREFIX)).toBe(true);
  return JSON.parse(message.slice(QUOTE_MESSAGE_PREFIX.length)) as Record<string, unknown>;
};

/** The same quote with its keys inserted in reverse order. */
const reversedKeys = (quote: Quote): Quote =>
  Object.fromEntries(Object.entries(quote).reverse()) as unknown as Quote;

describe("domain pricing: canonical quote message", () => {
  it("is a versioned prefix followed by JSON", () => {
    expect(QUOTE_MESSAGE_PREFIX).toMatch(/v\d+/);
    expect(() => bodyOf(canonicalQuoteMessage(sampleQuote()))).not.toThrow();
  });

  it("covers every Quote field except signature and hubPubkey (purpose on a request quote)", () => {
    const body = bodyOf(canonicalQuoteMessage(sampleQuote({ purpose: "request" })));

    expect(Object.keys(body).sort()).toEqual([...UNSIGNED_FIELDS].sort());
    expect(body).not.toHaveProperty("signature");
    expect(body).not.toHaveProperty("hubPubkey");
  });

  it("leaves purpose out of a swap quote's message, so it is the message of a quote made before quotes had a purpose", () => {
    const body = bodyOf(canonicalQuoteMessage(sampleQuote({ purpose: "swap" })));

    expect(Object.keys(body).sort()).toEqual(UNSIGNED_FIELDS.filter((field) => field !== "purpose").sort());
  });

  it("puts a request quote's purpose right after feeBps", () => {
    const keys = Object.keys(bodyOf(canonicalQuoteMessage(sampleQuote({ purpose: "request" }))));

    expect(keys[keys.indexOf("feeBps") + 1]).toBe("purpose");
    expect(bodyOf(canonicalQuoteMessage(sampleQuote({ purpose: "request" }))).purpose).toBe("request");
  });

  it("keeps a fixed field order whatever order the object was built in", () => {
    const quote = sampleQuote();

    expect(canonicalQuoteMessage(reversedKeys(quote))).toBe(canonicalQuoteMessage(quote));
    expect(Object.keys(bodyOf(canonicalQuoteMessage(reversedKeys(quote))))).toEqual(Object.keys(bodyOf(canonicalQuoteMessage(quote))));
  });

  it("writes amounts as exact decimal strings, beyond 2^53 too", () => {
    const body = bodyOf(canonicalQuoteMessage(sampleQuote({ sats: 2n ** 64n + 1n, fiberAmount: 10n ** 30n + 7n })));

    expect(body.sats).toBe("18446744073709551617");
    expect(body.fiberAmount).toBe("1000000000000000000000000000007");
  });

  it("keeps the other values as they are in the quote", () => {
    const quote = sampleQuote();
    const body = bodyOf(canonicalQuoteMessage(quote));

    expect(body).toMatchObject({
      id: quote.id,
      direction: quote.direction,
      asset: quote.asset,
      btcUsd: quote.btcUsd,
      assetUsd: quote.assetUsd,
      priceSource: quote.priceSource,
      priceAt: quote.priceAt,
      feeBps: quote.feeBps,
      createdAt: quote.createdAt,
      expiresAt: quote.expiresAt,
    });
  });

  it("is the same with or without signature and hubPubkey", () => {
    const quote = sampleQuote();
    const { signature: _signature, hubPubkey: _hubPubkey, ...unsigned } = quote;

    const resigned: Quote = { ...quote, signature: "ff".repeat(64), hubPubkey: "ee".repeat(32) };

    expect(canonicalQuoteMessage(unsigned)).toBe(canonicalQuoteMessage(quote));
    expect(canonicalQuoteMessage(resigned)).toBe(canonicalQuoteMessage(quote));
  });

  const changes: [keyof Quote, Partial<Quote>][] = [
    ["id", { id: "another-id" }],
    ["direction", { direction: "fiber_to_ln" }],
    ["asset", { asset: "RUSD" }],
    ["sats", { sats: 10_001n }],
    ["fiberAmount", { fiberAmount: 396_000_000_001n }],
    ["btcUsd", { btcUsd: 80_000.01 }],
    ["assetUsd", { assetUsd: 0.0021 }],
    ["priceSource", { priceSource: "median:binance" }],
    ["priceAt", { priceAt: sampleQuote().priceAt + 1 }],
    ["feeBps", { feeBps: 99 }],
    // sampleQuote is a swap quote: its message has no purpose, a request quote's has one.
    ["purpose", { purpose: "request" }],
    ["createdAt", { createdAt: sampleQuote().createdAt + 1 }],
    ["expiresAt", { expiresAt: sampleQuote().expiresAt + 1 }],
  ];

  it("lists a change case for every signed field", () => {
    expect(changes.map(([field]) => field).sort()).toEqual([...UNSIGNED_FIELDS].sort());
  });

  it.each(changes)("changes when %s changes", (_field, patch) => {
    expect(canonicalQuoteMessage(sampleQuote(patch))).not.toBe(canonicalQuoteMessage(sampleQuote()));
  });

  it("is deterministic", () => {
    expect(canonicalQuoteMessage(sampleQuote())).toBe(canonicalQuoteMessage(sampleQuote()));
  });
});
