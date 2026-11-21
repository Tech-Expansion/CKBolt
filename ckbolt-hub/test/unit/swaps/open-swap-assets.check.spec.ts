import "reflect-metadata";
import { join } from "node:path";
import { Logger, Module, type DynamicModule, type Provider } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import type { SwapStore } from "../../../src/application/ports/swap-store.port";
import { ASSETS, CLOCK, DEMO_FIBER, DEMO_LIGHTNING, FIBER, HUB_CONFIG, LIGHTNING, PRICE_SOURCES, SWAP_STORE, TIMING_PROFILE } from "../../../src/application/ports/tokens";
import { assertOpenSwapAssetsServed } from "../../../src/application/swaps/open-swap-assets.check";
import { SWAP_ENGINE } from "../../../src/application/swaps/swap-engine.contract";
import { SwapsModule } from "../../../src/application/swaps/swaps.module";
import { AppModule } from "../../../src/app.module";
import { SWAP_STATE } from "../../../src/common/constants/swap.constants";
import { loadHubConfig } from "../../../src/config/hub.config";
import { createAssetRegistry, type AssetRegistry } from "../../../src/domain/assets";
import type { FiberAsset, Swap } from "../../../src/domain/types";
import { openSqliteSwapStore } from "../../../src/infrastructure/persistence/sqlite-swap-store";
import { FakeClock, FakeFiberNetwork, FakeLightningNetwork, FakePriceSource, FakeSwapStore } from "../../fakes";
import { DEVNET_RUSD_SCRIPT } from "../api/api.fixtures";
import { makeSwap, makeTempDir, removeTempDir } from "../persistence/persistence.fixtures";
import { makeSwapHarness, silenceLogs, type SwapHarness } from "./swaps.fixtures";

/**
 * Security review H8: the engine reads and pays a Fiber leg by its asset's type script, so a swap still open in an
 * asset the hub no longer serves could neither finish nor be refunded. The hub refuses to start while one exists ("open"
 * as SwapStore.listOpenSwaps says: any state but final, or failed with the incoming leg not yet cancelled), naming the
 * swaps and the asset to put back, before the scheduler's recovery pass.
 */

const udt = (id: string, codeHashByte: string): FiberAsset => ({
  id,
  symbol: id,
  name: `${id} token`,
  decimals: 8,
  udtTypeScript: { codeHash: `0x${codeHashByte.repeat(32)}`, hashType: "type", args: "0x01" },
  usdRule: "usd_peg",
  cellDeps: [],
});
const RUSD = udt("RUSD", "11");
const CWBTC = udt("CWBTC", "22");

const CKB_ONLY = createAssetRegistry("testnet");
const WITH_RUSD = createAssetRegistry("testnet", [RUSD]);
const WITH_BOTH = createAssetRegistry("testnet", [RUSD, CWBTC]);

const thrownBy = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the check to throw");
};

describe("assertOpenSwapAssetsServed", () => {
  const clock = new FakeClock();
  const swapIn = (asset: string, overrides: Partial<Swap> = {}): Swap => makeSwap(clock, { asset, ...overrides });

  it("lets the hub start with no open swaps, whatever the hub serves", () => {
    expect(() => assertOpenSwapAssetsServed([], CKB_ONLY)).not.toThrow();
  });

  it("lets the hub start when every open swap is in an asset it serves", () => {
    expect(() => assertOpenSwapAssetsServed([swapIn("CKB"), swapIn("RUSD"), swapIn("CWBTC")], WITH_BOTH)).not.toThrow();
  });

  it("refuses an open swap in an asset the hub no longer serves, naming the swap, the asset and where to put it back", () => {
    const stranded = swapIn("RUSD");
    const error = thrownBy(() => assertOpenSwapAssetsServed([swapIn("CKB"), stranded], CKB_ONLY));
    expect(error.message).toMatch(/^Invalid hub configuration: 1 open swap\(s\) use RUSD, which the hub no longer serves/);
    expect(error.message).toContain(`swaps ${stranded.id}`);
    expect(error.message).toContain("Put RUSD back in FIBER_ASSETS");
  });

  it("names every stranded swap and each removed asset once, and none of the swaps it can still serve", () => {
    const served = swapIn("CKB");
    const stranded = [swapIn("RUSD"), swapIn("CWBTC"), swapIn("RUSD")];
    const error = thrownBy(() => assertOpenSwapAssetsServed([served, ...stranded], CKB_ONLY));
    expect(error.message).toContain("3 open swap(s) use RUSD, CWBTC,");
    for (const swap of stranded) expect(error.message).toContain(swap.id);
    expect(error.message).not.toContain(served.id);
    expect(error.message.match(/RUSD/g)?.length).toBe(2); // "use RUSD, CWBTC" and "Put RUSD, CWBTC back"
  });

  it("refuses only the removed asset when another UDT stays", () => {
    const error = thrownBy(() => assertOpenSwapAssetsServed([swapIn("RUSD"), swapIn("CWBTC")], WITH_RUSD));
    expect(error.message).toContain("1 open swap(s) use CWBTC,");
    expect(error.message).not.toContain("use RUSD");
  });

  it("counts a UDT as removed on mainnet, where the hub serves CKB only", () => {
    const mainnet = createAssetRegistry("mainnet", [RUSD]);
    expect(() => assertOpenSwapAssetsServed([swapIn("RUSD")], mainnet)).toThrow(/use RUSD/);
  });
});

