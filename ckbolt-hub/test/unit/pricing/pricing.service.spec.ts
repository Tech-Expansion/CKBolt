import type { PricingService } from "../../../src/application/pricing/pricing.contract";
import { PricingServiceImpl } from "../../../src/application/pricing/pricing.service";
import { Ed25519QuoteSigner } from "../../../src/application/pricing/ed25519-quote-signer";
import { API_ERROR_CODE, type ApiErrorCode } from "../../../src/common/constants/api.constants";
import { canonicalQuoteMessage } from "../../../src/domain/pricing";
import type { Direction, FiberAssetId, Quote, QuoteRequest, Swap } from "../../../src/domain/types";
import { FakeClock, FakeSwapStore } from "../../fakes";
import { makeSwap } from "../persistence/persistence.fixtures";
import {
  ALL_UDT_SCRIPTS,
  BTC_USD,
  channel,
  CKB_USD,
  CWBTC_SCRIPT,
  expectHubError,
  makeHarness,
  MAX_PRICE_AGE_MS,
  MAX_SATS,
  MIN_SATS,
  OTHER_UDT_SCRIPT,
  QUOTE_TTL_SECONDS,
  RUSD_SCRIPT,
  RUSD_SCRIPT_UPPER,
  setPrices,
  SHANNONS_PER_SAT,
  SIGNING_SEED_HEX,
  silenceWarnings,
  TOTAL_FEE_BPS,
  type Harness,
  type HarnessOptions,
} from "./pricing.fixtures";

const req = (direction: Direction, asset: FiberAssetId, side: QuoteRequest["side"], amount: bigint): QuoteRequest => ({
  direction,
  asset,
  side,
  amount,
});

const CKB = 100_000_000n;
const HEX_64_BYTES = /^[0-9a-f]{128}$/;
const HEX_32_BYTES = /^[0-9a-f]{64}$/;

/** A harness serving all three assets with plenty of liquidity in each. */
const fullHarness = (options: HarnessOptions = {}): Harness => {
  const h = makeHarness({ udtScripts: ALL_UDT_SCRIPTS, ...options });
  h.fiber.setChannels([
    channel({ localBalance: 100_000n * CKB }),
    channel({ udtTypeScript: RUSD_SCRIPT, localBalance: 10_000n * CKB }),
    channel({ udtTypeScript: CWBTC_SCRIPT, localBalance: 10n * CKB }),
  ]);
  return h;
};

