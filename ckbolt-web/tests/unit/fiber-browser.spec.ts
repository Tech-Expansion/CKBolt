import { readFileSync } from "node:fs";
import { withdrawableTokens } from "../../lib/wallets/fiber-browser/token-withdraw";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { ccc } from "@ckb-ccc/core";
import { scrypt } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decodeBech32, fromWords } from "../../lib/bech32";
import { HubApiError, HubClient } from "../../lib/hub/client";
import type { HubProxyConfig } from "../../lib/hub/config";
import { API_ERROR_CODE, API_ROUTES, type FiberNodeDto, type Script, type SwapDto, type SwapState } from "../../lib/hub/contract";
import { HubProxy, type HubProxyDeps } from "../../lib/hub/proxy";
import { HUB_ROUTES, hubResourcePath, matchHubRoute } from "../../lib/hub/routes";
import {
  activityLabel,
  isActivityFinal,
  readHistory,
  reconcileChannels,
  saveHistory,
  upsertActivity,
  withPayment,
  type ActivityEntry,
} from "../../lib/wallets/fiber-browser/activity";
import {
  BridgeClient,
  BridgeError,
  browserChannel,
  nextPresenceRead,
  NO_PRESENCE,
  type BroadcastLike,
  type ChannelFactory,
} from "../../lib/wallets/fiber-browser/bridge-client";
import {
  BRIDGE_ERROR,
  BRIDGE_METHOD,
  errorResponse,
  isNodePresence,
  okResponse,
  parseRequest,
  parseResponse,
  request,
  requestId,
  type MakeInvoiceParams,
  type NodePresence,
} from "../../lib/wallets/fiber-browser/bridge-protocol";
import { startBridgeServer, type BridgeHandlers } from "../../lib/wallets/fiber-browser/bridge-server";
import { assetScript, channelAsset, channelStateLabel, ckbToShannons, hubChannels, liquidityOf } from "../../lib/wallets/fiber-browser/channels";
import {
  ckbNeededToAccept,
  largestContribution,
  newChannelCapacity,
  parseContribution,
  readContribution,
  saveContribution,
  spendableContribution,
} from "../../lib/wallets/fiber-browser/channel-contribution";
import { scriptToAddress } from "../../lib/wallets/fiber-browser/ckb-address";
import { CkbRpcClient } from "../../lib/wallets/fiber-browser/ckb-rpc";
import { parseBrowserNodeConfig } from "../../lib/wallets/fiber-browser/config";
import {
  BRIDGE_CHANNEL_NAME,
  BROWSER_NODE_NETWORK,
  CHANNEL_RESERVE_CKB,
  CKB_RPC_DEFAULT_URL,
  FIBER_JS_VERSION,
  HUB_ACCEPT_RETRY_DELAYS_MS,
  INVOICE_EXTRA_SECONDS,
  INVOICE_MIN_EXPIRY_SECONDS,
  KDF_LIMITS,
  KDF_PARAMS,
  MIN_CHANNEL_CONTRIBUTION_CKB,
  NODE_AUTO_ACCEPT_CKB_FUNDING_SHANNONS,
  NODE_CHANNEL_CONTRIBUTION_CKB,
  PASSWORD_MIN_LENGTH,
  STORAGE_NAME,
} from "../../lib/wallets/fiber-browser/constants";
import { fiberErrorMessage } from "../../lib/wallets/fiber-browser/errors";
import { FiberJsNode, type FiberLike } from "../../lib/wallets/fiber-browser/fiber-js-adapter";
import { loadFiber } from "../../lib/wallets/fiber-browser/fiber-loader";
import { installedTestNode, TEST_FIBER_NODE_GLOBAL } from "../../lib/wallets/fiber-browser/fiber-test-hook";
import { fromHexQuantity, normalizeNodeId, strip0x, toHexQuantity, with0x } from "../../lib/wallets/fiber-browser/hex";
import { acceptHubChannel, HUB_ACCEPT_MESSAGE, isChannelNotArrived, planHubContribution } from "../../lib/wallets/fiber-browser/hub-accept";
import { dialHub, hubDialAddresses, isHubConnected } from "../../lib/wallets/fiber-browser/hub-link";
import { requestHubChannel } from "../../components/app/fiber-node/channel-actions";
import { HUB_PANEL_COPY } from "../../components/app/fiber-node/copy";
import { invoiceExpirySeconds, isInvoiceOfNetwork, parseBaseUnits, payoutInvoiceArgs } from "../../lib/wallets/fiber-browser/invoice-request";
import { canRunNode, checkIsolation, reloadOnceForIsolation } from "../../lib/wallets/fiber-browser/isolation";
import { generateNodeKeys, isValidSecretKey, keyTag, packKeys, unpackKeys, wipeKeys, type NodeKeys } from "../../lib/wallets/fiber-browser/keys";
import {
  backupFileName,
  browserKeystoreDeps,
  decryptKeys,
  encryptKeys,
  parseKeystore,
  passwordProblem,
  scryptDerive,
  serializeKeystore,
  WrongPasswordError,
  type KdfParams,
  type KeystoreDeps,
  type KeystoreRecord,
} from "../../lib/wallets/fiber-browser/keystore";
import { fundNodeHref, readFundAddress, fiberNodePageHref, urlHost } from "../../lib/wallets/fiber-browser/links";
import { browserNodeConfig, dialableAddresses, needsTlsPeers } from "../../lib/wallets/fiber-browser/node-config";
import { BrowserNodeController, nodeLockName, type NodeState } from "../../lib/wallets/fiber-browser/node-controller";
import { acquireNodeLock, isNodeLockHeld, type LockManagerLike, type NodeLockHandle } from "../../lib/wallets/fiber-browser/node-lock";
import type { BrowserFiberNode, NewInvoiceArgs, NodeChannel, NodePayment, SendPaymentOptions } from "../../lib/wallets/fiber-browser/node-port";
import { peerIdOf, withPeerId } from "../../lib/wallets/fiber-browser/peer-id";
import { databasePrefix, KeystoreRepository, storageKey, webStore, type KeyValueStore } from "../../lib/wallets/fiber-browser/storage";
import { makePayoutInvoice, payHoldInvoice, SwapRequestError, type SwapRequestDeps } from "../../lib/wallets/fiber-browser/swap-requests";

/*
 * The visitor's Fiber node in the browser (lib/wallets/fiber-browser): keys and keystore, the node config and the
 * fiber-js adapter, the single-tab lock, the bridge between /app and /app/fiber, the checks the node runs before it
 * makes an invoice or pays one, and the three /v1/fiber/* hub endpoints in the contract, client and proxy.
 * Spec: ../ckbolt-hub/docs/research/fiber-browser-wallet.md. No browser, no network.
 */

/* ------------------------------------------------------------------------------------------------ fixtures */

/** Real testnet nodes (Fiber's public testnet relays): compressed pubkey and tentacle peer id. */
const BOTTLE = { nodeId: "02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71", peerId: "QmXen3eUHhywmutEzydCsW4hXBoeVmdET2FJvMX69XJ1Eo" };
const BRACER = { nodeId: "0291a6576bd5a94bd74b27080a48340875338fff9f6d6361fe6b8db8d0d1912fcc", peerId: "QmbKyzq9qUmymW2Gi8Zq7kKVpPiNA1XUJ6uMvsUC4F3p89" };

