import "reflect-metadata";
import { Module, type DynamicModule, type Provider } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ASSETS, CLOCK, FIBER, HUB_CONFIG, LIGHTNING, PRICE_SOURCES, SWAP_STORE, TIMING_PROFILE } from "../../../src/application/ports/tokens";
import { PRICING_SERVICE, type PricingService } from "../../../src/application/pricing/pricing.contract";
import { SWAP_ENGINE, type SwapEngine } from "../../../src/application/swaps/swap-engine.contract";
import { SwapEngineService } from "../../../src/application/swaps/swap-engine.service";
import { SwapSchedulerService } from "../../../src/application/swaps/swap-scheduler.service";
import { SwapsModule } from "../../../src/application/swaps/swaps.module";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import type { Swap, SwapState } from "../../../src/domain/types";
import { FakePriceSource } from "../../fakes";
import {
  makeSwapHarness,
  newPreimage,
  payHoldInvoice,
  processPasses,
  requireSwap,
  silenceLogs,
  startSwap,
  userFiberInvoice,
  userLnInvoice,
  TEST_CLIENT_KEY,
  type SwapHarness,
} from "./swaps.fixtures";

/**
 * SwapsModule as Nest wires it: SWAP_ENGINE and the scheduler, PricingModule imported, every port and config value
 * from global modules (here one test module standing in for HubConfigModule and the infrastructure modules). The
 * scheduler runs for real: a recovery pass on init, push updates from the fake nodes, a clean stop on close.
 */

@Module({})
class TestInfrastructureModule {}

/** HUB_CONFIG, TIMING_PROFILE, ASSETS, CLOCK, LIGHTNING, FIBER, SWAP_STORE and PRICE_SOURCES from the harness. */
function infrastructure(h: SwapHarness): DynamicModule {
  const providers: Provider[] = [
    { provide: HUB_CONFIG, useValue: h.config },
    { provide: TIMING_PROFILE, useValue: h.config.timing },
    { provide: ASSETS, useValue: h.assets },
    { provide: CLOCK, useValue: h.clock },
    { provide: LIGHTNING, useValue: h.hubLn },
    { provide: FIBER, useValue: h.hubFiber },
    { provide: SWAP_STORE, useValue: h.store },
    { provide: PRICE_SOURCES, useValue: ["fake-a", "fake-b", "fake-c"].map((name) => new FakePriceSource(name, h.clock)) },
  ];
  return { module: TestInfrastructureModule, global: true, providers, exports: providers.map((p) => (p as { provide: symbol }).provide) };
}

/** A long poll interval: only the recovery pass and push updates move swaps in these specs. */
const POLL_INTERVAL_MS = 60_000;

async function compile(h: SwapHarness): Promise<TestingModule> {
  return Test.createTestingModule({ imports: [infrastructure(h), SwapsModule] }).compile();
}

/** Waits (real time) until the swap reaches `state`, or fails the test. */
async function waitForState(engine: SwapEngine, id: string, state: SwapState): Promise<Swap> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const swap = engine.getSwap(id);
    if (swap?.state === state) return swap;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`swap ${id} did not reach ${state}; it is ${engine.getSwap(id)?.state}`);
}

describe("SwapsModule (Nest)", () => {
  let h: SwapHarness;
  let moduleRef: TestingModule | null;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness({ swaps: { pollIntervalMs: POLL_INTERVAL_MS } });
    moduleRef = null;
  });

  afterEach(async () => {
    await moduleRef?.close();
    jest.restoreAllMocks();
  });

  it("provides SWAP_ENGINE as the SwapEngineService and the scheduler, with pricing from PricingModule", async () => {
    moduleRef = await compile(h);
    expect(moduleRef.get(SWAP_ENGINE)).toBeInstanceOf(SwapEngineService);
    expect(moduleRef.get(SwapSchedulerService)).toBeInstanceOf(SwapSchedulerService);
    const pricing = moduleRef.get<PricingService>(PRICING_SERVICE, { strict: false });
    expect(typeof pricing.createQuote).toBe("function");
  });

  it("exports SWAP_ENGINE to modules that import SwapsModule", async () => {
    @Module({ imports: [SwapsModule] })
    class ConsumerModule {}
    moduleRef = await Test.createTestingModule({ imports: [infrastructure(h), ConsumerModule] }).compile();
    expect(moduleRef.select(ConsumerModule).get(SWAP_ENGINE)).toBeInstanceOf(SwapEngineService);
  });

  it("resumes open swaps on start-up: a swap left in outgoing_succeeded is settled by the recovery pass", async () => {
    const { swap } = await startSwap(h, "ln_to_fiber");
    await payHoldInvoice(h, swap);
    await processPasses(h, swap.id, 3);
    expect(requireSwap(h, swap.id).state).toBe("outgoing_succeeded");

    moduleRef = await compile(h);
    await moduleRef.init();
    expect(requireSwap(h, swap.id).state).toBe("succeeded");
  });

  it("ln_to_fiber end to end: a real quote, a swap, the user's payment; push updates carry it to succeeded", async () => {
    moduleRef = await compile(h);
    await moduleRef.init();
    const pricing = moduleRef.get<PricingService>(PRICING_SERVICE, { strict: false });
    const engine = moduleRef.get<SwapEngine>(SWAP_ENGINE);

    const quote = await pricing.createQuote({ direction: "ln_to_fiber", asset: "CKB", side: "pay", amount: 10_000n });
    const preimage = newPreimage();
    const swap = await engine.createSwap({ quoteId: quote.id, payoutInvoice: userFiberInvoice(h, preimage, quote), demo: false, clientKey: TEST_CLIENT_KEY });
    expect(swap).toMatchObject({ state: "pending", sats: quote.sats, fiberAmount: quote.fiberAmount });

    await payHoldInvoice(h, swap);
    const done = await waitForState(engine, swap.id, "succeeded");
    expect(done.preimage).toBe(preimage);
    const hash = sha256Hex(preimage);
    expect(h.fiberNet.invoices.get(hash)?.state).toBe("Paid");
    expect((await h.hubLn.lookupInvoice(hash))?.state).toBe("SETTLED");
  });

  it("fiber_to_ln end to end: a real quote, a swap, the user's payment; push updates carry it to succeeded", async () => {
    moduleRef = await compile(h);
    await moduleRef.init();
    const pricing = moduleRef.get<PricingService>(PRICING_SERVICE, { strict: false });
    const engine = moduleRef.get<SwapEngine>(SWAP_ENGINE);

    const quote = await pricing.createQuote({ direction: "fiber_to_ln", asset: "CKB", side: "receive", amount: 10_000n });
    const preimage = newPreimage();
    const swap = await engine.createSwap({ quoteId: quote.id, payoutInvoice: userLnInvoice(h, preimage, quote), demo: true, clientKey: TEST_CLIENT_KEY });

    await payHoldInvoice(h, swap);
    const done = await waitForState(engine, swap.id, "succeeded");
    expect(done).toMatchObject({ preimage, demo: true });
    expect((await h.hubFiber.getInvoice(sha256Hex(preimage)))?.state).toBe("Paid");
  });

  it("stops on close: no more processing after the module is destroyed", async () => {
    const { swap } = await startSwap(h, "ln_to_fiber");
    moduleRef = await compile(h);
    await moduleRef.init();
    await moduleRef.close();
    moduleRef = null;

    await payHoldInvoice(h, swap);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requireSwap(h, swap.id).state).toBe("pending");
  });
});
