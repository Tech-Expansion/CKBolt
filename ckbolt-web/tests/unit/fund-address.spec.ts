import { expect, test } from "@playwright/test";
import { presenceOf, type BridgeContext } from "../../components/app/fiber-node/use-bridge-server";
import { encodeBech32, toWords } from "../../lib/bech32";
import type { Script } from "../../lib/hub/contract";
import type { NodePresence } from "../../lib/wallets/fiber-browser/bridge-protocol";
import { addressToScript, scriptToAddress } from "../../lib/wallets/fiber-browser/ckb-address";
import { fundTarget, ownNodeAddress, sameCkbAddress } from "../../lib/wallets/fiber-browser/fund-address";

/*
 * The funding page's address (security review W7, lib/wallets/fiber-browser/fund-address.ts): the link's address is only
 * a claim; the page funds it only when it is the node's own (compared by lock script), and then sends to the node's own
 * spelling of it. The page itself is tests/e2e/fund-fiber-node.spec.ts.
 */

const SECP_CODE_HASH = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const ARGS = `0x${"ab".repeat(20)}`;
const OTHER_ARGS = `0x${"cd".repeat(20)}`;
const lock = (args = ARGS): Script => ({ codeHash: SECP_CODE_HASH, hashType: "type", args });

const hexBytes = (hex: string): number[] => Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));

/** The same lock in each spelling RFC 0021 allows: the full format, the short format and the deprecated full type format. */
function spellings(args = ARGS, hrp: "ckt" | "ckb" = "ckt") {
  return {
    full: scriptToAddress(lock(args), hrp === "ckt" ? "testnet" : "mainnet"),
    short: encodeBech32(hrp, toWords([0x01, 0x00, ...hexBytes(args)]), "bech32"),
    deprecated: encodeBech32(hrp, toWords([0x04, ...hexBytes(SECP_CODE_HASH), ...hexBytes(args)]), "bech32"),
  };
}

const MINE = spellings();
const THEIRS = spellings(OTHER_ARGS);
const MINE_ON_MAINNET = spellings(ARGS, "ckb");

const presence = (overrides: Partial<NodePresence> = {}): NodePresence => ({
  phase: "running",
  nodeId: `02${"11".repeat(32)}`,
  network: "testnet",
  hubConnected: true,
  liquidity: {},
  address: MINE.full,
  ...overrides,
});