const SECP_CODE_HASH = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const secpLock = (args = `0x${"ab".repeat(20)}`): Script => ({ codeHash: SECP_CODE_HASH, hashType: "type", args });
const RUSD_SCRIPT: Script = {
  codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hashType: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const CKB = BigInt(100_000_000);
const ckb = (whole: number | string): bigint => BigInt(whole) * CKB;

const HUB_NODE: FiberNodeDto = {
  nodeId: BOTTLE.nodeId,
  network: "testnet",
  addresses: { p2p: ["/ip4/1.2.3.4/tcp/8228"], ws: ["/dns4/hub.example.test/tcp/443/wss", "/ip4/1.2.3.4/tcp/8229/ws"] },
  assets: [
    { id: "CKB", udtTypeScript: null, udtWhitelist: null, peerChannels: null },
    { id: "RUSD", udtTypeScript: RUSD_SCRIPT, udtWhitelist: null, peerChannels: null },
  ],
  inbound: { enabled: true, amounts: { CKB: "100000000000", RUSD: "2000000000" } },
};

const channel = (overrides: Partial<NodeChannel> = {}): NodeChannel => ({
  channelId: `0x${"11".repeat(32)}`,
  peerId: BOTTLE.nodeId,
  udtTypeScript: null,
  state: "ChannelReady",
  isPublic: false,
  enabled: true,
  localBalance: ckb(401),
  remoteBalance: ckb(0),
  ...overrides,
});

/** Deterministic bytes: 0x01, 0x02, ... so drawn keys and preimages are known. */
function countingRandom(start = 1) {
  let next = start;
  const drawn: Uint8Array[] = [];
  const random = (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = next++ & 0xff || 1;
    drawn.push(out.slice());
    return out;
  };
  return { random, drawn };
}

/** A map behind the Web Storage interface. */
class MapStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

/** Cheap scrypt for round trips; the default-parameter test runs the real cost once. */
const FAST_KDF: KdfParams = { logN: 4, r: 8, p: 1 };
const fastDeps = (overrides: Partial<KeystoreDeps> = {}): KeystoreDeps => ({ ...browserKeystoreDeps(), ...overrides });

const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const SWAP_ID = "6f9619ff-8b86-4011-b42d-00cf4fc964ff";

function swap(overrides: Partial<SwapDto> = {}): SwapDto {
  return {
    id: SWAP_ID,
    quoteId: "7f9619ff-8b86-4011-b42d-00cf4fc964ff",
    direction: "fiber_to_ln",
    asset: "CKB",
    state: "pending",
    paymentHash: "aa".repeat(32),
    pay: { network: "fiber", asset: "CKB", amount: "800000000000", decimals: 8, invoice: "fibt800000000000hubholdinvoice" },
    receive: { network: "lightning", asset: "BTC", amount: "19800", decimals: 8, invoice: "lntbs198u1visitor" },
    refunded: false,
    failureReason: null,
    preimage: null,
    demo: false,
    quoteExpiresAt: iso(NOW + 150_000),
    createdAt: iso(NOW),
    updatedAt: iso(NOW),
    links: { self: `/v1/swaps/${SWAP_ID}`, events: `/v1/swaps/${SWAP_ID}/events` },
    ...overrides,
  };
}

/** A BrowserFiberNode that records what it is asked and answers from its fields. */
class FakeNode implements BrowserFiberNode {
  channels: NodeChannel[] = [];
  readonly invoices: NewInvoiceArgs[] = [];
  readonly paid: string[] = [];
  /** send_payment's options, per call. */
  readonly payOptions: (SendPaymentOptions | undefined)[] = [];
  invoiceError: unknown = null;
  payment: Partial<NodePayment> | Error | string = { status: "Inflight" };
  readonly connected: string[] = [];
  connectErrors = new Map<string, unknown>();

  async info() {
    return { nodeId: "03" + "cd".repeat(32), version: "0.9.1", fundingLockScript: secpLock() };
  }
  async connectPeer(address: string) {
    this.connected.push(address);
    const error = this.connectErrors.get(address);
    if (error !== undefined) throw error;
  }
  async listPeers() {
    return [];
  }
  async openChannel() {
    return { temporaryChannelId: "0x01" };
  }
  async acceptChannel() {
    return { channelId: "0x02" };
  }
  async listChannels() {
    return this.channels;
  }
  async shutdownChannel() {}
  async newInvoice(args: NewInvoiceArgs) {
    // Copy: the caller wipes nothing here (it passes hex), but keep what arrived.
    this.invoices.push({ ...args });
    if (this.invoiceError !== null) throw this.invoiceError;
    return { invoice: `fibt${args.amount}invoice`, paymentHash: `0x${bytesToHex(sha256(hexToBytes(strip0x(args.preimage))))}` };
  }
  async getInvoiceStatus() {
    return "Open" as const;
  }
  async cancelInvoice() {
    return "Cancelled" as const;
  }
  async parseInvoice(): Promise<never> {
    throw new Error("parse_invoice is not used by swaps");
  }
  async sendPayment(invoice: string, options?: SendPaymentOptions): Promise<NodePayment> {
    this.paid.push(invoice);
    this.payOptions.push(options);
    if (this.payment instanceof Error || typeof this.payment === "string") throw this.payment;
    return { paymentHash: `0x${"bb".repeat(32)}`, status: "Inflight", failedError: null, fee: BigInt(0), ...this.payment };
  }
  async getPayment(): Promise<NodePayment> {
    return { paymentHash: `0x${"bb".repeat(32)}`, status: "Inflight", failedError: null, fee: BigInt(0) };
  }
  async stop() {}
}

function swapDeps(node: FakeNode, overrides: Partial<SwapRequestDeps> & { swap?: SwapDto | Error } = {}) {
  const asked: string[] = [];
  const answer = overrides.swap ?? swap();
  const deps: SwapRequestDeps = {
    node,
    network: "testnet",
    hubNode: HUB_NODE,
    hub: {
      getSwap: async (id: string) => {
        asked.push(id);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    random: countingRandom(7).random,
    now: () => NOW,
    ...overrides,
  };
  return { deps, asked };
}

const invoiceParams = (overrides: Partial<MakeInvoiceParams> = {}): MakeInvoiceParams => ({
  asset: "CKB",
  amount: "1980000000000",
  quoteExpiresAt: iso(NOW + 150_000),
  network: "testnet",
  ...overrides,
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

/* ------------------------------------------------------------------------------------------- the package */

test.describe("fiber-js package", () => {
  test("is pinned to exactly the version the code is written for, and that version is installed", () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.dependencies["@nervosnetwork/fiber-js"]).toBe(FIBER_JS_VERSION);
    const installed = JSON.parse(readFileSync(path.join(process.cwd(), "node_modules/@nervosnetwork/fiber-js/package.json"), "utf8"));
    expect(installed.version).toBe(FIBER_JS_VERSION);
    expect(FIBER_JS_VERSION).toBe("0.9.1");
  });

  test("the browser node runs on CKB testnet only; no environment value can move it to mainnet", () => {
    expect(BROWSER_NODE_NETWORK).toBe("testnet");
    const config = parseBrowserNodeConfig({ ckbRpcUrl: "https://mainnet.ckbapp.dev/", bootnodes: "/dns4/x/tcp/443/wss" });
    expect(config.network).toBe("testnet");
  });
});

/* ------------------------------------------------------------------------------------------------- keys */

test.describe("node keys", () => {
  const ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
  const keyOf = (n: bigint) => hexToBytes(n.toString(16).padStart(64, "0"));

  test("a valid secp256k1 secret key is 32 bytes in [1, n - 1]", () => {
    expect(isValidSecretKey(keyOf(BigInt(1)))).toBe(true);
    expect(isValidSecretKey(keyOf(ORDER - BigInt(1)))).toBe(true);
    expect(isValidSecretKey(keyOf(BigInt(0)))).toBe(false);
    expect(isValidSecretKey(keyOf(ORDER))).toBe(false);
    expect(isValidSecretKey(new Uint8Array(32).fill(0xff))).toBe(false);
    expect(isValidSecretKey(new Uint8Array(31).fill(1))).toBe(false);
    expect(isValidSecretKey(new Uint8Array(33).fill(1))).toBe(false);
  });

  test("generates two different valid keys from the browser's secure random source", () => {
    const a = generateNodeKeys();
    const b = generateNodeKeys();
    for (const keys of [a, b]) {
      expect(keys.fiberKey).toHaveLength(32);
      expect(keys.ckbKey).toHaveLength(32);
      expect(isValidSecretKey(keys.fiberKey)).toBe(true);
      expect(isValidSecretKey(keys.ckbKey)).toBe(true);
      expect(bytesToHex(keys.fiberKey)).not.toBe(bytesToHex(keys.ckbKey));
    }
    expect(bytesToHex(a.fiberKey)).not.toBe(bytesToHex(b.fiberKey));
  });

  test("draws again when the random source gives an invalid key, and gives up after a bounded number of tries", () => {
    const valid = new Uint8Array(32).fill(7);
    const draws: Uint8Array[] = [new Uint8Array(32), new Uint8Array(32).fill(0xff), valid, valid.slice()];
    let i = 0;
    const keys = generateNodeKeys(() => draws[i++]);
    expect(i).toBe(4);
    expect(bytesToHex(keys.fiberKey)).toBe(bytesToHex(valid));
    let calls = 0;
    expect(() =>
      generateNodeKeys(() => {
        calls++;
        return new Uint8Array(32);
      }),
    ).toThrow(/valid key/);
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(16);
  });

  test("packs the P2P key first and unpacks only two valid keys", () => {
    const keys: NodeKeys = { fiberKey: new Uint8Array(32).fill(1), ckbKey: new Uint8Array(32).fill(2) };
    const block = packKeys(keys);
    expect(block).toHaveLength(64);
    expect(bytesToHex(block)).toBe("01".repeat(32) + "02".repeat(32));
    const back = unpackKeys(block);
    expect(bytesToHex(back.fiberKey)).toBe("01".repeat(32));
    expect(bytesToHex(back.ckbKey)).toBe("02".repeat(32));
    expect(() => unpackKeys(block.slice(0, 63))).toThrow(/wrong length/);
    expect(() => unpackKeys(new Uint8Array(64))).toThrow(/not valid keys/);
  });

  test("the key tag names the node's database: 16 hex characters of sha256(P2P key), never the key itself", () => {
    const keys: NodeKeys = { fiberKey: new Uint8Array(32).fill(9), ckbKey: new Uint8Array(32).fill(3) };
    const tag = keyTag(keys);
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(tag).toBe(bytesToHex(sha256(keys.fiberKey)).slice(0, 16));
    expect(bytesToHex(keys.fiberKey)).not.toContain(tag);
    // The CKB key does not change it; another P2P key does.
    expect(keyTag({ ...keys, ckbKey: new Uint8Array(32).fill(4) })).toBe(tag);
    expect(keyTag({ ...keys, fiberKey: new Uint8Array(32).fill(8) })).not.toBe(tag);
  });

  test("wipes both keys in place", () => {
    const keys = generateNodeKeys();
    wipeKeys(keys);
    expect(keys.fiberKey.every((b) => b === 0)).toBe(true);
    expect(keys.ckbKey.every((b) => b === 0)).toBe(true);
  });
});

/* --------------------------------------------------------------------------------------------- keystore */

test.describe("keystore: keys encrypted with a password-derived key", () => {
  const PASSWORD = "correct horse battery";

  test("scrypt runs with the named parameters (N = 2^16, r = 8, p = 1) and gives the same key as @noble/hashes' scrypt", async () => {
    expect(KDF_PARAMS).toEqual({ logN: 16, r: 8, p: 1 });
    const salt = new Uint8Array(16).fill(5);
    const derived = await scryptDerive(PASSWORD, salt, KDF_PARAMS);
    expect(derived).toHaveLength(32);
    expect(bytesToHex(derived)).toBe(bytesToHex(scrypt(PASSWORD, salt, { N: 2 ** 16, r: 8, p: 1, dkLen: 32 })));
  });

  test("a new keystore records the default KDF parameters, a fresh salt and IV, and hands scrypt exactly those", async () => {
    const seen: { password: string; salt: string; params: KdfParams }[] = [];
    const deps = fastDeps({
      derive: async (password, salt, params) => {
        seen.push({ password, salt: bytesToHex(salt), params });
        return scrypt(password, salt, { N: 2 ** FAST_KDF.logN, r: FAST_KDF.r, p: FAST_KDF.p, dkLen: 32 });
      },
      now: () => new Date(NOW),
    });
    const keys = generateNodeKeys();
    const a = await encryptKeys(keys, PASSWORD, "testnet", deps);
    const b = await encryptKeys(keys, PASSWORD, "testnet", deps);
    expect(a.kdf).toMatchObject({ name: "scrypt", logN: 16, r: 8, p: 1 });
    expect(a.cipher.name).toBe("AES-GCM");
    expect(a.kdf.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(a.cipher.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(seen.map((s) => s.salt)).toEqual([a.kdf.salt, b.kdf.salt]);
    expect(seen[0]).toMatchObject({ password: PASSWORD, params: KDF_PARAMS });
    expect(a).toMatchObject({ version: 1, network: "testnet", nodeId: null, createdAt: iso(NOW) });
  });

  test("round-trips the keys, and the stored record holds neither the keys nor the password", async () => {
    const keys = generateNodeKeys();
    const fiberHex = bytesToHex(keys.fiberKey);
    const ckbHex = bytesToHex(keys.ckbKey);
    const record = await encryptKeys(keys, PASSWORD, "testnet", fastDeps(), FAST_KDF);
    // Encrypting does not wipe or change the caller's keys.
    expect(bytesToHex(keys.fiberKey)).toBe(fiberHex);
    const text = serializeKeystore(record);
    for (const secret of [fiberHex, ckbHex, PASSWORD, fiberHex.slice(0, 16), ckbHex.slice(-16)]) expect(text).not.toContain(secret);
    // AES-GCM: 64 bytes of keys plus a 16-byte tag.
    expect(record.ciphertext).toHaveLength((64 + 16) * 2);
    const opened = await decryptKeys(parseKeystore(text, "testnet")!, PASSWORD, fastDeps());
    expect(bytesToHex(opened.fiberKey)).toBe(fiberHex);
    expect(bytesToHex(opened.ckbKey)).toBe(ckbHex);
  });

  test("a wrong password, a changed ciphertext, IV, salt or KDF cost, or a relabelled network all fail as WrongPasswordError", async () => {
    const record = await encryptKeys(generateNodeKeys(), PASSWORD, "testnet", fastDeps(), FAST_KDF);
    const flip = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
    const variants: [string, KeystoreRecord, string][] = [
      ["wrong password", record, "correct horse batterY"],
      ["empty password", record, ""],
      ["ciphertext", { ...record, ciphertext: flip(record.ciphertext) }, PASSWORD],
      ["iv", { ...record, cipher: { ...record.cipher, iv: flip(record.cipher.iv) } }, PASSWORD],
      ["salt", { ...record, kdf: { ...record.kdf, salt: flip(record.kdf.salt) } }, PASSWORD],
      ["cost", { ...record, kdf: { ...record.kdf, logN: record.kdf.logN + 1 } }, PASSWORD],
      // The network is bound into the ciphertext (AES-GCM additional data): a testnet record cannot pass as mainnet.
      ["network", { ...record, network: "mainnet" }, PASSWORD],
    ];
    for (const [name, variant, password] of variants) {
      const error = await rejection(decryptKeys(variant, password, fastDeps()));
      expect(error, name).toBeInstanceOf(WrongPasswordError);
      expect((error as Error).message).toBe("Wrong password, or the stored node key was changed.");
    }
  });

  test("wipes the derived key and the packed plaintext once it is done", async () => {
    const derivedKeys: Uint8Array[] = [];
    const deps = fastDeps({
      derive: async (password, salt, params) => {
        const key = await scryptDerive(password, salt, params);
        derivedKeys.push(key);
        return key;
      },
    });
    const record = await encryptKeys(generateNodeKeys(), PASSWORD, "testnet", deps, FAST_KDF);
    await decryptKeys(record, PASSWORD, deps);
    await rejection(decryptKeys(record, "nope nope nope", deps));
    expect(derivedKeys).toHaveLength(3);
    for (const key of derivedKeys) expect(key.every((b) => b === 0)).toBe(true);
  });

  test("password rules: at least the named minimum, typed twice the same", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(passwordProblem("1234567", "1234567")).toBe("Use at least 8 characters.");
    expect(passwordProblem("", "")).toBe("Use at least 8 characters.");
    expect(passwordProblem("12345678", "12345679")).toBe("The two passwords differ.");
    expect(passwordProblem("12345678", "12345678")).toBeNull();
  });

  test("reads back only well-formed records of this version and network, and drops unknown fields", async () => {
    const record = await encryptKeys(generateNodeKeys(), PASSWORD, "testnet", fastDeps(), FAST_KDF);
    const good = JSON.parse(serializeKeystore({ ...record, nodeId: BOTTLE.nodeId }));
    expect(parseKeystore(JSON.stringify({ ...good, extra: "x", plaintext: "leak" }), "testnet")).toEqual({ ...record, nodeId: BOTTLE.nodeId });
    const bad: [string, unknown][] = [
      ["not json", "{"],
      ["array", []],
      ["version 2", { ...good, version: 2 }],
      ["mainnet record", { ...good, network: "mainnet" }],
      ["other kdf", { ...good, kdf: { ...good.kdf, name: "pbkdf2" } }],
      ["upper-case salt", { ...good, kdf: { ...good.kdf, salt: good.kdf.salt.toUpperCase() } }],
      ["empty salt", { ...good, kdf: { ...good.kdf, salt: "" } }],
      ["logN above the limit", { ...good, kdf: { ...good.kdf, logN: KDF_LIMITS.maxLogN + 1 } }],
      ["r above the limit", { ...good, kdf: { ...good.kdf, r: KDF_LIMITS.maxR + 1 } }],
      ["p above the limit", { ...good, kdf: { ...good.kdf, p: KDF_LIMITS.maxP + 1 } }],
      ["logN zero", { ...good, kdf: { ...good.kdf, logN: 0 } }],
      ["logN fraction", { ...good, kdf: { ...good.kdf, logN: 15.5 } }],
      ["logN string", { ...good, kdf: { ...good.kdf, logN: "16" } }],
      ["other cipher", { ...good, cipher: { ...good.cipher, name: "AES-CBC" } }],
      ["short iv", { ...good, cipher: { ...good.cipher, iv: good.cipher.iv.slice(2) } }],
      ["odd ciphertext", { ...good, ciphertext: good.ciphertext.slice(1) }],
      ["no ciphertext", { ...good, ciphertext: "" }],
      ["numeric node id", { ...good, nodeId: 7 }],
      ["no createdAt", { ...good, createdAt: undefined }],
    ];
    for (const [name, value] of bad) {
      expect(parseKeystore(typeof value === "string" ? value : JSON.stringify(value), "testnet"), name).toBeNull();
    }
    // The cost limits keep a crafted backup from freezing the tab.
    expect(KDF_LIMITS.maxLogN).toBeLessThanOrEqual(20);
  });

  test("names the backup file by network and the start of the node id", async () => {
    const record = await encryptKeys(generateNodeKeys(), PASSWORD, "testnet", fastDeps(), FAST_KDF);
    expect(backupFileName(record)).toBe("ckbolt-fiber-node-testnet.json");
    expect(backupFileName({ ...record, nodeId: BOTTLE.nodeId })).toBe("ckbolt-fiber-node-testnet-02b6d4e3.json");
  });
});

/* -------------------------------------------------------------------------------------------- storage */

test.describe("browser storage", () => {
  test("every key lives under a per-network namespace, and the node's database is per network and per key", () => {
    expect(storageKey("testnet", STORAGE_NAME.KEYSTORE)).toBe("ckbolt:fiber-browser:testnet:keystore");
    expect(storageKey("mainnet", STORAGE_NAME.KEYSTORE)).toBe("ckbolt:fiber-browser:mainnet:keystore");
    expect(nodeLockName("testnet")).toBe("ckbolt:fiber-browser:testnet:node");
    expect(databasePrefix("testnet", "0011223344556677")).toBe("/ckbolt-fiber/testnet/0011223344556677");
    expect(BRIDGE_CHANNEL_NAME).toBe("ckbolt:fiber-browser:bridge");
  });

  test("the repository saves, loads and removes one network's record and never reads another network's", async () => {
    const store = new MapStore();
    const testnet = new KeystoreRepository(store, "testnet", STORAGE_NAME.KEYSTORE);
    const mainnet = new KeystoreRepository(store, "mainnet", STORAGE_NAME.KEYSTORE);
    expect(testnet.load()).toBeNull();
    expect(testnet.hasUnreadable()).toBe(false);
    const record = await encryptKeys(generateNodeKeys(), "password1", "testnet", fastDeps(), FAST_KDF);
    testnet.save(record);
    expect([...store.map.keys()]).toEqual(["ckbolt:fiber-browser:testnet:keystore"]);
    expect(testnet.load()).toEqual(record);
    expect(mainnet.load()).toBeNull();
    // A testnet record copied into the mainnet slot is not readable there.
    store.setItem("ckbolt:fiber-browser:mainnet:keystore", serializeKeystore(record));
    expect(mainnet.load()).toBeNull();
    expect(mainnet.hasUnreadable()).toBe(true);
    testnet.remove();
    expect(testnet.load()).toBeNull();
    store.setItem("ckbolt:fiber-browser:testnet:keystore", "garbage");
    expect(testnet.load()).toBeNull();
    expect(testnet.hasUnreadable()).toBe(true);
  });

  test("web storage is null where the runtime has none", () => {
    // Node has no localStorage or sessionStorage (without --experimental-webstorage).
    if (typeof (globalThis as { localStorage?: unknown }).localStorage === "undefined") expect(webStore("localStorage")).toBeNull();
    if (typeof (globalThis as { sessionStorage?: unknown }).sessionStorage === "undefined") expect(webStore("sessionStorage")).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------ hex, errors */

test.describe("hex and fiber-js errors", () => {
  test("quantities are 0x hex of whole numbers, exact for large amounts", () => {
    expect(toHexQuantity(0)).toBe("0x0");
    expect(toHexQuantity(ckb(500))).toBe("0xba43b7400");
    expect(toHexQuantity(BigInt("123456789012345678901234567890"))).toBe(`0x${BigInt("123456789012345678901234567890").toString(16)}`);
    expect(() => toHexQuantity(BigInt(-1))).toThrow();
    expect(fromHexQuantity("0xba43b7400")).toBe(ckb(500));
    expect(fromHexQuantity("0XFF")).toBe(BigInt(255));
    for (const bad of ["", "0x", "12", "0xzz", null, 5, undefined]) expect(fromHexQuantity(bad)).toBe(BigInt(0));
    expect(strip0x("0xAB")).toBe("AB");
    expect(with0x("ab")).toBe("0xab");
    expect(with0x("0xab")).toBe("0xab");
    expect(normalizeNodeId(` 0x${BOTTLE.nodeId.toUpperCase()} `)).toBe(BOTTLE.nodeId);
  });

  test("reads the message out of fiber-js's error strings, Errors and worker events", () => {
    expect(fiberErrorMessage('ErrorObject { code: ServerError(-32000), message: "Peer not found" }')).toBe("Peer not found");
    expect(fiberErrorMessage('ErrorObject { code: InvalidParams, message: "Invalid \\"pubkey\\" field" }')).toBe('Invalid "pubkey" field');
    expect(fiberErrorMessage(new Error("worker crashed"))).toBe("worker crashed");
    expect(fiberErrorMessage({ message: "from an ErrorEvent" })).toBe("from an ErrorEvent");
    for (const unreadable of [null, undefined, 42, {}, "", "   "]) expect(fiberErrorMessage(unreadable)).toBe("The Fiber node reported an error.");
  });
});

/* ------------------------------------------------------------------------------------- address, peer id */

test.describe("the node's CKB address and peer id", () => {
  test("encodes the funding lock as the full-format address CCC would show, testnet ckt1 by default for the browser node", () => {
    for (const lock of [secpLock(), secpLock(`0x${"00".repeat(20)}`), { ...secpLock(), hashType: "data1" as const }]) {
      const address = scriptToAddress(lock, "testnet");
      expect(address.startsWith("ckt1")).toBe(true);
      expect(address).toBe(ccc.Address.from({ script: lock, prefix: "ckt" }).toString());
      expect(scriptToAddress(lock, "mainnet")).toBe(ccc.Address.from({ script: lock, prefix: "ckb" }).toString());
      const { hrp, words, variant } = decodeBech32(address);
      expect([hrp, variant]).toEqual(["ckt", "bech32m"]);
      expect(bytesToHex(new Uint8Array(fromWords(words)))).toBe(`00${strip0x(lock.codeHash)}${lock.hashType === "type" ? "01" : "02"}${strip0x(lock.args)}`);
    }
    expect(() => scriptToAddress({ ...secpLock(), codeHash: "0x1234" }, "testnet")).toThrow(/32 bytes/);
  });

  test("derives the tentacle peer id of real testnet nodes (bottle, bracer)", () => {
    expect(peerIdOf(BOTTLE.nodeId)).toBe(BOTTLE.peerId);
    expect(peerIdOf(BRACER.nodeId)).toBe(BRACER.peerId);
    expect(peerIdOf(`0x${BRACER.nodeId}`)).toBe(BRACER.peerId);
  });

  test("appends /p2p/<peer id> to a hub address that lacks it, and keeps one that has it", () => {
    expect(withPeerId("/dns4/hub.example.test/tcp/443/wss", BOTTLE.nodeId)).toBe(`/dns4/hub.example.test/tcp/443/wss/p2p/${BOTTLE.peerId}`);
    expect(withPeerId("/dns4/hub.example.test/tcp/443/wss/", BOTTLE.nodeId)).toBe(`/dns4/hub.example.test/tcp/443/wss/p2p/${BOTTLE.peerId}`);
    expect(withPeerId(`/dns4/x/tcp/443/wss/p2p/${BRACER.peerId}`, BOTTLE.nodeId)).toBe(`/dns4/x/tcp/443/wss/p2p/${BRACER.peerId}`);
  });
});

/* ---------------------------------------------------------------------------------------- node config */

test.describe("node config", () => {
  test("reads the CKB RPC and extra bootnodes from the environment, with safe defaults", () => {
    expect(parseBrowserNodeConfig({})).toEqual({ network: "testnet", ckbRpcUrl: CKB_RPC_DEFAULT_URL.testnet, bootnodes: [] });
    expect(CKB_RPC_DEFAULT_URL.testnet).toBe("https://testnet.ckbapp.dev/");
    expect(parseBrowserNodeConfig({ ckbRpcUrl: " https://rpc.example.test/ckb " }).ckbRpcUrl).toBe("https://rpc.example.test/ckb");
    for (const bad of ["ftp://x", "javascript:alert(1)", "not a url", "   "]) {
      expect(parseBrowserNodeConfig({ ckbRpcUrl: bad }).ckbRpcUrl, bad).toBe(CKB_RPC_DEFAULT_URL.testnet);
    }
    expect(parseBrowserNodeConfig({ bootnodes: " /dns4/a/tcp/443/wss , junk,, /dns4/b/tcp/443/wss/p2p/Qm1 " }).bootnodes).toEqual([
      "/dns4/a/tcp/443/wss",
      "/dns4/b/tcp/443/wss/p2p/Qm1",
    ]);
  });

  test("replaces fiber-js 0.9.1's own TCP bootnodes with WebSocket ones and stops announcing, leaving the rest of its testnet config as it is", async () => {
    const { Fiber } = await import("@nervosnetwork/fiber-js");
    // The real bundled config, without starting a node (the constructor would create workers and shared buffers).
    const original = Fiber.prototype.getDefaultConfig.call(Object.create(Fiber.prototype), "testnet", "https://rpc.example.test/");
    expect(original).toContain("bootnode_addrs:");
    expect(original).toMatch(/announce_listening_addr: true/);
    const hub = `/dns4/hub.example.test/tcp/443/wss/p2p/${BOTTLE.peerId}`;
    const edited = browserNodeConfig(original, [hub, "/dns4/thrall.fiber.channel/tcp/443/wss/p2p/Qmes1"]);
    expect(edited).toContain(`  bootnode_addrs:\n    - "${hub}"\n    - "/dns4/thrall.fiber.channel/tcp/443/wss/p2p/Qmes1"\n`);
    expect(edited).not.toContain("/tcp/8228/p2p/Qmes1EBD4yNo9Ywkfe6eRw9tG1nVNGLDmMud1xJMsoYFKy");
    expect(edited).toMatch(/^ {2}announce_listening_addr: false$/m);
    expect(edited).not.toMatch(/announce_listening_addr: true/);
    expect(edited).toContain("chain: testnet");
    expect(edited).toContain("https://rpc.example.test/");
    // Only the bootnode items and the announce flag changed.
    const removed = original.split("\n").filter((line) => !edited.split("\n").includes(line));
    expect(removed.every((line) => /bootnode_addrs|\/tcp\/8228\/p2p\/|announce_listening_addr/.test(line))).toBe(true);
    expect(browserNodeConfig(original, [])).toMatch(/^ {2}bootnode_addrs: \[\]$/m);
  });

  test("handles a config without those keys, an empty list and comments between items", () => {
    expect(browserNodeConfig("", ["/dns4/a/tcp/443/wss"])).toBe("");
    expect(browserNodeConfig("ckb:\n  rpc_url: x\n", ["/dns4/a/tcp/443/wss"])).toBe("ckb:\n  rpc_url: x\n");
    const yaml = 'fiber:\n  bootnode_addrs: []\n  announce_listening_addr: true\nckb:\n  rpc_url: "x"\n';
    expect(browserNodeConfig(yaml, ["/dns4/a/tcp/443/wss"])).toBe(
      'fiber:\n  auto_accept_channel_ckb_funding_amount: 0\n  bootnode_addrs:\n    - "/dns4/a/tcp/443/wss"\n  announce_listening_addr: false\nckb:\n  rpc_url: "x"\n',
    );
    const commented = 'fiber:\n  bootnode_addrs:\n    # first\n    - "/ip4/1.1.1.1/tcp/8228"\n    # second\n    - "/ip4/2.2.2.2/tcp/8228"\n  chain: testnet\n';
    expect(browserNodeConfig(commented, [])).toBe("fiber:\n  auto_accept_channel_ckb_funding_amount: 0\n  bootnode_addrs: []\n  chain: testnet\n");
  });

  test("a blank line between old bootnode items does not leave a TCP bootnode behind", () => {
    // Valid YAML: a blank line inside a sequence. No old item may survive under the new list.
    const spaced = 'fiber:\n  bootnode_addrs:\n    - "/ip4/1.1.1.1/tcp/8228"\n\n    - "/ip4/2.2.2.2/tcp/8228"\n  chain: testnet\n';
    const edited = browserNodeConfig(spaced, ["/dns4/a/tcp/443/wss"]);
    expect(edited).not.toContain("/ip4/1.1.1.1");
    expect(edited).not.toContain("/ip4/2.2.2.2");
    expect(edited).toContain('  bootnode_addrs:\n    - "/dns4/a/tcp/443/wss"\n');
    expect(edited).toContain("  chain: testnet");
  });

  test("turns fnn's automatic accept of CKB channels off in the fiber section of fiber-js 0.9.1's real testnet config, once", async () => {
    const { Fiber } = await import("@nervosnetwork/fiber-js");
    const original = Fiber.prototype.getDefaultConfig.call(Object.create(Fiber.prototype), "testnet", "https://rpc.example.test/");
    // fiber-js leaves it to fnn's default, the 99 CKB reserve: fnn would accept the hub's CKB channel by itself.
    expect(original).not.toContain("auto_accept_channel_ckb_funding_amount");
    expect(NODE_AUTO_ACCEPT_CKB_FUNDING_SHANNONS).toBe(BigInt(0));
    // By default: 0, which fnn v0.9.1 reads as "never auto-accept a CKB channel"; the app accepts the hub's itself.
    const edited = browserNodeConfig(original, []);
    expect(edited).toMatch(/^fiber:\n {2}auto_accept_channel_ckb_funding_amount: 0$/m);
    expect(edited.match(/auto_accept_channel_ckb_funding_amount/g)).toHaveLength(1);
    // A value already there (a config from an older page) is replaced, not doubled.
    const old = browserNodeConfig(original, [], ckbToShannons(NODE_CHANNEL_CONTRIBUTION_CKB));
    expect(old).toMatch(/^ {2}auto_accept_channel_ckb_funding_amount: 120000000000$/m);
    const again = browserNodeConfig(old, []);
    expect(again).toMatch(/^ {2}auto_accept_channel_ckb_funding_amount: 0$/m);
    expect(again.match(/auto_accept_channel_ckb_funding_amount/g)).toHaveLength(1);
    // null leaves the key as fiber-js has it.
    expect(browserNodeConfig(original, [], null)).not.toContain("auto_accept_channel_ckb_funding_amount");
  });

  test("the node asks for a channel only when it can accept it: its contribution or the RUSD reserve, plus the fee margin", () => {
    expect(NODE_CHANNEL_CONTRIBUTION_CKB).toBeGreaterThan(CHANNEL_RESERVE_CKB.CKB);
    expect(MIN_CHANNEL_CONTRIBUTION_CKB).toBeGreaterThan(CHANNEL_RESERVE_CKB.CKB);
    expect(ckbNeededToAccept("CKB", NODE_CHANNEL_CONTRIBUTION_CKB)).toBe(NODE_CHANNEL_CONTRIBUTION_CKB + 1);
    expect(ckbNeededToAccept("CKB", 49_000)).toBe(49_001);
    // A token channel takes only its CKB reserve from the node, whatever the CKB contribution.
    expect(ckbNeededToAccept("RUSD", 49_000)).toBe(CHANNEL_RESERVE_CKB.UDT + 1);
    expect(spendableContribution(1_200)).toBe(1_101);
    expect(spendableContribution(49_000)).toBe(48_901);
  });

  test("a new channel from the hub: send the node's share less its reserve, receive the hub's less the hub's reserve", () => {
    // 5,000 CKB from the hub, 1,200 CKB from the node: 99 CKB of each side stays as its reserve.
    expect(newChannelCapacity("CKB", ckbToShannons(5_000), 1_200)).toEqual({ send: ckbToShannons(1_101), receive: ckbToShannons(4_901) });
    expect(newChannelCapacity("CKB", ckbToShannons(1_000), 49_000)).toEqual({ send: ckbToShannons(48_901), receive: ckbToShannons(901) });
    // Nothing below zero, whatever the hub offers.
    expect(newChannelCapacity("CKB", ckbToShannons(50), 1_200).receive).toBe(BigInt(0));
    // A token channel's reserves are CKB: the node sends none of the token at first and receives all the hub puts in.
    expect(newChannelCapacity("RUSD", BigInt(2_000_000_000), 1_200)).toEqual({ send: BigInt(0), receive: BigInt(2_000_000_000) });
  });

  test("the contribution the visitor types: whole CKB from the minimum up, with or without group separators", () => {
    expect(parseContribution("49000")).toBe(49_000);
    expect(parseContribution("49,000")).toBe(49_000);
    expect(parseContribution(" 49 000 ")).toBe(49_000);
    expect(parseContribution(String(MIN_CHANNEL_CONTRIBUTION_CKB))).toBe(MIN_CHANNEL_CONTRIBUTION_CKB);
    for (const bad of ["", "abc", "1200.5", "-1200", String(MIN_CHANNEL_CONTRIBUTION_CKB - 1), "1e5", "99999999999999999999"]) {
      expect(parseContribution(bad), bad).toBeNull();
    }
  });

  test("the contribution is saved per network and falls back to the default when missing, invalid or blocked", () => {
    const store = new MapStore();
    expect(readContribution(store, "testnet")).toBe(NODE_CHANNEL_CONTRIBUTION_CKB);
    saveContribution(store, "testnet", 49_000);
    expect(readContribution(store, "testnet")).toBe(49_000);
    expect(store.getItem("ckbolt:fiber-browser:testnet:channel-contribution")).toBe("49000");
    expect(readContribution(store, "mainnet")).toBe(NODE_CHANNEL_CONTRIBUTION_CKB);
    store.setItem("ckbolt:fiber-browser:testnet:channel-contribution", "12");
    expect(readContribution(store, "testnet")).toBe(NODE_CHANNEL_CONTRIBUTION_CKB);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => undefined };
    expect(readContribution(blocked, "testnet")).toBe(NODE_CHANNEL_CONTRIBUTION_CKB);
    expect(() => saveContribution(blocked, "testnet", 5_000)).not.toThrow();
    expect(readContribution(null, "testnet")).toBe(NODE_CHANNEL_CONTRIBUTION_CKB);
  });

  test("the amount for the hub's CKB channel is checked before the hub is asked: whole CKB from the minimum, within what the node holds", () => {
    const rich = ckbToShannons(1_300);
    expect(planHubContribution("1,200", rich)).toEqual({ ok: true, ckb: 1_200, shannons: ckbToShannons(1_200) });
    expect(planHubContribution("1299", rich)).toEqual({ ok: true, ckb: 1_299, shannons: ckbToShannons(1_299) });
    // The reserve is inside the amount: below the minimum (the 99 CKB reserve and about a hundred) is refused.
    expect(MIN_CHANNEL_CONTRIBUTION_CKB).toBeGreaterThan(CHANNEL_RESERVE_CKB.CKB);
    for (const bad of ["", "abc", "150", "1200.5", "-5"]) expect(planHubContribution(bad, rich), bad).toEqual({ ok: false, error: "Whole CKB, at least 200." });
    expect(planHubContribution("1200", null)).toEqual({ ok: false, error: "Wait until the node has read its CKB balance." });
    // The fee margin stays on chain: 1,300 CKB lets the node put in 1,299 at most.
    expect(planHubContribution("1300", rich)).toEqual({ ok: false, error: "Your node can put in at most 1,299 CKB now." });
    expect(planHubContribution("49000", ckbToShannons(100))).toEqual({ ok: false, error: "Fund the node with at least 49,001 CKB first." });
    for (const plan of [planHubContribution("abc", rich), planHubContribution("1300", rich), planHubContribution("500", BigInt(0))]) {
      if (plan.ok) throw new Error("expected a refusal");
      expect(plan.error).not.toContain("\n");
    }
  });

  test("accepting the hub's channel waits for its open to arrive, with a bounded backoff, and stops at any other refusal", async () => {
    const notFound = 'ErrorObject { code: ServerError(-32000), message: "No channel with temp id Hash256(0xabc) found" }';
    expect(isChannelNotArrived(notFound)).toBe(true);
    expect(isChannelNotArrived(new Error("Peer not found"))).toBe(false);
    const slept: number[] = [];
    const deps = { delaysMs: [10, 20, 40], sleep: async (ms: number) => void slept.push(ms) };
    const node = (answers: unknown[]) => {
      const seen: { temporaryChannelId: string; fundingAmount: bigint }[] = [];
      return {
        seen,
        acceptChannel: async (args: { temporaryChannelId: string; fundingAmount: bigint }) => {
          seen.push(args);
          const next = answers.shift();
          if (next !== undefined) throw next;
          return { channelId: "0xfinal" };
        },
      };
    };
    // The hub's open_channel reaches the node after two tries.
    const late = node([notFound, notFound]);
    expect(await acceptHubChannel(late, { temporaryChannelId: "0xabc", fundingAmount: ckb(1_200) }, deps)).toEqual({ channelId: "0xfinal" });
    expect(late.seen).toEqual(Array(3).fill({ temporaryChannelId: "0xabc", fundingAmount: ckb(1_200) }));
    expect(slept).toEqual([10, 20]);
    // Never: every delay is used once, then the visitor is told.
    slept.length = 0;
    const never = node([notFound, notFound, notFound, notFound, notFound]);
    await expect(acceptHubChannel(never, { temporaryChannelId: "0xabc", fundingAmount: ckb(200) }, deps)).rejects.toThrow(HUB_ACCEPT_MESSAGE.NOT_ARRIVED);
    // The hub refuses a new request (409) until it abandons its open after 10 minutes: the line says when, in 12 words or fewer.
    expect(HUB_ACCEPT_MESSAGE.NOT_ARRIVED).toBe("The hub's channel did not arrive. Try again in 10 minutes.");
    expect(HUB_ACCEPT_MESSAGE.NOT_ARRIVED.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(never.seen).toHaveLength(4);
    expect(slept).toEqual([10, 20, 40]);
    // Any other refusal: at once, with fnn's reason, in one line.
    slept.length = 0;
    const refused = node(['ErrorObject { code: ServerError(-32000), message: "The funding amount should be greater than the reserved amount" }']);
    await expect(acceptHubChannel(refused, { temporaryChannelId: "0xabc", fundingAmount: ckb(200) }, deps)).rejects.toThrow(
      "Your node could not accept the hub's channel: The funding amount should be greater than the reserved amount",
    );
    expect(slept).toEqual([]);
    // The real schedule is bounded: about 20 seconds in all.
    const total = HUB_ACCEPT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(10_000);
    expect(total).toBeLessThanOrEqual(30_000);
  });

  test("asking the hub for a CKB channel: the amount is checked first, then the node accepts the hub's temporary id with it", async () => {
    const opened: unknown[] = [];
    const client = {
      requestInboundChannel: async (body: { nodeId: string; asset: "CKB" | "RUSD" }) => {
        opened.push(body);
        return { nodeId: body.nodeId, asset: body.asset, fundingAmount: body.asset === "CKB" ? "100000000000" : "2000000000", temporaryChannelId: "0xtemp" };
      },
    };
    const accepted: unknown[] = [];
    const node = { acceptChannel: async (args: unknown) => (accepted.push(args), { channelId: "0xfinal" }) };
    const format = (asset: string, amount: string) => `${BigInt(amount) / BigInt(100_000_000)} ${asset}`;
    const history = { channels: [], assetOf: () => null };
    const ids = { nodeId: BOTTLE.nodeId, hubNodeId: HUB_NODE.nodeId };
    const deps = { delaysMs: [], sleep: async () => undefined };

    const result = await requestHubChannel(client, node, ids, "CKB", { text: "49,000", balance: ckbToShannons(50_000) }, format, history, deps);
    expect(opened).toEqual([{ nodeId: BOTTLE.nodeId, asset: "CKB" }]);
    expect(accepted).toEqual([{ temporaryChannelId: "0xtemp", fundingAmount: ckbToShannons(49_000) }]);
    expect(result.message).toBe("The hub is opening a channel of 1000 CKB to your node, and your node put in 49000 CKB. It reads Ready after a few confirmations.");
    expect(result.entry).toMatchObject({ id: "0xtemp", kind: "channel", asset: "CKB", amount: "100000000000" });

    // Too much, or no balance yet: the hub is never asked, so no open waits at the hub for an accept that cannot come.
    await expect(requestHubChannel(client, node, ids, "CKB", { text: "50000", balance: ckbToShannons(50_000) }, format, history, deps)).rejects.toThrow(
      "Your node can put in at most 49,999 CKB now.",
    );
    await expect(requestHubChannel(client, node, ids, "CKB", { text: "1200", balance: null }, format, history, deps)).rejects.toThrow("Wait until");
    await expect(requestHubChannel(client, null, ids, "CKB", { text: "1200", balance: ckbToShannons(5_000) }, format, history, deps)).rejects.toThrow("Start the node first.");
    expect(opened).toHaveLength(1);

    // A token channel: fnn accepts it by its UDT whitelist with nothing from the node, so no accept_channel and no CKB check.
    const rusd = await requestHubChannel(client, node, ids, "RUSD", { text: "", balance: null }, format, history, deps);
    expect(rusd.message).toBe("The hub is opening a channel of 20 RUSD to your node. It reads Ready after a few confirmations.");
    expect(accepted).toHaveLength(1);

    // The hub's open never reaches the node: one line, and nothing is recorded.
    const lost = { acceptChannel: async () => Promise.reject('ErrorObject { code: ServerError(-32000), message: "No channel with temp id 0xtemp found" }') };
    await expect(requestHubChannel(client, lost, ids, "CKB", { text: "1200", balance: ckbToShannons(5_000) }, format, history, deps)).rejects.toThrow(
      HUB_ACCEPT_MESSAGE.NOT_ARRIVED,
    );
  });

  test("nothing about a restart is left in the hub panel's copy for the CKB channel; only a token the node started without asks for one", () => {
    // The CKB amount is per request (accept_channel): no restart. fnn reads its token whitelist only at start, so the one
    // line that asks for a restart names the tokens a node started before the hub served them (and its row says so).
    const strings = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : typeof value === "function"
          ? strings((value as (...a: unknown[]) => unknown)("1", "2", "3"))
          : Array.isArray(value)
            ? value.flatMap(strings)
            : typeof value === "object" && value !== null
              ? Object.values(value).flatMap(strings)
              : [];
    expect(Object.keys(HUB_PANEL_COPY).filter((key) => /RESTART|WAIT_PAYMENTS/.test(key))).toEqual(["RESTART"]);
    for (const [key, value] of Object.entries(HUB_PANEL_COPY)) {
      if (key === "RESTART" || key === "LOCK" || key === "LOCK_BUSY") continue;
      const texts = key === "STATUS" ? strings({ ...HUB_PANEL_COPY.STATUS, restart: "" }) : strings(value);
      for (const text of texts) expect(text, key).not.toMatch(/restart/i);
    }
    expect(HUB_PANEL_COPY.STATUS.restart).toBe("Restart needed");
    expect(HUB_PANEL_COPY.RESTART("cWBTC")).toBe("Restart your node to accept cWBTC channels: lock it, then unlock.");
  });

  test("Max puts in all the node holds but the fee margin, in whole CKB", () => {
    expect(largestContribution(ckbToShannons(50_000))).toBe(49_999);
    expect(largestContribution(ckbToShannons(50_000) + BigInt(99_999_999))).toBe(49_999);
    expect(largestContribution(BigInt(0))).toBe(0);
  });

  test("a page dials only WebSocket addresses, and only TLS ones from an https page", () => {
    const all = ["/ip4/1.2.3.4/tcp/8228", "/ip4/1.2.3.4/tcp/8229/ws", "/dns4/h/tcp/443/wss", "/dns4/h/tcp/443/tls/sni/h/ws", "/dns4/h/tcp/443/wss/p2p/Qm1"];
    expect(dialableAddresses(all, false)).toEqual(all.slice(1));
    expect(dialableAddresses(all, true)).toEqual(["/dns4/h/tcp/443/wss", "/dns4/h/tcp/443/tls/sni/h/ws", "/dns4/h/tcp/443/wss/p2p/Qm1"]);
    expect(needsTlsPeers({ protocol: "https:" })).toBe(true);
    expect(needsTlsPeers({ protocol: "http:" })).toBe(false);
  });
});

/* --------------------------------------------------------------------------------------- test hook */

test.describe("test hook", () => {
  test("is the documented window global, as an object or a function called per start", () => {
    expect(TEST_FIBER_NODE_GLOBAL).toBe("__ckboltTestFiberNode");
    const fake: FiberLike = { start: async () => {}, invokeCommand: async () => null, stop: async () => {} };
    expect(installedTestNode(undefined)).toBeNull();
    expect(installedTestNode({})).toBeNull();
    expect(installedTestNode({ [TEST_FIBER_NODE_GLOBAL]: fake } as Partial<Window>)).toBe(fake);
    let made = 0;
    const factory = () => (made++, fake);
    expect(installedTestNode({ [TEST_FIBER_NODE_GLOBAL]: factory } as Partial<Window>)).toBe(fake);
    expect(made).toBe(1);
  });

  test("the node loader uses it only in a build made for tests (NEXT_PUBLIC_CKBOLT_TEST_HOOKS=1)", async () => {
    const fake: FiberLike = { start: async () => {}, invokeCommand: async () => null, stop: async () => {} };
    const before = process.env.NEXT_PUBLIC_CKBOLT_TEST_HOOKS;
    try {
      process.env.NEXT_PUBLIC_CKBOLT_TEST_HOOKS = "1";
      expect(await loadFiber({ [TEST_FIBER_NODE_GLOBAL]: fake } as Partial<Window>)).toBe(fake);
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_CKBOLT_TEST_HOOKS;
      else process.env.NEXT_PUBLIC_CKBOLT_TEST_HOOKS = before;
    }
  });
});

/* ------------------------------------------------------------------------------------ fiber-js adapter */

/** A fiber-js stand-in that records `invokeCommand` calls and answers from a table. */
function recordingFiber(answers: Record<string, unknown | ((params: unknown) => unknown)> = {}) {
  const calls: { name: string; args: unknown[] | undefined }[] = [];
  const fiber: FiberLike = {
    start: async () => {},
    stop: async () => {},
    invokeCommand: async (name, args) => {
      calls.push({ name, args });
      const answer = answers[name];
      if (answer === undefined) throw `ErrorObject { code: MethodNotFound, message: "${name} is not a function" }`;
      return typeof answer === "function" ? (answer as (p: unknown) => unknown)(args?.[0]) : answer;
    },
  };
  return { fiber, calls };
}

test.describe("fiber-js adapter", () => {
  test("node_info: the node id in the hub's form, and the funding lock as a contract Script", async () => {
    const { fiber, calls } = recordingFiber({
      node_info: { version: "0.9.1", pubkey: `0x${BOTTLE.nodeId.toUpperCase()}`, default_funding_lock_script: { code_hash: SECP_CODE_HASH, hash_type: "type", args: "0xab" } },
    });
    expect(await new FiberJsNode(fiber).info()).toEqual({ nodeId: BOTTLE.nodeId, version: "0.9.1", fundingLockScript: { codeHash: SECP_CODE_HASH, hashType: "type", args: "0xab" } });
    expect(calls).toEqual([{ name: "node_info", args: [] }]);
  });

  test("an unreadable answer is a node error, not a crash later", async () => {
    for (const answer of [null, "x", 5]) {
      const { fiber } = recordingFiber({ node_info: answer, list_channels: answer });
      await expect(new FiberJsNode(fiber).info()).rejects.toThrow("unreadable answer to node_info");
      await expect(new FiberJsNode(fiber).listChannels()).rejects.toThrow("unreadable answer to list_channels");
    }
    const { fiber } = recordingFiber({ node_info: { version: "0.9.1", pubkey: BOTTLE.nodeId } });
    await expect(new FiberJsNode(fiber).info()).rejects.toThrow(/funding lock/);
  });

  test("open_channel to the hub: its pubkey, the exact funding in shannons as hex, private", async () => {
    const { fiber, calls } = recordingFiber({ open_channel: { temporary_channel_id: "0xtemp" } });
    const result = await new FiberJsNode(fiber).openChannel({ peerId: BOTTLE.nodeId, fundingAmount: ckb(500), isPublic: false });
    expect(result).toEqual({ temporaryChannelId: "0xtemp" });
    expect(calls).toEqual([{ name: "open_channel", args: [{ pubkey: BOTTLE.nodeId, funding_amount: "0xba43b7400", public: false }] }]);
  });

  test("accept_channel: the hub's temporary id, the node's funding in shannons as hex, and the node's own lock unless a shutdown script is given", async () => {
    const { fiber, calls } = recordingFiber({ accept_channel: { channel_id: "0xfinal" } });
    const node = new FiberJsNode(fiber);
    expect(await node.acceptChannel({ temporaryChannelId: "0xabc", fundingAmount: ckb(1_200) })).toEqual({ channelId: "0xfinal" });
    await node.acceptChannel({ temporaryChannelId: "abc", fundingAmount: ckb(200), shutdownScript: secpLock() });
    expect(calls).toEqual([
      { name: "accept_channel", args: [{ temporary_channel_id: "0xabc", funding_amount: "0x1bf08eb000" }] },
      {
        name: "accept_channel",
        args: [
          {
            temporary_channel_id: "0xabc",
            funding_amount: "0x4a817c800",
            shutdown_script: { code_hash: secpLock().codeHash, hash_type: secpLock().hashType, args: secpLock().args },
          },
        ],
      },
    ]);
    const { fiber: bad } = recordingFiber({ accept_channel: null });
    await expect(new FiberJsNode(bad).acceptChannel({ temporaryChannelId: "0x1", fundingAmount: ckb(200) })).rejects.toThrow("unreadable answer to accept_channel");
  });

  test("list_channels: balances as exact bigints, the peer normalized, UDT scripts mapped", async () => {
    const { fiber } = recordingFiber({
      list_channels: {
        channels: [
          {
            channel_id: "0x01",
            is_public: false,
            pubkey: `0x${BOTTLE.nodeId}`,
            funding_udt_type_script: null,
            state: { state_name: "ChannelReady" },
            local_balance: "0x9502f9000",
            remote_balance: "0x0",
            enabled: true,
          },
          {
            channel_id: "0x02",
            is_public: true,
            pubkey: BRACER.nodeId,
            funding_udt_type_script: { code_hash: RUSD_SCRIPT.codeHash, hash_type: "type", args: RUSD_SCRIPT.args },
            state: { state_name: "AwaitingChannelReady" },
            local_balance: "0xffffffffffffffffffffffff",
            remote_balance: "garbage",
            enabled: false,
          },
        ],
      },
    });
    const channels = await new FiberJsNode(fiber).listChannels();
    expect(channels).toEqual([
      { channelId: "0x01", peerId: BOTTLE.nodeId, udtTypeScript: null, state: "ChannelReady", isPublic: false, enabled: true, localBalance: ckb(400), remoteBalance: BigInt(0) },
      {
        channelId: "0x02",
        peerId: BRACER.nodeId,
        udtTypeScript: RUSD_SCRIPT,
        state: "AwaitingChannelReady",
        isPublic: true,
        enabled: false,
        localBalance: BigInt("0xffffffffffffffffffffffff"),
        remoteBalance: BigInt(0),
      },
    ]);
  });

  test("new_invoice always asks for sha256, with the exact amount, the preimage and expiry as hex, and the UDT script", async () => {
    const { fiber, calls } = recordingFiber({ new_invoice: { invoice_address: "fibt1abc", invoice: { data: { payment_hash: "0xhash" } } } });
    const node = new FiberJsNode(fiber);
    const preimage = `0x${"07".repeat(32)}`;
    expect(await node.newInvoice({ amount: BigInt("1980000000000"), currency: "Fibt", preimage, expirySeconds: 3750, description: "d", udtTypeScript: null })).toEqual({
      invoice: "fibt1abc",
      paymentHash: "0xhash",
    });
    await node.newInvoice({ amount: BigInt(3_960_000_000), currency: "Fibt", preimage: "07".repeat(32), expirySeconds: 60, description: "d", udtTypeScript: RUSD_SCRIPT });
    expect(calls.map((c) => c.args?.[0])).toEqual([
      { amount: "0x1cd01325800", currency: "Fibt", payment_preimage: preimage, expiry: "0xea6", description: "d", hash_algorithm: "sha256" },
      {
        amount: "0xec08ce00",
        currency: "Fibt",
        payment_preimage: preimage,
        expiry: "0x3c",
        description: "d",
        hash_algorithm: "sha256",
        udt_type_script: { code_hash: RUSD_SCRIPT.codeHash, hash_type: "type", args: RUSD_SCRIPT.args },
      },
    ]);
  });

  test("get_invoice, send_payment and get_payment: 0x hashes, the invoice alone, statuses and errors passed on", async () => {
    const { fiber, calls } = recordingFiber({
      get_invoice: { invoice_address: "fibt1", invoice: { data: { payment_hash: "0xaa" } }, status: "Received" },
      send_payment: { payment_hash: "0xbb", status: "Inflight", fee: "0x10" },
      get_payment: { payment_hash: "0xbb", status: "Failed", failed_error: "no route", fee: "0x0" },
    });
    const node = new FiberJsNode(fiber);
    expect(await node.getInvoiceStatus("aa")).toBe("Received");
    expect(await node.sendPayment("fibt1hold")).toEqual({ paymentHash: "0xbb", status: "Inflight", failedError: null, fee: BigInt(16) });
    expect(await node.getPayment("0xbb")).toEqual({ paymentHash: "0xbb", status: "Failed", failedError: "no route", fee: BigInt(0) });
    expect(calls.map((c) => [c.name, c.args?.[0]])).toEqual([
      ["get_invoice", { payment_hash: "0xaa" }],
      ["send_payment", { invoice: "fibt1hold" }],
      ["get_payment", { payment_hash: "0xbb" }],
    ]);
    const { fiber: failing } = recordingFiber({});
    await expect(new FiberJsNode(failing).sendPayment("fibt1")).rejects.toMatch(/send_payment is not a function/);
  });

  test("cancel_invoice: the 0x hash alone, and the status fnn answers with; fnn's refusal is passed on", async () => {
    const { fiber, calls } = recordingFiber({ cancel_invoice: { invoice_address: "fibt1", invoice: { data: { payment_hash: "0xaa" } }, status: "Cancelled" } });
    expect(await new FiberJsNode(fiber).cancelInvoice("aa")).toBe("Cancelled");
    expect(calls.map((c) => [c.name, c.args?.[0]])).toEqual([["cancel_invoice", { payment_hash: "0xaa" }]]);
    const { fiber: refusing } = recordingFiber({
      cancel_invoice: () => {
        throw new Error("Invoice already paid");
      },
    });
    await expect(new FiberJsNode(refusing).cancelInvoice("0xaa")).rejects.toThrow("Invoice already paid");
  });
});

/* --------------------------------------------------------------------------------- node controller, lock */

/** A Web Locks stand-in with `ifAvailable` semantics and `query`. */
class FakeLocks implements LockManagerLike {
  readonly held = new Set<string>();
  async request(name: string, _options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void> | void) {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
  async query() {
    return { held: [...this.held].map((name) => ({ name })) };
  }
}

function controllerHarness(opts: { lockHeld?: boolean; startError?: unknown; loadError?: unknown; noLocks?: boolean } = {}) {
  const locks = new FakeLocks();
  if (opts.lockHeld) locks.held.add(nodeLockName("testnet"));
  const log: string[] = [];
  const starts: { config: string; fiberKey: string; ckbKey: string; chainSpec?: string; logLevel?: string; dbPrefix?: string; refs: Uint8Array[] }[] = [];
  const fiber: FiberLike = {
    getDefaultConfig: (network, url) => {
      log.push(`config ${network} ${url}`);
      return 'fiber:\n  bootnode_addrs:\n    - "/ip4/9.9.9.9/tcp/8228/p2p/QmOld"\n  announce_listening_addr: true\nckb:\n  rpc_url: "' + url + '"\n';
    },
    start: async (config, fiberKey, ckbKey, chainSpec, logLevel, dbPrefix) => {
      starts.push({ config, fiberKey: bytesToHex(fiberKey), ckbKey: bytesToHex(ckbKey!), chainSpec, logLevel, dbPrefix, refs: [fiberKey, ckbKey!] });
      if (opts.startError !== undefined) throw opts.startError;
    },
    invokeCommand: async (name) => {
      if (name === "node_info") return { version: "0.9.1", pubkey: BOTTLE.nodeId, default_funding_lock_script: { code_hash: SECP_CODE_HASH, hash_type: "type", args: "0x01" } };
      throw new Error(`unexpected ${name}`);
    },
    stop: async () => {
      log.push("stop");
    },
  };
  const controller = new BrowserNodeController({
    config: { network: "testnet", ckbRpcUrl: "https://rpc.example.test/", bootnodes: [] },
    load: async () => {
      log.push("load");
      if (opts.loadError !== undefined) throw opts.loadError;
      return fiber;
    },
    lock: (name) => acquireNodeLock(name, opts.noLocks ? null : locks),
  });
  const states: NodeState["phase"][] = [];
  controller.subscribe(() => states.push(controller.getState().phase));
  return { controller, locks, log, starts, states };
}

test.describe("node controller and the single-tab lock", () => {
  test("starts under the lock with the edited config, the keys, info logs and a per-key database, then wipes the keys", async () => {
    const h = controllerHarness();
    const keys = generateNodeKeys();
    const fiberHex = bytesToHex(keys.fiberKey);
    const ckbHex = bytesToHex(keys.ckbKey);
    const tag = keyTag(keys);
    const hubAddress = `/dns4/hub.example.test/tcp/443/wss/p2p/${BOTTLE.peerId}`;
    expect(h.controller.getState()).toEqual({ phase: "locked", info: null, error: null, exclusive: true, udts: null });
    expect(await h.controller.start(keys, [hubAddress])).toBe(true);
    expect(h.states).toEqual(["starting", "running"]);
    expect(h.controller.getState()).toMatchObject({
      phase: "running",
      error: null,
      exclusive: true,
      info: { nodeId: BOTTLE.nodeId, version: "0.9.1" },
    });
    expect(h.locks.held.has("ckbolt:fiber-browser:testnet:node")).toBe(true);
    expect(h.log).toEqual(["load", "config testnet https://rpc.example.test/"]);
    const start = h.starts[0];
    expect(start).toMatchObject({ fiberKey: fiberHex, ckbKey: ckbHex, chainSpec: undefined, logLevel: "info", dbPrefix: `/ckbolt-fiber/testnet/${tag}` });
    expect(start.config).toContain(`bootnode_addrs:\n    - "${hubAddress}"`);
    expect(start.config).not.toContain("QmOld");
    expect(start.config).toContain("announce_listening_addr: false");
    // CKB channels wait for the app's accept_channel, with the amount chosen per request: no restart ever changes it.
    expect(start.config).toContain("auto_accept_channel_ckb_funding_amount: 0\n");
    // fiber-js had its copy; ours are zero now, including the arrays fiber-js was handed.
    expect(keys.fiberKey.every((b) => b === 0) && keys.ckbKey.every((b) => b === 0)).toBe(true);
    expect(h.controller.node).not.toBeNull();

    await h.controller.stop();
    expect(h.log.at(-1)).toBe("stop");
    expect(h.locks.held.size).toBe(0);
    expect(h.controller.getState()).toMatchObject({ phase: "locked" });
    expect(h.controller.node).toBeNull();
  });

  test("every start builds the config afresh with automatic CKB accept off, so a node from before picks it up at its next start", async () => {
    const h = controllerHarness();
    expect(await h.controller.start(generateNodeKeys(), [])).toBe(true);
    await h.controller.stop();
    expect(await h.controller.start(generateNodeKeys(), [])).toBe(true);
    expect(h.starts).toHaveLength(2);
    for (const start of h.starts) expect(start.config.match(/auto_accept_channel_ckb_funding_amount: 0$/gm)).toHaveLength(1);
  });

  test("another tab holding the lock: the page says so, never loads fiber-js, and still wipes the keys", async () => {
    const h = controllerHarness({ lockHeld: true });
    const keys = generateNodeKeys();
    expect(await h.controller.start(keys, [])).toBe(false);
    expect(h.controller.getState().phase).toBe("other-tab");
    expect(h.log).toEqual([]);
    expect(h.starts).toEqual([]);
    expect(keys.fiberKey.every((b) => b === 0)).toBe(true);
    expect(await isNodeLockHeld(nodeLockName("testnet"), h.locks)).toBe(true);
  });

  test("a start that fails reports fiber-js's message, stops the workers and frees the lock for a retry", async () => {
    const h = controllerHarness({ startError: 'ErrorObject { code: ServerError(-32000), message: "Failed to load contract cell deps" }' });
    const keys = generateNodeKeys();
    expect(await h.controller.start(keys, [])).toBe(false);
    expect(h.controller.getState()).toEqual({ phase: "failed", info: null, error: "Failed to load contract cell deps", exclusive: true, udts: null });
    expect(h.log).toContain("stop");
    expect(h.locks.held.size).toBe(0);
    expect(keys.ckbKey.every((b) => b === 0)).toBe(true);

    const load = controllerHarness({ loadError: new Error("Could not load the 15 MB bundle") });
    expect(await load.controller.start(generateNodeKeys(), [])).toBe(false);
    expect(load.controller.getState()).toMatchObject({ phase: "failed", error: "Could not load the 15 MB bundle" });
    expect(load.locks.held.size).toBe(0);
  });

  test("a second start while running is a no-op that wipes the extra keys", async () => {
    const h = controllerHarness();
    await h.controller.start(generateNodeKeys(), []);
    const extra = generateNodeKeys();
    expect(await h.controller.start(extra, [])).toBe(true);
    expect(h.starts).toHaveLength(1);
    expect(extra.fiberKey.every((b) => b === 0)).toBe(true);
  });

  test("without Web Locks the node runs, marked not exclusive", async () => {
    const h = controllerHarness({ noLocks: true });
    expect(await h.controller.start(generateNodeKeys(), [])).toBe(true);
    expect(h.controller.getState()).toMatchObject({ phase: "running", exclusive: false });
  });

  test("the lock is exclusive across holders and free again after release", async () => {
    const locks = new FakeLocks();
    const first = (await acquireNodeLock("n", locks)) as NodeLockHandle;
    expect(first.exclusive).toBe(true);
    expect(await acquireNodeLock("n", locks)).toBeNull();
    expect(await isNodeLockHeld("n", locks)).toBe(true);
    expect(await isNodeLockHeld("other", locks)).toBe(false);
    first.release();
    await expect.poll(() => locks.held.size).toBe(0);
    expect(await acquireNodeLock("n", locks)).not.toBeNull();
    expect(await isNodeLockHeld("n", null)).toBe(false);
    expect(await isNodeLockHeld("n", { request: locks.request.bind(locks), query: async () => Promise.reject(new Error("x")) })).toBe(false);
  });
});

/* ----------------------------------------------------------------------------------------------- isolation */

test.describe("cross-origin isolation", () => {
  const isolated = { crossOriginIsolated: true, isSecureContext: true, SharedArrayBuffer: ArrayBuffer, BroadcastChannel: class {}, navigator: { locks: {} } };

  test("the node runs only on an isolated, secure page with shared memory", () => {
    expect(checkIsolation(isolated)).toEqual({ isolated: true, sharedMemory: true, secureContext: true, webLocks: true, bridge: true });
    expect(canRunNode(checkIsolation(isolated))).toBe(true);
    expect(canRunNode(checkIsolation({ ...isolated, crossOriginIsolated: false }))).toBe(false);
    expect(canRunNode(checkIsolation({ ...isolated, SharedArrayBuffer: undefined }))).toBe(false);
    expect(canRunNode(checkIsolation({ ...isolated, isSecureContext: false }))).toBe(false);
    expect(checkIsolation({})).toEqual({ isolated: false, sharedMemory: false, secureContext: false, webLocks: false, bridge: false });
  });

  test("reloads once per tab to pick up the page's headers, never in a loop", () => {
    const session = new MapStore();
    const key = storageKey("testnet", STORAGE_NAME.ISOLATION_RELOAD);
    const plain = checkIsolation({ ...isolated, crossOriginIsolated: false, SharedArrayBuffer: undefined });
    expect(reloadOnceForIsolation(plain, session, key)).toBe(true);
    expect(session.getItem(key)).not.toBeNull();
    expect(reloadOnceForIsolation(plain, session, key)).toBe(false);
    // Isolated: the mark goes, so a later un-isolated arrival may reload once again.
    expect(reloadOnceForIsolation(checkIsolation(isolated), session, key)).toBe(false);
    expect(session.getItem(key)).toBeNull();
    expect(reloadOnceForIsolation(plain, session, key)).toBe(true);
    // No reload on an insecure page (it cannot be isolated) or without session storage.
    expect(reloadOnceForIsolation(checkIsolation({ ...isolated, crossOriginIsolated: false, isSecureContext: false }), new MapStore(), key)).toBe(false);
    expect(reloadOnceForIsolation(plain, null, key)).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------- links, funding page */

test.describe("links to the node page and its funding page", () => {
  const TESTNET_ADDRESS = scriptToAddress(secpLock(), "testnet");
  const MAINNET_ADDRESS = scriptToAddress(secpLock(), "mainnet");

  test("the node page, and the funding page for the node's address", () => {
    expect(fiberNodePageHref()).toBe("/app/fiber");
    expect(fundNodeHref(TESTNET_ADDRESS)).toBe(`/app/fiber/fund?address=${TESTNET_ADDRESS}`);
    expect(readFundAddress(`?address=${TESTNET_ADDRESS}`)).toBe(TESTNET_ADDRESS);
    expect(readFundAddress(`?x=1&address=${encodeURIComponent(` ${TESTNET_ADDRESS} `)}`)).toBe(TESTNET_ADDRESS);
    expect(readFundAddress(new URL(fundNodeHref(TESTNET_ADDRESS), "https://ckbolt.test").search)).toBe(TESTNET_ADDRESS);
  });

  test("a mainnet address, a broken address or none funds nothing", () => {
    for (const search of [`?address=${MAINNET_ADDRESS}`, `?address=${TESTNET_ADDRESS.slice(0, -2)}`, "?address=hello", "?address=", "", `?fund=${TESTNET_ADDRESS}`]) {
      expect(readFundAddress(search), search).toBeNull();
    }
  });

  test("names a service by its host", () => {
    expect(urlHost("https://faucet.nervos.org/")).toBe("faucet.nervos.org");
    expect(urlHost("https://testnet.ckbapp.dev:8114/rpc")).toBe("testnet.ckbapp.dev:8114");
    expect(urlHost("not a url")).toBe("not a url");
  });
});

/* ------------------------------------------------------------------------------------- channels, liquidity */

test.describe("channels and liquidity", () => {
  test("an asset is CKB without a UDT script, else the hub's asset with the same script (any hex case); unknown tokens are null", () => {
    const assets = HUB_NODE.assets;
    expect(channelAsset(channel(), assets)).toBe("CKB");
    expect(channelAsset(channel({ udtTypeScript: { ...RUSD_SCRIPT, args: RUSD_SCRIPT.args.toUpperCase().replace("0X", "0x") } }), assets)).toBe("RUSD");
    expect(channelAsset(channel({ udtTypeScript: { ...RUSD_SCRIPT, args: "0x01" } }), assets)).toBeNull();
    expect(channelAsset(channel({ udtTypeScript: { ...RUSD_SCRIPT, hashType: "data1" } }), assets)).toBeNull();
    expect(assetScript("CKB", [])).toBeNull();
    expect(assetScript("RUSD", assets)).toEqual(RUSD_SCRIPT);
    expect(assetScript("RUSD", [])).toBeUndefined();
  });

  test("liquidity counts only ready, enabled channels in the asset, summed exactly", () => {
    const channels = [
      channel({ localBalance: ckb(401), remoteBalance: ckb(150) }),
      channel({ channelId: "0x2", peerId: BRACER.nodeId, localBalance: BigInt(1), remoteBalance: ckb(1000) }),
      channel({ channelId: "0x3", state: "AwaitingChannelReady", localBalance: ckb(9999), remoteBalance: ckb(9999) }),
      channel({ channelId: "0x4", enabled: false, localBalance: ckb(9999), remoteBalance: ckb(9999) }),
      channel({ channelId: "0x5", udtTypeScript: RUSD_SCRIPT, localBalance: BigInt(20_00000000), remoteBalance: BigInt(5) }),
    ];
    expect(liquidityOf(channels, "CKB", HUB_NODE.assets)).toEqual({ send: ckb(401) + BigInt(1), receive: ckb(1150) });
    expect(liquidityOf(channels, "RUSD", HUB_NODE.assets)).toEqual({ send: BigInt(2_000_000_000), receive: BigInt(5) });
    // Without the hub's asset list a RUSD channel cannot be told apart, so it counts for nothing.
    expect(liquidityOf(channels, "RUSD", [])).toEqual({ send: BigInt(0), receive: BigInt(0) });
  });

  test("channels with the hub are those not closed or closing, and states read in plain words", () => {
    const channels = [
      channel(),
      channel({ channelId: "0x2", state: "Closed" }),
      channel({ channelId: "0x3", state: "ShuttingDown" }),
      channel({ channelId: "0x4", state: "NegotiatingFunding" }),
      channel({ channelId: "0x5", peerId: BRACER.nodeId }),
    ];
    expect(hubChannels(channels, BOTTLE.nodeId).map((c) => c.channelId)).toEqual([channels[0].channelId, "0x4"]);
    expect(["ChannelReady", "AwaitingChannelReady", "ShuttingDown", "Closed", "NegotiatingFunding", ""].map(channelStateLabel)).toEqual([
      "Ready",
      "Waiting for confirmations",
      "Closing",
      "Closed",
      "Opening",
      "Opening",
    ]);
  });
});

/* -------------------------------------------------------------------------------------- invoice request */

test.describe("payout invoice arguments", () => {
  test("stays valid past the quote by the named margin, never less than the minimum", () => {
    expect(INVOICE_EXTRA_SECONDS).toBe(3_600);
    expect(invoiceExpirySeconds(iso(NOW + 150_000), NOW)).toBe(150 + 3_600);
    expect(invoiceExpirySeconds(iso(NOW + 150_001), NOW)).toBe(151 + 3_600);
    expect(invoiceExpirySeconds(iso(NOW - 10_000), NOW)).toBe(3_600);
    expect(invoiceExpirySeconds("not a date", NOW)).toBe(3_600);
    expect(INVOICE_MIN_EXPIRY_SECONDS).toBeLessThanOrEqual(INVOICE_EXTRA_SECONDS);
  });

  test("takes only positive whole base units, exactly", () => {
    expect(parseBaseUnits("1")).toBe(BigInt(1));
    expect(parseBaseUnits("123456789012345678901234567890")).toBe(BigInt("123456789012345678901234567890"));
    for (const bad of ["0", "-1", "01", "1.5", "1e3", " 1", "0x10", "", "1234567890123456789012345678901"]) expect(parseBaseUnits(bad), bad).toBeNull();
  });

  test("Fibt on testnet, the preimage as 0x hex, the swap description", () => {
    const preimage = new Uint8Array(32).fill(0xab);
    expect(payoutInvoiceArgs({ amount: BigInt(5), network: "testnet", udtTypeScript: null, quoteExpiresAt: iso(NOW + 60_000), nowMs: NOW, preimage })).toEqual({
      amount: BigInt(5),
      currency: "Fibt",
      preimage: `0x${"ab".repeat(32)}`,
      expirySeconds: 3_660,
      description: "CKBolt swap payout",
      udtTypeScript: null,
    });
  });

  test("tells a Fiber invoice of the node's network from one of another network", () => {
    expect(isInvoiceOfNetwork("fibt1qq...", "testnet")).toBe(true);
    expect(isInvoiceOfNetwork(" FIBT800000000000abc ", "testnet")).toBe(true);
    for (const other of ["fibb1qq...", "fibd1qq...", "lntbs198u1visitor", ""]) expect(isInvoiceOfNetwork(other, "testnet"), other).toBe(false);
    expect(isInvoiceOfNetwork("fibb1qq...", "mainnet")).toBe(true);
  });
});

/* --------------------------------------------------------------------------------- what the node agrees to */

test.describe("ln_to_fiber: the node makes the payout invoice", () => {
  const ready = (remote: bigint, udt: Script | null = null) => channel({ udtTypeScript: udt, localBalance: ckb(99), remoteBalance: remote });

  test("an invoice for exactly the quote's amount, sha256-ready, with a fresh preimage that never leaves the node", async () => {
    const node = new FakeNode();
    node.channels = [ready(BigInt("1980000000000"))];
    const rng = countingRandom(40);
    const { deps } = swapDeps(node, { random: rng.random });
    const result = await makePayoutInvoice(deps, invoiceParams());
    const args = node.invoices[0];
    expect(args.amount).toBe(BigInt("1980000000000"));
    expect(args).toMatchObject({ currency: "Fibt", expirySeconds: 150 + 3_600, description: "CKBolt swap payout", udtTypeScript: null });
    const drawn = rng.drawn[0];
    expect(drawn).toHaveLength(32);
    expect(args.preimage).toBe(`0x${bytesToHex(drawn)}`);
    // The answer carries the invoice and its hash only, never the preimage.
    expect(Object.keys(result).sort()).toEqual(["invoice", "paymentHash"]);
    expect(JSON.stringify(result)).not.toContain(bytesToHex(drawn));
    expect(result.paymentHash).toBe(`0x${bytesToHex(sha256(drawn))}`);
    // A second invoice gets a different preimage.
    await makePayoutInvoice(swapDeps(node).deps, invoiceParams());
    expect(node.invoices[1].preimage).not.toBe(node.invoices[0].preimage);
  });

  test("a RUSD payout asks for the hub's RUSD script and counts only RUSD channels", async () => {
    const node = new FakeNode();
    node.channels = [ready(ckb(1_000_000)), ready(BigInt(3_960_000_000), RUSD_SCRIPT)];
    await makePayoutInvoice(swapDeps(node).deps, invoiceParams({ asset: "RUSD", amount: "3960000000" }));
    expect(node.invoices[0]).toMatchObject({ amount: BigInt(3_960_000_000), udtTypeScript: RUSD_SCRIPT });
    const error = await rejection(makePayoutInvoice(swapDeps(node).deps, invoiceParams({ asset: "RUSD", amount: "3960000001" })));
    expect(error).toMatchObject({ code: BRIDGE_ERROR.NO_INBOUND });
  });

  test("receive capacity equal to the amount is enough; one base unit short is refused before the node is asked", async () => {
    const node = new FakeNode();
    node.channels = [ready(BigInt("1980000000000"))];
    await makePayoutInvoice(swapDeps(node).deps, invoiceParams());
    const error = await rejection(makePayoutInvoice(swapDeps(node).deps, invoiceParams({ amount: "1980000000001" })));
    expect(error).toBeInstanceOf(SwapRequestError);
    expect(error).toMatchObject({ code: BRIDGE_ERROR.NO_INBOUND, message: expect.stringContaining("ask the hub for inbound liquidity") });
    expect(node.invoices).toHaveLength(1);
  });

  test("refuses another network: a mainnet or devnet hub, from the swap form or from the hub's node", async () => {
    const node = new FakeNode();
    node.channels = [ready(ckb(1_000_000))];
    for (const [params, hubNode] of [
      [invoiceParams({ network: "mainnet" }), HUB_NODE],
      [invoiceParams({ network: "devnet" }), HUB_NODE],
      [invoiceParams({ network: null }), { ...HUB_NODE, network: "mainnet" }],
    ] as const) {
      const error = await rejection(makePayoutInvoice(swapDeps(node, { hubNode }).deps, params));
      expect(error).toMatchObject({ code: BRIDGE_ERROR.WRONG_NETWORK, message: expect.stringContaining("cannot pay each other") });
    }
    expect(node.invoices).toHaveLength(0);
  });

  test("refuses when the node page could not read the hub's Fiber node, so its network is unknown", async () => {
    const node = new FakeNode();
    node.channels = [ready(ckb(1_000_000))];
    for (const params of [invoiceParams(), invoiceParams({ network: null })]) {
      const error = await rejection(makePayoutInvoice(swapDeps(node, { hubNode: null }).deps, params));
      expect(error).toMatchObject({ code: BRIDGE_ERROR.HUB_ERROR, message: expect.stringContaining("cannot check which network the hub runs on") });
    }
    expect(node.invoices).toHaveLength(0);
  });

  test("refuses a malformed amount or expiry, and an expired quote", async () => {
    const node = new FakeNode();
    node.channels = [ready(ckb(1_000_000))];
    for (const params of [
      invoiceParams({ amount: "0" }),
      invoiceParams({ amount: "1.5" }),
      invoiceParams({ amount: "-5" }),
      invoiceParams({ amount: "1e9" }),
      invoiceParams({ quoteExpiresAt: "tomorrow" }),
    ]) {
      expect(await rejection(makePayoutInvoice(swapDeps(node).deps, params))).toMatchObject({ code: BRIDGE_ERROR.INVALID_REQUEST });
    }
    for (const expiresAt of [NOW, NOW - 1]) {
      expect(await rejection(makePayoutInvoice(swapDeps(node).deps, invoiceParams({ quoteExpiresAt: iso(expiresAt) })))).toMatchObject({
        code: BRIDGE_ERROR.INVALID_REQUEST,
        message: "The quote has expired. Get a new quote first.",
      });
    }
    expect(node.invoices).toHaveLength(0);
  });

  test("a token the hub did not list cannot be asked for; the node's own error is passed on", async () => {
    const node = new FakeNode();
    node.channels = [ready(ckb(1_000_000))];
    expect(await rejection(makePayoutInvoice(swapDeps(node, { hubNode: null }).deps, invoiceParams({ asset: "RUSD" })))).toMatchObject({ code: BRIDGE_ERROR.HUB_ERROR });
    node.invoiceError = 'ErrorObject { code: ServerError(-32000), message: "Duplicated payment hash" }';
    expect(await rejection(makePayoutInvoice(swapDeps(node).deps, invoiceParams()))).toMatchObject({ code: BRIDGE_ERROR.NODE_ERROR, message: "Duplicated payment hash" });
  });

  test("wipes the preimage bytes once the node has it", async () => {
    const node = new FakeNode();
    node.channels = [ready(ckb(1_000_000))];
    const handed: Uint8Array[] = [];
    const { deps } = swapDeps(node, {
      random: (n) => {
        const bytes = new Uint8Array(n).fill(0x42);
        handed.push(bytes);
        return bytes;
      },
    });
    await makePayoutInvoice(deps, invoiceParams());
    expect(handed[0].every((b) => b === 0)).toBe(true);
  });
});

test.describe("fiber_to_ln: the node pays the hub's hold invoice only when the hub says so", () => {
  const outbound = (local: bigint) => channel({ localBalance: local, remoteBalance: BigInt(0) });
  const HOLD = swap().pay.invoice;

  test("pays exactly the hub's invoice, once, after the hub confirms the swap waits for it", async () => {
    const node = new FakeNode();
    node.channels = [outbound(ckb(8_000))];
    const { deps, asked } = swapDeps(node);
    const sent = await payHoldInvoice(deps, { swapId: SWAP_ID, invoice: HOLD });
    expect(asked).toEqual([SWAP_ID]);
    expect(node.paid).toEqual([HOLD]);
    // The hub's own hold invoice: paid on the node's channel with the hub, no trampoline, no dry run, as before Pay's routes.
    expect(node.payOptions).toEqual([undefined]);
    expect(sent).toEqual({ paymentHash: `0x${"bb".repeat(32)}`, status: "Inflight", asset: "CKB", amount: "800000000000", lightningSats: swap().receive.amount });
  });

  test("refuses an invoice the hub does not list for the swap, the wrong direction, or a Lightning pay leg", async () => {
    for (const [name, answer, invoice] of [
      ["other invoice", swap(), "fibt800000000000attacker"],
      ["ln_to_fiber swap", swap({ direction: "ln_to_fiber" }), HOLD],
      ["lightning pay leg", swap({ pay: { ...swap().pay, network: "lightning" } }), HOLD],
    ] as const) {
      const node = new FakeNode();
      node.channels = [outbound(ckb(100_000))];
      const error = await rejection(payHoldInvoice(swapDeps(node, { swap: answer }).deps, { swapId: SWAP_ID, invoice }));
      expect(error, name).toMatchObject({ code: BRIDGE_ERROR.REFUSED, message: "This is not the hub's Fiber invoice for that swap, so your node did not pay it." });
      expect(node.paid, name).toEqual([]);
    }
  });

  test("refuses once the swap no longer waits for a payment, whatever the state", async () => {
    const states: SwapState[] = ["incoming_accepted", "outgoing_in_flight", "outgoing_succeeded", "succeeded", "failed"];
    for (const state of states) {
      const node = new FakeNode();
      node.channels = [outbound(ckb(100_000))];
      const error = await rejection(payHoldInvoice(swapDeps(node, { swap: swap({ state }) }).deps, { swapId: SWAP_ID, invoice: HOLD }));
      expect(error, state).toMatchObject({ code: BRIDGE_ERROR.REFUSED, message: "This swap no longer waits for a payment, so your node did not pay." });
      expect(node.paid).toEqual([]);
    }
  });

  test("a hub that cannot be asked means no payment", async () => {
    const node = new FakeNode();
    node.channels = [outbound(ckb(100_000))];
    const error = await rejection(payHoldInvoice(swapDeps(node, { swap: new HubApiError(503, "hub_unavailable", "The CKBolt hub cannot be reached.") }).deps, { swapId: SWAP_ID, invoice: HOLD }));
    expect(error).toMatchObject({ code: BRIDGE_ERROR.HUB_ERROR, message: expect.stringContaining("The CKBolt hub cannot be reached.") });
    expect(node.paid).toEqual([]);
  });

  test("a hub whose Fiber node the page could not read is refused before the hub or the node is asked", async () => {
    const node = new FakeNode();
    node.channels = [outbound(ckb(100_000))];
    const { deps, asked } = swapDeps(node, { hubNode: null });
    expect(await rejection(payHoldInvoice(deps, { swapId: SWAP_ID, invoice: HOLD }))).toMatchObject({ code: BRIDGE_ERROR.HUB_ERROR });
    expect(asked).toEqual([]);
    expect(node.paid).toEqual([]);
  });

  test("a hold invoice of another network is never paid, even when the hub lists it for the swap", async () => {
    for (const invoice of ["fibb800000000000hubholdinvoice", "fibd800000000000hubholdinvoice", "lntbs198u1visitor"]) {
      const node = new FakeNode();
      node.channels = [outbound(ckb(100_000))];
      const { deps, asked } = swapDeps(node, { swap: swap({ pay: { ...swap().pay, invoice } }) });
      expect(await rejection(payHoldInvoice(deps, { swapId: SWAP_ID, invoice })), invoice).toMatchObject({
        code: BRIDGE_ERROR.WRONG_NETWORK,
        message: "This is not a Fiber invoice of CKB testnet, so your node did not pay it.",
      });
      expect(asked, invoice).toEqual([]);
      expect(node.paid, invoice).toEqual([]);
    }
  });

  test("a hub on another network is refused before the hub or the node is asked", async () => {
    const node = new FakeNode();
    node.channels = [outbound(ckb(100_000))];
    const { deps, asked } = swapDeps(node, { hubNode: { ...HUB_NODE, network: "mainnet" } });
    expect(await rejection(payHoldInvoice(deps, { swapId: SWAP_ID, invoice: HOLD }))).toMatchObject({ code: BRIDGE_ERROR.WRONG_NETWORK });
    expect(asked).toEqual([]);
    expect(node.paid).toEqual([]);
  });

  test("outbound equal to the hub's amount pays; one shannon short is refused without paying", async () => {
    const node = new FakeNode();
    node.channels = [outbound(BigInt("799999999999"))];
    expect(await rejection(payHoldInvoice(swapDeps(node).deps, { swapId: SWAP_ID, invoice: HOLD }))).toMatchObject({
      code: BRIDGE_ERROR.NO_OUTBOUND,
      message: expect.stringContaining("Receive it first: ask the hub for a channel on the node page"),
    });
    expect(node.paid).toEqual([]);
    node.channels = [outbound(BigInt("800000000000"))];
    await payHoldInvoice(swapDeps(node).deps, { swapId: SWAP_ID, invoice: HOLD });
    expect(node.paid).toEqual([HOLD]);
  });

  test("a payment the node reports Failed, or that throws, is a node error", async () => {
    const node = new FakeNode();
    node.channels = [outbound(ckb(100_000))];
    node.payment = { status: "Failed", failedError: "Failed to build route" };
    expect(await rejection(payHoldInvoice(swapDeps(node).deps, { swapId: SWAP_ID, invoice: HOLD }))).toMatchObject({ code: BRIDGE_ERROR.NODE_ERROR, message: "Failed to build route" });
    node.payment = { status: "Failed", failedError: null };
    expect(await rejection(payHoldInvoice(swapDeps(node).deps, { swapId: SWAP_ID, invoice: HOLD }))).toMatchObject({ message: "Your node could not send the payment." });
    node.payment = 'ErrorObject { code: ServerError(-32000), message: "Peer not connected" }';
    expect(await rejection(payHoldInvoice(swapDeps(node).deps, { swapId: SWAP_ID, invoice: HOLD }))).toMatchObject({ code: BRIDGE_ERROR.NODE_ERROR, message: "Peer not connected" });
  });
});

/* ------------------------------------------------------------------------------------------- bridge */

/** BroadcastChannel semantics in memory: a message reaches every other open channel of the same name, later. */
class FakeBus {
  readonly channels: FakeChannel[] = [];
  readonly messages: unknown[] = [];
  readonly factory: ChannelFactory = (name) => {
    const c = new FakeChannel(this, name);
    this.channels.push(c);
    return c;
  };
  deliver(from: FakeChannel, data: unknown) {
    this.messages.push(structuredClone(data));
    for (const c of this.channels) if (c !== from && c.name === from.name && !c.closed) setTimeout(() => c.emit(structuredClone(data)), 0);
  }
  get openCount() {
    return this.channels.filter((c) => !c.closed).length;
  }
  /** Sends raw data as if from another tab. */
  inject(data: unknown) {
    const other = new FakeChannel(this, BRIDGE_CHANNEL_NAME);
    this.channels.push(other);
    other.postMessage(data);
    other.close();
  }
}

class FakeChannel implements BroadcastLike {
  closed = false;
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  constructor(
    private readonly bus: FakeBus,
    readonly name: string,
  ) {}
  postMessage(message: unknown) {
    if (this.closed) throw new Error("posted on a closed channel");
    this.bus.deliver(this, message);
  }
  addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "message", listener: (event: MessageEvent) => void) {
    this.listeners.delete(listener);
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    if (this.closed) return;
    for (const listener of [...this.listeners]) listener({ data } as MessageEvent);
  }
}

const FAST_BRIDGE = { statusWindowMs: 40, statusLateMs: 200, invoiceTimeoutMs: 300, paymentTimeoutMs: 300, readTimeoutMs: 300, confirmTimeoutMs: 300 };

const presence = (overrides: Partial<NodePresence> = {}): NodePresence => ({
  phase: "running",
  nodeId: BOTTLE.nodeId,
  network: "testnet",
  hubConnected: true,
  liquidity: { CKB: { send: "40100000000", receive: "0" } },
  ...overrides,
});

function handlers(overrides: Partial<BridgeHandlers> = {}): BridgeHandlers & { invoiceCalls: MakeInvoiceParams[] } {
  const invoiceCalls: MakeInvoiceParams[] = [];
  return {
    invoiceCalls,
    presence: () => presence(),
    serves: () => true,
    makeInvoice: async (params) => {
      invoiceCalls.push(params);
      return { invoice: "fibt1made", paymentHash: "0xhash" };
    },
    payInvoice: async () => ({ paymentHash: "0xpaid", status: "Inflight" }),
    readInvoice: async () => Promise.reject(new Error("not in this test")),
    requestPayment: async () => Promise.reject(new Error("not in this test")),
    paymentStatus: async () => Promise.reject(new Error("not in this test")),
    requestOnChain: async () => Promise.reject(new Error("not in this test")),
    makeReceiveInvoice: async () => Promise.reject(new Error("not in this test")),
    invoiceStatus: async () => Promise.reject(new Error("not in this test")),
    ...overrides,
  };
}

test.describe("bridge protocol", () => {
  test("accepts only well-formed requests of this version", () => {
    const good = request("id1", { method: BRIDGE_METHOD.MAKE_INVOICE, params: invoiceParams() });
    expect(parseRequest(good)).toEqual(good);
    expect(parseRequest(request("s", { method: BRIDGE_METHOD.STATUS }))).toEqual({ v: 1, kind: "request", id: "s", method: "status" });
    expect(parseRequest(request("p", { method: BRIDGE_METHOD.PAY_INVOICE, params: { swapId: SWAP_ID, invoice: "fibt1" } }))?.method).toBe("pay-invoice");
    const bad: unknown[] = [
      null,
      "x",
      { ...good, v: 2 },
      { ...good, kind: "response" },
      { ...good, id: "" },
      { ...good, method: "steal-keys" },
      // Not an asset id as the hub writes them (upper-case letters and digits, 2 to 16, a letter first).
      { ...good, params: { ...invoiceParams(), asset: "btc" } },
      { ...good, params: { ...invoiceParams(), asset: "X" } },
      { ...good, params: { ...invoiceParams(), asset: "1INCH" } },
      { ...good, params: { ...invoiceParams(), asset: "C-KB" } },
      { ...good, params: { ...invoiceParams(), asset: "A".repeat(17) } },
      { ...good, params: { ...invoiceParams(), asset: 7 } },
      { ...good, params: { ...invoiceParams(), amount: 5 } },
      { ...good, params: { ...invoiceParams(), network: 1 } },
      { ...good, params: undefined },
      { v: 1, kind: "request", id: "p", method: "pay-invoice", params: { swapId: "", invoice: "fibt1" } },
      { v: 1, kind: "request", id: "p", method: "pay-invoice", params: { swapId: SWAP_ID } },
    ];
    for (const value of bad) expect(parseRequest(value), JSON.stringify(value)).toBeNull();
    // Any well-formed id passes the bridge: the hub's list says which it serves (a new token needs no web change), and
    // the node refuses one its hub does not list for its network (makePayoutInvoice).
    for (const asset of ["CWBTC", "RUSD", "ABC123", "A".repeat(16)]) {
      const params = { ...invoiceParams(), asset };
      expect(parseRequest({ ...good, params }), asset).toEqual({ ...good, params });
    }
    expect(requestId({ ...good, params: undefined })).toBe("id1");
    expect(requestId({ ...good, v: 2 })).toBeNull();
  });

  test("accepts only responses with a known error code", () => {
    expect(parseResponse(okResponse("a", { x: 1 }))).toEqual({ v: 1, kind: "response", id: "a", ok: true, result: { x: 1 } });
    expect(parseResponse(errorResponse("a", BRIDGE_ERROR.NO_INBOUND, "m"))).toEqual(errorResponse("a", BRIDGE_ERROR.NO_INBOUND, "m"));
    expect(parseResponse({ ...errorResponse("a", BRIDGE_ERROR.NO_INBOUND, "m"), error: { code: "made_up", message: "m" } })).toBeNull();
    expect(parseResponse({ ...okResponse("a", 1), v: 0 })).toBeNull();
    expect(isNodePresence(presence())).toBe(true);
    expect(isNodePresence({ ...presence(), phase: "dancing" })).toBe(false);
    expect(isNodePresence({ ...presence(), liquidity: null })).toBe(false);
  });
});

test.describe("bridge between the swap form and the node tab", () => {
  test("one status window without an answer keeps the node; two in a row forget it", () => {
    const node = { phase: "running" as const, nodeId: null, network: "testnet", hubConnected: true, liquidity: {} };
    const seen = nextPresenceRead(NO_PRESENCE, node);
    expect(seen).toEqual({ presence: node, misses: 0 });
    // A busy or hidden tab answers late once: the card keeps what it knew, so its button keeps its target.
    const late = nextPresenceRead(seen, null);
    expect(late).toEqual({ presence: node, misses: 1 });
    expect(nextPresenceRead(late, node)).toEqual({ presence: node, misses: 0 });
    // The tab closed: gone after the second silent window.
    expect(nextPresenceRead(late, null)).toEqual({ presence: null, misses: 2 });
    expect(nextPresenceRead(NO_PRESENCE, null)).toEqual({ presence: null, misses: 1 });
  });

  test("a busy tab that answers after the window still counts, until statusLateMs; then the channel is closed", async () => {
    // A node tab that answers each status request after `delayMs`, as a busy or hidden tab does.
    const slowTab = (bus: FakeBus, delayMs: number) => {
      const channel = bus.factory(BRIDGE_CHANNEL_NAME)!;
      let stopped = false;
      channel.addEventListener("message", (event) => {
        const req = parseRequest(event.data);
        if (req?.method === BRIDGE_METHOD.STATUS) setTimeout(() => !stopped && channel.postMessage(okResponse(req.id, presence())), delayMs);
      });
      return () => {
        stopped = true;
        channel.close();
      };
    };
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const bus = new FakeBus();
    const stop = slowTab(bus, 100);
    const late: NodePresence[] = [];
    const client = new BridgeClient(bus.factory, FAST_BRIDGE);
    expect(await client.status((p) => late.push(p))).toBeNull();
    await wait(150);
    expect(late).toEqual([presence()]);
    // Without a taker for late answers, the window closes the channel at once.
    expect(await client.status()).toBeNull();
    stop();
    await wait(150);
    expect(bus.openCount).toBe(0);

    // Later than statusLateMs: not taken, and nothing stays open.
    const slower = new FakeBus();
    const stopSlower = slowTab(slower, 300);
    const none: NodePresence[] = [];
    expect(await new BridgeClient(slower.factory, FAST_BRIDGE).status((p) => none.push(p))).toBeNull();
    await wait(350);
    expect(none).toEqual([]);
    stopSlower();
    expect(slower.openCount).toBe(0);
  });

  test("no node tab: status is null after the window, and an invoice request times out; every channel is closed after", async () => {
    const bus = new FakeBus();
    const client = new BridgeClient(bus.factory, FAST_BRIDGE);
    expect(await client.status()).toBeNull();
    const error = await rejection(client.makeInvoice(invoiceParams()));
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: BRIDGE_ERROR.TIMEOUT });
    expect(bus.openCount).toBe(0);
  });

  test("without BroadcastChannel the swap form finds no node", async () => {
    const client = new BridgeClient(() => null, FAST_BRIDGE);
    expect(await client.status()).toBeNull();
    expect(await rejection(client.payInvoice({ swapId: SWAP_ID, invoice: "fibt1" }))).toMatchObject({ code: BRIDGE_ERROR.NO_NODE });
    expect(startBridgeServer(handlers(), () => null)).toBeInstanceOf(Function);
  });

  test("status prefers the tab that runs the node over a locked or waiting one, and ignores unreadable answers", async () => {
    const bus = new FakeBus();
    const stops = [
      startBridgeServer(handlers({ presence: () => presence({ phase: "locked", nodeId: null, liquidity: {} }), serves: () => false }), bus.factory),
      startBridgeServer(handlers({ presence: () => ({ phase: "bogus" }) as unknown as NodePresence }), bus.factory),
      startBridgeServer(handlers({ presence: () => presence({ phase: "other-tab" }), serves: () => false }), bus.factory),
      startBridgeServer(handlers(), bus.factory),
    ];
    const client = new BridgeClient(bus.factory, FAST_BRIDGE);
    expect(await client.status()).toEqual(presence());
    stops.forEach((stop) => stop());
    expect(bus.openCount).toBe(0);
  });

  test("only the tab whose node runs makes the invoice; the params arrive intact", async () => {
    const bus = new FakeBus();
    const idle = handlers({ serves: () => false });
    const running = handlers();
    const stops = [startBridgeServer(idle, bus.factory), startBridgeServer(running, bus.factory)];
    const client = new BridgeClient(bus.factory, FAST_BRIDGE);
    expect(await client.makeInvoice(invoiceParams())).toEqual({ invoice: "fibt1made", paymentHash: "0xhash" });
    expect(idle.invoiceCalls).toEqual([]);
    expect(running.invoiceCalls).toEqual([invoiceParams()]);
    // One request, one answer.
    expect(bus.messages.filter((m) => (m as { kind?: string }).kind === "response")).toHaveLength(1);
    stops.forEach((stop) => stop());
  });

  test("the node's refusal arrives with its code and sentence; other errors as node_error; unreadable results too", async () => {
    const bus = new FakeBus();
    let mode: "refuse" | "throw" | "garbage" = "refuse";
    const stop = startBridgeServer(
      handlers({
        makeInvoice: async () => {
          if (mode === "refuse") throw new SwapRequestError(BRIDGE_ERROR.NO_INBOUND, "Your node cannot receive this much CKB yet.");
          if (mode === "throw") throw new TypeError("boom");
          return { invoice: "" } as never;
        },
        payInvoice: async () => {
          throw new SwapRequestError(BRIDGE_ERROR.REFUSED, "not the hub's invoice");
        },
      }),
      bus.factory,
    );
    const client = new BridgeClient(bus.factory, FAST_BRIDGE);
    expect(await rejection(client.makeInvoice(invoiceParams()))).toMatchObject({ code: "no_inbound", message: "Your node cannot receive this much CKB yet." });
    mode = "throw";
    expect(await rejection(client.makeInvoice(invoiceParams()))).toMatchObject({ code: "node_error", message: "boom" });
    mode = "garbage";
    expect(await rejection(client.makeInvoice(invoiceParams()))).toMatchObject({ code: "node_error", message: "Your Fiber node sent an answer CKBolt could not read." });
    expect(await rejection(client.payInvoice({ swapId: SWAP_ID, invoice: "fibt1" }))).toMatchObject({ code: "refused", message: "not the hub's invoice" });
    stop();
  });

  test("a request the node cannot read gets invalid_request from the running tab only; another protocol version gets no answer", async () => {
    const bus = new FakeBus();
    const stops = [startBridgeServer(handlers({ serves: () => false }), bus.factory), startBridgeServer(handlers(), bus.factory)];
    bus.inject({ v: 1, kind: "request", id: "bad", method: BRIDGE_METHOD.MAKE_INVOICE, params: { asset: "BTC" } });
    bus.inject({ v: 2, kind: "request", id: "future", method: BRIDGE_METHOD.STATUS });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const responses = bus.messages.filter((m) => (m as { kind?: string }).kind === "response");
    expect(responses).toEqual([errorResponse("bad", BRIDGE_ERROR.INVALID_REQUEST, "Your Fiber node could not read this request. Reload the page and try again.")]);
    stops.forEach((stop) => stop());
  });

  test("answers to other requests are ignored, and a stopped node tab answers nothing", async () => {
    const bus = new FakeBus();
    let ids = 0;
    const client = new BridgeClient(bus.factory, FAST_BRIDGE, () => `mine-${++ids}`);
    const pending = client.makeInvoice(invoiceParams());
    bus.inject(okResponse("someone-else", { invoice: "fibt1forged", paymentHash: "0x1" }));
    expect(await rejection(pending)).toMatchObject({ code: BRIDGE_ERROR.TIMEOUT });
    const stop = startBridgeServer(handlers(), bus.factory);
    stop();
    expect(await rejection(client.makeInvoice(invoiceParams()))).toMatchObject({ code: BRIDGE_ERROR.TIMEOUT });
  });

  test("works over the runtime's real BroadcastChannel under the agreed channel name", async () => {
    test.skip(typeof BroadcastChannel !== "function", "no BroadcastChannel in this runtime");
    const seen: unknown[] = [];
    const spy = new BroadcastChannel(BRIDGE_CHANNEL_NAME);
    spy.onmessage = (event) => seen.push(event.data);
    const stop = startBridgeServer(handlers(), browserChannel);
    try {
      const client = new BridgeClient(browserChannel, FAST_BRIDGE);
      expect(await client.makeInvoice(invoiceParams())).toEqual({ invoice: "fibt1made", paymentHash: "0xhash" });
      expect((await client.status())?.phase).toBe("running");
      await expect.poll(() => seen.length).toBeGreaterThanOrEqual(4);
      expect(seen.every((m) => (m as { v?: number }).v === 1)).toBe(true);
    } finally {
      stop();
      spy.close();
    }
  });
});

/* ---------------------------------------------------------------------------------------- hub link, RPC */

test.describe("connecting to the hub's node", () => {
  test("dials the hub's WebSocket addresses with its peer id: TLS only from https, plain ws too from localhost", () => {
    expect(hubDialAddresses(HUB_NODE, true)).toEqual([`/dns4/hub.example.test/tcp/443/wss/p2p/${BOTTLE.peerId}`]);
    expect(hubDialAddresses(HUB_NODE, false)).toEqual([`/dns4/hub.example.test/tcp/443/wss/p2p/${BOTTLE.peerId}`, `/ip4/1.2.3.4/tcp/8229/ws/p2p/${BOTTLE.peerId}`]);
    expect(hubDialAddresses(null, false)).toEqual([]);
    expect(hubDialAddresses({ ...HUB_NODE, addresses: { p2p: ["/ip4/1.2.3.4/tcp/8228"], ws: [] } }, false)).toEqual([]);
  });

  test("tries each address in order until one works, and reports the last error otherwise", async () => {
    const node = new FakeNode();
    const [a, b] = hubDialAddresses(HUB_NODE, false);
    node.connectErrors.set(a, 'ErrorObject { code: ServerError(-32000), message: "Failed to dial" }');
    expect(await dialHub(node, [a, b])).toEqual({ address: b, error: null });
    node.connectErrors.set(b, new Error("timed out"));
    expect(await dialHub(node, [a, b])).toEqual({ address: null, error: "timed out" });
    expect(await dialHub(node, [])).toEqual({ address: null, error: "The hub lists no WebSocket address this page can dial." });
    expect(node.connected).toEqual([a, b, a, b]);
    expect(isHubConnected([BRACER.nodeId, BOTTLE.nodeId], BOTTLE.nodeId)).toBe(true);
    expect(isHubConnected([BRACER.nodeId], BOTTLE.nodeId)).toBe(false);
    expect(isHubConnected([BOTTLE.nodeId], null)).toBe(false);
  });

  test("reads the node's spendable on-chain CKB with get_cells_capacity for its lock only, plain cells only", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let answer: () => Response = () => Response.json({ jsonrpc: "2.0", id: 1, result: { capacity: "0xdf8475800", block_number: "0x1" } });
    const rpc = new CkbRpcClient(
      "https://rpc.example.test/",
      async (url, init) => {
        calls.push({ url, init });
        return answer();
      },
      1_000,
    );
    const lock = secpLock();
    expect(await rpc.spendableCapacity(lock)).toBe(ckb(600));
    expect(calls[0].url).toBe("https://rpc.example.test/");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      id: 1,
      jsonrpc: "2.0",
      method: "get_cells_capacity",
      params: [
        {
          script: { code_hash: lock.codeHash, hash_type: "type", args: lock.args },
          script_type: "lock",
          filter: { script_len_range: ["0x0", "0x1"], output_data_len_range: ["0x0", "0x1"] },
        },
      ],
    });
    answer = () => Response.json({ jsonrpc: "2.0", id: 1, result: null });
    expect(await rpc.spendableCapacity(lock)).toBe(BigInt(0));
    answer = () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "indexer is syncing" } });
    await expect(rpc.spendableCapacity(lock)).rejects.toThrow("indexer is syncing");
    answer = () => new Response("bad gateway", { status: 502 });
    await expect(rpc.spendableCapacity(lock)).rejects.toThrow("The CKB RPC answered 502. Try again in a minute.");
    answer = () => new Response("<html>", { status: 200 });
    await expect(rpc.spendableCapacity(lock)).rejects.toThrow("unreadable");
    answer = () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(rpc.spendableCapacity(lock)).rejects.toThrow("The CKB RPC cannot be reached. Try again in a minute.");
  });
});

/* --------------------------------------------------------------------------------------- activity list */

test.describe("the node's activity", () => {
  const HASH = `0x${"01".repeat(32)}`;
  const swapEntry = (overrides: Partial<ActivityEntry> = {}, leg: "invoice" | "payment" = "invoice"): ActivityEntry => ({
    id: HASH,
    kind: "swap",
    asset: "CKB",
    amount: "1980000000000",
    status: leg === "invoice" ? "Open" : "Inflight",
    error: null,
    at: NOW,
    swap: { id: leg === "payment" ? "swap-1" : null, leg, lightningSats: leg === "payment" ? "20000" : null },
    ...overrides,
  });
  const channelEntry = (action: "open" | "close", overrides: Partial<ActivityEntry> = {}): ActivityEntry => ({
    id: `channel-${action}`,
    kind: "channel",
    asset: "CKB",
    amount: "100000000000",
    status: action === "open" ? "Opening" : "Closing",
    error: null,
    at: NOW,
    counterparty: HUB_NODE.nodeId,
    channel: { action, channelId: action === "close" ? "0xc1" : null, readyBefore: 0 },
    ...overrides,
  });
  const ckbOf = () => "CKB" as const;
  const memory = () => {
    const data = new Map<string, string>();
    return { data, store: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) } };
  };

  test("a swap's invoice is done once paid, cancelled or expired; its payment once it succeeded or failed", () => {
    expect(["Open", "Received", "Paid", "Cancelled", "Expired"].map((status) => isActivityFinal(swapEntry({ status: status as ActivityEntry["status"] })))).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(
      ["Created", "Inflight", "Success", "Failed"].map((status) => isActivityFinal(swapEntry({ status: status as ActivityEntry["status"] }, "payment"))),
    ).toEqual([false, false, true, true]);
    expect(activityLabel(swapEntry())).toBe("Waiting");
    expect(activityLabel(swapEntry({ status: "Paid" }))).toBe("Received");
    expect(activityLabel(swapEntry({}, "payment"))).toBe("In flight");
  });

  test("appends newest first, updates an entry in place by its id, and keeps the newest 200", () => {
    const list = upsertActivity(upsertActivity([], swapEntry()), swapEntry({ id: "0x02" }));
    expect(list.map((e) => e.id)).toEqual(["0x02", HASH]);
    expect(upsertActivity(list, swapEntry({ status: "Paid" })).map((e) => `${e.id} ${e.status}`)).toEqual(["0x02 Open", `${HASH} Paid`]);
    let many: ActivityEntry[] = [];
    for (let i = 0; i < 205; i++) many = upsertActivity(many, swapEntry({ id: `0x${i}` }));
    expect(many).toHaveLength(200);
    expect(many[0].id).toBe("0x204");
    expect(many.at(-1)?.id).toBe("0x5");
  });

  test("a swap's payment takes get_payment's status, its error, and its fee once it succeeded", () => {
    const paid = withPayment(swapEntry({}, "payment"), { status: "Success", failedError: null, fee: BigInt(1_000) });
    expect(paid).toMatchObject({ status: "Success", error: null, fee: "1000" });
    const failed = withPayment(swapEntry({}, "payment"), { status: "Failed", failedError: "no route", fee: BigInt(0) });
    expect(failed).toMatchObject({ status: "Failed", error: "no route", fee: null });
  });

  test("a channel asked for is open once the peer has one more ready channel in its asset; a closing one is closed once gone or closed", () => {
    const ready = { channelId: "0xa1", peerId: HUB_NODE.nodeId, state: "ChannelReady", udtTypeScript: null };
    const opening = channelEntry("open");
    expect(reconcileChannels([opening], [{ ...ready, state: "AwaitingChannelReady" }], ckbOf)[0].status).toBe("Opening");
    expect(reconcileChannels([opening], [ready], ckbOf)[0].status).toBe("Open");
    // A channel the peer already had does not count: only one more than before.
    expect(reconcileChannels([channelEntry("open", { channel: { action: "open", channelId: null, readyBefore: 1 } })], [ready], ckbOf)[0].status).toBe("Opening");
    const closing = channelEntry("close");
    expect(reconcileChannels([closing], [{ ...ready, channelId: "0xc1", state: "ShuttingDown" }], ckbOf)[0].status).toBe("Closing");
    expect(reconcileChannels([closing], [{ ...ready, channelId: "0xc1", state: "Closed" }], ckbOf)[0].status).toBe("Closed");
    expect(reconcileChannels([closing], [], ckbOf)[0].status).toBe("Closed");
    // Entries that changed nothing stay the same objects, so the page saves nothing.
    const done = channelEntry("open", { status: "Open" });
    expect(reconcileChannels([done], [], ckbOf)[0]).toBe(done);
  });

  test("kept per network and per node; only the node's own kinds read back, and nothing secret is stored", () => {
    const { data, store } = memory();
    const nodeA = `02${"aa".repeat(32)}`;
    const nodeB = `02${"bb".repeat(32)}`;
    saveHistory(store, "testnet", nodeA, [swapEntry(), channelEntry("open")]);
    saveHistory(store, "testnet", nodeB, [channelEntry("close")]);
    expect(readHistory(store, "testnet", nodeA).map((e) => e.kind)).toEqual(["swap", "channel"]);
    expect(readHistory(store, "testnet", nodeB).map((e) => e.kind)).toEqual(["channel"]);
    expect(readHistory(store, "devnet", nodeA)).toEqual([]);
    expect([...data.keys()].sort()).toEqual([`ckbolt:fiber-browser:testnet:history:${nodeA}`, `ckbolt:fiber-browser:testnet:history:${nodeB}`]);
    const wire = [...data.values()].join("");
    for (const secret of ["preimage", "password", "fibt1"]) expect(wire).not.toContain(secret);
    // An entry of a kind the node no longer keeps (its own payments and invoices), or a broken one, is dropped.
    data.set(
      `ckbolt:fiber-browser:testnet:history:${nodeA}`,
      JSON.stringify([
        { ...swapEntry(), kind: "payment", source: "wallet" },
        { ...swapEntry(), swap: undefined },
        { ...swapEntry(), amount: "1.5" },
        swapEntry({ id: "0x09" }),
        "junk",
      ]),
    );
    expect(readHistory(store, "testnet", nodeA).map((e) => e.id)).toEqual(["0x09"]);
    // A node with nothing to list keeps nothing.
    saveHistory(store, "testnet", nodeB, []);
    expect(data.has(`ckbolt:fiber-browser:testnet:history:${nodeB}`)).toBe(false);
    data.set(`ckbolt:fiber-browser:testnet:history:${nodeA}`, "{not json");
    expect(readHistory(store, "testnet", nodeA)).toEqual([]);
    expect(readHistory(null, "testnet", nodeA)).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------- hub contract: /v1/fiber */

test.describe("hub contract: the browser node's endpoints", () => {
  const NODE_ID = "03" + "ab".repeat(32);
  const HUB = "http://hub.test:8787";
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const proxyConfig = (overrides: Partial<HubProxyConfig> = {}): HubProxyConfig => ({
    hubUrl: HUB,
    timeoutMs: 2_000,
    maxBodyBytes: 1_024,
    trustProxy: false,
    proxySecret: null,
    rateLimit: { windowMs: 60_000, maxPerClient: 100, maxGlobal: 100, maxTrackedClients: 100 },
    problems: [],
    ...overrides,
  });
  const ALLOW: HubProxyDeps["rateLimiter"] = { take: () => ({ allowed: true, retryAfterMs: 0 }) };
  /** A request as the app's client sends it: a body goes as JSON (lib/hub/client.ts). */
  const proxyRequest = (p: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (init.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
    return new Request(`http://localhost:3100/api/hub/${p}`, { ...init, headers });
  };

  test("mirrors the hub's routes and error code", () => {
    expect(API_ROUTES.FIBER_NODE).toBe("fiber/node");
    expect(API_ROUTES.FIBER_INBOUND_CHANNELS).toBe("fiber/inbound-channels");
    expect(API_ERROR_CODE.INBOUND_DISABLED).toBe("inbound_disabled");
    const hubConstants = path.join(process.cwd(), "..", "ckbolt-hub", "src", "common", "constants", "api.constants.ts");
    let text: string;
    try {
      text = readFileSync(hubConstants, "utf8");
    } catch {
      test.skip(true, "the hub repo is not next to this one");
      return;
    }
    expect(text).toContain('FIBER_NODE: "fiber/node"');
    expect(text).toContain('FIBER_INBOUND_CHANNELS: "fiber/inbound-channels"');
    expect(text).toContain('INBOUND_DISABLED: "inbound_disabled"');
  });

  test("the proxy allow-list has the three paths with their methods", () => {
    const table = HUB_ROUTES.map((r) => `${r.methods.join(",")} /${r.pattern.join("/")}`);
    expect(table).toEqual(expect.arrayContaining(["GET /v1/fiber/node", "POST /v1/fiber/inbound-channels", "GET /v1/fiber/inbound-channels/:nodeId"]));
    expect(matchHubRoute(["v1", "fiber", "node"])?.methods).toEqual(["GET"]);
    expect(matchHubRoute(["v1", "fiber", "inbound-channels"])?.methods).toEqual(["POST"]);
    for (const id of [NODE_ID, `0x${NODE_ID}`, NODE_ID.toUpperCase(), BOTTLE.nodeId]) {
      expect(matchHubRoute(["v1", "fiber", "inbound-channels", id])?.methods, id).toEqual(["GET"]);
    }
  });

  test("a node id segment must be a compressed public key, so nothing can climb out of the API", () => {
    const refused = [
      ["v1", "fiber"],
      ["v1", "fiber", "nodes"],
      ["v1", "fiber", "node", NODE_ID],
      ["v1", "fiber", "inbound-channels", NODE_ID.slice(2)],
      ["v1", "fiber", "inbound-channels", `04${"ab".repeat(32)}`],
      ["v1", "fiber", "inbound-channels", `${NODE_ID}00`],
      ["v1", "fiber", "inbound-channels", `02${"zz".repeat(32)}`],
      ["v1", "fiber", "inbound-channels", ".."],
      ["v1", "fiber", "inbound-channels", "6f9619ff-8b86-4011-b42d-00cf4fc964ff"],
      ["v1", "fiber", "inbound-channels", NODE_ID, "close"],
      ["v1", "fiber", "inbound-channels", "%2e%2e"],
    ];
    for (const segments of refused) expect(matchHubRoute(segments), segments.join("/")).toBeNull();
  });

  test("the proxy forwards the three calls, refuses other methods with Allow, and passes 202, 409 and 429 through", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answers: Record<string, Response> = {};
    const proxy = new HubProxy(proxyConfig(), {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return answers[`${init.method} ${url}`] ?? json({ error: { code: "not_found", message: "x" } }, 404);
      },
      rateLimiter: ALLOW,
    });
    answers[`GET ${HUB}/v1/fiber/node`] = json(HUB_NODE);
    let res = await proxy.handle(proxyRequest("v1/fiber/node"), ["v1", "fiber", "node"]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(HUB_NODE);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = JSON.stringify({ nodeId: NODE_ID, asset: "CKB" });
    answers[`POST ${HUB}/v1/fiber/inbound-channels`] = json({ nodeId: NODE_ID, asset: "CKB", fundingAmount: "100000000000", temporaryChannelId: "0x1" }, 202);
    res = await proxy.handle(proxyRequest("v1/fiber/inbound-channels", { method: "POST", body, headers: { "content-type": "application/json" } }), ["v1", "fiber", "inbound-channels"]);
    expect(res.status).toBe(202);
    expect(calls.at(-1)?.init.body).toBe(body);

    answers[`GET ${HUB}/v1/fiber/inbound-channels/${NODE_ID}`] = json({ data: [] });
    res = await proxy.handle(proxyRequest(`v1/fiber/inbound-channels/${NODE_ID}`), ["v1", "fiber", "inbound-channels", NODE_ID]);
    expect(await res.json()).toEqual({ data: [] });

    answers[`POST ${HUB}/v1/fiber/inbound-channels`] = json({ error: { code: "rate_limited", message: "Too many inbound channels today." } }, 429, { "retry-after": "3600" });
    res = await proxy.handle(proxyRequest("v1/fiber/inbound-channels", { method: "POST", body }), ["v1", "fiber", "inbound-channels"]);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3600");

    const forwarded = calls.length;
    for (const [method, p, allow] of [
      ["POST", "v1/fiber/node", "GET"],
      ["GET", "v1/fiber/inbound-channels", "POST"],
      ["POST", `v1/fiber/inbound-channels/${NODE_ID}`, "GET"],
      ["DELETE", `v1/fiber/inbound-channels/${NODE_ID}`, "GET"],
    ]) {
      res = await proxy.handle(proxyRequest(p, { method, body: method === "POST" ? "{}" : undefined }), p.split("/"));
      expect(res.status, `${method} ${p}`).toBe(405);
      expect(res.headers.get("allow")).toBe(allow);
    }
    res = await proxy.handle(proxyRequest("v1/fiber/inbound-channels/.."), ["v1", "fiber", "inbound-channels", ".."]);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(forwarded);
  });

  test("the proxy keeps its protections on the new paths: no hub, body size, rate limit", async () => {
    let fetched = 0;
    const fetch = async () => (fetched++, json({}));
    const noHub = new HubProxy(proxyConfig({ hubUrl: null }), { fetch, rateLimiter: ALLOW });
    let res = await noHub.handle(proxyRequest("v1/fiber/node"), ["v1", "fiber", "node"]);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("hub_unavailable");
    const small = new HubProxy(proxyConfig({ maxBodyBytes: 32 }), { fetch, rateLimiter: ALLOW });
    res = await small.handle(proxyRequest("v1/fiber/inbound-channels", { method: "POST", body: JSON.stringify({ nodeId: NODE_ID, asset: "CKB" }) }), [
      "v1",
      "fiber",
      "inbound-channels",
    ]);
    expect(res.status).toBe(413);
    const limited = new HubProxy(proxyConfig(), { fetch, rateLimiter: { take: () => ({ allowed: false, retryAfterMs: 5_000 }) } });
    res = await limited.handle(proxyRequest("v1/fiber/node"), ["v1", "fiber", "node"]);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(fetched).toBe(0);
  });

  test("the client calls the three endpoints through the same-origin proxy and unwraps the list", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new HubClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith("/fiber/node")) return json(HUB_NODE);
        if (init?.method === "POST") return json({ nodeId: NODE_ID, asset: "RUSD", fundingAmount: "2000000000", temporaryChannelId: "0x9" }, 202);
        return json({ data: [{ channelId: "0x1", asset: "CKB", state: "ready", hubBalance: "1", nodeBalance: "0" }] });
      },
    });
    expect(await client.getFiberNode()).toEqual(HUB_NODE);
    expect(await client.requestInboundChannel({ nodeId: NODE_ID, asset: "RUSD" })).toMatchObject({ fundingAmount: "2000000000" });
    expect(await client.listInboundChannels(NODE_ID)).toEqual([{ channelId: "0x1", asset: "CKB", state: "ready", hubBalance: "1", nodeBalance: "0" }]);
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      "GET /api/hub/v1/fiber/node",
      "POST /api/hub/v1/fiber/inbound-channels",
      `GET /api/hub/v1/fiber/inbound-channels/${NODE_ID}`,
    ]);
    expect(calls[1].init).toMatchObject({ body: JSON.stringify({ nodeId: NODE_ID, asset: "RUSD" }), cache: "no-store", headers: { "content-type": "application/json" } });
    expect(hubResourcePath(API_ROUTES.FIBER_INBOUND_CHANNELS, "../x")).toBe("/v1/fiber/inbound-channels/..%2Fx");
  });

  test("the hub's refusals reach the page as HubApiErrors with their codes", async () => {
    for (const [status, code, message] of [
      [404, "inbound_disabled", "This hub does not open inbound channels."],
      [409, "conflict", "Connect your node to the hub's node first."],
      [422, "asset_unavailable", "The hub does not open RUSD channels."],
      [429, "rate_limited", "Too many inbound channels today."],
    ] as const) {
      const client = new HubClient({ fetch: async () => json({ error: { code, message } }, status) });
      const error = await rejection(client.requestInboundChannel({ nodeId: NODE_ID, asset: "CKB" }));
      expect(error).toBeInstanceOf(HubApiError);
      expect(error).toMatchObject({ status, code, message });
    }
    const down = new HubClient({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(await rejection(down.getFiberNode())).toMatchObject({ status: 0, code: "hub_unavailable" });
  });
});

test.describe("tokens the node can withdraw from its address (lib/wallets/fiber-browser/token-withdraw.ts)", () => {
  const RUSD = { codeHash: `0x${"11".repeat(32)}`, hashType: "type" as const, args: `0x${"22".repeat(32)}` };
  const CWBTC = { codeHash: `0x${"33".repeat(32)}`, hashType: "type" as const, args: `0x${"44".repeat(36)}` };
  const DEP = { outPoint: { txHash: `0x${"55".repeat(32)}`, index: "0x0" }, depType: "code" as const };

  test("each hub token with a whitelist entry, with that entry's cell deps; CKB and tokens without an entry left out", () => {
    const tokens = [
      { id: "CKB", symbol: "CKB", decimals: 8, udtTypeScript: null },
      { id: "RUSD", symbol: "RUSD", decimals: 8, udtTypeScript: RUSD },
      { id: "CWBTC", symbol: "cWBTC", decimals: 8, udtTypeScript: CWBTC },
    ];
    const whitelist = [{ name: "RUSD", script: { ...RUSD, args: RUSD.args.toUpperCase().replace("0X", "0x") }, cellDeps: [DEP], autoAcceptAmount: null }];
    expect(withdrawableTokens(tokens, whitelist)).toEqual([
      { id: "RUSD", symbol: "RUSD", decimals: 8, token: { symbol: "RUSD", script: whitelist[0]!.script, cellDeps: [DEP] } },
    ]);
    expect(withdrawableTokens(tokens, [])).toEqual([]);
  });
});
