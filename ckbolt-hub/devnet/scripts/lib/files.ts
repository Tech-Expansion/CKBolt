import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const UTF8 = "utf8";

/** Reads a text file; undefined when it cannot be read (missing, for one). */
export function readTextFile(path: string): Promise<string | undefined> {
  return readFile(path, UTF8).catch(() => undefined);
}

/** Writes a text file, creating its folder; returns false when the file already had this content. */
export async function writeTextFile(path: string, content: string): Promise<boolean> {
  if ((await readTextFile(path)) === content) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, UTF8);
  return true;
}
