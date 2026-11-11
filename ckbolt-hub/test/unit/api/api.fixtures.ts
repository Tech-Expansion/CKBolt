import "reflect-metadata";
import { Logger, Module, type DynamicModule, type INestApplication, type ModuleMetadata, type Provider } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { DemoWallet } from "../../../src/application/demo/demo-wallet.contract";
import { DEMO_WALLET } from "../../../src/application/demo/demo-wallet.contract";
import { HEALTH_SERVICE, type HealthReport, type HealthService } from "../../../src/application/health/health.contract";
import type { FiberPort } from "../../../src/application/ports/fiber.port";
import type { LightningPort } from "../../../src/application/ports/lightning.port";
import { CLOCK, DEMO_FIBER, DEMO_LIGHTNING, FIBER, HUB_CONFIG, LIGHTNING } from "../../../src/application/ports/tokens";
import { PRICING_SERVICE, type AssetAvailability, type PricingService } from "../../../src/application/pricing/pricing.contract";
import { SWAP_ENGINE, type CreatedSwap, type CreateSwapInput, type SwapEngine } from "../../../src/application/swaps/swap-engine.contract";
import { RESOURCE_NAME } from "../../../src/common/constants/api.constants";
import { NotFoundError } from "../../../src/common/errors/hub.error";
import { secretDigest } from "../../../src/common/utils/secret.util";
import { HubConfigModule } from "../../../src/config/config.module";
import { assetRegistryOf, loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import type { AssetRegistry } from "../../../src/domain/assets";
import type { AssetLiquidity } from "../../../src/domain/pricing";
import type { FiberAsset, Quote, QuoteRequest, Script, Swap, SwapEvent } from "../../../src/domain/types";
import { ApiModule } from "../../../src/interfaces/http/api.module";
import type { FakeClock } from "../../fakes";

/**
 * Shared fixtures for the API module tests: a test HubConfig, quote and swap records, stub application services that
 * implement the contracts (their real implementations are other modules), and a real Nest app around ApiModule.
 */

export const QUOTE_ID = "11111111-1111-4111-8111-111111111111";
export const SWAP_ID = "22222222-2222-4222-8222-222222222222";
export const UNKNOWN_ID = "33333333-3333-4333-8333-333333333333";
export const PAYMENT_HASH = "ab".repeat(32);
export const PREIMAGE = "cd".repeat(32);
/** The cancel token StubSwapEngine.createSwap answers with, and the hash a stub swap keeps of it. */
export const CANCEL_TOKEN = "ef".repeat(32);
export const CANCEL_TOKEN_HASH = secretDigest(CANCEL_TOKEN);

/** A devnet RUSD stand-in, so the registry serves CKB and RUSD (CWBTC stays unserved). */
export const DEVNET_RUSD_SCRIPT: Script = {
  codeHash: `0x${"12".repeat(32)}`,
  hashType: "type",
  args: `0x${"34".repeat(32)}`,
};

export interface ConfigPatch {
  server?: Partial<HubConfig["server"]>;
  demo?: Partial<HubConfig["demo"]>;
  health?: Partial<HubConfig["health"]>;
  pricing?: Partial<HubConfig["pricing"]>;
  swaps?: Partial<HubConfig["swaps"]>;
  timing?: Partial<HubConfig["timing"]>;
}

/** The validated default config (regtest, devnet, RUSD stand-in) with some sections changed. */
export function testConfig(patch: ConfigPatch = {}): HubConfig {
  const base = loadHubConfig({ UDT_RUSD_SCRIPT: JSON.stringify(DEVNET_RUSD_SCRIPT) });
  return {
    ...base,
    server: { ...base.server, ...patch.server },
    demo: { ...base.demo, ...patch.demo },
    health: { ...base.health, ...patch.health },
    pricing: { ...base.pricing, ...patch.pricing },
    swaps: { ...base.swaps, ...patch.swaps },
    timing: { ...base.timing, ...patch.timing },
  };
}

export const testAssets = (config: HubConfig): AssetRegistry => assetRegistryOf(config);

export function requireAsset(registry: AssetRegistry, id: FiberAsset["id"]): FiberAsset {
  const asset = registry.get(id);
  if (!asset) throw new Error(`test setup: asset ${id} is not served`);
  return asset;
}

export function makeQuote(overrides: Partial<Quote> = {}): Quote {
  const createdAt = Date.UTC(2026, 9, 23, 12, 0, 0);
  return {
    id: QUOTE_ID,
    direction: "ln_to_fiber",
    asset: "CKB",
    sats: 50_000n,
    fiberAmount: 2_000_000_000_000n,
    btcUsd: 80_000,
    assetUsd: 0.002,
    priceSource: "median:fake-a,fake-b",
    priceAt: createdAt - 5_000,
    feeBps: 100,
    purpose: "swap",
    createdAt,
    expiresAt: createdAt + 180_000,
    signature: "ee".repeat(64),
    hubPubkey: "ff".repeat(32),
    ...overrides,
  };
}

export function makeSwap(overrides: Partial<Swap> = {}): Swap {
  const createdAt = Date.UTC(2026, 9, 23, 12, 1, 0);
  return {
    id: SWAP_ID,
    quoteId: QUOTE_ID,
    direction: "ln_to_fiber",
    asset: "CKB",
    paymentHash: PAYMENT_HASH,
    sats: 50_000n,
    fiberAmount: 2_000_000_000_000n,
    payoutInvoice: "fibd-user-payout-invoice",
    holdInvoice: "lnbcrt-hub-hold-invoice",
    state: "pending",
    preimage: null,
    failureReason: null,
    refunded: false,
    holdCltvExpiry: 200,
    holdFinalExpiryDeltaMs: null,
    payoutLockLimit: null,
    quoteExpiresAt: createdAt + 120_000,
    cancelTokenHash: CANCEL_TOKEN_HASH,
    demo: false,
    createdAt,
    updatedAt: createdAt + 1_000,
    ...overrides,
  };
}

export function makeAvailability(asset: FiberAsset, overrides: Partial<AssetAvailability> = {}): AssetAvailability {
  return {
    asset,
    directions: ["ln_to_fiber", "fiber_to_ln"],
    minSats: 1_000n,
    maxSats: 100_000n,
    liquidity: { lightningSats: 900_000n, fiberAmount: 12_345_678_901_234_567_890n },
    ...overrides,
  };
}

export const okHealthReport = (overrides: Partial<HealthReport> = {}): HealthReport => ({
  status: "ok",
  version: "9.9.9-test",
  lightning: { reachable: true, network: "regtest", synced: true, blockHeight: 321 },
  fiber: { reachable: true, network: "devnet", version: "0.9.1" },
  demo: { enabled: false },
  swaps: { paused: false },
  ...overrides,
});

/* ------------------------------------------------------------------------------- stub application services */

/** PricingService stub: createQuote stores and returns a quote for the request; getQuote reads the store. */
export class StubPricingService implements PricingService {
  readonly quotes = new Map<string, Quote>();
  availability: AssetAvailability[] = [];
  nextQuote: Quote = makeQuote();

  readonly createQuote = jest.fn(async (request: QuoteRequest): Promise<Quote> => {
    const quote = { ...this.nextQuote, direction: request.direction, asset: request.asset };
    this.quotes.set(quote.id, quote);
    return quote;
  });
  readonly getQuote = jest.fn((id: string): Quote | null => this.quotes.get(id) ?? null);
  readonly verifyQuote = jest.fn((): boolean => true);
  readonly listAssets = jest.fn(async (): Promise<AssetAvailability[]> => this.availability);
  readonly liquidityFor = jest.fn(async (): Promise<AssetLiquidity> => ({ lightningSats: 900_000n, fiberAmount: 12_345_678_901_234_567_890n }));
}

/** SwapEngine stub over an in-memory map. */
export class StubSwapEngine implements SwapEngine {
  readonly swaps = new Map<string, Swap>();
  readonly events: SwapEvent[] = [];
  nextSwap: Swap = makeSwap();

  readonly createSwap = jest.fn(async (input: CreateSwapInput): Promise<CreatedSwap> => {
    const swap = { ...this.nextSwap, quoteId: input.quoteId, payoutInvoice: input.payoutInvoice, demo: input.demo };
    this.swaps.set(swap.id, swap);
    return { ...swap, cancelToken: CANCEL_TOKEN };
  });
  /** Marks the swap failed and refunded, like a cancel of an unpaid swap; 404 for an unknown id. */
  readonly cancelSwap = jest.fn(async (id: string): Promise<Swap> => {
    const swap = this.swaps.get(id);
    if (!swap) throw new NotFoundError(RESOURCE_NAME.SWAP);
    const cancelled: Swap = { ...swap, state: "failed", refunded: true };
    this.swaps.set(id, cancelled);
    return cancelled;
  });
  readonly getSwap = jest.fn((id: string): Swap | null => this.swaps.get(id) ?? null);
  readonly listEvents = jest.fn((swapId: string): SwapEvent[] => this.events.filter((e) => e.swapId === swapId));
  readonly processSwap = jest.fn(async (): Promise<void> => undefined);
  readonly processOpenSwaps = jest.fn(async (): Promise<void> => undefined);

  add(swap: Swap): Swap {
    this.swaps.set(swap.id, swap);
    return swap;
  }
}

export class StubHealthService implements HealthService {
  report: HealthReport = okHealthReport();
  readonly check = jest.fn(async (): Promise<HealthReport> => this.report);
}

export class StubDemoWallet implements DemoWallet {
  enabled = true;
  readonly createPayoutInvoice = jest.fn(async () => ({ invoice: "fibd-demo-invoice", paymentHash: PAYMENT_HASH }));
  readonly payHoldInvoice = jest.fn(async (): Promise<void> => undefined);
  readonly receivesPayout = jest.fn(async (): Promise<boolean> => false);
}

export interface Stubs {
  pricing: StubPricingService;
  engine: StubSwapEngine;
  health: StubHealthService;
  demo: StubDemoWallet;
}

export const makeStubs = (): Stubs => ({
  pricing: new StubPricingService(),
  engine: new StubSwapEngine(),
  health: new StubHealthService(),
  demo: new StubDemoWallet(),
});

/* ------------------------------------------------------------------------------------------- Nest wiring */

@Module({})
class StubServicesModule {}

@Module({})
class FakeNodesModule {}

/** A module that provides and exports the given providers under their tokens. */
export function exportingModule(providers: (Provider & { provide: symbol })[]): DynamicModule {
  return { module: StubServicesModule, providers, exports: providers.map((p) => p.provide) };
}

export const stubServicesModule = (stubs: Stubs, without: symbol[] = []): DynamicModule =>
  exportingModule(
    [
      { provide: PRICING_SERVICE, useValue: stubs.pricing },
      { provide: SWAP_ENGINE, useValue: stubs.engine },
      { provide: HEALTH_SERVICE, useValue: stubs.health },
      { provide: DEMO_WALLET, useValue: stubs.demo },
    ].filter((p) => !without.includes(p.provide)),
  );

export interface FakeNodes {
  lightning: LightningPort;
  fiber: FiberPort;
  demoLightning: LightningPort | null;
  demoFiber: FiberPort | null;
}

/** Global node bindings, like LightningModule and FiberModule: demo tokens are null (from a factory) when off. */
export function fakeNodesModule(nodes: FakeNodes): DynamicModule {
  const providers = [
    { provide: LIGHTNING, useValue: nodes.lightning },
    { provide: FIBER, useValue: nodes.fiber },
    { provide: DEMO_LIGHTNING, useFactory: () => nodes.demoLightning },
    { provide: DEMO_FIBER, useFactory: () => nodes.demoFiber },
  ];
  return { module: FakeNodesModule, global: true, providers, exports: providers.map((p) => p.provide) };
}

export interface ApiAppOptions {
  config: HubConfig;
  clock: FakeClock;
  /** Passed to ApiModule.register({ imports }). */
  apiImports: ModuleMetadata["imports"];
  /** Extra root imports, e.g. global fake nodes. */
  rootImports?: ModuleMetadata["imports"];
}

/** A real Nest app: HubConfigModule (config and clock overridden) + ApiModule, listening on no port (supertest). */
export async function createApiApp(options: ApiAppOptions): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [HubConfigModule, ...(options.rootImports ?? []), ApiModule.register({ imports: options.apiImports })],
  })
    .overrideProvider(HUB_CONFIG)
    .useValue(options.config)
    .overrideProvider(CLOCK)
    .useValue(options.clock)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

/** Silences Nest loggers for a test and returns spies to assert on what was logged. */
export function spyOnLogger(): { error: jest.SpyInstance; warn: jest.SpyInstance; log: jest.SpyInstance } {
  return {
    error: jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined),
    warn: jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined),
    log: jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined),
  };
}
