import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET_DIGEST = "sha256";
const SECRET_ENCODING = "hex";

const digestOf = (value: string): Buffer => createHash(SECRET_DIGEST).update(value, "utf8").digest();

/**
 * Whether `given` is `expected`, compared in constant time: both are hashed first, so neither where they differ nor
 * their lengths show in how long the comparison takes.
 */
export const secretsMatch = (given: string, expected: string): boolean => timingSafeEqual(digestOf(given), digestOf(expected));

/** A new random secret of `bytes` bytes, as hex. */
export const newSecret = (bytes: number): string => randomBytes(bytes).toString(SECRET_ENCODING);

/** What a random secret is kept as, so a copy of the database cannot be used in its place: its hash, as hex. */
export const secretDigest = (secret: string): string => digestOf(secret).toString(SECRET_ENCODING);

/** Whether `given` is the secret `expectedDigest` was made from, compared in constant time. */
export const matchesSecretDigest = (given: string, expectedDigest: string): boolean => {
  const actual = digestOf(given);
  const expected = Buffer.from(expectedDigest, SECRET_ENCODING);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
