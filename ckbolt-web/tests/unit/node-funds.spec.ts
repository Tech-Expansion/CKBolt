import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { ccc } from "@ckb-ccc/connector-react";
import { encodeBech32, toWords } from "../../lib/bech32";
import { cccNodeClient, withdrawAll } from "../../lib/wallets/fiber-browser/ccc-withdraw";
import { addressToScript, scriptToAddress } from "../../lib/wallets/fiber-browser/ckb-address";
import { channelsMovingFunds } from "../../lib/wallets/fiber-browser/channels";
import { FiberJsNode, type FiberLike } from "../../lib/wallets/fiber-browser/fiber-js-adapter";
import { generateNodeKeys, type NodeKeys } from "../../lib/wallets/fiber-browser/keys";
import {
  DESTINATION_ERROR,
  parseCkbDestination,
  WITHDRAW_BLOCK,
  WITHDRAW_FAILURE,
  withdrawBlock,
  WithdrawError,
} from "../../lib/wallets/fiber-browser/withdraw";
import { TESTNET_RUSD } from "../../lib/wallets/fiber-byo/constants";
import {
  FakeCkbChain,
  rpcTransactionHash,
  sameScript,
  secpLock,
  udtData,
  units,
  type JsonRpcRequest,
  type Script,
} from "../e2e/fiber-byo-fakes";

/*
 * Getting CKB back from the browser node (lib/wallets/fiber-browser/withdraw.ts, ccc-withdraw.ts): the addresses a
 * visitor gives for it, when a withdrawal may run, the close_script of shutdown_channel, and the withdrawal itself,
 * built, signed with the node's CKB key and sent through CCC to a fake CKB testnet (tests/e2e/fiber-byo-fakes.ts).
 */

const SECP_CODE_HASH = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const HEX = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;
/** A lock like JoyID's: another code hash, hash type data1, 22 bytes of args. */
const otherLock = (): Script => ({ codeHash: HEX(Buffer.alloc(32, 0xd2)), hashType: "data1", args: HEX(Buffer.alloc(22, 0x07)) });

/** A client CCC uses only offline here (known scripts, address parsing); nothing is ever sent to it. */
const offlineClient = (network: "testnet" | "mainnet" = "testnet") =>
  network === "testnet"
    ? new ccc.ClientPublicTestnet({ url: "http://127.0.0.1:9/", fallbacks: [] })
    : new ccc.ClientPublicMainnet({ url: "http://127.0.0.1:9/", fallbacks: [] });

const fromCcc = (s: ccc.Script): Script => ({ codeHash: s.codeHash, hashType: s.hashType, args: s.args });

/** A short-format (0x01) or deprecated full-format (0x02, 0x04) address, bech32 as RFC 0021 writes them. */
const legacyAddress = (prefix: string, bytes: number[]): string => encodeBech32(prefix, toWords(bytes), "bech32");
const bytesOf = (hex: string): number[] => Array.from(Buffer.from(hex.slice(2), "hex"));

