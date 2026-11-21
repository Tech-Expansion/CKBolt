import { scryptAsync } from "@noble/hashes/scrypt.js";
import { validateCkbAddress } from "@/lib/payment-request";
import { bytesToHex, fromHexBytes } from "./hex";
import { packKeys, unpackKeys, type NodeKeys, type RandomBytes } from "./keys";
import {
  BACKUP_FILE_EXTENSION,
  BACKUP_FILE_NODE_ID_CHARS,
  BACKUP_FILE_PREFIX,
  CIPHER_IV_BYTES,
  CIPHER_NAME,
  KDF_ASYNC_TICK_MS,
  KDF_KEY_BYTES,
  KDF_LIMITS,
  KDF_NAME,
  KDF_PARAMS,
  KDF_SALT_BYTES,
  KEYSTORE_VERSION,
  PASSWORD_MIN_LENGTH,
  STORAGE_PREFIX,
} from "./constants";

/** scrypt cost: N = 2^logN, block size r, parallelism p. */
export interface KdfParams {
  logN: number;
  r: number;
  p: number;
}

/**
 * The node keys as stored in the browser and in a backup file: AES-256-GCM under a key that scrypt derives from the
 * visitor's password. Hex fields are plain lower-case hex. `nodeId` and `address` are public: the node id is shown
 * before unlocking, and the address is the node's own CKB address as the running node reported it, so the funding page
 * can tell a link to this node from a link to anyone else's (security review W7).
 */
export interface KeystoreRecord {
  version: typeof KEYSTORE_VERSION;
  network: string;
  kdf: { name: typeof KDF_NAME; salt: string } & KdfParams;
  cipher: { name: typeof CIPHER_NAME; iv: string };
  ciphertext: string;
  nodeId: string | null;
  /** The node's CKB address on `network`, written by the node once it runs; null until then and after a restore. */
  address: string | null;
  createdAt: string;
}

export interface KeystoreDeps {
  subtle: SubtleCrypto;
  random: RandomBytes;
  now: () => Date;
  /** scrypt; replaceable so unit tests can run it cheaply. */
  derive: (password: string, salt: Uint8Array, params: KdfParams) => Promise<Uint8Array>;
}

/** The password did not open the keystore (or the record was changed). */
export class WrongPasswordError extends Error {
  constructor() {
    super("Wrong password, or the stored node key was changed.");
    this.name = "WrongPasswordError";
  }
}

export const scryptDerive = (password: string, salt: Uint8Array, params: KdfParams): Promise<Uint8Array> =>
  scryptAsync(password, salt, { N: 2 ** params.logN, r: params.r, p: params.p, dkLen: KDF_KEY_BYTES, asyncTick: KDF_ASYNC_TICK_MS });

export const browserKeystoreDeps = (): KeystoreDeps => ({
  subtle: crypto.subtle,
  random: (length) => crypto.getRandomValues(new Uint8Array(length)),
  now: () => new Date(),
  derive: scryptDerive,
});

/** Why a password cannot protect a new keystore, or null when it can. Only for new passwords: unlocking never checks it. */
export function passwordProblem(password: string, confirmation: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password !== confirmation) return "The two passwords differ.";
  return null;
}

/** Binds the ciphertext to the record's version and network, so a record cannot be relabelled. */
const additionalData = (version: number, network: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`${STORAGE_PREFIX}:v${version}:${network}`);

/** A copy backed by a plain ArrayBuffer, as WebCrypto's typings ask for. */
const buffer = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

async function aesKey(subtle: SubtleCrypto, raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return subtle.importKey("raw", buffer(raw), { name: CIPHER_NAME }, false, [usage]);
}

/** Encrypts the keys with the password. */
export async function encryptKeys(
  keys: NodeKeys,
  password: string,
  network: string,
  deps: KeystoreDeps,
  params: KdfParams = KDF_PARAMS,
): Promise<KeystoreRecord> {
  const salt = deps.random(KDF_SALT_BYTES);
  const iv = deps.random(CIPHER_IV_BYTES);
  const derived = await deps.derive(password, salt, params);
  const plaintext = packKeys(keys);
  try {
    const key = await aesKey(deps.subtle, derived, "encrypt");
    const sealed = await deps.subtle.encrypt(
      { name: CIPHER_NAME, iv: buffer(iv), additionalData: additionalData(KEYSTORE_VERSION, network) },
      key,
      buffer(plaintext),
    );
    return {
      version: KEYSTORE_VERSION,
      network,
      kdf: { name: KDF_NAME, salt: bytesToHex(salt), ...params },
      cipher: { name: CIPHER_NAME, iv: bytesToHex(iv) },
      ciphertext: bytesToHex(new Uint8Array(sealed)),
      nodeId: null,
      address: null,
      createdAt: deps.now().toISOString(),
    };
  } finally {
    derived.fill(0);
    plaintext.fill(0);
  }
}

