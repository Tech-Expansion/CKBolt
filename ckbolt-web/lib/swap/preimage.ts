import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** Whether a settled swap's preimage hashes to its payment hash, as the page itself checks with Web Crypto. */
export type PreimageCheck = "match" | "mismatch" | "unavailable";

const HEX_PREFIX = /^0x/i;
const strip = (hex: string): string => hex.trim().replace(HEX_PREFIX, "").toLowerCase();

/** The browser's SubtleCrypto, or null where there is none (a page served over plain http to another host). */
const browserSubtle = (): SubtleCrypto | null => (typeof globalThis.crypto === "object" ? (globalThis.crypto.subtle ?? null) : null);

/**
 * sha256(preimage) = payment hash, computed in the page: the proof that the payment the user made and the payout the
 * user got are locked to the same secret. `subtle` is injectable for tests.
 */
export async function checkPreimage(preimage: string, paymentHash: string, subtle: SubtleCrypto | null = browserSubtle()): Promise<PreimageCheck> {
  if (!subtle) return "unavailable";
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(strip(preimage));
  } catch {
    return "mismatch";
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", new Uint8Array(bytes)));
  return bytesToHex(digest) === strip(paymentHash) ? "match" : "mismatch";
}
