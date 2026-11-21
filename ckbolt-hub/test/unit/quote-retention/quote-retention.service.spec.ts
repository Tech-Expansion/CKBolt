import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { Logger, Module, type DynamicModule } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import type { QuoteRetention } from "../../../src/application/ports/quote-retention.port";
import { CLOCK, DEMO_FIBER, DEMO_LIGHTNING, FIBER, HUB_CONFIG, LIGHTNING, PRICE_SOURCES, QUOTE_RETENTION } from "../../../src/application/ports/tokens";
import { QuoteRetentionModule } from "../../../src/application/quote-retention/quote-retention.module";
import { QuoteRetentionService } from "../../../src/application/quote-retention/quote-retention.service";
import { AppModule } from "../../../src/app.module";
import { MS_PER_DAY, MS_PER_MINUTE } from "../../../src/common/constants/protocol.constants";
import { HubError } from "../../../src/common/errors/hub.error";
import { loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import { openSqliteSwapStore } from "../../../src/infrastructure/persistence/sqlite-swap-store";
import { FakeClock, FakeFiberNetwork, FakeLightningNetwork, FakePriceSource } from "../../fakes";
import { readEnvExample } from "../../support/env-example";
import { makeQuote, makeSwap, makeTempDir, removeTempDir } from "../persistence/persistence.fixtures";

/**
 * Security review H9: QuoteRetentionService deletes the quotes no swap uses QUOTE_RETENTION_DAYS after they expired,
 * once at start-up and then every QUOTE_PRUNE_INTERVAL_MINUTES. A failed round is logged and never thrown into the hub.
 */

const RETENTION_MS = 7 * MS_PER_DAY;
const INTERVAL_MS = 60 * MS_PER_MINUTE;

/** A QuoteRetention that records each cutoff it is asked for and answers what the test scripts. */
class RecordingQuoteRetention implements QuoteRetention {
  readonly cutoffs: number[] = [];
  /** The next answers, in order; a thrown value fails that round. Then `fallback`. */
  readonly answers: (number | { throws: unknown })[] = [];
  fallback = 0;

  deleteUnusedQuotesExpiredBefore(expiredBefore: number): number {
    this.cutoffs.push(expiredBefore);
    const answer = this.answers.shift() ?? this.fallback;
    if (typeof answer === "number") return answer;
    throw answer.throws;
  }
}

const configWith = (overrides: Partial<HubConfig["pricing"]> = {}): HubConfig => {
  const config = loadHubConfig({});
  return { ...config, pricing: { ...config.pricing, quoteRetentionMs: RETENTION_MS, quotePruneIntervalMs: INTERVAL_MS, ...overrides } };
};

describe("QuoteRetentionService", () => {
  let clock: FakeClock;
  let quotes: RecordingQuoteRetention;
  let service: QuoteRetentionService;
  let logs: { log: jest.SpyInstance; warn: jest.SpyInstance; error: jest.SpyInstance };

  beforeEach(() => {
    jest.useFakeTimers();
    clock = new FakeClock();
    quotes = new RecordingQuoteRetention();
    service = new QuoteRetentionService(quotes, clock, configWith());
    logs = {
      log: jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined),
      warn: jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined),
      error: jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined),
    };
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Moves the hub's clock and the timers together. */
  const elapse = (ms: number): void => {
    clock.advance(ms);
    jest.advanceTimersByTime(ms);
  };

  it("prunes once at start-up, before any interval, with the cutoff QUOTE_RETENTION_DAYS before now", () => {
    service.onModuleInit();
    expect(quotes.cutoffs).toEqual([clock.now() - RETENTION_MS]);
  });

  it("prunes again every QUOTE_PRUNE_INTERVAL_MINUTES, each time with a cutoff that follows the clock", () => {
    const start = clock.now();
    service.onModuleInit();
    elapse(INTERVAL_MS - 1);
    expect(quotes.cutoffs).toHaveLength(1);
    elapse(1);
    elapse(INTERVAL_MS);
    expect(quotes.cutoffs).toEqual([start - RETENTION_MS, start + INTERVAL_MS - RETENTION_MS, start + 2 * INTERVAL_MS - RETENTION_MS]);
  });

  it("follows the configured retention and interval", () => {
    service = new QuoteRetentionService(quotes, clock, configWith({ quoteRetentionMs: MS_PER_DAY, quotePruneIntervalMs: 5 * MS_PER_MINUTE }));
    service.onModuleInit();
    elapse(5 * MS_PER_MINUTE);
    expect(quotes.cutoffs).toEqual([clock.now() - 5 * MS_PER_MINUTE - MS_PER_DAY, clock.now() - MS_PER_DAY]);
  });

  it("stops on module destroy, and a second destroy (or one before start) does no harm", () => {
    service.onModuleDestroy();
    service.onModuleInit();
    service.onModuleDestroy();
    service.onModuleDestroy();
    elapse(10 * INTERVAL_MS);
    expect(quotes.cutoffs).toHaveLength(1);
  });

  it("logs how many quotes a round deleted, and stays quiet when it deleted none", () => {
    quotes.answers.push(3, 0);
    service.onModuleInit();
    elapse(INTERVAL_MS);
    expect(logs.log).toHaveBeenCalledTimes(1);
    expect(logs.log.mock.calls[0]?.[0]).toBe("Deleted 3 expired quotes that no swap uses");
  });

  it("returns what a round deleted", () => {
    quotes.answers.push(5);
    expect(service.prune()).toBe(5);
    expect(service.prune()).toBe(0);
  });

  it("logs a failed round as a warning, with the error and its detail, and never throws it into the hub", () => {
    const failure = new HubError("database is locked", 503, "upstream_unavailable", { detail: "SQLITE_BUSY", cause: new Error("busy timeout 5000 ms") });
    quotes.answers.push({ throws: failure });
    expect(() => service.onModuleInit()).not.toThrow();
    expect(logs.warn).toHaveBeenCalledTimes(1);
    const line = String(logs.warn.mock.calls[0]?.[0]);
    expect(line).toMatch(/^Could not delete old quotes: /);
    expect(line).toContain("database is locked");
    expect(line).toContain("SQLITE_BUSY");
    expect(line).toContain("busy timeout 5000 ms");
    expect(logs.error).not.toHaveBeenCalled();
  });

  it("answers 0 for a failed round and tries again on the next one", () => {
    quotes.answers.push({ throws: new Error("disk I/O error") }, { throws: "not even an Error" }, 2);
    expect(service.prune()).toBe(0);
    service.onModuleInit();
    expect(logs.warn).toHaveBeenCalledTimes(2);
    expect(String(logs.warn.mock.calls[1]?.[0])).toContain("not even an Error");
    elapse(INTERVAL_MS);
    expect(quotes.cutoffs).toHaveLength(3);
    expect(logs.log.mock.calls.map((call: unknown[]) => call[0])).toEqual(["Deleted 2 expired quotes that no swap uses"]);
  });

  it("keeps pruning on schedule after rounds fail", () => {
    quotes.answers.push({ throws: new Error("1") }, { throws: new Error("2") });
    service.onModuleInit();
    elapse(INTERVAL_MS);
    elapse(INTERVAL_MS);
    expect(quotes.cutoffs).toHaveLength(3);
  });
});

