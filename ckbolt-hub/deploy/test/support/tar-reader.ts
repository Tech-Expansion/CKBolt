import { gunzipSync } from "node:zlib";

/** A minimal ustar reader for tests: checks each header's checksum and returns the regular files. */

export interface ReadEntry {
  path: string;
  mode: number;
  size: number;
  mtime: number;
  uid: number;
  gid: number;
  content: Buffer;
}

const BLOCK = 512;
const text = (block: Buffer, offset: number, length: number): string => block.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/s, "");
const octal = (block: Buffer, offset: number, length: number): number => parseInt(text(block, offset, length).trim() || "0", 8);

export function readTar(archive: Buffer): ReadEntry[] {
  assertBlocks(archive);
  const entries: ReadEntry[] = [];
  let offset = 0;
  for (;;) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.length < BLOCK) throw new Error("archive ends without the two empty blocks");
    if (header.every((byte) => byte === 0)) {
      const next = archive.subarray(offset + BLOCK, offset + 2 * BLOCK);
      if (next.length !== BLOCK || !next.every((byte) => byte === 0)) throw new Error("only one end-of-archive block");
      return entries;
    }
    const stored = octal(header, 148, 8);
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 0x20 : byte), 0);
    if (stored !== sum) throw new Error(`bad checksum at ${offset}: stored ${stored}, computed ${sum}`);
    if (text(header, 257, 6) !== "ustar") throw new Error("not a ustar header");
    const name = text(header, 0, 100);
    const prefix = text(header, 345, 155);
    const size = octal(header, 124, 12);
    if (text(header, 156, 1) !== "0") throw new Error(`not a regular file: ${name}`);
    const content = Buffer.from(archive.subarray(offset + BLOCK, offset + BLOCK + size));
    entries.push({
      path: prefix ? `${prefix}/${name}` : name,
      mode: octal(header, 100, 8),
      size,
      mtime: octal(header, 136, 12),
      uid: octal(header, 108, 8),
      gid: octal(header, 116, 8),
      content,
    });
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
}

function assertBlocks(archive: Buffer): void {
  if (archive.length % BLOCK !== 0) throw new Error(`archive length ${archive.length} is not a multiple of ${BLOCK}`);
}

export const readTarGz = (archive: Buffer): ReadEntry[] => readTar(gunzipSync(archive));