/** Opens the keystore; throws WrongPasswordError when the password (or the record) is wrong. */
export async function decryptKeys(record: KeystoreRecord, password: string, deps: KeystoreDeps): Promise<NodeKeys> {
  const derived = await deps.derive(password, fromHexBytes(record.kdf.salt), record.kdf);
  let plaintext: Uint8Array;
  try {
    const key = await aesKey(deps.subtle, derived, "decrypt");
    const opened = await deps.subtle.decrypt(
      { name: CIPHER_NAME, iv: buffer(fromHexBytes(record.cipher.iv)), additionalData: additionalData(record.version, record.network) },
      key,
      buffer(fromHexBytes(record.ciphertext)),
    );
    plaintext = new Uint8Array(opened);
  } catch {
    throw new WrongPasswordError();
  } finally {
    derived.fill(0);
  }
  try {
    return unpackKeys(plaintext);
  } finally {
    plaintext.fill(0);
  }
}

/** scrypt's memory (N x r) and work (N x r x p), in units of 128-byte blocks. */
const kdfMemory = (params: KdfParams): number => 2 ** params.logN * params.r;
const kdfWork = (params: KdfParams): number => kdfMemory(params) * params.p;

/**
 * True when `params` cost an attacker less than `current`: less memory or less work, and no more of the other. A record
 * that is stronger in one of them (made by something other than this app) is not weaker, so moving a record to
 * `current` never makes it cheaper to attack in either.
 */
export function isWeakerKdf(params: KdfParams, current: KdfParams = KDF_PARAMS): boolean {
  const [memory, work] = [kdfMemory(params), kdfWork(params)];
  const [currentMemory, currentWork] = [kdfMemory(current), kdfWork(current)];
  return memory <= currentMemory && work <= currentWork && (memory < currentMemory || work < currentWork);
}

/**
 * Security review W6: a record opened with weaker scrypt parameters than KDF_PARAMS (a key made by an older page, or a
 * restored backup) is encrypted again with them, under the same password, once that password has opened it. Returns
 * the new record, with the old one's node id, address and creation time, or null when it is not weaker. The
 * password's length is not checked: a key kept under a short password still unlocks, and today's parameters make that
 * password costlier to guess.
 */
export async function strengthenKeystore(
  record: KeystoreRecord,
  keys: NodeKeys,
  password: string,
  deps: KeystoreDeps,
  params: KdfParams = KDF_PARAMS,
): Promise<KeystoreRecord | null> {
  if (!isWeakerKdf(record.kdf, params)) return null;
  const stronger = await encryptKeys(keys, password, record.network, deps, params);
  return { ...stronger, nodeId: record.nodeId, address: record.address, createdAt: record.createdAt };
}

/* ------------------------------------------------------------------------------------------- parsing */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isHex = (v: unknown, bytes?: number): v is string =>
  typeof v === "string" && /^[0-9a-f]*$/.test(v) && v.length % 2 === 0 && (bytes === undefined ? v.length > 0 : v.length === bytes * 2);
const isWhole = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** A CKB address on `network`, or null for anything else: a bad address never makes the keys unreadable. */
function addressOn(v: unknown, network: string): string | null {
  if (typeof v !== "string") return null;
  try {
    return validateCkbAddress(v) === network ? v : null;
  } catch {
    return null;
  }
}

/** A keystore record from stored or imported JSON for `network`, or null when it is not one this app can open. */
export function parseKeystore(text: string, network: string): KeystoreRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== KEYSTORE_VERSION || value.network !== network) return null;
  const { kdf, cipher } = value;
  if (!isRecord(kdf) || kdf.name !== KDF_NAME || !isHex(kdf.salt)) return null;
  if (!isWhole(kdf.logN, 1, KDF_LIMITS.maxLogN) || !isWhole(kdf.r, 1, KDF_LIMITS.maxR) || !isWhole(kdf.p, 1, KDF_LIMITS.maxP)) return null;
  if (!isRecord(cipher) || cipher.name !== CIPHER_NAME || !isHex(cipher.iv, CIPHER_IV_BYTES) || !isHex(value.ciphertext)) return null;
  if (value.nodeId !== null && typeof value.nodeId !== "string") return null;
  if (typeof value.createdAt !== "string") return null;
  return {
    version: KEYSTORE_VERSION,
    network,
    kdf: { name: KDF_NAME, salt: kdf.salt, logN: kdf.logN, r: kdf.r, p: kdf.p },
    cipher: { name: CIPHER_NAME, iv: cipher.iv },
    ciphertext: value.ciphertext,
    nodeId: value.nodeId,
    // Records made before the address was kept have none.
    address: addressOn(value.address, network),
    createdAt: value.createdAt,
  };
}

export const serializeKeystore = (record: KeystoreRecord): string => JSON.stringify(record, null, 2);

/** File name for an encrypted backup of `record`. */
export const backupFileName = (record: KeystoreRecord): string =>
  [BACKUP_FILE_PREFIX, record.network, record.nodeId?.slice(0, BACKUP_FILE_NODE_ID_CHARS)].filter(Boolean).join("-") + BACKUP_FILE_EXTENSION;
