import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { LF_ONLY_FILE_PATTERN, SYNC_EXCLUDED_NAMES, SYNC_EXCLUDED_SUFFIXES } from "./constants";
import type { TarEntry } from "./tar";

/** What gets uploaded: the kit (deploy/testnet) and the parts of the hub repository the images build from. */

const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;
const SHELL_SCRIPT_SUFFIX = ".sh";
const CRLF = "\r\n";
const LF = "\n";

/** True when a path (relative, POSIX) must never leave this machine: settings with secrets, wallets, builds. */
export function isExcludedFromSync(relativePath: string): boolean {
  const segments = relativePath.split(posix.sep);
  const name = segments[segments.length - 1] ?? "";
  return segments.some((segment) => SYNC_EXCLUDED_NAMES.includes(segment)) || SYNC_EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Files that run in Linux get LF line endings, whatever the Windows checkout gave them. */
export function normalizeLineEndings(relativePath: string, content: Buffer): Buffer {
  if (!LF_ONLY_FILE_PATTERN.test(relativePath)) return content;
  const text = content.toString("utf8");
  return text.includes(CRLF) ? Buffer.from(text.replaceAll(CRLF, LF), "utf8") : content;
}

export const modeFor = (relativePath: string): number => (relativePath.endsWith(SHELL_SCRIPT_SUFFIX) ? EXECUTABLE_MODE : FILE_MODE);

const toPosix = (path: string): string => path.split(sep).join(posix.sep);

/** Every file under `root/start` (a file or a folder), as archive entries with paths relative to `root`. */
export function collectEntries(root: string, start = ""): TarEntry[] {
  const absolute = join(root, start);
  const stat = statSync(absolute);
  const relativePath = toPosix(relative(root, absolute));
  if (relativePath && isExcludedFromSync(relativePath)) return [];
  if (stat.isDirectory()) {
    return readdirSync(absolute)
      .sort()
      .flatMap((child) => collectEntries(root, join(start, child)));
  }
  return [
    {
      path: relativePath,
      content: normalizeLineEndings(relativePath, readFileSync(absolute)),
      mode: modeFor(relativePath),
      mtimeSeconds: Math.floor(stat.mtimeMs / MS_PER_SECOND),
    },
  ];
}

/** The files at `paths` (files or folders, relative to `root`), as archive entries relative to `root`. */
export const collectPaths = (root: string, paths: readonly string[]): TarEntry[] => paths.flatMap((path) => collectEntries(root, path));
