import { ccc } from "@ckb-ccc/core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { BrowserContext, Page } from "@playwright/test";
import type { NodePresence } from "../../../lib/wallets/fiber-browser/bridge-protocol";
import { BRIDGE_CHANNEL_NAME, BRIDGE_PROTOCOL_VERSION, BROWSER_NODE_NETWORK, STORAGE_NAME } from "../../../lib/wallets/fiber-browser/constants";
import { generateNodeKeys, type NodeKeys } from "../../../lib/wallets/fiber-browser/keys";
import { browserKeystoreDeps, encryptKeys, serializeKeystore, type KdfParams, type KeystoreRecord } from "../../../lib/wallets/fiber-browser/keystore";
import { storageKey } from "../../../lib/wallets/fiber-browser/storage";

/*
 * The node's key as this browser keeps it, and a node tab, for the specs that need them without running a node page:
 * a keystore record made here with the app's own code (an older page's record: a short password, a cheaper scrypt, the
 * node's public address next to it), put into the page's localStorage before the page loads; and a stand-in node tab
 * that answers the bridge's status request (BroadcastChannel, same origin) with the presence a test gives it.
 */

/** Where the page keeps the testnet node's keystore (lib/wallets/fiber-browser/storage.ts). */
export const KEYSTORE_KEY = storageKey(BROWSER_NODE_NETWORK, STORAGE_NAME.KEYSTORE);

/** A cheap scrypt, as a page older than today's parameters might have used. */
export const OLD_KDF: KdfParams = { logN: 10, r: 8, p: 1 };

const SECP_CODE_HASH = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";

/** The node id and CKB address the fake fiber-js reports for these keys (its nodeId is "02" + sha256(P2P key)). */
export function fakeNodeIdentity(keys: NodeKeys): { nodeId: string; address: string } {
  const lockArgs = ccc.hashCkb(secp256k1.getPublicKey(keys.ckbKey, true)).slice(0, 42);
  return {
    nodeId: `02${bytesToHex(sha256(keys.fiberKey))}`,
    address: ccc.Address.from({ script: { codeHash: SECP_CODE_HASH, hashType: "type", args: lockArgs }, prefix: "ckt" }).toString(),
  };
}

/** Copies of the keys, so a test can compare what the node started with. */
export const keysHex = (keys: NodeKeys) => ({ fiberKey: bytesToHex(keys.fiberKey), ckbKey: bytesToHex(keys.ckbKey) });

/** Keys from their hex (a fresh copy each time: encryptKeys and the node may wipe what they are given). */
export const keysFromHex = (hex: { fiberKey: string; ckbKey: string }): NodeKeys => ({ fiberKey: hexToBytes(hex.fiberKey), ckbKey: hexToBytes(hex.ckbKey) });

export interface StoredKey {
  record: KeystoreRecord;
  /** The record as the page stores it (and as a backup file holds it). */
  text: string;
  keys: { fiberKey: string; ckbKey: string };
}

/**
 * A keystore record made with the app's own encryptKeys: by default new keys under a short password with OLD_KDF, no
 * node id and no address (set `nodeId` and `address` for a record the node already wrote to).
 */
export async function makeStoredKey(opts: {
  password: string;
  kdf?: KdfParams;
  keys?: NodeKeys;
  nodeId?: string | null;
  address?: string | null;
  createdAt?: string;
}): Promise<StoredKey> {
  const keys = keysHex(opts.keys ?? generateNodeKeys());
  const created = opts.createdAt ? new Date(opts.createdAt) : new Date();
  const record = {
    ...(await encryptKeys(keysFromHex(keys), opts.password, BROWSER_NODE_NETWORK, { ...browserKeystoreDeps(), now: () => created }, opts.kdf ?? OLD_KDF)),
    nodeId: opts.nodeId ?? null,
    address: opts.address ?? null,
  };
  return { record, text: serializeKeystore(record), keys };
}

/** A record that holds only the node's public address, as the node writes it once it ran (the funding page reads that). */
export async function keystoreWithAddress(address: string): Promise<string> {
  return (await makeStoredKey({ password: "a password nobody types here", address })).text;
}

