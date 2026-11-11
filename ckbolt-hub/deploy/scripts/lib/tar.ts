import { gzipSync } from "node:zlib";

/**
 * A minimal ustar (POSIX.1-1988) writer: regular files only, gzipped. The server's GNU tar unpacks it and makes the
 * parent folders. Built here rather than with a local tar so it behaves the same from PowerShell, Git Bash and Linux
 * (GNU tar on Windows takes "D:" for a remote host; bsdtar spells options differently).
 */

export interface TarEntry {
  /** POSIX path relative to the archive root, without a leading slash. */
  path: string;
  content: Buffer;
  /** Octal permission bits, e.g. 0o644. */
  mode: number;
  /** Seconds since the epoch. */
  mtimeSeconds: number;
}

export const TAR_BLOCK_BYTES = 512;
const END_OF_ARCHIVE_BLOCKS = 2;
const NAME_BYTES = 100;
const PREFIX_BYTES = 155;
const REGULAR_FILE = "0";
const USTAR_MAGIC = "ustar\0";
const USTAR_VERSION = "00";
const CHECKSUM_PLACEHOLDER = " ".repeat(8);

/** Byte offsets and lengths of the ustar header fields. */
const FIELD = {
  NAME: [0, NAME_BYTES],
  MODE: [100, 8],
  UID: [108, 8],
  GID: [116, 8],
  SIZE: [124, 12],
  MTIME: [136, 12],
  CHECKSUM: [148, 8],
  TYPE: [156, 1],
  MAGIC: [257, 6],
  VERSION: [263, 2],
  PREFIX: [345, PREFIX_BYTES],
} as const satisfies Record<string, readonly [number, number]>;

/** A path as ustar stores it: the name, and a prefix of leading folders when the name alone is too long. */
export function splitTarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= NAME_BYTES) return { name: path, prefix: "" };
  for (let slash = path.indexOf("/"); slash > 0; slash = path.indexOf("/", slash + 1)) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= PREFIX_BYTES && Buffer.byteLength(name) <= NAME_BYTES) return { name, prefix };
  }
  throw new Error(`Path too long for a tar archive: ${path}`);
}

/** A number as zero-padded octal digits that fill the field but its final NUL. */
const octal = (value: number, fieldBytes: number): string => `${value.toString(8).padStart(fieldBytes - 1, "0")}\0`;

function writeField(header: Buffer, [offset, length]: readonly [number, number], value: string): void {
  header.write(value, offset, length, "utf8");
}

export function tarHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  const { name, prefix } = splitTarPath(entry.path);
  writeField(header, FIELD.NAME, name);
  writeField(header, FIELD.MODE, octal(entry.mode, FIELD.MODE[1]));
  writeField(header, FIELD.UID, octal(0, FIELD.UID[1]));
  writeField(header, FIELD.GID, octal(0, FIELD.GID[1]));
  writeField(header, FIELD.SIZE, octal(entry.content.length, FIELD.SIZE[1]));
  writeField(header, FIELD.MTIME, octal(entry.mtimeSeconds, FIELD.MTIME[1]));
  writeField(header, FIELD.CHECKSUM, CHECKSUM_PLACEHOLDER);
  writeField(header, FIELD.TYPE, REGULAR_FILE);
  writeField(header, FIELD.MAGIC, USTAR_MAGIC);
  writeField(header, FIELD.VERSION, USTAR_VERSION);
  writeField(header, FIELD.PREFIX, prefix);
  // The checksum is the byte sum of the header with the checksum field as spaces: six octal digits, NUL, space.
  const sum = header.reduce((total, byte) => total + byte, 0);
  writeField(header, FIELD.CHECKSUM, `${sum.toString(8).padStart(FIELD.CHECKSUM[1] - 2, "0")}\0 `);
  return header;
}

const padding = (bytes: number): Buffer => Buffer.alloc((TAR_BLOCK_BYTES - (bytes % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES);

/** The uncompressed archive: a header and the padded content per entry, then two empty blocks. */
export function createTar(entries: readonly TarEntry[]): Buffer {
  const parts = entries.flatMap((entry) => [tarHeader(entry), entry.content, padding(entry.content.length)]);
  return Buffer.concat([...parts, Buffer.alloc(TAR_BLOCK_BYTES * END_OF_ARCHIVE_BLOCKS)]);
}

export const createTarGz = (entries: readonly TarEntry[]): Buffer => gzipSync(createTar(entries));