test.describe("CKB addresses for the node's CKB", () => {
  test("every address format reads back as the lock CCC reads from it, with its network", async () => {
    const secp = secpLock();
    const other = otherLock();
    const addresses = [
      scriptToAddress(secp, "testnet"),
      scriptToAddress(other, "testnet"),
      scriptToAddress(secp, "mainnet"),
      // Short format: secp256k1 (index 0), multisig (1), anyone-can-pay (2).
      legacyAddress("ckt", [0x01, 0x00, ...bytesOf(secp.args)]),
      legacyAddress("ckt", [0x01, 0x01, ...bytesOf(secp.args)]),
      legacyAddress("ckt", [0x01, 0x02, ...bytesOf(secp.args)]),
      legacyAddress("ckb", [0x01, 0x02, ...bytesOf(secp.args)]),
      // Deprecated full formats: hash type data (0x02) and type (0x04).
      legacyAddress("ckt", [0x02, ...bytesOf(other.codeHash), ...bytesOf(other.args)]),
      legacyAddress("ckt", [0x04, ...bytesOf(other.codeHash), ...bytesOf(other.args)]),
    ];
    for (const address of addresses) {
      const parsed = addressToScript(address);
      const network = address.startsWith("ckt") ? "testnet" : "mainnet";
      expect(parsed.network, address).toBe(network);
      const viaCcc = await ccc.Address.fromString(address, offlineClient(network));
      expect(parsed.script, address).toEqual(fromCcc(viaCcc.script));
    }
    expect(addressToScript(scriptToAddress(secp, "testnet")).script).toEqual(secp);
    expect(addressToScript(`  ${scriptToAddress(other, "testnet")} `).script).toEqual(other);
  });

  test("anything else is refused with a sentence", () => {
    expect(() => addressToScript("hello")).toThrow();
    expect(() => addressToScript("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toThrow(/ckb1 \(mainnet\) or ckt1 \(testnet\)/);
    // A short format with an unknown code hash index.
    expect(() => addressToScript(legacyAddress("ckt", [0x01, 0x03, ...bytesOf(secpLock().args)]))).toThrow();
  });

  test("a destination must be on the node's network and not the node's own address; it is read trimmed", () => {
    const node = secpLock();
    const wallet = otherLock();
    expect(parseCkbDestination("", "testnet", node)).toEqual({ status: "empty" });
    expect(parseCkbDestination("   ", "testnet", node)).toEqual({ status: "empty" });
    expect(parseCkbDestination("not an address", "testnet", node)).toMatchObject({ status: "invalid" });
    expect(parseCkbDestination(scriptToAddress(wallet, "mainnet"), "testnet", node)).toEqual({
      status: "invalid",
      error: DESTINATION_ERROR.WRONG_NETWORK("testnet"),
    });
    expect(DESTINATION_ERROR.WRONG_NETWORK("testnet")).toBe("This address is not on CKB testnet. Use a CKB testnet address (ckt1…), like the node's.");
    expect(parseCkbDestination(scriptToAddress(node, "testnet"), "testnet", node)).toEqual({ status: "invalid", error: DESTINATION_ERROR.OWN_ADDRESS });
    // The node's lock written as a short address is still the node's own.
    expect(parseCkbDestination(legacyAddress("ckt", [0x01, 0x00, ...bytesOf(node.args)]), "testnet", node)).toMatchObject({ status: "invalid" });
    const address = scriptToAddress(wallet, "testnet");
    expect(parseCkbDestination(` ${address}\n`, "testnet", node)).toEqual({ status: "ok", address, script: wallet });
    // Before the node runs its lock is unknown: only the network is checked.
    expect(parseCkbDestination(scriptToAddress(node, "testnet"), "testnet", null)).toMatchObject({ status: "ok" });
  });
});

test.describe("when the node's on-chain CKB may be withdrawn", () => {
  test("not while a channel opens or closes: fnn may be spending those cells", () => {
    const moving = ["NegotiatingFunding", "CollaboratingFundingTx", "SigningCommitment", "AwaitingTxSignatures", "AwaitingChannelReady", "ShuttingDown"];
    for (const state of moving) expect(channelsMovingFunds([{ state }]), state).toHaveLength(1);
    expect(channelsMovingFunds([{ state: "ChannelReady" }, { state: "Closed" }])).toEqual([]);
    expect(withdrawBlock(units(600), [{ state: "ChannelReady" }, { state: "AwaitingChannelReady" }])).toBe(WITHDRAW_BLOCK.CHANNELS_MOVING);
    expect(withdrawBlock(units(600), [{ state: "ShuttingDown" }])).toBe(WITHDRAW_BLOCK.CHANNELS_MOVING);
    // A ready channel keeps its CKB; the rest can go.
    expect(withdrawBlock(units(600), [{ state: "ChannelReady" }])).toBeNull();
  });

  test("not before the balance is read, nor with nothing or less than one CKB cell", () => {
    expect(withdrawBlock(null, [])).toBe(WITHDRAW_BLOCK.BALANCE_UNKNOWN);
    expect(withdrawBlock(BigInt(0), [])).toBe(WITHDRAW_BLOCK.NOTHING);
    expect(withdrawBlock(units(61), [])).toBe(WITHDRAW_BLOCK.TOO_LITTLE);
    expect(WITHDRAW_BLOCK.TOO_LITTLE).toBe("Too little CKB to withdraw: a CKB cell needs at least 61 CKB.");
    expect(withdrawBlock(units(61) + BigInt(1), [])).toBeNull();
  });
});

test.describe("shutdown_channel's close_script", () => {
  function recordingFiber() {
    const calls: { name: string; args: unknown[] | undefined }[] = [];
    const fiber: FiberLike = {
      start: async () => {},
      stop: async () => {},
      invokeCommand: async (name, args) => {
        calls.push({ name, args });
        return null;
      },
    };
    return { fiber, calls };
  }

  test("without a target fnn pays the node's own address; with one, the lock goes in fnn's form", async () => {
    const { fiber, calls } = recordingFiber();
    const node = new FiberJsNode(fiber);
    await node.shutdownChannel("0xchan1");
    await node.shutdownChannel("0xchan2", null);
    const wallet = otherLock();
    await node.shutdownChannel("0xchan3", wallet);
    expect(calls).toEqual([
      { name: "shutdown_channel", args: [{ channel_id: "0xchan1" }] },
      { name: "shutdown_channel", args: [{ channel_id: "0xchan2" }] },
      { name: "shutdown_channel", args: [{ channel_id: "0xchan3", close_script: { code_hash: wallet.codeHash, hash_type: "data1", args: wallet.args } }] },
    ]);
  });
});

/* ------------------------------------------------------------------------------- the withdrawal, on a fake chain */

/** A JSON-RPC server for one FakeCkbChain, like the CKB testnet public RPC. */
async function startRpc(chain: FakeCkbChain): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const payload = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
      const answer = Array.isArray(payload) ? payload.map((p) => chain.handle(p)) : chain.handle(payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server };
}

interface Setup {
  chain: FakeCkbChain;
  client: ccc.Client;
  keys: NodeKeys;
  nodeLock: Script;
  close: () => Promise<void>;
}

/** A node (fresh keys) whose lock is the secp256k1 lock of its CKB key, as fnn makes it, with these plain cells. */
async function setup(ckbCells: number[] = [600, 400]): Promise<Setup> {
  const chain = new FakeCkbChain();
  const { url, server } = await startRpc(chain);
  const client = cccNodeClient(url, "testnet");
  const keys = generateNodeKeys();
  const own = await new ccc.SignerCkbPrivateKey(client, HEX(keys.ckbKey)).getRecommendedAddressObj();
  const nodeLock = fromCcc(own.script);
  expect(nodeLock.codeHash).toBe(SECP_CODE_HASH);
  for (const ckb of ckbCells) chain.addCell({ lock: nodeLock, capacity: units(ckb) });
  return { chain, client, keys, nodeLock, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const wiped = (keys: NodeKeys) => keys.ckbKey.every((b) => b === 0) && keys.fiberKey.every((b) => b === 0);

async function failure(promise: Promise<unknown>): Promise<WithdrawError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(WithdrawError);
    return e as WithdrawError;
  }
  throw new Error("expected the withdrawal to fail");
}

test.describe("withdraw: the node's on-chain CKB to the visitor (CCC private-key signer, fake CKB testnet)", () => {
  test("every plain cell at the node goes to the destination in one output, minus a small fee, signed; tokens and others' cells stay", async () => {
    const s = await setup([600, 400]);
    try {
      const rusd = s.chain.addCell({ lock: s.nodeLock, capacity: units(142), type: TESTNET_RUSD.script, data: udtData(units(20)) });
      const stranger = s.chain.addCell({ lock: secpLock(), capacity: units(5_000) });
      const wallet = secpLock();
      const receipt = await withdrawAll({ client: s.client, keys: s.keys, nodeLock: s.nodeLock, to: wallet });

      expect(s.chain.sent).toHaveLength(1);
      const tx = s.chain.sent[0];
      expect(receipt.txHash).toBe(rpcTransactionHash(tx));
      // One output: the wallet, a plain cell, all 1,000 CKB but the fee.
      expect(tx.outputs).toHaveLength(1);
      expect(sameScript(tx.outputs[0].lock, wallet)).toBe(true);
      expect(tx.outputs[0].type ?? null).toBeNull();
      expect(tx.outputs_data).toEqual(["0x"]);
      const amount = BigInt(tx.outputs[0].capacity);
      expect(receipt.amount).toBe(amount);
      expect(receipt.fee).toBe(units(1_000) - amount);
      expect(receipt.fee).toBeGreaterThan(BigInt(0));
      expect(receipt.fee).toBeLessThan(units(1) / BigInt(100));
      // Inputs: the node's two plain cells, not its RUSD cell, not anyone else's.
      const spent = tx.inputs.map((i) => s.chain.cells.find((c) => c.txHash === i.previous_output.tx_hash)!);
      expect(spent.map((c) => c.capacity).sort()).toEqual([units(400), units(600)].sort());
      expect(spent.every((c) => sameScript(c.lock, s.nodeLock) && c.type === null)).toBe(true);
      expect(spent).not.toContain(rusd);
      expect(spent).not.toContain(stranger);
      // Signed with the node's key: a 65-byte signature in the first witness, and the secp256k1 dep group.
      expect(tx.witnesses[0].length).toBeGreaterThan(2 + 130);
      expect(tx.cell_deps.some((d) => d.dep_type === "dep_group")).toBe(true);
      expect(wiped(s.keys)).toBe(true);
      expect(s.chain.unknown).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("a destination with another lock (JoyID-like: data1, 22-byte args) gets all of it too", async () => {
    const s = await setup([200]);
    try {
      const wallet = otherLock();
      const receipt = await withdrawAll({ client: s.client, keys: s.keys, nodeLock: s.nodeLock, to: wallet });
      const tx = s.chain.sent[0];
      expect(sameScript(tx.outputs[0].lock, wallet)).toBe(true);
      expect(receipt.amount + receipt.fee).toBe(units(200));
    } finally {
      await s.close();
    }
  });

  test("a key that does not sign for the node's address sends nothing and reads nothing; the keys are wiped", async () => {
    const s = await setup();
    try {
      const error = await failure(withdrawAll({ client: s.client, keys: s.keys, nodeLock: secpLock(), to: otherLock() }));
      expect(error.code).toBe(WITHDRAW_FAILURE.KEY_MISMATCH);
      expect(error.message).toBe("This key does not sign for the node's address, so nothing was sent.");
      expect(s.chain.count("get_cells")).toBe(0);
      expect(s.chain.sent).toEqual([]);
      expect(wiped(s.keys)).toBe(true);
    } finally {
      await s.close();
    }
  });

  test("nothing at the node, or too little for the new cell and the fee: a plain sentence, nothing sent, keys wiped", async () => {
    const empty = await setup([]);
    try {
      const error = await failure(withdrawAll({ client: empty.client, keys: empty.keys, nodeLock: empty.nodeLock, to: secpLock() }));
      expect(error.code).toBe(WITHDRAW_FAILURE.NOTHING);
      expect(empty.chain.sent).toEqual([]);
      expect(wiped(empty.keys)).toBe(true);
    } finally {
      await empty.close();
    }
    const short = await setup([61]);
    try {
      const error = await failure(withdrawAll({ client: short.client, keys: short.keys, nodeLock: short.nodeLock, to: secpLock() }));
      expect(error.code).toBe(WITHDRAW_FAILURE.TOO_LITTLE);
      expect(error.message).toBe("Too little CKB to withdraw: the new cell needs at least 61 CKB plus the fee.");
      expect(short.chain.sent).toEqual([]);
      expect(wiped(short.keys)).toBe(true);
    } finally {
      await short.close();
    }
  });

  test("CKB testnet refusing the signed transaction is said so; one it already holds counts as sent", async () => {
    const s = await setup();
    try {
      s.chain.onSend = () => ({ error: { code: -302, message: "TransactionFailedToVerify: Verification failed" } });
      const error = await failure(withdrawAll({ client: s.client, keys: s.keys, nodeLock: s.nodeLock, to: secpLock() }));
      expect(error.code).toBe(WITHDRAW_FAILURE.REJECTED);
      expect(error.message).toMatch(/^CKB testnet did not accept the withdrawal .*so nothing was sent\. Try again\.$/);
      expect(wiped(s.keys)).toBe(true);
    } finally {
      await s.close();
    }
    const again = await setup();
    try {
      let hash = "";
      again.chain.onSend = (tx) => {
        hash = rpcTransactionHash(tx);
        return { error: { code: -1107, message: "PoolRejectedDuplicatedTransaction" } };
      };
      const receipt = await withdrawAll({ client: again.client, keys: again.keys, nodeLock: again.nodeLock, to: secpLock() });
      expect(receipt.txHash).toBe(hash);
    } finally {
      await again.close();
    }
  });
});