describe("QuoteRetentionService timer (real timers)", () => {
  it("does not hold the process open (its interval is unref'd)", () => {
    const service = new QuoteRetentionService(new RecordingQuoteRetention(), new FakeClock(), configWith());
    service.onModuleInit();
    try {
      const timer = (service as unknown as { timer: NodeJS.Timeout | null }).timer;
      expect(timer?.hasRef()).toBe(false);
    } finally {
      service.onModuleDestroy();
    }
  });
});

/* ------------------------------------------------------------------------------------------------ Nest wiring */

@Module({})
class TestPortsModule {}

describe("QuoteRetentionModule (Nest)", () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("prunes when the module starts, on the interval while it runs, and stops when it closes", async () => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const quotes = new RecordingQuoteRetention();
    const providers = [
      { provide: QUOTE_RETENTION, useValue: quotes },
      { provide: CLOCK, useValue: new FakeClock() },
      { provide: HUB_CONFIG, useValue: configWith() },
    ];
    const ports: DynamicModule = { module: TestPortsModule, global: true, providers, exports: providers.map((provider) => provider.provide) };
    moduleRef = await Test.createTestingModule({ imports: [ports, QuoteRetentionModule] }).compile();
    expect(quotes.cutoffs).toHaveLength(0);
    await moduleRef.init();
    expect(quotes.cutoffs).toHaveLength(1);
    jest.advanceTimersByTime(INTERVAL_MS);
    expect(quotes.cutoffs).toHaveLength(2);
    await moduleRef.close();
    moduleRef = undefined;
    jest.advanceTimersByTime(5 * INTERVAL_MS);
    expect(quotes.cutoffs).toHaveLength(2);
  });
});

