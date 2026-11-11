import "reflect-metadata";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Inject, Injectable, Module, type OnModuleDestroy, type Type } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import type { SwapStore } from "../../../src/application/ports/swap-store.port";
import { CLOCK, HUB_CONFIG, SWAP_STORE } from "../../../src/application/ports/tokens";
import { SQLITE_IN_MEMORY_PATH } from "../../../src/common/constants/persistence.constants";
import { HubConfigModule } from "../../../src/config/config.module";
import { loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import { PersistenceModule } from "../../../src/infrastructure/persistence/persistence.module";
import { SqliteSwapStore } from "../../../src/infrastructure/persistence/sqlite-swap-store";
import { FakeClock } from "../../fakes";
import { makeSwap, makeTempDir, removeTempDir } from "./persistence.fixtures";

/** A HubConfig with only the database path changed; every other value is the validated default. */
const configWithDatabase = (path: string): HubConfig => {
  const defaults = loadHubConfig({});
  return { ...defaults, database: { path } };
};

/** A feature module that injects SWAP_STORE without importing PersistenceModule, as application modules do. */
@Injectable()
class SwapReader implements OnModuleDestroy {
  readonly seenOnDestroy: (string | null)[] = [];
  watchedId = "";

  constructor(@Inject(SWAP_STORE) readonly store: SwapStore) {}

  onModuleDestroy(): void {
    this.seenOnDestroy.push(this.store.getSwap(this.watchedId)?.id ?? null);
  }
}

@Module({ providers: [SwapReader], exports: [SwapReader] })
class FeatureModule {}

describe("PersistenceModule", () => {
  let dir: string;
  let clock: FakeClock;
  let moduleRef: TestingModule | undefined;

  const compile = async (path: string, extraImports: Type<unknown>[] = []): Promise<TestingModule> => {
    moduleRef = await Test.createTestingModule({
      imports: [HubConfigModule, PersistenceModule, ...extraImports],
    })
      .overrideProvider(HUB_CONFIG)
      .useValue(configWithDatabase(path))
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    await moduleRef.init();
    return moduleRef;
  };

  beforeEach(() => {
    dir = makeTempDir();
    clock = new FakeClock();
    moduleRef = undefined;
  });

  afterEach(async () => {
    await moduleRef?.close();
    removeTempDir(dir);
  });

  it("provides SWAP_STORE as the SQLite store, in memory when the path is :memory:", async () => {
    const app = await compile(SQLITE_IN_MEMORY_PATH);
    const store = app.get<SwapStore>(SWAP_STORE);
    expect(store).toBeInstanceOf(SqliteSwapStore);
    const swap = makeSwap(clock);
    store.createSwap(swap);
    expect(store.getSwap(swap.id)).toEqual(swap);
  });

  it("opens config.database.path, creating its parent directory", async () => {
    const path = join(dir, "data", "hub.sqlite");
    const app = await compile(path);
    app.get<SwapStore>(SWAP_STORE).createSwap(makeSwap(clock));
    expect(existsSync(path)).toBe(true);
  });

  it("uses the injected CLOCK for updatedAt", async () => {
    const store = (await compile(SQLITE_IN_MEMORY_PATH)).get<SwapStore>(SWAP_STORE);
    const swap = makeSwap(clock);
    store.createSwap(swap);
    clock.advance(42_000);
    expect(store.transition(swap.id, "pending", { state: "incoming_accepted" })?.updatedAt).toBe(swap.createdAt + 42_000);
  });

  it("is global: a feature module gets the same store without importing it", async () => {
    const app = await compile(SQLITE_IN_MEMORY_PATH, [FeatureModule]);
    expect(app.get(SwapReader).store).toBe(app.get(SWAP_STORE));
  });

  it("closes the store when the module is destroyed", async () => {
    const app = await compile(SQLITE_IN_MEMORY_PATH);
    const store = app.get<SwapStore>(SWAP_STORE);
    await app.close();
    moduleRef = undefined;
    expect(() => store.getSwap("any")).toThrow();
  });

  it("keeps the store open while feature modules run their own onModuleDestroy", async () => {
    const app = await compile(SQLITE_IN_MEMORY_PATH, [FeatureModule]);
    const reader = app.get(SwapReader);
    const swap = makeSwap(clock);
    reader.store.createSwap(swap);
    reader.watchedId = swap.id;
    await app.close();
    moduleRef = undefined;
    expect(reader.seenOnDestroy).toEqual([swap.id]);
  });

  it("keeps data across an application restart on the same file", async () => {
    const path = join(dir, "hub.sqlite");
    const swap = makeSwap(clock);
    (await compile(path)).get<SwapStore>(SWAP_STORE).createSwap(swap);
    await moduleRef!.close();

    const restarted = await compile(path);
    expect(restarted.get<SwapStore>(SWAP_STORE).getSwap(swap.id)).toEqual(swap);
  });
});