/**
 * Puts `text` into the page's (or every page's) localStorage as the node's keystore before the site's scripts run, unless
 * one is there already: a reload keeps what the page itself wrote since.
 */
export async function seedKeystore(target: Page | BrowserContext, text: string) {
  await target.addInitScript(
    ({ key, value }) => {
      try {
        if (location.origin !== "null" && localStorage.getItem(key) === null) localStorage.setItem(key, value);
      } catch {
        // A document without storage (an opaque origin) has no keystore.
      }
    },
    { key: KEYSTORE_KEY, value: text },
  );
}

/** The keystore record the page holds now, parsed, or null. */
export async function storedKeystore(page: Page): Promise<(KeystoreRecord & Record<string, unknown>) | null> {
  const text = await page.evaluate((key) => localStorage.getItem(key), KEYSTORE_KEY);
  return text === null ? null : JSON.parse(text);
}

/* ------------------------------------------------------------------------------------------- node tab */

/** A stand-in node tab: answers the bridge's status requests with its presence, which the test may change. */
export interface FakeNodeTab {
  page: Page;
  setPresence(presence: Partial<NodePresence> | null): Promise<void>;
  /** How many status requests it has seen. */
  asked(): Promise<number>;
}

/** What a running testnet node tab says about itself (lib/wallets/fiber-browser/bridge-protocol.ts NodePresence). */
export const runningPresence = (address: string | null, overrides: Partial<NodePresence> = {}): NodePresence => ({
  phase: "running",
  nodeId: `02${"5a".repeat(32)}`,
  network: BROWSER_NODE_NETWORK,
  hubConnected: true,
  liquidity: {},
  onChainCkb: null,
  contributionCkb: null,
  address,
  ...overrides,
});

/**
 * Opens a tab of the site that answers the bridge like a node tab. It loads the site's icon, a same-origin document with
 * no app code, so its answers are the only ones; a null presence answers nothing (no node tab).
 */
export async function openFakeNodeTab(context: BrowserContext, presence: Partial<NodePresence> | null): Promise<FakeNodeTab> {
  const page = await context.newPage();
  await page.goto("/icon.svg");
  await page.evaluate(
    ({ name, version, presence }) => {
      const w = window as unknown as { __fakeNode: { presence: unknown; asked: number; channel: BroadcastChannel } };
      const channel = new BroadcastChannel(name);
      w.__fakeNode = { presence, asked: 0, channel };
      channel.onmessage = (event) => {
        const data = event.data as { v?: number; kind?: string; id?: string; method?: string } | null;
        if (!data || data.v !== version || data.kind !== "request" || data.method !== "status" || typeof data.id !== "string") return;
        w.__fakeNode.asked++;
        if (w.__fakeNode.presence === null) return;
        channel.postMessage({ v: version, kind: "response", id: data.id, ok: true, result: w.__fakeNode.presence });
      };
    },
    { name: BRIDGE_CHANNEL_NAME, version: BRIDGE_PROTOCOL_VERSION, presence },
  );
  return {
    page,
    setPresence: (next) =>
      page.evaluate((p) => {
        (window as unknown as { __fakeNode: { presence: unknown } }).__fakeNode.presence = p;
      }, next),
    asked: () => page.evaluate(() => (window as unknown as { __fakeNode: { asked: number } }).__fakeNode.asked),
  };
}

/* ------------------------------------------------------------------------------------- page states */

/**
 * Records, in order, each of `testIds` the first time it appears in the page (a MutationObserver from before the page's
 * scripts run), so a test can tell which states a page went through, however briefly one showed.
 */
export async function recordStates(page: Page, testIds: readonly string[]) {
  await page.addInitScript((ids) => {
    const w = window as unknown as { __statesSeen: string[] };
    w.__statesSeen = [];
    const look = () => {
      for (const id of ids) if (!w.__statesSeen.includes(id) && document.querySelector(`[data-testid="${id}"]`)) w.__statesSeen.push(id);
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
  }, testIds as string[]);
}

/** The states recordStates saw so far, in the order they first appeared. */
export const statesSeen = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __statesSeen: string[] }).__statesSeen);
