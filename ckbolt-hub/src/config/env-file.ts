import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { HUB_ENV_FILE } from "../common/constants/config.constants";

/**
 * Loads an env file (KEY=value lines, see .env.example) into `env` before the config is read. Variables already set in
 * the environment win over the file; without the file only the environment counts.
 */
export function loadEnvFile(path: string = HUB_ENV_FILE, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    env[key] ??= value;
  }
}
