import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads the kit's files under public/ when the brand pages build (they are static), so the sizes and the token file
 * they show are always those of the files served. Server code only.
 */
const PUBLIC_DIR = join(process.cwd(), "public");

const BYTES_PER_KB = 1024;

/** A served file's size, in whole KB as the kit writes it ("4 KB"); never below 1. */
export function fileSizeLabel(publicPath: string): string {
  const bytes = statSync(join(PUBLIC_DIR, publicPath)).size;
  return `${Math.max(1, Math.round(bytes / BYTES_PER_KB))} KB`;
}

/** A served text file's content. */
export function publicText(publicPath: string): string {
  return readFileSync(join(PUBLIC_DIR, publicPath), "utf8");
}
