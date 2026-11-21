import "reflect-metadata";
import { join } from "node:path";
import { Test, type TestingModule } from "@nestjs/testing";
import type Database from "better-sqlite3";
import type { QuoteRetention } from "../../../src/application/ports/quote-retention.port";
import type { SwapStore } from "../../../src/application/ports/swap-store.port";
import { CLOCK, HUB_CONFIG, QUOTE_RETENTION, SWAP_STORE } from "../../../src/application/ports/tokens";
import { SQLITE_IN_MEMORY_PATH } from "../../../src/common/constants/persistence.constants";
import { MS_PER_DAY } from "../../../src/common/constants/protocol.constants";
import { SWAP_STATE } from "../../../src/common/constants/swap.constants";
import { HubConfigModule } from "../../../src/config/config.module";
import { loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import type { Quote } from "../../../src/domain/types";
import { PersistenceModule } from "../../../src/infrastructure/persistence/persistence.module";
import { SqliteQuoteRetention } from "../../../src/infrastructure/persistence/sqlite-quote-retention";
import { SqliteSwapStore } from "../../../src/infrastructure/persistence/sqlite-swap-store";
import { openHubDatabase } from "../../../src/infrastructure/persistence/sqlite.database";
import { FakeClock } from "../../fakes";
import { makeQuote, makeSwap, makeTempDir, removeTempDir } from "./persistence.fixtures";

/**
 * Security review H9: quotes are deleted once they expired before a cutoff and no swap references them, in one
 * statement on the hub's database. A quote a swap uses is kept however old it is (the swap still names it).
 */

describe("SqliteQuoteRetention (QuoteRetention on the hub's SQLite database)", () => {
  let clock: FakeClock;
  let db: Database.Database;
  let store: SqliteSwapStore;
  let retention: SqliteQuoteRetention;
  /** The cutoff the tests delete before: a week before "now". */
  let cutoff: number;

  beforeEach(() => {
    clock = new FakeClock();
    db = openHubDatabase(SQLITE_IN_MEMORY_PATH, clock);
    store = new SqliteSwapStore(db, clock);
    retention = new SqliteQuoteRetention(db);
    cutoff = clock.now() - 7 * MS_PER_DAY;
  });

  afterEach(() => store.close());

  /** A quote saved through the swap store, expiring at `expiresAt`. */
  const savedQuote = (expiresAt: number, overrides: Partial<Quote> = {}): Quote => {
    const quote = makeQuote(clock, { createdAt: expiresAt - 180_000, priceAt: expiresAt - 181_000, expiresAt, ...overrides });
    store.saveQuote(quote);
    return quote;
  };
  /** A swap that names `quote` (its id), in `state`. */
  const swapFor = (quote: Quote, overrides: Parameters<typeof makeSwap>[1] = {}) => {
    const swap = makeSwap(clock, { quoteId: quote.id, quoteExpiresAt: quote.expiresAt, ...overrides });
    store.createSwap(swap);
    return swap;
  };
  const kept = (quote: Quote): boolean => store.getQuote(quote.id) !== null;

  it("deletes a quote that expired before the cutoff and that no swap uses, and says how many it deleted", () => {
    const old = savedQuote(cutoff - 1);
    const older = savedQuote(cutoff - 30 * MS_PER_DAY);
    expect(retention.deleteUnusedQuotesExpiredBefore(cutoff)).toBe(2);
    expect(kept(old)).toBe(false);
    expect(kept(older)).toBe(false);
  });

  it("keeps a quote that expired at the cutoff or after it, and one not expired yet", () => {
    const atCutoff = savedQuote(cutoff);
    const recent = savedQuote(cutoff + 1);
    const live = savedQuote(clock.now() + 180_000);
    expect(retention.deleteUnusedQuotesExpiredBefore(cutoff)).toBe(0);
    expect([atCutoff, recent, live].map(kept)).toEqual([true, true, true]);
  });

  it.each([SWAP_STATE.PENDING, SWAP_STATE.SUCCEEDED, SWAP_STATE.FAILED])("keeps a quote a %s swap uses, however old", (state) => {
    const used = savedQuote(cutoff - 365 * MS_PER_DAY);
    const swap = swapFor(used, { state, refunded: state === SWAP_STATE.FAILED });
    expect(retention.deleteUnusedQuotesExpiredBefore(cutoff)).toBe(0);
    expect(kept(used)).toBe(true);
    expect(store.getSwap(swap.id)?.quoteId).toBe(used.id);
  });

  it("deletes only the unused old quotes of a mix, and leaves the swaps alone", () => {
    const usedOld = savedQuote(cutoff - 10 * MS_PER_DAY);
    const unusedOld = savedQuote(cutoff - 10 * MS_PER_DAY);
    const usedRecent = savedQuote(cutoff + MS_PER_DAY);
    const unusedRecent = savedQuote(cutoff + MS_PER_DAY);
    const swaps = [swapFor(usedOld), swapFor(usedRecent, { state: SWAP_STATE.SUCCEEDED })];

    expect(retention.deleteUnusedQuotesExpiredBefore(cutoff)).toBe(1);
    expect({ usedOld: kept(usedOld), unusedOld: kept(unusedOld), usedRecent: kept(usedRecent), unusedRecent: kept(unusedRecent) }).toEqual({
      usedOld: true,
      unusedOld: false,
      usedRecent: true,
      unusedRecent: true,
    });
    for (const swap of swaps) expect(store.getSwap(swap.id)).toEqual(swap);
  });

  it("deletes nothing from an empty table, and nothing more on a second run", () => {
    expect(retention.deleteUnusedQuotesExpiredBefore(cutoff)).toBe(0);
    savedQuote(cutoff - 1);
    expect(retention.deleteUnusedQuotesExpiredBefore(cutoff)).toBe(1);
    expect(retention.deleteUnusedQuotesExpiredBefore(cutoff)).toBe(0);
  });

  it("does not close the database it was given: the swap store still works after it", () => {
    savedQuote(cutoff - 1);
    retention.deleteUnusedQuotesExpiredBefore(cutoff);
    const swap = makeSwap(clock);
    store.createSwap(swap);
    expect(store.getSwap(swap.id)).toEqual(swap);
  });
});

describe("PersistenceModule provides QUOTE_RETENTION", () => {
  let dir: string;
  let clock: FakeClock;
  let moduleRef: TestingModule | undefined;

  const configWithDatabase = (path: string): HubConfig => ({ ...loadHubConfig({}), database: { path } });

  const compile = async (path: string): Promise<TestingModule> => {
    moduleRef = await Test.createTestingModule({ imports: [HubConfigModule, PersistenceModule] })
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

  it("as the SQLite retention, on the same database as SWAP_STORE", async () => {
    const app = await compile(join(dir, "hub.sqlite"));
    const retention = app.get<QuoteRetention>(QUOTE_RETENTION);
    const store = app.get<SwapStore>(SWAP_STORE);
    expect(retention).toBeInstanceOf(SqliteQuoteRetention);

    const old = makeQuote(clock, { expiresAt: clock.now() - 8 * MS_PER_DAY });
    const used = makeQuote(clock, { expiresAt: clock.now() - 8 * MS_PER_DAY });
    store.saveQuote(old);
    store.saveQuote(used);
    store.createSwap(makeSwap(clock, { quoteId: used.id }));

    expect(retention.deleteUnusedQuotesExpiredBefore(clock.now() - 7 * MS_PER_DAY)).toBe(1);
    expect(store.getQuote(old.id)).toBeNull();
    expect(store.getQuote(used.id)).not.toBeNull();
  });

  it("to modules that do not import PersistenceModule (it is global)", async () => {
    const app = await compile(SQLITE_IN_MEMORY_PATH);
    expect(app.get<QuoteRetention>(QUOTE_RETENTION, { strict: false })).toBeInstanceOf(SqliteQuoteRetention);
  });
});
