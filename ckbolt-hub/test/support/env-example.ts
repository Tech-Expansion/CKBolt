import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** The hub's .env.example as KEY -> value, commented-out examples ("# KEY=value") included. */
export function readEnvExample(): Record<string, string> {
  const text = readFileSync(join(__dirname, "..", "..", ".env.example"), "utf8");
  const uncommented = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#\s*(?=[A-Z][A-Z0-9_]*=)/, ""))
    .join("\n");
  return parseEnv(uncommented) as Record<string, string>;
}
