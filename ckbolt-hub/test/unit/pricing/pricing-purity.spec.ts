import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  aggregateMarketPrice,
  assetLiquidity,
  assetPriceFor,
  canonicalQuoteMessage,
  exchangeTermsFor,
  payoutCapacity,
  quoteAmounts,
} from "../../../src/domain/pricing";
import { createAssetRegistry, knownUdtAssets } from "../../../src/domain/assets";
import { ALL_UDT_SCRIPTS, MAX_PRICE_AGE_MS, RUSD_SCRIPT, sampleQuote, TOTAL_FEE_BPS } from "./pricing.fixtures";

/**
 * Coding rules for the domain (CONTRIBUTING.md, hub rules 1 and 2): pure functions with no Nest, no I/O and no clock reads, and no
 * magic numbers in the pricing code (protocol facts are named constants; tunables come from config).
 */
describe("domain pricing: purity and coding rules", () => {
  const PRICING_DIR = join(__dirname, "../../../src/domain/pricing");
  const NOW = Date.UTC(2026, 9, 23, 12);

  const callEveryFunction = () => {
    const assets = createAssetRegistry("devnet", knownUdtAssets(ALL_UDT_SCRIPTS));
    const market = aggregateMarketPrice(
      Object.freeze([Object.freeze({ source: "a", btc: { usd: 80_000, at: NOW - 1_000 }, ckb: { usd: 0.002, at: NOW - 1_000 } })]),
      Object.freeze({ now: NOW, maxAgeMs: MAX_PRICE_AGE_MS }),
    );
    const results: unknown[] = [market];
    for (const asset of assets.list()) {
      const price = assetPriceFor(asset.usdRule, market);
      if (!price) throw new Error("fixture price should be fresh");
      const terms = Object.freeze(exchangeTermsFor(asset, price, TOTAL_FEE_BPS));
      results.push(price, terms);
      results.push(quoteAmounts(Object.freeze({ direction: "ln_to_fiber", side: "pay", amount: 10_000n }), terms));
      results.push(quoteAmounts(Object.freeze({ direction: "fiber_to_ln", side: "receive", amount: 10_000n }), terms));
      const liquidity = assetLiquidity(
        Object.freeze({ lightningSats: 5n, fiberChannels: Object.freeze([Object.freeze({ udtTypeScript: RUSD_SCRIPT, ready: true, localBalance: 3n })]) }),
        asset,
      );
      results.push(liquidity, payoutCapacity("ln_to_fiber", liquidity));
    }
    results.push(canonicalQuoteMessage(Object.freeze(sampleQuote())));
    return results;
  };

  afterEach(() => jest.restoreAllMocks());

  it("never reads the clock: time is always passed in", () => {
    const dateNow = jest.spyOn(Date, "now");
    const perfNow = jest.spyOn(performance, "now");

    callEveryFunction();

    expect(dateNow).not.toHaveBeenCalled();
    expect(perfNow).not.toHaveBeenCalled();
  });

  it("accepts frozen inputs and is deterministic", () => {
    expect(callEveryFunction()).toEqual(callEveryFunction());
  });

  const sources = readdirSync(PRICING_DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
    .map((file) => ({ file, text: readFileSync(join(PRICING_DIR, file), "utf8") }));

  const codeOnly = (text: string) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, '""');

  it("has source files to check", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources.map((s) => [s.file, s.text] as const))("%s imports no framework, I/O or outer layer", (_file, text) => {
    const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");

    for (const source of imports) {
      expect(source).not.toMatch(/^@nestjs|^node:|^fs$|^path$|^http|^crypto$|infrastructure|interfaces|application|config\//);
    }
    expect(codeOnly(text)).not.toMatch(/Date\.now|new Date|process\.|Math\.random|console\.|\bfetch\(/);
  });

  it.each(sources.map((s) => [s.file, s.text] as const))("%s has no magic numbers (only 0 and 1, number or bigint)", (_file, text) => {
    const literals = codeOnly(text).match(/(?<![\w.])\d[\d_]*(?:\.\d+)?n?(?![\w])/g) ?? [];

    expect(literals.filter((n) => !["0", "1", "0n", "1n"].includes(n))).toEqual([]);
  });

  it.each(sources.map((s) => [s.file, s.text] as const))("%s spells no direction, side or asset string inline", (_file, text) => {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const strings = [...code.matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)]
      .map((m) => m[2] ?? "")
      .filter((s) => !s.startsWith(".") && !s.startsWith("/"));

    expect(strings.filter((s) => ["ln_to_fiber", "fiber_to_ln", "pay", "receive"].includes(s))).toEqual([]);
  });
});
