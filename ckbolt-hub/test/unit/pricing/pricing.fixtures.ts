import { Logger } from "@nestjs/common";
import { LiquidityService } from "../../../src/application/pricing/liquidity.service";
import { MarketPriceService } from "../../../src/application/pricing/market-price.service";
import { PricingServiceImpl } from "../../../src/application/pricing/pricing.service";
import { Ed25519QuoteSigner } from "../../../src/application/pricing/ed25519-quote-signer";
import type { FiberChannelBalance } from "../../../src/application/ports/fiber.port";
import type { ApiErrorCode } from "../../../src/common/constants/api.constants";
import { HubError } from "../../../src/common/errors/hub.error";
import { loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import { legacyUdtAssetSettings } from "../../../src/config/fiber-assets.config";
import { createAssetRegistry, type AssetRegistry, type UdtScripts } from "../../../src/domain/assets";
import type { CkbNetwork, Quote, Script } from "../../../src/domain/types";
import {
  FakeClock,
  FakeFiberNetwork,
  FakeLightningNetwork,
  FakePriceSource,
  FakeSwapStore,
  type FakeFiberNode,
  type FakeLightningNode,
} from "../../fakes";

/**
 * Shared fixtures for the pricing tests. Expected amounts in the specs are worked out by hand from the default fake
 * prices (1 BTC = $80,000, 1 CKB = $0.002, so 1 sat = 0.4 CKB = 40,000,000 shannons) and the rules in the module spec.
 * Nothing here reuses the implementation's maths helpers, so the specs stay an independent check.
 */

export const BTC_USD = 80_000;
export const CKB_USD = 0.002;

/** Base units per whole asset unit (all three Fiber assets have 8 decimals) and sats per BTC. */
export const BASE_UNITS_PER_WHOLE = 100_000_000n;
export const SATS_PER_BTC = 100_000_000n;
/** 1 sat = 0.4 CKB at the default prices. */
export const SHANNONS_PER_SAT = 40_000_000n;

/** Hub fee and option premium used by the harness: 1 % in total. */
export const FEE_BPS = 50;
export const OPTION_PREMIUM_BPS = 50;
export const TOTAL_FEE_BPS = FEE_BPS + OPTION_PREMIUM_BPS;

/** Routing fee limits of the payouts (config.swaps): the quote's liquidity check keeps this much on top of a payout. */
export const LN_MAX_FEE_BPS = 100;
export const FIBER_MAX_FEE_BPS = 50;

export const MIN_SATS = 1_000n;
export const MAX_SATS = 100_000n;
export const QUOTE_TTL_SECONDS = 180;
export const MAX_PRICE_AGE_MS = 10 * 60_000;

/** A whole RFC 8032 seed, so tests that need a stable key across restarts can share one. */
export const SIGNING_SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";

/** Devnet stand-ins for the UDTs; hex in mixed case on purpose to check script comparison ignores case. */
export const RUSD_SCRIPT: Script = { codeHash: `0x${"ab".repeat(32)}`, hashType: "type", args: `0x${"01".repeat(32)}` };
export const RUSD_SCRIPT_UPPER: Script = { codeHash: `0x${"AB".repeat(32)}`, hashType: "type", args: `0x${"01".repeat(32)}` };
export const CWBTC_SCRIPT: Script = { codeHash: `0x${"cd".repeat(32)}`, hashType: "data1", args: "0x02" };
export const OTHER_UDT_SCRIPT: Script = { codeHash: `0x${"ef".repeat(32)}`, hashType: "type", args: "0x03" };

export const ALL_UDT_SCRIPTS: UdtScripts = { RUSD: RUSD_SCRIPT, CWBTC: CWBTC_SCRIPT };

export interface ConfigPatch {
  pricing?: Partial<HubConfig["pricing"]>;
  swaps?: Partial<HubConfig["swaps"]>;
  udtScripts?: UdtScripts;
  network?: CkbNetwork;
}

/**
 * The validated default config with explicit pricing values (so specs do not depend on env defaults) and any patch.
 * The price cache is off unless a spec turns it on, so every quote reads the sources.
 */
export function hubConfig(patch: ConfigPatch = {}): HubConfig {
  const base = loadHubConfig({});
  const network = patch.network ?? "devnet";
  return {
    ...base,
    ckb: { network, udtAssets: legacyUdtAssetSettings({ network, udtScripts: patch.udtScripts ?? {}, inboundAmounts: {} }).map(({ asset }) => asset) },
    pricing: {
      ...base.pricing,
      sources: ["coingecko", "binance", "kucoin"],
      httpTimeoutMs: 5_000,
      maxPriceAgeMs: MAX_PRICE_AGE_MS,
      priceCacheMs: 0,
      feeBps: FEE_BPS,
      optionPremiumBps: OPTION_PREMIUM_BPS,
      quoteTtlSeconds: QUOTE_TTL_SECONDS,
      minSats: MIN_SATS,
      maxSats: MAX_SATS,
      signingKeyHex: null,
      ...patch.pricing,
    },
    swaps: { ...base.swaps, lnMaxFeeBps: LN_MAX_FEE_BPS, fiberMaxFeeBps: FIBER_MAX_FEE_BPS, ...patch.swaps },
  };
}

export const channel = (patch: Partial<FiberChannelBalance> = {}): FiberChannelBalance => ({
  channelId: `0x${"22".repeat(32)}`,
  peer: "peer",
  udtTypeScript: null,
  ready: true,
  localBalance: 0n,
  remoteBalance: 0n,
  ...patch,
});

export interface Harness {
  config: HubConfig;
  clock: FakeClock;
  assets: AssetRegistry;
  sources: FakePriceSource[];
  lightning: FakeLightningNode;
  fiber: FakeFiberNode;
  store: FakeSwapStore;
  signer: Ed25519QuoteSigner;
  marketPrices: MarketPriceService;
  liquidity: LiquidityService;
  service: PricingServiceImpl;
}

export interface HarnessOptions extends ConfigPatch {
  clock?: FakeClock;
  /** Names of the fake price sources; all start at the default prices. */
  sourceNames?: string[];
  store?: FakeSwapStore;
}

/** A PricingServiceImpl wired by hand to the fakes, as the Nest module would wire it. */
export function makeHarness(options: HarnessOptions = {}): Harness {
  const clock = options.clock ?? new FakeClock();
  const config = hubConfig(options);
  const assets = createAssetRegistry(config.ckb.network, config.ckb.udtAssets);
  const sources = (options.sourceNames ?? ["coingecko", "binance", "kucoin"]).map((name) => new FakePriceSource(name, clock));
  const lightning = new FakeLightningNetwork("regtest", clock).node("hub");
  const fiber = new FakeFiberNetwork("devnet", clock).node("hub");
  const store = options.store ?? new FakeSwapStore(clock);
  const signer = new Ed25519QuoteSigner(config);
  const marketPrices = new MarketPriceService(sources, clock, config);
  const liquidity = new LiquidityService(lightning, fiber);
  const service = new PricingServiceImpl(config, assets, clock, store, signer, marketPrices, liquidity);
  return { config, clock, assets, sources, lightning, fiber, store, signer, marketPrices, liquidity, service };
}

/** Sets every fake source to these prices. */
export function setPrices(sources: FakePriceSource[], prices: { btc: number; ckb: number; ageMs?: number }): void {
  for (const source of sources) source.prices = { ...prices };
}

/** Runs `action` and returns the HubError it throws, after checking its status and code. */
export async function expectHubError(action: () => unknown, status: number, code: ApiErrorCode): Promise<HubError> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(HubError);
  const hubError = thrown as HubError;
  expect({ status: hubError.status, code: hubError.code }).toEqual({ status, code });
  expect(hubError.message.length).toBeGreaterThan(0);
  return hubError;
}