test.describe("fund-address.ts: is the link's address the node's own?", () => {
  test("the spellings are really different strings for one lock", () => {
    expect(new Set(Object.values(MINE)).size).toBe(3);
    for (const address of Object.values(MINE)) expect(addressToScript(address)).toEqual({ network: "testnet", script: lock() });
  });

  test("sameCkbAddress: the same lock on the same network, however each address is written", () => {
    const all = Object.values(MINE);
    for (const a of all) for (const b of all) expect(sameCkbAddress(a, b), `${a} / ${b}`).toBe(true);
    // Upper-case hex in the script is the same lock (sameScript ignores the case of hex).
    expect(sameCkbAddress(scriptToAddress({ ...lock(), args: ARGS.toUpperCase().replace("0X", "0x") }, "testnet"), MINE.short)).toBe(true);
  });

  test("sameCkbAddress: another lock, the same lock on mainnet, or anything that is not an address is never the same", () => {
    for (const mine of Object.values(MINE)) {
      for (const theirs of Object.values(THEIRS)) expect(sameCkbAddress(mine, theirs)).toBe(false);
      for (const mainnet of Object.values(MINE_ON_MAINNET)) expect(sameCkbAddress(mine, mainnet)).toBe(false);
      // Same args, another code hash or hash type.
      expect(sameCkbAddress(mine, scriptToAddress({ ...lock(), hashType: "data1" }, "testnet"))).toBe(false);
      expect(sameCkbAddress(mine, scriptToAddress({ ...lock(), codeHash: `0x${"00".repeat(32)}` }, "testnet"))).toBe(false);
      // Longer args that start with the node's.
      expect(sameCkbAddress(mine, scriptToAddress(lock(`${ARGS}00`), "testnet"))).toBe(false);
      for (const garbage of ["", "hello", "ckt1", mine.slice(0, -1), `${mine}q`, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"]) {
        expect(sameCkbAddress(mine, garbage), garbage).toBe(false);
        expect(sameCkbAddress(garbage, mine), garbage).toBe(false);
      }
    }
    expect(sameCkbAddress("garbage", "garbage")).toBe(false);
  });

  test("ownNodeAddress: the running node's own address first, then the one kept next to its key", () => {
    expect(ownNodeAddress(presence(), THEIRS.full, "testnet")).toBe(MINE.full);
    expect(ownNodeAddress(presence({ address: MINE.short }), null, "testnet")).toBe(MINE.short);
    // No node tab, a tab of an older page (no address), or a node that does not run yet: the kept address.
    expect(ownNodeAddress(null, THEIRS.full, "testnet")).toBe(THEIRS.full);
    const { address: _none, ...older } = presence();
    expect(ownNodeAddress(older as NodePresence, THEIRS.full, "testnet")).toBe(THEIRS.full);
    expect(ownNodeAddress(presence({ phase: "locked", address: null }), THEIRS.full, "testnet")).toBe(THEIRS.full);
    expect(ownNodeAddress(null, null, "testnet")).toBeNull();
    expect(ownNodeAddress(presence({ address: null }), null, "testnet")).toBeNull();
  });

  test("ownNodeAddress: a presence or an address on another network, or one that is not an address, is ignored", () => {
    // A node tab on another network.
    expect(ownNodeAddress(presence({ network: "mainnet", address: MINE_ON_MAINNET.full }), null, "testnet")).toBeNull();
    expect(ownNodeAddress(presence({ network: "mainnet", address: MINE.full }), THEIRS.full, "testnet")).toBe(THEIRS.full);
    // A testnet tab that reports a mainnet address, or garbage, or something that is not a string.
    expect(ownNodeAddress(presence({ address: MINE_ON_MAINNET.full }), null, "testnet")).toBeNull();
    expect(ownNodeAddress(presence({ address: "hello" }), THEIRS.full, "testnet")).toBe(THEIRS.full);
    expect(ownNodeAddress(presence({ address: 42 as unknown as string }), null, "testnet")).toBeNull();
    // A kept address on another network, or garbage.
    expect(ownNodeAddress(null, MINE_ON_MAINNET.full, "testnet")).toBeNull();
    expect(ownNodeAddress(null, "not an address", "testnet")).toBeNull();
    // On mainnet the other way round.
    expect(ownNodeAddress(presence({ network: "mainnet", address: MINE_ON_MAINNET.short }), MINE.full, "mainnet")).toBe(MINE_ON_MAINNET.short);
  });

  test("fundTarget: no link address, no known own address, the node's own (its spelling), or someone else's", () => {
    expect(fundTarget(null, MINE.full)).toEqual({ kind: "missing" });
    expect(fundTarget(null, null)).toEqual({ kind: "missing" });
    expect(fundTarget(MINE.full, null)).toEqual({ kind: "unconfirmed" });
    expect(fundTarget(MINE.full, MINE.full)).toEqual({ kind: "own", address: MINE.full });
    // The link's spelling is not the one sent to: the node's own is.
    expect(fundTarget(MINE.short, MINE.full)).toEqual({ kind: "own", address: MINE.full });
    expect(fundTarget(MINE.deprecated, MINE.full)).toEqual({ kind: "own", address: MINE.full });
    expect(fundTarget(MINE.full, MINE.short)).toEqual({ kind: "own", address: MINE.short });
    // Someone else's: the target names the node's own address only, never the link's.
    const mismatch = fundTarget(THEIRS.full, MINE.full);
    expect(mismatch).toEqual({ kind: "mismatch", own: MINE.full });
    expect(JSON.stringify(mismatch)).not.toContain(THEIRS.full);
    expect(fundTarget(THEIRS.short, MINE.short)).toEqual({ kind: "mismatch", own: MINE.short });
    // The node's lock written as a mainnet address is not the node's testnet address.
    expect(fundTarget(MINE_ON_MAINNET.full, MINE.full)).toEqual({ kind: "mismatch", own: MINE.full });
  });

  test("the node tab's presence carries its own address, from its funding lock, and nothing while the lock is unknown", () => {
    const ctx = {
      state: { phase: "running", info: null, error: null, exclusive: true },
      node: null,
      network: "testnet",
      hubNode: null,
      hubConnected: false,
      channels: [],
      balance: null,
      contributionCkb: null,
      nodeLock: lock(),
    } as unknown as BridgeContext;
    expect(presenceOf(ctx).address).toBe(MINE.full);
    expect(presenceOf({ ...ctx, nodeLock: null }).address).toBeNull();
    // A lock no address can name (a code hash of the wrong length) is no address, not an error.
    expect(presenceOf({ ...ctx, nodeLock: { ...lock(), codeHash: "0x1234" } }).address).toBeNull();
    // On the funding page, a running node's presence is its own address.
    expect(ownNodeAddress(presenceOf(ctx), null, "testnet")).toBe(MINE.full);
  });
});
