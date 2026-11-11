import type { LogLevel } from "@nestjs/common";
import { readCount, type Env } from "../../../devnet/scripts/lib/env";
import { MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";

/**
 * Tunables of the end-to-end tests, each with an E2E_* variable to override it in the environment of
 * `npm run test:e2e` (the devnet's own tunables are DEVNET_* in devnet/scripts/lib/settings.ts).
 */
export interface E2eSettings {
  /** Skip `npm --prefix devnet run up` before the run, e.g. right after starting the devnet by hand (E2E_SKIP_DEVNET_UP). */
  skipDevnetUp: boolean;
  /** Longest a test waits for a swap or a node to reach the state it expects, ms (E2E_WAIT_TIMEOUT_MS). */
  waitTimeoutMs: number;
  /** How often a test reads the swap or the node it waits for, ms (E2E_POLL_INTERVAL_MS). */
  pollIntervalMs: number;
  /** Nest log levels the hub under test prints, comma separated; empty silences it (E2E_HUB_LOG_LEVELS). */
  hubLogLevels: LogLevel[];
}

const TRUE_VALUES = ["true", "1", "yes"];
const LOG_LEVELS: readonly LogLevel[] = ["verbose", "debug", "log", "warn", "error", "fatal"];
const DEFAULT_HUB_LOG_LEVELS = "error";

function readFlag(env: Env, name: string): boolean {
  return TRUE_VALUES.includes(env[name]?.trim().toLowerCase() ?? "");
}

function readLogLevels(env: Env, name: string, fallback: string): LogLevel[] {
  const names = (env[name] ?? fallback).split(",").map((level) => level.trim()).filter(Boolean);
  const unknown = names.filter((level) => !LOG_LEVELS.includes(level as LogLevel));
  if (unknown.length > 0) throw new Error(`${name} has unknown log levels: ${unknown.join(", ")} (known: ${LOG_LEVELS.join(", ")})`);
  return names as LogLevel[];
}

export function loadE2eSettings(env: Env = process.env): E2eSettings {
  return {
    skipDevnetUp: readFlag(env, "E2E_SKIP_DEVNET_UP"),
    waitTimeoutMs: readCount(env, "E2E_WAIT_TIMEOUT_MS", 120 * MS_PER_SECOND),
    pollIntervalMs: readCount(env, "E2E_POLL_INTERVAL_MS", 250),
    hubLogLevels: readLogLevels(env, "E2E_HUB_LOG_LEVELS", DEFAULT_HUB_LOG_LEVELS),
  };
}
