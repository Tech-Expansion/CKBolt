/** Shared bech32 / bech32m primitives (BIP-173, BIP-350). */

export const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

export const BECH32_CONST = 1;
export const BECH32M_CONST = 0x2bc830a3;

export function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

export function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

export type Bech32Parts = { hrp: string; words: number[]; variant: "bech32" | "bech32m" };

/**
 * Splits and checksum-verifies a bech32 or bech32m string. No length limit,
 * since Lightning and Fiber invoices are longer than BIP-173's 90 characters.
 */
export function decodeBech32(input: string): Bech32Parts {
  if (input !== input.toLowerCase() && input !== input.toUpperCase()) {
    throw new Error("The text mixes upper and lower case.");
  }
  const s = input.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (sep < 1 || sep + 7 > s.length) throw new Error("This is not a bech32 string.");
  const hrp = s.slice(0, sep);
  for (const c of hrp) {
    const code = c.charCodeAt(0);
    if (code < 33 || code > 126) throw new Error("This is not a bech32 string.");
  }
  const words: number[] = [];
  for (const c of s.slice(sep + 1)) {
    const idx = CHARSET.indexOf(c);
    if (idx === -1) throw new Error("The text contains characters that are not valid bech32.");
    words.push(idx);
  }
  const chk = polymod([...hrpExpand(hrp), ...words]);
  const variant = chk === BECH32_CONST ? "bech32" : chk === BECH32M_CONST ? "bech32m" : null;
  if (!variant) throw new Error("Checksum failed. Check that it was copied completely.");
  return { hrp, words: words.slice(0, -6), variant };
}

/** Bytes to 5-bit words, padding the last word (BIP-173 convertbits 8→5). */
export function toWords(bytes: Iterable<number>): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
}

/**
 * 5-bit words to bytes (convertbits 5→8). Leftover bits are dropped; with
 * `strict`, they must be fewer than five and all zero, as BIP-173 requires.
 */
export function fromWords(words: Iterable<number>, strict = false): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = ((acc << 5) | w) & 0xfff;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (strict && (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0)) throw new Error("Invalid padding.");
  return Uint8Array.from(out);
}

export function encodeBech32(hrp: string, words: number[], variant: "bech32" | "bech32m"): string {
  const k = variant === "bech32" ? BECH32_CONST : BECH32M_CONST;
  const chk = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ k;
  const checksum = Array.from({ length: 6 }, (_, i) => (chk >>> (5 * (5 - i))) & 31);
  return hrp + "1" + [...words, ...checksum].map((w) => CHARSET[w]).join("");
}