describe("PricingServiceImpl", () => {
  beforeEach(() => silenceWarnings());
  afterEach(() => jest.restoreAllMocks());

  describe("createQuote: a firm quote", () => {
    it("prices ln_to_fiber CKB, side=pay, with every field set", async () => {
      const h = makeHarness();
      const now = h.clock.now();

      const quote = await h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n));

      expect(quote).toMatchObject({
        direction: "ln_to_fiber",
        asset: "CKB",
        sats: 10_000n,
        fiberAmount: 396_000_000_000n,
        btcUsd: BTC_USD,
        assetUsd: CKB_USD,
        priceAt: now,
        feeBps: TOTAL_FEE_BPS,
        createdAt: now,
        expiresAt: now + QUOTE_TTL_SECONDS * 1_000,
      });
      expect(typeof quote.id).toBe("string");
      expect(quote.id.length).toBeGreaterThan(0);
      for (const name of ["coingecko", "binance", "kucoin"]) expect(quote.priceSource).toContain(name);
      expect(quote.signature).toMatch(HEX_64_BYTES);
      expect(quote.hubPubkey).toMatch(HEX_32_BYTES);
      expect(quote.hubPubkey).toBe(h.signer.publicKeyHex);
    });

    it.each`
      label                                        | direction        | asset      | side         | amount                | sats       | fiberAmount
      ${"ln_to_fiber CKB receive (rounded up)"}    | ${"ln_to_fiber"} | ${"CKB"}   | ${"receive"} | ${396_000_000_001n}   | ${10_001n} | ${396_000_000_001n}
      ${"fiber_to_ln CKB pay (rounded down)"}      | ${"fiber_to_ln"} | ${"CKB"}   | ${"pay"}     | ${400_040_404_040n}   | ${9_900n}  | ${400_040_404_040n}
      ${"fiber_to_ln CKB receive (rounded up)"}    | ${"fiber_to_ln"} | ${"CKB"}   | ${"receive"} | ${9_901n}             | ${9_901n}  | ${400_040_404_041n}
      ${"ln_to_fiber RUSD pay ($1 peg)"}           | ${"ln_to_fiber"} | ${"RUSD"}  | ${"pay"}     | ${10_000n}            | ${10_000n} | ${792_000_000n}
      ${"fiber_to_ln RUSD pay ($1 peg)"}           | ${"fiber_to_ln"} | ${"RUSD"}  | ${"pay"}     | ${800_000_000n}       | ${9_900n}  | ${800_000_000n}
      ${"ln_to_fiber CWBTC pay (BTC parity)"}      | ${"ln_to_fiber"} | ${"CWBTC"} | ${"pay"}     | ${10_000n}            | ${10_000n} | ${9_900n}
      ${"fiber_to_ln CWBTC receive (BTC parity)"}  | ${"fiber_to_ln"} | ${"CWBTC"} | ${"receive"} | ${9_901n}             | ${9_901n}  | ${10_002n}
    `("prices $label", async ({ direction, asset, side, amount, sats, fiberAmount }) => {
      const h = fullHarness();

      const quote = await h.service.createQuote(req(direction, asset, side, amount));

      expect({ sats: quote.sats, fiberAmount: quote.fiberAmount }).toEqual({ sats, fiberAmount });
      expect({ direction: quote.direction, asset: quote.asset }).toEqual({ direction, asset });
    });

    it.each`
      asset      | assetUsd
      ${"CKB"}   | ${CKB_USD}
      ${"RUSD"}  | ${1}
      ${"CWBTC"} | ${BTC_USD}
    `("states the $asset USD price it used: $assetUsd", async ({ asset, assetUsd }) => {
      const quote = await fullHarness().service.createQuote(req("ln_to_fiber", asset, "pay", 10_000n));

      expect(quote.assetUsd).toBe(assetUsd);
      expect(quote.btcUsd).toBe(BTC_USD);
    });

    it("applies the hub fee plus the option premium, once, and states the total", async () => {
      const h = makeHarness({ pricing: { feeBps: 30, optionPremiumBps: 20 } });

      const quote = await h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n));

      expect(quote.feeBps).toBe(50);
      expect(quote.fiberAmount).toBe((10_000n * SHANNONS_PER_SAT * 9_950n) / 10_000n);
    });

    it("charges the same whether the fee or the premium carries the bps", async () => {
      const allFee = makeHarness({ pricing: { feeBps: 100, optionPremiumBps: 0 } });
      const allPremium = makeHarness({ pricing: { feeBps: 0, optionPremiumBps: 100 } });
      const request = req("fiber_to_ln", "CKB", "pay", 400_000_000_000n);

      const a = await allFee.service.createQuote(request);
      const b = await allPremium.service.createQuote(request);

      expect([a.sats, a.feeBps]).toEqual([9_900n, 100]);
      expect([b.sats, b.feeBps]).toEqual([9_900n, 100]);
    });

    it("refuses at start-up a total fee of 100 % or more", () => {
      expect(() => makeHarness({ pricing: { feeBps: 9_000, optionPremiumBps: 1_000 } })).toThrow();
    });

    it("sets expiresAt from config.pricing.quoteTtlSeconds and createdAt from the injected clock", async () => {
      const h = makeHarness({ pricing: { quoteTtlSeconds: 120 } });
      h.clock.advance(12_345);

      const quote = await h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n));

      expect(quote.createdAt).toBe(h.clock.now());
      expect(quote.expiresAt - quote.createdAt).toBe(120_000);
    });

    it("prices from the median and dates it with the oldest fresh source", async () => {
      const h = makeHarness();
      const [a, b, c] = h.sources;
      if (!a || !b || !c) throw new Error("three sources expected");
      a.prices = { btc: 78_000, ckb: 0.0019, ageMs: 1_000 };
      b.prices = { btc: 80_000, ckb: 0.002, ageMs: 90_000 };
      c.prices = { btc: 95_000, ckb: 0.003, ageMs: 5_000 };

      const quote = await h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n));

      expect({ btcUsd: quote.btcUsd, assetUsd: quote.assetUsd }).toEqual({ btcUsd: 80_000, assetUsd: 0.002 });
      expect(quote.priceAt).toBe(h.clock.now() - 90_000);
      expect(quote.fiberAmount).toBe(396_000_000_000n);
    });

    it("leaves a stale or failing source out of the price and its label", async () => {
      const h = makeHarness();
      const [coingecko, binance, kucoin] = h.sources;
      if (!coingecko || !binance || !kucoin) throw new Error("three sources expected");
      coingecko.prices = { btc: 1, ckb: 1, ageMs: MAX_PRICE_AGE_MS + 1 };
      binance.failing = true;

      const quote = await h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n));

      expect(quote.priceSource).toContain("kucoin");
      expect(quote.priceSource).not.toContain("coingecko");
      expect(quote.priceSource).not.toContain("binance");
      expect(quote.fiberAmount).toBe(396_000_000_000n);
    });

    it("reads fresh prices for every quote", async () => {
      const h = makeHarness();
      const first = await h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n));
      setPrices(h.sources, { btc: 80_000, ckb: 0.004 });

      const second = await h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n));

      expect(second.fiberAmount * 2n).toBe(first.fiberAmount);
    });

    it("states prices from which anyone can re-derive its amounts, rounded in the hub's favour (cents in the BTC price)", async () => {
      const h = makeHarness();
      setPrices(h.sources, { btc: 80_000.12, ckb: 0.002345 });

      const quote = await h.service.createQuote(req("fiber_to_ln", "CKB", "receive", 22_523n));

      // From the signed fields alone: fiber >= ceil(sats * btcUsd / assetUsd / (1 - fee)).
      expect({ btcUsd: quote.btcUsd, assetUsd: quote.assetUsd, feeBps: quote.feeBps }).toEqual({ btcUsd: 80_000.12, assetUsd: 0.002345, feeBps: 100 });
      expect(String(quote.fiberAmount)).toBe("776137797059");
    });

    it("gives every quote its own id", async () => {
      const h = makeHarness();
      const ids = new Set<string>();
      for (let i = 0; i < 20; i += 1) ids.add((await h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n))).id);

      expect(ids.size).toBe(20);
    });
  });

  describe("createQuote: storage", () => {
    it("saves the signed quote through SWAP_STORE, and getQuote reads it back", async () => {
      const h = makeHarness();
      const save = jest.spyOn(h.store, "saveQuote");

      const quote = await h.service.createQuote(req("fiber_to_ln", "CKB", "receive", 5_000n));

      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith(quote);
      expect(h.store.getQuote(quote.id)).toEqual(quote);
      expect(h.service.getQuote(quote.id)).toEqual(quote);
    });

    it("getQuote returns null for an unknown id", () => {
      expect(makeHarness().service.getQuote("no-such-quote")).toBeNull();
    });

    it("getQuote reads from the store, so another instance on the same store sees the quote", async () => {
      const h = makeHarness();
      const quote = await h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n));
      const other = makeHarness({ store: h.store, clock: h.clock });

      expect(other.service.getQuote(quote.id)).toEqual(quote);
    });
  });

  describe("createQuote: validation (422 validation_failed, asset_unavailable)", () => {
    const expectRejected = async (h: Harness, request: QuoteRequest, status = 422, code: ApiErrorCode = API_ERROR_CODE.VALIDATION) => {
      const save = jest.spyOn(h.store, "saveQuote");
      const error = await expectHubError(() => h.service.createQuote(request), status, code);
      expect(save).not.toHaveBeenCalled();
      return error;
    };

    it.each([
      ["RUSD on a devnet with no RUSD script", "RUSD"],
      ["cWBTC with no cWBTC script", "CWBTC"],
      ["an asset id the hub has never heard of", "DOGE"],
    ])("refuses %s with asset_unavailable", async (_label, asset) => {
      await expectRejected(makeHarness(), req("ln_to_fiber", asset as FiberAssetId, "pay", 10_000n), 422, API_ERROR_CODE.ASSET_UNAVAILABLE);
    });

    it("serves RUSD on testnet through the default whitelist script", async () => {
      const h = makeHarness({ network: "testnet" });
      const rusd = h.assets.get("RUSD");
      if (!rusd?.udtTypeScript) throw new Error("testnet RUSD expected");
      h.fiber.setChannels([channel({ udtTypeScript: rusd.udtTypeScript, localBalance: 10_000n * CKB })]);

      await expect(h.service.createQuote(req("ln_to_fiber", "RUSD", "pay", 10_000n))).resolves.toMatchObject({ fiberAmount: 792_000_000n });
    });

    it.each([0n, -1n, -10_000n])("refuses an amount of %s", async (amount) => {
      await expectRejected(makeHarness(), req("ln_to_fiber", "CKB", "pay", amount));
      await expectRejected(makeHarness(), req("fiber_to_ln", "CKB", "pay", amount));
    });

    it.each`
      label                         | direction        | side         | sats
      ${"ln_to_fiber pay below"}    | ${"ln_to_fiber"} | ${"pay"}     | ${MIN_SATS - 1n}
      ${"ln_to_fiber pay above"}    | ${"ln_to_fiber"} | ${"pay"}     | ${MAX_SATS + 1n}
      ${"fiber_to_ln receive below"} | ${"fiber_to_ln"} | ${"receive"} | ${MIN_SATS - 1n}
      ${"fiber_to_ln receive above"} | ${"fiber_to_ln"} | ${"receive"} | ${MAX_SATS + 1n}
    `("refuses a fixed Lightning leg $label config.pricing.minSats..maxSats", async ({ direction, side, sats }) => {
      await expectRejected(makeHarness(), req(direction, "CKB", side, sats));
    });

    it.each`
      direction        | side         | sats
      ${"ln_to_fiber"} | ${"pay"}     | ${MIN_SATS}
      ${"ln_to_fiber"} | ${"pay"}     | ${MAX_SATS}
      ${"fiber_to_ln"} | ${"receive"} | ${MIN_SATS}
      ${"fiber_to_ln"} | ${"receive"} | ${MAX_SATS}
    `("accepts a fixed Lightning leg of exactly $sats sats ($direction $side)", async ({ direction, side, sats }) => {
      const quote = await makeHarness().service.createQuote(req(direction, "CKB", side, sats));

      expect(quote.sats).toBe(sats);
    });

    it("uses the caps from config", async () => {
      const h = makeHarness({ pricing: { minSats: 5_000n, maxSats: 6_000n } });

      await expectRejected(h, req("ln_to_fiber", "CKB", "pay", 4_999n));
      await expectRejected(h, req("ln_to_fiber", "CKB", "pay", 6_001n));
      await expect(h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 5_500n))).resolves.toMatchObject({ sats: 5_500n });
    });

    it("checks the computed Lightning leg when the Fiber leg is fixed (ln_to_fiber receive)", async () => {
      // 39,600 CKB costs exactly 100,000 sats; one shannon more needs 100,001 sats.
      const h = makeHarness();

      await expect(h.service.createQuote(req("ln_to_fiber", "CKB", "receive", 39_600n * CKB))).resolves.toMatchObject({ sats: MAX_SATS });
      await expectRejected(h, req("ln_to_fiber", "CKB", "receive", 39_600n * CKB + 1n));
    });

    it("checks the computed Lightning leg when the Fiber leg is fixed (fiber_to_ln pay)", async () => {
      // 1,000 sats out costs 404.04040404... CKB in: 40,404,040,405 shannons is the least that buys them.
      const h = makeHarness();

      await expect(h.service.createQuote(req("fiber_to_ln", "CKB", "pay", 40_404_040_405n))).resolves.toMatchObject({ sats: MIN_SATS });
      await expectRejected(h, req("fiber_to_ln", "CKB", "pay", 40_404_040_404n));
      // 10 CKB buys 24 sats (below the minimum); 50,000 CKB would buy 123,750 sats (above the maximum).
      await expectRejected(h, req("fiber_to_ln", "CKB", "pay", 10n * CKB));
      await expectRejected(h, req("fiber_to_ln", "CKB", "pay", 50_000n * CKB));
    });

    it("refuses an amount so small one leg rounds to nothing, even with no minimum", async () => {
      const h = fullHarness({ pricing: { minSats: 0n } });

      await expectRejected(h, req("fiber_to_ln", "CKB", "pay", 1n));
      await expectRejected(h, req("ln_to_fiber", "CWBTC", "pay", 1n));
    });

    it("validates before reading prices or balances", async () => {
      const h = makeHarness();
      const fetches = h.sources.map((source) => jest.spyOn(source, "fetch"));

      await expectRejected(h, req("ln_to_fiber", "RUSD", "pay", 10_000n), 422, API_ERROR_CODE.ASSET_UNAVAILABLE);
      await expectRejected(h, req("ln_to_fiber", "CKB", "pay", 0n));
      await expectRejected(h, req("ln_to_fiber", "CKB", "pay", MAX_SATS + 1n));

      for (const fetch of fetches) expect(fetch).not.toHaveBeenCalled();
      expect(h.lightning.calls).not.toContain("getBalances");
      expect(h.fiber.calls).not.toContain("listChannels");
    });
  });

  describe("createQuote: prices (503 quote_unavailable)", () => {
    it("refuses when every source is older than config.pricing.maxPriceAgeMs", async () => {
      const h = makeHarness();
      setPrices(h.sources, { btc: BTC_USD, ckb: CKB_USD, ageMs: MAX_PRICE_AGE_MS + 1 });
      const save = jest.spyOn(h.store, "saveQuote");

      await expectHubError(() => h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n)), 503, API_ERROR_CODE.QUOTE_UNAVAILABLE);
      expect(save).not.toHaveBeenCalled();
    });

    it("refuses when every source is down", async () => {
      const h = makeHarness();
      for (const source of h.sources) source.failing = true;

      await expectHubError(() => h.service.createQuote(req("fiber_to_ln", "CKB", "receive", 10_000n)), 503, API_ERROR_CODE.QUOTE_UNAVAILABLE);
    });

    it("quotes with a single fresh source", async () => {
      const h = makeHarness({ sourceNames: ["kucoin"] });

      await expect(h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n))).resolves.toMatchObject({ fiberAmount: 396_000_000_000n });
    });

    it("refuses a price exactly one millisecond past the limit and accepts one at it", async () => {
      const h = makeHarness({ sourceNames: ["coingecko"] });
      setPrices(h.sources, { btc: BTC_USD, ckb: CKB_USD, ageMs: MAX_PRICE_AGE_MS });

      await expect(h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n))).resolves.toBeDefined();
      setPrices(h.sources, { btc: BTC_USD, ckb: CKB_USD, ageMs: MAX_PRICE_AGE_MS + 1 });
      await expectHubError(() => h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n)), 503, API_ERROR_CODE.QUOTE_UNAVAILABLE);
    });
  });

  describe("createQuote: liquidity (422 insufficient_liquidity)", () => {
    const expectNoLiquidity = async (h: Harness, request: QuoteRequest) => {
      const save = jest.spyOn(h.store, "saveQuote");
      await expectHubError(() => h.service.createQuote(request), 422, API_ERROR_CODE.INSUFFICIENT_LIQUIDITY);
      expect(save).not.toHaveBeenCalled();
    };

    it("ln_to_fiber pays out on Fiber: refuses one base unit short of the payout plus its fee budget, accepts exactly enough", async () => {
      const h = makeHarness();
      const request = req("ln_to_fiber", "CKB", "pay", 10_000n);
      // 396,000,000,000 shannons + 0.5 % Fiber fee budget (1,980,000,000) = 397,980,000,000.
      h.fiber.setChannels([channel({ localBalance: 397_980_000_000n - 1n })]);
      await expectNoLiquidity(h, request);

      h.fiber.setChannels([channel({ localBalance: 397_980_000_000n })]);
      await expect(h.service.createQuote(request)).resolves.toMatchObject({ fiberAmount: 396_000_000_000n });
    });

    it("adds up several ready channels in the asset", async () => {
      const h = makeHarness();
      h.fiber.setChannels([channel({ localBalance: 200_000_000_000n }), channel({ localBalance: 197_980_000_000n })]);

      await expect(h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n))).resolves.toBeDefined();
    });

    it("does not count channels that are not ready", async () => {
      const h = makeHarness();
      h.fiber.setChannels([channel({ localBalance: 10n ** 15n, ready: false }), channel({ localBalance: 1n })]);

      await expectNoLiquidity(h, req("ln_to_fiber", "CKB", "pay", 10_000n));
    });

    it("does not count the remote side of a channel", async () => {
      const h = makeHarness();
      h.fiber.setChannels([channel({ localBalance: 0n, remoteBalance: 10n ** 15n })]);

      await expectNoLiquidity(h, req("ln_to_fiber", "CKB", "pay", 10_000n));
    });

    it("does not count channels in another asset", async () => {
      const ckbQuote = makeHarness({ udtScripts: ALL_UDT_SCRIPTS });
      ckbQuote.fiber.setChannels([channel({ udtTypeScript: RUSD_SCRIPT, localBalance: 10n ** 15n })]);
      await expectNoLiquidity(ckbQuote, req("ln_to_fiber", "CKB", "pay", 10_000n));

      const rusdQuote = makeHarness({ udtScripts: ALL_UDT_SCRIPTS });
      rusdQuote.fiber.setChannels([channel({ localBalance: 10n ** 15n }), channel({ udtTypeScript: OTHER_UDT_SCRIPT, localBalance: 10n ** 15n })]);
      await expectNoLiquidity(rusdQuote, req("ln_to_fiber", "RUSD", "pay", 10_000n));
    });

    it("matches a UDT channel whose script differs only in hex case", async () => {
      const h = makeHarness({ udtScripts: ALL_UDT_SCRIPTS });
      // 792,000,000 + 0.5 % (3,960,000).
      h.fiber.setChannels([channel({ udtTypeScript: RUSD_SCRIPT_UPPER, localBalance: 795_960_000n })]);

      await expect(h.service.createQuote(req("ln_to_fiber", "RUSD", "pay", 10_000n))).resolves.toMatchObject({ fiberAmount: 792_000_000n });
    });

    it("fiber_to_ln pays out on Lightning: refuses one sat short of the payout plus its fee budget, accepts exactly enough", async () => {
      const h = makeHarness();
      const request = req("fiber_to_ln", "CKB", "receive", 9_900n);
      h.fiber.setChannels([]);
      // 9,900 sats + 1 % Lightning fee budget (99) = 9,999.
      h.lightning.setBalances({ channelLocalSats: 9_998n, channelRemoteSats: 10n ** 9n, onchainSats: 10n ** 9n });
      await expectNoLiquidity(h, request);

      h.lightning.setBalances({ channelLocalSats: 9_999n });
      await expect(h.service.createQuote(request)).resolves.toMatchObject({ sats: 9_900n, fiberAmount: 400_000_000_000n });
    });

    describe("open swaps keep their payouts", () => {
      const openSwap = (h: Harness, patch: Partial<Swap>): void => h.store.createSwap(makeSwap(h.clock, patch));

      it("fiber_to_ln: subtracts every open swap's Lightning payout not sent yet, with its 1 % fee budget, whatever its asset", async () => {
        const h = makeHarness({ udtScripts: ALL_UDT_SCRIPTS });
        openSwap(h, { direction: "fiber_to_ln", asset: "RUSD", state: "pending", sats: 5_000n });
        openSwap(h, { direction: "fiber_to_ln", asset: "CKB", state: "incoming_accepted", sats: 4_000n });
        const request = req("fiber_to_ln", "CKB", "receive", 9_900n);
        // Reserved: 5,000 + 50 + 4,000 + 40 = 9,090; the quote needs 9,900 + 99 = 9,999; together 19,089.
        h.lightning.setBalances({ channelLocalSats: 19_088n });
        await expectNoLiquidity(h, request);

        h.lightning.setBalances({ channelLocalSats: 19_089n });
        await expect(h.service.createQuote(request)).resolves.toMatchObject({ sats: 9_900n });
      });

      it("ln_to_fiber: subtracts open swaps paying out the same asset on Fiber, with their 0.5 % fee budget", async () => {
        const h = makeHarness();
        openSwap(h, { direction: "ln_to_fiber", asset: "CKB", state: "pending", fiberAmount: 1_000_000_000n });
        const request = req("ln_to_fiber", "CKB", "pay", 10_000n);
        // 397,980,000,000 for the quote + 1,005,000,000 reserved.
        h.fiber.setChannels([channel({ localBalance: 398_985_000_000n - 1n })]);
        await expectNoLiquidity(h, request);

        h.fiber.setChannels([channel({ localBalance: 398_985_000_000n })]);
        await expect(h.service.createQuote(request)).resolves.toMatchObject({ fiberAmount: 396_000_000_000n });
      });

      it("ignores payouts already sent, ended swaps, other assets on Fiber and the other direction", async () => {
        const h = makeHarness({ udtScripts: ALL_UDT_SCRIPTS });
        const big = { fiberAmount: 10n ** 15n, sats: 10n ** 9n };
        openSwap(h, { ...big, direction: "ln_to_fiber", asset: "CKB", state: "outgoing_in_flight" });
        openSwap(h, { ...big, direction: "ln_to_fiber", asset: "CKB", state: "outgoing_succeeded" });
        openSwap(h, { ...big, direction: "ln_to_fiber", asset: "CKB", state: "failed", refunded: false });
        openSwap(h, { ...big, direction: "ln_to_fiber", asset: "CKB", state: "succeeded" });
        openSwap(h, { ...big, direction: "ln_to_fiber", asset: "RUSD", state: "pending" });
        openSwap(h, { ...big, direction: "fiber_to_ln", asset: "CKB", state: "pending" });
        h.fiber.setChannels([channel({ localBalance: 397_980_000_000n })]);

        await expect(h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n))).resolves.toBeDefined();
      });

      it("listAssets reports what is left for a new quote", async () => {
        const h = makeHarness();
        openSwap(h, { direction: "fiber_to_ln", asset: "CKB", state: "pending", sats: 10_000n });
        h.lightning.setBalances({ channelLocalSats: 30_300n });
        h.fiber.setChannels([]);

        const [ckb] = await h.service.listAssets();

        // (30,300 - 10,100 reserved) / 1.01 = 20,000.
        expect(ckb?.liquidity).toEqual({ lightningSats: 20_000n, fiberAmount: 0n });
      });
    });

    it("fiber_to_ln does not need Fiber liquidity (the hub receives on Fiber)", async () => {
      const h = makeHarness();
      h.fiber.setChannels([]);

      await expect(h.service.createQuote(req("fiber_to_ln", "CKB", "pay", 400_000_000_000n))).resolves.toBeDefined();
    });

    it("ln_to_fiber does not need Lightning liquidity (the hub receives on Lightning)", async () => {
      const h = makeHarness();
      h.lightning.setBalances({ channelLocalSats: 0n });

      await expect(h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n))).resolves.toBeDefined();
    });

    it("refuses with a 503 HubError, and stores nothing, when a node's balances cannot be read", async () => {
      for (const breakNode of [(h: Harness) => (h.lightning.failNext = "getBalances"), (h: Harness) => (h.fiber.failNext = "listChannels")]) {
        const h = makeHarness();
        breakNode(h);
        const save = jest.spyOn(h.store, "saveQuote");

        await expectHubError(() => h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n)), 503, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
        expect(save).not.toHaveBeenCalled();
      }
    });
  });

  describe("verifyQuote", () => {
    const createdQuote = async (options: HarnessOptions = {}) => {
      const h = makeHarness(options);
      return { h, quote: await h.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n)) };
    };

    it("accepts a quote it issued, also after a round trip through the store", async () => {
      const { h, quote } = await createdQuote();
      const stored = h.service.getQuote(quote.id);

      expect(h.service.verifyQuote(quote)).toBe(true);
      expect(stored && h.service.verifyQuote(stored)).toBe(true);
    });

    const tampers: [string, (q: Quote) => Quote][] = [
      ["id", (q) => ({ ...q, id: "someone-elses-id" })],
      ["direction", (q) => ({ ...q, direction: "fiber_to_ln" })],
      ["asset", (q) => ({ ...q, asset: "RUSD" })],
      ["sats (pay less)", (q) => ({ ...q, sats: q.sats - 1n })],
      ["fiberAmount (receive more)", (q) => ({ ...q, fiberAmount: q.fiberAmount + 1n })],
      ["btcUsd", (q) => ({ ...q, btcUsd: q.btcUsd + 1 })],
      ["assetUsd", (q) => ({ ...q, assetUsd: q.assetUsd / 2 })],
      ["priceSource", (q) => ({ ...q, priceSource: "median:mine" })],
      ["priceAt", (q) => ({ ...q, priceAt: q.priceAt + 1 })],
      ["feeBps", (q) => ({ ...q, feeBps: 0 })],
      ["createdAt", (q) => ({ ...q, createdAt: q.createdAt + 1 })],
      ["expiresAt (extend the free option)", (q) => ({ ...q, expiresAt: q.expiresAt + 3_600_000 })],
      ["signature", (q) => ({ ...q, signature: q.signature.slice(0, -2) + (q.signature.endsWith("00") ? "01" : "00") })],
      ["signature removed", (q) => ({ ...q, signature: "" })],
      ["hubPubkey", (q) => ({ ...q, hubPubkey: "ab".repeat(32) })],
    ];

    it.each(tampers)("rejects a quote with a changed %s", async (_label, tamper) => {
      const { h, quote } = await createdQuote();

      expect(h.service.verifyQuote(tamper(quote))).toBe(false);
    });

    it("rejects a quote another hub signed", async () => {
      const ours = await createdQuote();
      const theirs = await createdQuote();

      expect(ours.h.service.verifyQuote(theirs.quote)).toBe(false);
    });

    it("rejects a quote re-signed by someone else with their own key in hubPubkey", async () => {
      const { h, quote } = await createdQuote();
      const forger = new Ed25519QuoteSigner(h.config);
      const better = { ...quote, fiberAmount: quote.fiberAmount * 2n };
      const forged: Quote = { ...better, signature: forger.sign(canonicalQuoteMessage(better)), hubPubkey: forger.publicKeyHex };

      expect(forger.verify(canonicalQuoteMessage(forged), forged.signature, forged.hubPubkey)).toBe(true);
      expect(h.service.verifyQuote(forged)).toBe(false);
    });

    it("does not check expiry", async () => {
      const { h, quote } = await createdQuote();
      h.clock.advance(QUOTE_TTL_SECONDS * 1_000 * 10);

      expect(h.clock.now()).toBeGreaterThan(quote.expiresAt);
      expect(h.service.verifyQuote(quote)).toBe(true);
    });

    it("still accepts a quote after a restart when the signing key is configured", async () => {
      const store = new FakeSwapStore(new FakeClock());
      const before = makeHarness({ store, pricing: { signingKeyHex: SIGNING_SEED_HEX } });
      const quote = await before.service.createQuote(req("ln_to_fiber", "CKB", "pay", 10_000n));
      const after = makeHarness({ store, pricing: { signingKeyHex: SIGNING_SEED_HEX } });
      const stored = after.service.getQuote(quote.id);

      expect(stored).not.toBeNull();
      expect(after.service.verifyQuote(stored as Quote)).toBe(true);
    });

    it("no longer accepts older quotes after a restart with a per-process key", async () => {
      const before = await createdQuote();
      const after = makeHarness({ store: before.h.store });

      expect(after.service.verifyQuote(before.quote)).toBe(false);
    });
  });

  describe("listAssets", () => {
    it("lists only CKB on a devnet with no UDT scripts", async () => {
      const list = await makeHarness().service.listAssets();

      expect(list.map((a) => a.asset.id)).toEqual(["CKB"]);
    });

    it("lists every served asset, both directions, the caps from config and the largest payout each side allows", async () => {
      const h = fullHarness({ pricing: { minSats: 2_000n, maxSats: 50_000n } });
      h.lightning.setBalances({ channelLocalSats: 777_000n, channelRemoteSats: 1n, onchainSats: 5n });
      h.fiber.setChannels([
        channel({ localBalance: 5n * CKB }),
        channel({ localBalance: 99n * CKB, ready: false }),
        channel({ udtTypeScript: RUSD_SCRIPT, localBalance: 3n * CKB }),
        channel({ udtTypeScript: RUSD_SCRIPT_UPPER, localBalance: 1n }),
        channel({ udtTypeScript: OTHER_UDT_SCRIPT, localBalance: 8n * CKB }),
      ]);

      const list = await h.service.listAssets();

      expect(list.map((a) => a.asset.id).sort()).toEqual(["CKB", "CWBTC", "RUSD"]);
      for (const entry of list) {
        expect([...entry.directions].sort()).toEqual(["fiber_to_ln", "ln_to_fiber"]);
        expect({ minSats: entry.minSats, maxSats: entry.maxSats }).toEqual({ minSats: 2_000n, maxSats: 50_000n });
        // floor(777,000 / 1.01): the largest payout that leaves its 1 % Lightning fee budget.
        expect(entry.liquidity.lightningSats).toBe(769_306n);
        expect(entry.asset).toEqual(h.assets.get(entry.asset.id));
      }
      const fiberById = Object.fromEntries(list.map((a) => [a.asset.id, a.liquidity.fiberAmount]));
      // floor(balance / 1.005): 500,000,000 -> 497,512,437 and 300,000,001 -> 298,507,463.
      expect(fiberById).toEqual({ CKB: 497_512_437n, RUSD: 298_507_463n, CWBTC: 0n });
    });

    it("reports liquidity as it is now", async () => {
      const h = makeHarness();
      h.lightning.setBalances({ channelLocalSats: 10_100n });
      const before = await h.service.listAssets();
      h.lightning.setBalances({ channelLocalSats: 20_200n });
      const after = await h.service.listAssets();

      expect(before[0]?.liquidity.lightningSats).toBe(10_000n);
      expect(after[0]?.liquidity.lightningSats).toBe(20_000n);
    });

    it("works while every price source is down: it needs no price", async () => {
      const h = makeHarness();
      for (const source of h.sources) source.failing = true;

      await expect(h.service.listAssets()).resolves.toHaveLength(1);
    });

    it("throws a 503 HubError when a node's balances cannot be read", async () => {
      const h = makeHarness();
      h.fiber.failNext = "listChannels";

      await expectHubError(() => h.service.listAssets(), 503, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
    });
  });

  it("implements the PricingService contract", () => {
    const service: PricingService = makeHarness().service;

    expect(service).toBeInstanceOf(PricingServiceImpl);
  });
});
