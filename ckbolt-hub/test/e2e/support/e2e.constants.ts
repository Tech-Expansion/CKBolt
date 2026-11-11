import { resolve } from "node:path";
import { resolveDevnetPaths } from "../../../devnet/scripts/lib/paths";

/** Facts of the e2e harness. Tunables (timeouts, intervals, log levels) are in e2e.settings.ts. */

/** devnet/ and the files the devnet writes there (hub.env). */
export const DEVNET_PATHS = resolveDevnetPaths();

/** The hub repository root: the parent of devnet/. Paths in devnet/hub.env are relative to it. */
export const HUB_ROOT = resolve(DEVNET_PATHS.devnetDir, "..");

/** Starts the devnet with its saved state and makes it usable (devnet/README.md). Run from HUB_ROOT. */
export const DEVNET_UP_COMMAND = ["npm", "--prefix", "devnet", "run", "up"] as const;

/** hub.env variables that name files end with this; relative ones are resolved against HUB_ROOT. */
export const ENV_PATH_SUFFIX = "_PATH";

/**
 * Per-client limits high enough never to trigger: every test talks to the hub from one loopback client, polls its swaps
 * and leaves some unpaid until their quotes expire, which the limits would throttle without protecting anything.
 */
const UNLIMITED = String(Number.MAX_SAFE_INTEGER);

/** Set on top of devnet/hub.env for every hub under test; a test adds its own (database, timings). */
export const E2E_HUB_ENV: Readonly<Record<string, string>> = {
  HUB_RATE_LIMIT_PER_MINUTE: UNLIMITED,
  DEMO_MAX_ACTIONS_PER_HOUR: UNLIMITED,
  DEMO_MAX_ACTIONS_PER_HOUR_TOTAL: UNLIMITED,
  SWAP_MAX_UNPAID_PER_CLIENT: UNLIMITED,
  SWAP_MAX_UNPAID: UNLIMITED,
};

/** The name the fake price source reports in quotes (prices.source). */
export const E2E_PRICE_SOURCE_NAME = "e2e-fixed-prices";

/** Each test file gets a fresh SQLite database in a new directory with this prefix under the OS temp directory. */
export const TEMP_DATABASE_DIR_PREFIX = "ckbolt-hub-e2e-";
export const TEMP_DATABASE_FILE = "hub.sqlite";

/** Description on the invoices a test makes as the user, so they are easy to tell apart in node logs. */
export const E2E_INVOICE_DESCRIPTION = "ckbolt e2e";
