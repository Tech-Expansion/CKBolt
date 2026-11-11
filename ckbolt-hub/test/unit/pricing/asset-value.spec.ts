import { assetPriceFor, exchangeTermsFor, resolveAssetTerms, type CoinPrice, type MarketPrice } from "../../../src/domain/pricing";
import type { FiberAsset } from "../../../src/domain/types";

const BTC_USD = 80_000;
const CKB_USD = 0.002;
const NOW = Date.UTC(2026, 9, 23, 12);

const coin = (usd: number, ageMs: number, sources: string[]): CoinPrice => ({ usd, at: NOW - ageMs, sources });
const BTC = coin(BTC_USD, 2_000, ["coingecko", "binance"]);
const CKB = coin(CKB_USD, 9_000, ["coingecko", "kucoin"]);
const market: MarketPrice = { btc: BTC, ckb: CKB };
const ckbDown: MarketPrice = { btc: BTC, ckb: null };
const btcDown: MarketPrice = { btc: null, ckb: CKB };

describe("domain pricing: an asset's prices by its USD rule (assetPriceFor)", () => {
  it("values CKB (ckb_market) at its market price, dated with the older coin and naming every source used", () => {
    expect(assetPriceFor("ckb_market", market)).toEqual({
      btcUsd: BTC_USD,
      assetUsd: CKB_USD,
      at: NOW - 9_000,
      source: "median:coingecko,binance,kucoin",
    });
  });

  it("values a usd_peg asset (RUSD) at $1 from BTC alone", () => {
    expect(assetPriceFor("usd_peg", market)).toEqual({ btcUsd: BTC_USD, assetUsd: 1, at: NOW - 2_000, source: "median:coingecko,binance" });
  });

  it("values a btc_parity asset (cWBTC) at the BTC price from BTC alone", () => {
    expect(assetPriceFor("btc_parity", market)).toEqual({ btcUsd: BTC_USD, assetUsd: BTC_USD, at: NOW - 2_000, source: "median:coingecko,binance" });
  });

  describe("with the CKB feeds down", () => {
    it("still prices the usd_peg and btc_parity assets, exactly as with CKB up", () => {
      expect(assetPriceFor("usd_peg", ckbDown)).toEqual(assetPriceFor("usd_peg", market));
      expect(assetPriceFor("btc_parity", ckbDown)).toEqual(assetPriceFor("btc_parity", market));
    });

    it("cannot price CKB", () => {
      expect(assetPriceFor("ckb_market", ckbDown)).toBeNull();
    });
  });

  it("prices nothing without BTC: every quote has a Lightning leg", () => {
    for (const rule of ["ckb_market", "usd_peg", "btc_parity"] as const) expect(assetPriceFor(rule, btcDown)).toBeNull();
  });
});

describe("domain pricing: exchange terms and per-asset terms", () => {
  const cwbtc: FiberAsset = {
    id: "CWBTC",
    symbol: "cWBTC",
    name: "CCH Wrapped BTC",
    decimals: 8,
    udtTypeScript: { codeHash: `0x${"25".repeat(32)}`, hashType: "type", args: "0x01" },
    usdRule: "btc_parity",
    cellDeps: [],
  };

  it("builds the exchange terms from the asset's decimals, its prices and the total fee", () => {
    const price = assetPriceFor(cwbtc.usdRule, market);
    if (!price) throw new Error("fixture market prices cWBTC");

    expect(exchangeTermsFor(cwbtc, price, 50)).toEqual({ btcUsd: BTC_USD, assetUsd: BTC_USD, assetDecimals: 8, feeBps: 50 });
  });

  it("takes what an asset sets itself and the global values for the rest; 0 is a value, not a gap", () => {
    const defaults = { feeBps: 50, optionPremiumBps: 50, minSats: 1_000n, maxSats: 100_000n };

    expect(resolveAssetTerms(defaults)).toEqual(defaults);
    expect(resolveAssetTerms(defaults, { optionPremiumBps: 0, maxSats: 20_000n })).toEqual({ feeBps: 50, optionPremiumBps: 0, minSats: 1_000n, maxSats: 20_000n });
  });
});
