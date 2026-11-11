import { createHash, randomBytes } from "node:crypto";
import { PAYMENT_PREIMAGE_BYTES } from "../constants/protocol.constants";
import type { Hex32 } from "../../domain/types";

const HEX32 = /^[0-9a-f]{64}$/;
const HEX_DIGITS = /^[0-9a-fA-F]*$/;
const HEX_CHARS_PER_BYTE = 2;

export const isHex32 = (value: string): value is Hex32 => HEX32.test(value);

/** True when `value` is exactly `bytes` bytes of hex, in either case, without 0x. */
export const isHexOfBytes = (value: string, bytes: number): boolean =>
  value.length === bytes * HEX_CHARS_PER_BYTE && HEX_DIGITS.test(value);

/** Accepts upper case and an optional 0x; returns the canonical form or throws. */
export function toHex32(value: string): Hex32 {
  const v = value.trim().toLowerCase().replace(/^0x/, "");
  if (!isHex32(v)) throw new Error(`Not a 32-byte hex value: ${value}`);
  return v;
}

/** A fresh random payment preimage, as the payee of an invoice creates it. */
export const randomPreimage = (): Hex32 => randomBytes(PAYMENT_PREIMAGE_BYTES).toString("hex");

/** sha256 of a 32-byte preimage, as Hex32. */
export function sha256Hex(preimage: Hex32): Hex32 {
  return createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
}

/** True when sha256(preimage) equals the payment hash. Every settle must check this first. */
export function preimageMatches(preimage: Hex32, paymentHash: Hex32): boolean {
  return isHex32(preimage) && sha256Hex(preimage) === paymentHash;
}

export const with0x = (hex: string) => (hex.startsWith("0x") ? hex : `0x${hex}`);
export const without0x = (hex: string) => hex.replace(/^0x/, "");

/** Lower-case hex without 0x: the form in which two spellings of the same id compare equal. */
export const canonicalHex = (hex: string): string => without0x(hex).toLowerCase();

/** The same bytes in reverse order, as lower-case hex without 0x: a hash in the other of its two byte orders. */
export const reverseHexBytes = (hex: string): string => Buffer.from(without0x(hex), "hex").reverse().toString("hex");