/** Silences the Nest logger's warnings (failing price sources, node reads) and returns the spy. */
export const silenceWarnings = (): jest.SpyInstance => jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

/* ---------------------------------------------------------------------------- exact rationals for the checks */

export interface Fraction {
  num: bigint;
  den: bigint;
}

/** A plain decimal (no exponent) as an exact fraction: "0.0021" -> 21/10000. */
export function fractionOf(value: number): Fraction {
  const text = String(value);
  if (/e/i.test(text)) throw new Error(`Test price ${text} must be a plain decimal`);
  const [whole = "0", fraction = ""] = text.split(".");
  return { num: BigInt(whole + fraction), den: 10n ** BigInt(fraction.length) };
}

export const floorDiv = (a: bigint, b: bigint): bigint => a / b;
export const ceilDivide = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A complete Quote, for message and signature tests. */
export const sampleQuote = (patch: Partial<Quote> = {}): Quote => ({
  id: "6f1c1d1e-0000-4000-8000-000000000001",
  direction: "ln_to_fiber",
  asset: "CKB",
  sats: 10_000n,
  fiberAmount: 396_000_000_000n,
  btcUsd: BTC_USD,
  assetUsd: CKB_USD,
  priceSource: "median:coingecko,binance,kucoin",
  priceAt: Date.UTC(2026, 9, 23, 11, 59, 0),
  feeBps: TOTAL_FEE_BPS,
  purpose: "swap",
  createdAt: Date.UTC(2026, 9, 23, 12, 0, 0),
  expiresAt: Date.UTC(2026, 9, 23, 12, 3, 0),
  signature: "00".repeat(64),
  hubPubkey: "11".repeat(32),
  ...patch,
});
