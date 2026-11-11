import "reflect-metadata";
import { Inject, Injectable, Module, type DynamicModule } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { PRICING_SERVICE, type PricingService } from "../../../src/application/pricing/pricing.contract";
import { PricingModule } from "../../../src/application/pricing/pricing.module";
import { PricingServiceImpl } from "../../../src/application/pricing/pricing.service";
import type { PriceSource } from "../../../src/application/ports/prices.port";
import { CLOCK, FIBER, HUB_CONFIG, LIGHTNING, PRICE_SOURCES, SWAP_STORE } from "../../../src/application/ports/tokens";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { HubConfigModule } from "../../../src/config/config.module";
import { FakeClock, FakeFiberNetwork, FakeLightningNetwork, FakePriceSource, FakeSwapStore } from "../../fakes";
import { ALL_UDT_SCRIPTS, expectHubError, hubConfig, QUOTE_TTL_SECONDS, silenceWarnings } from "./pricing.fixtures";

interface Fakes {
  clock: FakeClock;
  sources: FakePriceSource[];
  lightning: ReturnType<FakeLightningNetwork["node"]>;
  fiber: ReturnType<FakeFiberNetwork["node"]>;
  store: FakeSwapStore;
}

const makeFakes = (): Fakes => {
  const clock = new FakeClock();
  return {
    clock,
    sources: [new FakePriceSource("coingecko", clock), new FakePriceSource("kucoin", clock)],
    lightning: new FakeLightningNetwork("regtest", clock).node("hub"),
    fiber: new FakeFiberNetwork("devnet", clock).node("hub"),
    store: new FakeSwapStore(clock),
  };
};

/** Stands in for the global infrastructure modules (LightningModule, FiberModule, PersistenceModule, PricesModule). */
@Module({})
class FakeInfrastructureModule {
  static with(fakes: Fakes): DynamicModule {
    const providers = [
      { provide: LIGHTNING, useValue: fakes.lightning },
      { provide: FIBER, useValue: fakes.fiber },
      { provide: SWAP_STORE, useValue: fakes.store },
      { provide: PRICE_SOURCES, useValue: fakes.sources as PriceSource[] },
    ];
    return { module: FakeInfrastructureModule, global: true, providers, exports: providers.map((p) => p.provide) };
  }
}

/** A feature module (like the HTTP API) that imports PricingModule and injects the service by its token. */
@Injectable()
class QuotesController {
  constructor(@Inject(PRICING_SERVICE) readonly pricing: PricingService) {}
}

@Module({ imports: [PricingModule], providers: [QuotesController] })
class ApiLikeModule {}

describe("PricingModule", () => {
  let moduleRef: TestingModule | undefined;
  let fakes: Fakes;

  const compile = async (configPatch: Parameters<typeof hubConfig>[0] = {}): Promise<TestingModule> => {
    moduleRef = await Test.createTestingModule({
      imports: [HubConfigModule, FakeInfrastructureModule.with(fakes), ApiLikeModule],
    })
      .overrideProvider(HUB_CONFIG)
      .useValue(hubConfig(configPatch))
      .overrideProvider(CLOCK)
      .useValue(fakes.clock)
      .compile();
    return moduleRef;
  };

  beforeEach(() => {
    fakes = makeFakes();
    silenceWarnings();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it("exports PRICING_SERVICE, bound to PricingServiceImpl, to a module that imports it", async () => {
    const controller = (await compile()).get(QuotesController);

    expect(controller.pricing).toBeInstanceOf(PricingServiceImpl);
  });

  it("wires the service to the injected ports, config, clock and assets", async () => {
    const { pricing } = (await compile({ pricing: { quoteTtlSeconds: 240 }, udtScripts: ALL_UDT_SCRIPTS })).get(QuotesController);
    fakes.clock.advance(5_000);

    const quote = await pricing.createQuote({ direction: "ln_to_fiber", asset: "CKB", side: "pay", amount: 10_000n });

    expect(quote).toMatchObject({ sats: 10_000n, fiberAmount: 396_000_000_000n, createdAt: fakes.clock.now(), expiresAt: fakes.clock.now() + 240_000 });
    expect(quote.priceSource).toContain("coingecko");
    expect(quote.priceSource).toContain("kucoin");
    expect(fakes.store.getQuote(quote.id)).toEqual(quote);
    expect(pricing.getQuote(quote.id)).toEqual(quote);
    expect(pricing.verifyQuote(quote)).toBe(true);
    expect(fakes.lightning.calls).toContain("getBalances");
    expect(fakes.fiber.calls).toContain("listChannels");
    expect((await pricing.listAssets()).map((a) => a.asset.id).sort()).toEqual(["CKB", "CWBTC", "RUSD"]);
  });

  it("uses the configured TTL by default", async () => {
    const { pricing } = (await compile()).get(QuotesController);

    const quote = await pricing.createQuote({ direction: "fiber_to_ln", asset: "CKB", side: "receive", amount: 5_000n });

    expect(quote.expiresAt - quote.createdAt).toBe(QUOTE_TTL_SECONDS * 1_000);
  });

  it("surfaces the injected sources' failure as quote_unavailable", async () => {
    const { pricing } = (await compile()).get(QuotesController);
    for (const source of fakes.sources) source.failing = true;

    await expectHubError(() => pricing.createQuote({ direction: "ln_to_fiber", asset: "CKB", side: "pay", amount: 10_000n }), 503, API_ERROR_CODE.QUOTE_UNAVAILABLE);
  });

  it("is a singleton: the same service everywhere, so one signing key per process", async () => {
    const ref = await compile();
    const a = ref.get(QuotesController).pricing;
    const quote = await a.createQuote({ direction: "ln_to_fiber", asset: "CKB", side: "pay", amount: 10_000n });

    expect(ref.get<PricingService>(PRICING_SERVICE, { strict: false })).toBe(a);
    expect(ref.get<PricingService>(PRICING_SERVICE, { strict: false }).verifyQuote(quote)).toBe(true);
  });

  it("fails to start without the infrastructure ports", async () => {
    await expect(
      Test.createTestingModule({ imports: [HubConfigModule, ApiLikeModule] })
        .overrideProvider(HUB_CONFIG)
        .useValue(hubConfig())
        .compile(),
    ).rejects.toThrow();
  });
});