describe("the hub (AppModule) deletes old unused quotes at start-up, on its SQLite database", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    removeTempDir(dir);
    jest.restoreAllMocks();
  });

  it("deletes a quote that expired more than a week ago and that no swap uses; keeps a used one and a recent one", async () => {
    const clock = new FakeClock();
    const path = join(dir, "hub.sqlite");
    const longAgo = clock.now() - RETENTION_MS - MS_PER_DAY;
    const unusedOld = makeQuote(clock, { expiresAt: longAgo });
    const usedOld = makeQuote(clock, { expiresAt: longAgo });
    const unusedRecent = makeQuote(clock, { expiresAt: clock.now() - RETENTION_MS + MS_PER_MINUTE });
    const seed = openSqliteSwapStore(path, clock);
    [unusedOld, usedOld, unusedRecent].forEach((quote) => seed.saveQuote(quote));
    // A finished swap: the hub's recovery pass leaves it alone.
    seed.createSwap(makeSwap(clock, { quoteId: usedOld.id, state: "succeeded", preimage: "ab".repeat(32) }));
    seed.close();

    const ln = new FakeLightningNetwork("regtest", clock);
    const fiber = new FakeFiberNetwork("devnet", clock);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(HUB_CONFIG)
      .useValue(loadHubConfig({ HUB_DB_PATH: path }))
      .overrideProvider(CLOCK)
      .useValue(clock)
      .overrideProvider(LIGHTNING)
      .useValue(ln.node("hub"))
      .overrideProvider(DEMO_LIGHTNING)
      .useValue(null)
      .overrideProvider(FIBER)
      .useValue(fiber.node("hub"))
      .overrideProvider(DEMO_FIBER)
      .useValue(null)
      .overrideProvider(PRICE_SOURCES)
      .useValue([new FakePriceSource("coingecko", clock), new FakePriceSource("binance", clock)])
      .compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await app.close();

    const after = openSqliteSwapStore(path, clock);
    try {
      expect(after.getQuote(unusedOld.id)).toBeNull();
      expect(after.getQuote(usedOld.id)).not.toBeNull();
      expect(after.getQuote(unusedRecent.id)).not.toBeNull();
    } finally {
      after.close();
    }
  });
});

/* ------------------------------------------------------------------------------------------------------ config */

describe("HubConfig: QUOTE_RETENTION_DAYS and QUOTE_PRUNE_INTERVAL_MINUTES", () => {
  const hubEnvExample = parseEnv(readFileSync(join(__dirname, "..", "..", "..", "deploy", "testnet", "hub.env.example"), "utf8"));

  it("default to 7 days and 60 minutes, as .env.example and the kit's hub.env.example document", () => {
    const { pricing } = loadHubConfig({});
    expect(pricing.quoteRetentionMs).toBe(7 * MS_PER_DAY);
    expect(pricing.quotePruneIntervalMs).toBe(60 * MS_PER_MINUTE);
    expect(readEnvExample().QUOTE_RETENTION_DAYS).toBe("7");
    expect(readEnvExample().QUOTE_PRUNE_INTERVAL_MINUTES).toBe("60");
    expect(hubEnvExample.QUOTE_RETENTION_DAYS).toBe("7");
    expect(hubEnvExample.QUOTE_PRUNE_INTERVAL_MINUTES).toBe("60");
  });

  it("are read from their env vars, in days and minutes", () => {
    const { pricing } = loadHubConfig({ QUOTE_RETENTION_DAYS: "30", QUOTE_PRUNE_INTERVAL_MINUTES: "5" });
    expect(pricing.quoteRetentionMs).toBe(30 * MS_PER_DAY);
    expect(pricing.quotePruneIntervalMs).toBe(5 * MS_PER_MINUTE);
  });

  it.each(["QUOTE_RETENTION_DAYS", "QUOTE_PRUNE_INTERVAL_MINUTES"])("%s refuses 0, a negative, a fraction and text, naming the variable", (key) => {
    for (const value of ["0", "-1", "1.5", "abc", ""]) {
      expect(() => loadHubConfig({ [key]: value })).toThrow(key);
    }
  });
});
