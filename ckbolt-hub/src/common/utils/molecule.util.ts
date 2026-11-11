import type { Script } from "../../domain/types";
import { with0x, without0x } from "./hex.util";

/**
 * Decoding of CKB molecule bytes (https://github.com/nervosnetwork/molecule). Fiber invoices carry their UDT type
 * script this way (`udt_script` attribute). A Script is the table `{ code_hash: Byte32, hash_type: byte, args: Bytes }`.
 */

/** Molecule writes sizes, offsets and vector lengths as little-endian u32. */
const NUMBER_BYTES = 4;
const BYTE32_BYTES = 32;
const HASH_TYPE_BYTES = 1;
const SCRIPT_FIELD_COUNT = 3;
const EVEN_HEX = /^(?:[0-9a-fA-F]{2})*$/;

/** CKB `ScriptHashType` byte values. */
const HASH_TYPE_BY_BYTE: ReadonlyMap<number, Script["hashType"]> = new Map([
  [0, "data"],
  [1, "type"],
  [2, "data1"],
  [4, "data2"],
]);

/** 0x hex of a molecule `Script` -> Script with 0x-prefixed lowercase hex fields. Throws on malformed input. */
export function decodeMoleculeScript(hex: string): Script {
  const [codeHash, hashType, args] = readTableFields(hexToBytes(hex), SCRIPT_FIELD_COUNT);
  if (!codeHash || !hashType || !args) throw new Error("Molecule Script is missing a field");
  return { codeHash: decodeByte32(codeHash), hashType: decodeHashType(hashType), args: decodeBytes(args) };
}

function hexToBytes(hex: string): Buffer {
  const digits = without0x(hex);
  if (!EVEN_HEX.test(digits)) throw new Error(`Not molecule hex: ${hex}`);
  return Buffer.from(digits, "hex");
}

/** Reads the first `count` fields of a molecule table; extra fields (a newer, compatible schema) are ignored. */
function readTableFields(bytes: Buffer, count: number): Buffer[] {
  if (bytes.length < NUMBER_BYTES || bytes.readUInt32LE(0) !== bytes.length) throw new Error("Molecule table size mismatch");
  const headerEnd = bytes.length > NUMBER_BYTES ? bytes.readUInt32LE(NUMBER_BYTES) : NUMBER_BYTES;
  const fieldCount = headerEnd / NUMBER_BYTES - 1;
  if (!Number.isInteger(fieldCount) || fieldCount < count || headerEnd > bytes.length) {
    throw new Error("Molecule table header is invalid");
  }
  const offsets = Array.from({ length: fieldCount }, (_, i) => bytes.readUInt32LE(NUMBER_BYTES * (i + 1)));
  const bounds = [...offsets, bytes.length];
  return offsets.slice(0, count).map((start, i) => {
    const end = bounds[i + 1] ?? bytes.length;
    if (start < headerEnd || end < start || end > bytes.length) throw new Error("Molecule table offsets are invalid");
    return bytes.subarray(start, end);
  });
}

function decodeByte32(field: Buffer): string {
  if (field.length !== BYTE32_BYTES) throw new Error("Molecule Byte32 has the wrong length");
  return with0x(field.toString("hex"));
}

function decodeHashType(field: Buffer): Script["hashType"] {
  const hashType = field.length === HASH_TYPE_BYTES ? HASH_TYPE_BY_BYTE.get(field.readUInt8(0)) : undefined;
  if (!hashType) throw new Error("Molecule Script has an unknown hash_type");
  return hashType;
}

/** Molecule `Bytes` is a fixvec: u32 item count, then the bytes. */
function decodeBytes(field: Buffer): string {
  if (field.length < NUMBER_BYTES || field.readUInt32LE(0) !== field.length - NUMBER_BYTES) {
    throw new Error("Molecule Bytes length mismatch");
  }
  return with0x(field.subarray(NUMBER_BYTES).toString("hex"));
}
