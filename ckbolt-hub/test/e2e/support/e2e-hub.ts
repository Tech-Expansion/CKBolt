import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { systemClock } from "../../../src/application/ports/clock.port";
import { ASSETS, LIGHTNING, PRICE_SOURCES } from "../../../src/application/ports/tokens";
import { loadEnvFile } from "../../../src/config/env-file";
import { loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import type { AssetRegistry } from "../../../src/domain/assets";
import { FakePriceSource } from "../../fakes";
import { startHubApp, type HttpClient, type HubHttp, type ProviderOverride } from "../../support/hub-http";
import {
  DEVNET_PATHS,
  E2E_HUB_ENV,
  E2E_PRICE_SOURCE_NAME,
  ENV_PATH_SUFFIX,
  HUB_ROOT,
  TEMP_DATABASE_DIR_PREFIX,
  TEMP_DATABASE_FILE,
} from "./e2e.constants";
import { loadE2eSettings } from "./e2e.settings";

/**
 * A hub under test: the real AppModule in-process with the real LND and fnn adapters on the devnet, configured from
 * devnet/hub.env (never from the hub's .env), with fixed prices instead of the exchanges (no internet), on a SQLite
 * file of the test's own. Driven over HTTP with supertest.
 */
export interface E2eHub extends HubHttp {
  app: INestApplication;
  config: HubConfig;
  assets: AssetRegistry;
  close(): Promise<void>;
}

export interface E2eHubOptions {
  /** The SQLite file; two hubs started one after the other on the same file act as one hub restarting. */
  databasePath: string;
  /** Hub variables on top of devnet/hub.env and E2E_HUB_ENV, e.g. QUOTE_TTL_SECONDS or SWAP_POLL_INTERVAL_MS. */
  env?: Record<string, string>;
  /**
   * false: the hub gets no push hints from its nodes (Fiber pubsub off, the LND adapter's onUpdate hidden), so only the
   * scheduler's start-up pass and its timer move swaps. Default true, as configured.
   */
  pushHints?: boolean;
  /** Providers to replace, e.g. the hub's CLOCK with one a test can move forward. */
  providers?: ProviderOverride[];
}

/** devnet/hub.env as written by `npm --prefix devnet run up`, with its relative file paths made absolute. */
function readDevnetHubEnv(): Record<string, string> {
  const env: NodeJS.ProcessEnv = {};
  loadEnvFile(DEVNET_PATHS.hubEnvFile, env);
  if (Object.keys(env).length === 0) throw new Error(`${DEVNET_PATHS.hubEnvFile} is missing or empty: run npm --prefix devnet run bootstrap`);
  return Object.fromEntries(
    Object.entries(env).map(([key, value = ""]) => [key, key.endsWith(ENV_PATH_SUFFIX) && !isAbsolute(value) ? resolve(HUB_ROOT, value) : value]),
  );
}

/** The hub's config for the devnet: hub.env, the e2e defaults, the test's database and its own variables. */
function e2eHubConfig(options: E2eHubOptions): HubConfig {
  const pushOff = options.pushHints === false ? { FIBER_PUBSUB: "false" } : {};
  return loadHubConfig({ ...readDevnetHubEnv(), ...E2E_HUB_ENV, HUB_DB_PATH: options.databasePath, ...pushOff, ...options.env });
}

/** Shadows a node adapter's onUpdate (a prototype method) with an own undefined property: an adapter without push hints. */
const hidePushHints = (node: object): void => void Object.defineProperty(node, "onUpdate", { value: undefined });

export async function startE2eHub(options: E2eHubOptions): Promise<E2eHub> {
  const config = e2eHubConfig(options);
  const prices = [new FakePriceSource(E2E_PRICE_SOURCE_NAME, systemClock)];
  const app = await startHubApp(config, [[PRICE_SOURCES, prices], ...(options.providers ?? [])], {
    logger: loadE2eSettings().hubLogLevels,
    // Before onModuleInit: the swap scheduler subscribes to the nodes' push hints there.
    beforeInit: (moduleRef) => {
      if (options.pushHints === false) hidePushHints(moduleRef.get(LIGHTNING));
    },
  });
  const http = (): HttpClient => request(app.getHttpServer());
  let closed: Promise<void> | null = null;
  // Idempotent: a test may stop a hub itself (a restart) before the lifecycle hook closes every hub it started.
  const close = (): Promise<void> => (closed ??= app.close());
  return { app, config, assets: app.get<AssetRegistry>(ASSETS), http, close };
}

/** A fresh SQLite file for one test file, in a directory of its own that `remove` deletes. */
export interface TempDatabase {
  path: string;
  remove(): void;
}

export function createTempDatabase(): TempDatabase {
  const dir = mkdtempSync(join(tmpdir(), TEMP_DATABASE_DIR_PREFIX));
  return { path: join(dir, TEMP_DATABASE_FILE), remove: () => rmSync(dir, { recursive: true, force: true }) };
}
