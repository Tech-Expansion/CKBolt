import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PACKAGE_MANIFEST_FILE, UNKNOWN_VERSION } from "../constants/health.constants";

/** The nearest package.json at or above `startDir`, or null when there is none up to the filesystem root. */
function findManifest(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, PACKAGE_MANIFEST_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The `version` of the nearest package.json at or above `startDir`. Works from src/ (ts-node, Jest) and from dist/
 * (the build's rootDir is src/, so the manifest cannot be imported). Returns UNKNOWN_VERSION when none is found.
 */
export function readPackageVersion(startDir: string): string {
  const manifest = findManifest(startDir);
  if (!manifest) return UNKNOWN_VERSION;
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
  return typeof version === "string" ? version : UNKNOWN_VERSION;
}
