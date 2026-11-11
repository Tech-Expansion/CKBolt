import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "./hex";
import { KEY_GENERATION_MAX_TRIES, KEY_TAG_BYTES, SECP256K1_ORDER_HEX, SECRET_KEY_BYTES } from "./constants";

/**
 * The node's two secrets, generated in the browser and never sent anywhere: `fiberKey` is the P2P identity (the node
 * id is its public key), `ckbKey` signs the node's on-chain transactions (its CKB address is that key's lock).
 */
export interface NodeKeys {
  fiberKey: Uint8Array;
  ckbKey: Uint8Array;
}

export type RandomBytes = (length: number) => Uint8Array;

/** Cryptographically secure random bytes from the browser. */
export const browserRandomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

const SECP256K1_ORDER = BigInt(`0x${SECP256K1_ORDER_HEX}`);

/** True for 32 bytes that make a valid secp256k1 secret key: not zero and below the group order. */
export function isValidSecretKey(bytes: Uint8Array): boolean {
  if (bytes.length !== SECRET_KEY_BYTES) return false;
  const value = BigInt(`0x${bytesToHex(bytes)}`);
  return value > BigInt(0) && value < SECP256K1_ORDER;
}

function randomSecretKey(random: RandomBytes): Uint8Array {
  for (let i = 0; i < KEY_GENERATION_MAX_TRIES; i++) {
    const candidate = random(SECRET_KEY_BYTES);
    if (isValidSecretKey(candidate)) return candidate;
  }
  throw new Error("Could not draw a valid key from the browser's random source.");
}

/** Two fresh secret keys for a new node. */
export const generateNodeKeys = (random: RandomBytes = browserRandomBytes): NodeKeys => ({
  fiberKey: randomSecretKey(random),
  ckbKey: randomSecretKey(random),
});

/** Both keys as one 64-byte block (P2P key first), the plaintext of the keystore. */
export function packKeys(keys: NodeKeys): Uint8Array {
  const out = new Uint8Array(SECRET_KEY_BYTES * 2);
  out.set(keys.fiberKey, 0);
  out.set(keys.ckbKey, SECRET_KEY_BYTES);
  return out;
}

/** The keys from a 64-byte block; throws when it is not two valid keys. */
export function unpackKeys(block: Uint8Array): NodeKeys {
  if (block.length !== SECRET_KEY_BYTES * 2) throw new Error("The stored node keys have the wrong length.");
  const keys = { fiberKey: block.slice(0, SECRET_KEY_BYTES), ckbKey: block.slice(SECRET_KEY_BYTES) };
  if (!isValidSecretKey(keys.fiberKey) || !isValidSecretKey(keys.ckbKey)) throw new Error("The stored node keys are not valid keys.");
  return keys;
}

/** A short public tag of the P2P key (start of its sha256), naming the node's database; it reveals nothing usable. */
export const keyTag = (keys: NodeKeys): string => bytesToHex(sha256(keys.fiberKey).slice(0, KEY_TAG_BYTES));

/** Overwrites the keys in memory once fiber-js has its own copy. */
export function wipeKeys(keys: NodeKeys): void {
  keys.fiberKey.fill(0);
  keys.ckbKey.fill(0);
}