/* --------------------------------------------------------------------------------------------- SwapsModule */

@Module({})
class TestInfrastructureModule {}

/** The swap harness's ports, with ASSETS replaced: what the hub serves after an asset was removed from its config. */
function infrastructure(h: SwapHarness, assets: AssetRegistry): DynamicModule {
  const providers: Provider[] = [
    { provide: HUB_CONFIG, useValue: h.config },
    { provide: TIMING_PROFILE, useValue: h.config.timing },
    { provide: ASSETS, useValue: assets },
    { provide: CLOCK, useValue: h.clock },
    { provide: LIGHTNING, useValue: h.hubLn },
    { provide: FIBER, useValue: h.hubFiber },
    { provide: SWAP_STORE, useValue: h.store },
    { provide: PRICE_SOURCES, useValue: ["fake-a", "fake-b", "fake-c"].map((name) => new FakePriceSource(name, h.clock)) },
  ];
  return { module: TestInfrastructureModule, global: true, providers, exports: providers.map((p) => (p as { provide: symbol }).provide) };
}

describe("SwapsModule refuses to start with an open swap in an asset the hub no longer serves", () => {
  let h: SwapHarness;
  let moduleRef: TestingModule | null;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness({ swaps: { pollIntervalMs: 60_000 } });
    moduleRef = null;
  });

  afterEach(async () => {
    await moduleRef?.close();
    jest.restoreAllMocks();
  });

  const compile = async (assets: AssetRegistry): Promise<TestingModule> =>
    Test.createTestingModule({ imports: [infrastructure(h, assets), SwapsModule] }).compile();
  const saved = (overrides: Partial<Swap>): Swap => {
    const swap = makeSwap(h.clock, overrides);
    h.store.createSwap(swap);
    return swap;
  };

  it.each([SWAP_STATE.PENDING, SWAP_STATE.INCOMING_ACCEPTED, SWAP_STATE.OUTGOING_IN_FLIGHT, SWAP_STATE.OUTGOING_SUCCEEDED])(
    "an open swap (%s): compile fails with the swap and the asset named, and no node is asked anything",
    async (state) => {
      const swap = saved({ asset: "RUSD", state });
      await expect(compile(CKB_ONLY)).rejects.toThrow(new RegExp(`1 open swap\\(s\\) use RUSD.*${swap.id}`, "s"));
      expect(h.hubLn.calls).toEqual([]);
      expect(h.hubFiber.calls).toEqual([]);
    },
  );

  it("a failed swap whose incoming leg is not cancelled yet (refunded false) still counts as open", async () => {
    const swap = saved({ asset: "RUSD", state: SWAP_STATE.FAILED, failureReason: "payout failed", refunded: false });
    await expect(compile(CKB_ONLY)).rejects.toThrow(swap.id);
  });

  it("starts when the swaps in the removed asset have ended (succeeded, or failed and refunded)", async () => {
    saved({ asset: "RUSD", state: SWAP_STATE.SUCCEEDED, preimage: "ab".repeat(32) });
    saved({ asset: "RUSD", state: SWAP_STATE.FAILED, failureReason: "quote expired", refunded: true });
    moduleRef = await compile(CKB_ONLY);
    await moduleRef.init();
    expect(moduleRef.get(SWAP_ENGINE)).toBeDefined();
  });

  it("starts with no swaps at all", async () => {
    moduleRef = await compile(CKB_ONLY);
    await moduleRef.init();
    expect(moduleRef.get(SWAP_ENGINE)).toBeDefined();
  });

  it("starts when the asset of the open swap is still served", async () => {
    saved({ asset: "RUSD", state: SWAP_STATE.PENDING });
    moduleRef = await compile(WITH_RUSD);
    expect(moduleRef.get(SWAP_ENGINE)).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- the hub on its SQLite database */

describe("the hub (AppModule) refuses to start on a database with an open swap in a removed asset", () => {
  let dir: string;
  let clock: FakeClock;
  let path: string;

  beforeEach(() => {
    dir = makeTempDir();
    clock = new FakeClock();
    path = join(dir, "hub.sqlite");
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    removeTempDir(dir);
    jest.restoreAllMocks();
  });

  /** Writes `swaps` to the hub's database, as an earlier run of the hub left them. */
  const seed = (...swaps: Partial<Swap>[]): Swap[] => {
    const store: SwapStore = openSqliteSwapStore(path, clock);
    try {
      return swaps.map((overrides) => {
        const swap = makeSwap(clock, overrides);
        store.createSwap(swap);
        return swap;
      });
    } finally {
      store.close();
    }
  };

  /** Starts the real AppModule on that database, RUSD served or not; returns the node fakes to inspect. */
  async function start(rusdServed: boolean) {
    const ln = new FakeLightningNetwork("regtest", clock);
    const fiber = new FakeFiberNetwork("devnet", clock);
    const hubLn = ln.node("hub");
    const hubFiber = fiber.node("hub");
    const env: Record<string, string> = { HUB_DB_PATH: path };
    if (rusdServed) env.UDT_RUSD_SCRIPT = JSON.stringify(DEVNET_RUSD_SCRIPT);
    const boot = async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(HUB_CONFIG)
        .useValue(loadHubConfig(env))
        .overrideProvider(CLOCK)
        .useValue(clock)
        .overrideProvider(LIGHTNING)
        .useValue(hubLn)
        .overrideProvider(DEMO_LIGHTNING)
        .useValue(null)
        .overrideProvider(FIBER)
        .useValue(hubFiber)
        .overrideProvider(DEMO_FIBER)
        .useValue(null)
        .overrideProvider(PRICE_SOURCES)
        .useValue([new FakePriceSource("coingecko", clock), new FakePriceSource("binance", clock)])
        .compile();
      const app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      return app;
    };
    return { boot, hubLn, hubFiber };
  }

  it("names the open RUSD swap when RUSD was removed from the config, before the recovery pass asks any node", async () => {
    const [swap] = seed({ asset: "RUSD", state: SWAP_STATE.PENDING }, { asset: "CKB", state: SWAP_STATE.PENDING });
    const hub = await start(false);
    await expect(hub.boot()).rejects.toThrow(new RegExp(`1 open swap\\(s\\) use RUSD.*${swap?.id}`, "s"));
    expect(hub.hubLn.calls).toEqual([]);
    expect(hub.hubFiber.calls).toEqual([]);
  });

  it("counts a failed, unrefunded swap the database holds as open too", async () => {
    const [swap] = seed({ asset: "RUSD", state: SWAP_STATE.FAILED, failureReason: "payout failed", refunded: false });
    await expect((await start(false)).boot()).rejects.toThrow(swap?.id);
  });

  it("starts once RUSD is back in the config", async () => {
    seed({ asset: "RUSD", state: SWAP_STATE.FAILED, failureReason: "payout failed", refunded: false });
    const app = await (await start(true)).boot();
    await app.close();
  });

  it("starts without RUSD when its swaps on record have all ended", async () => {
    seed({ asset: "RUSD", state: SWAP_STATE.SUCCEEDED, preimage: "ab".repeat(32) }, { asset: "RUSD", state: SWAP_STATE.FAILED, failureReason: "x", refunded: true });
    const app = await (await start(false)).boot();
    await app.close();
  });

  it("the fake store the engine tests use agrees on which swaps are open", () => {
    const fake = new FakeSwapStore(clock);
    const swaps = [
      makeSwap(clock, { asset: "RUSD", state: SWAP_STATE.FAILED, refunded: false }),
      makeSwap(clock, { asset: "RUSD", state: SWAP_STATE.FAILED, refunded: true }),
      makeSwap(clock, { asset: "RUSD", state: SWAP_STATE.SUCCEEDED }),
      makeSwap(clock, { asset: "RUSD", state: SWAP_STATE.OUTGOING_IN_FLIGHT }),
    ];
    swaps.forEach((swap) => fake.createSwap(swap));
    const sqlite = openSqliteSwapStore(path, clock);
    try {
      swaps.forEach((swap) => sqlite.createSwap(swap));
      const ids = (store: SwapStore) => store.listOpenSwaps().map((swap) => swap.id).sort();
      expect(ids(sqlite)).toEqual(ids(fake));
      expect(ids(fake)).toEqual([swaps[0]?.id, swaps[3]?.id].sort());
    } finally {
      sqlite.close();
    }
  });
});
