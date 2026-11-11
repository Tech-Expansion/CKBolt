/** Typed reads of optional DEVNET_* overrides. A bad value fails loudly instead of silently using the default. */

export type Env = Readonly<Record<string, string | undefined>>;

const INTEGER = /^\d+$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

const present = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value ? value : undefined;
};

function invalid(name: string, value: string, expected: string): Error {
  return new Error(`${name}=${value} is not ${expected}`);
}

/** A non-negative integer that fits in a JS number (counts, ms, blocks). */
export function readCount(env: Env, name: string, fallback: number): number {
  const value = present(env, name);
  if (value === undefined) return fallback;
  if (!INTEGER.test(value) || !Number.isSafeInteger(Number(value))) throw invalid(name, value, "a non-negative integer");
  return Number(value);
}

/** A non-negative amount in base units (sats, shannons, UDT units). */
export function readAmount(env: Env, name: string, fallback: bigint): bigint {
  const value = present(env, name);
  if (value === undefined) return fallback;
  if (!INTEGER.test(value)) throw invalid(name, value, "a non-negative integer amount in base units");
  return BigInt(value);
}

/** A 32-byte secp256k1 private key as 0x hex. */
export function readPrivateKey(env: Env, name: string, fallback: string): string {
  const value = present(env, name);
  if (value === undefined) return fallback;
  if (!PRIVATE_KEY.test(value)) throw invalid(name, "<hidden>", "a 0x-prefixed 32-byte hex private key");
  return value;
}
