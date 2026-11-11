import type { Script } from "@/lib/hub/contract";
import { fromHexBytes, toHexBytes } from "./hex";
import { CKB_HASH_TYPE_BYTE } from "./constants";

/**
 * Decoding of CKB molecule bytes (https://github.com/nervosnetwork/molecule), as the hub does it
 * (../ckbolt-hub/src/common/utils/molecule.util.ts). A Fiber invoice carries its token this way (`udt_script`). A Script
 * is the table `{ code_hash: Byte32, hash_type: byte, args: Bytes }`.
 */

/** Molecule writes sizes, offsets and vector lengths as little-endian u32. */
const NUMBER_BYTES = 4;
const BYTE32_BYTES = 32;
const HASH_TYPE_BYTES = 1;
const SCRIPT_FIELD_COUNT = 3;
const LITTLE_ENDIAN = true;

const HASH_TYPE_BY_BYTE: ReadonlyMap<number, Script["hashType"]> = new Map(
  (Object.entries(CKB_HASH_TYPE_BYTE) as [Script["hashType"], number][]).map(([name, byte]) => [byte, name]),
);

const u32 = (bytes: Uint8Array, at: number): number => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, LITTLE_ENDIAN);

/** Reads the first `count` fields of a molecule table; extra fields (a newer, compatible schema) are ignored. */
function readTableFields(bytes: Uint8Array, count: number): Uint8Array[] {
  if (bytes.length < NUMBER_BYTES || u32(bytes, 0) !== bytes.length) throw new Error("Molecule table size mismatch");
  const headerEnd = bytes.length > NUMBER_BYTES ? u32(bytes, NUMBER_BYTES) : NUMBER_BYTES;
  const fieldCount = headerEnd / NUMBER_BYTES - 1;
  if (!Number.isInteger(fieldCount) || fieldCount < count || headerEnd > bytes.length) throw new Error("Molecule table header is invalid");
  const offsets = Array.from({ length: fieldCount }, (_, i) => u32(bytes, NUMBER_BYTES * (i + 1)));
  const bounds = [...offsets, bytes.length];
  return offsets.slice(0, count).map((start, i) => {
    const end = bounds[i + 1];
    if (start < headerEnd || end < start || end > bytes.length) throw new Error("Molecule table offsets are invalid");
    return bytes.subarray(start, end);
  });
}

function decodeHashType(field: Uint8Array): Script["hashType"] {
  const hashType = field.length === HASH_TYPE_BYTES ? HASH_TYPE_BY_BYTE.get(field[0]) : undefined;
  if (!hashType) throw new Error("Molecule Script has an unknown hash_type");
  return hashType;
}

/** Molecule `Bytes` is a fixvec: a u32 item count, then the bytes. */
function decodeBytes(field: Uint8Array): string {
  if (field.length < NUMBER_BYTES || u32(field, 0) !== field.length - NUMBER_BYTES) throw new Error("Molecule Bytes length mismatch");
  return toHexBytes(field.subarray(NUMBER_BYTES));
}

/** 0x hex of a molecule Script, as a Script with 0x-prefixed lower-case hex fields. Throws on malformed input. */
export function decodeMoleculeScript(hex: string): Script {
  const [codeHash, hashType, args] = readTableFields(fromHexBytes(hex), SCRIPT_FIELD_COUNT);
  if (codeHash.length !== BYTE32_BYTES) throw new Error("Molecule Byte32 has the wrong length");
  return { codeHash: toHexBytes(codeHash), hashType: decodeHashType(hashType), args: decodeBytes(args) };
}
