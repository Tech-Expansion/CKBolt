import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** Fiber RPC numbers and hashes are 0x-prefixed hex; CKBolt's hub contract uses plain lower-case hex. */
const PREFIX = "0x";
const HEX_RADIX = 16;

export const strip0x = (value: string): string => (value.startsWith(PREFIX) || value.startsWith("0X") ? value.slice(PREFIX.length) : value);

export const with0x = (value: string): string => `${PREFIX}${strip0x(value)}`;

/** Bytes as 0x-prefixed hex. */
export const toHexBytes = (bytes: Uint8Array): string => `${PREFIX}${bytesToHex(bytes)}`;

/** 0x-prefixed or plain hex as bytes; throws on odd length or non-hex characters. */
export const fromHexBytes = (hex: string): Uint8Array => hexToBytes(strip0x(hex));

/** A non-negative whole number as a Fiber RPC quantity ("0x1f4"). */
export function toHexQuantity(value: bigint | number): string {
  const n = typeof value === "bigint" ? value : BigInt(Math.floor(value));
  if (n < BigInt(0)) throw new Error("A quantity cannot be negative.");
  return `${PREFIX}${n.toString(HEX_RADIX)}`;
}

/** A Fiber RPC quantity ("0x1f4") as a bigint; 0 for anything that is not one. */
export function fromHexQuantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return BigInt(0);
  return BigInt(value);
}

/** A Fiber node id as the hub's contract writes it: 66 lower-case hex characters, no 0x. */
export const normalizeNodeId = (value: string): string => strip0x(value.trim()).toLowerCase();

export { bytesToHex };
