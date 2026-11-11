import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { connectPeerRequest, curlCommand, newInvoiceRequest, rpcBody, rpcQuantity, sendPaymentRequest, shellQuote } from "../../lib/wallets/fiber-byo/rpc-commands";
import { FIBER_CHANNEL_MESSAGE, fiberChannelError, fiberChannelStatus, shownFiberChannel } from "../../lib/wallets/fiber-byo/hub-fiber-channel";
import type { InboundChannelDto } from "../../lib/hub/contract";
import { ccc } from "@ckb-ccc/connector-react";
import { encodeBech32 } from "../../lib/bech32";
import { encodeUnsignedBolt11 } from "../../lib/bolt11";
import { demoFiberInvoice } from "../../lib/payment-request";
import {
  CKB_TESTNET_EXPLORER_URL,
  FIBER_CURRENCY,
  FIBER_FUNDING,
  MAX_PAYOUT_INVOICE_LENGTH,
  TESTNET_RUSD,
  TYPE_ID_CODE_HASH,
} from "../../lib/wallets/fiber-byo/constants";
import { fiberNetworkOf, invoicePrefix } from "../../lib/wallets/fiber-byo/network";
import { checkByoInvoice, formatAssetAmount, type ByoInvoiceExpectation } from "../../lib/wallets/fiber-byo/invoice-check";
import {
  CKB_FUNDING_TOKEN,
  checkFundingAmount,
  ckbPresetAmount,
  explorerTxUrl,
  formatFunding,
  FUNDING_FAILURE,
  FUNDING_PRESETS,
  FundingError,
  fundingErrorMessage,
  fundingUnits,
  lockScriptToAddress,
  parseFundingTarget,
  parseLockScriptJson,
  presetsFor,
  TESTNET_FUNDING_TOKENS,
  type FundingToken,
} from "../../lib/wallets/fiber-byo/funding";
import { cccFundingTransport } from "../../lib/wallets/fiber-byo/ccc-funding";
import {
  FakeCkbChain,
  readUdtData,
  rpcTransactionHash,
  sameScript,
  secpLock,
  udtData,
  units,
  type JsonRpcRequest,
  type RpcTransaction,
  type Script,
} from "../e2e/fiber-byo-fakes";

/*
 * Bring your own Fiber node (phase 3b): the network helpers and the pre-check of the invoice pasted on the swap card,
 * "Fund this node" (with a real CCC signer against a fake CKB node). Specification:
 * ../ckbolt-hub/docs/research/fiber-browser-wallet.md (sections 2.2, 4 and 7).
 */

const CKB_DECIMALS = 8;
const QUOTED = "1980000000000"; // 19,800 CKB
const CKB_EXPECTED: ByoInvoiceExpectation = { network: "testnet", amount: QUOTED, decimals: CKB_DECIMALS, symbol: "CKB" };
const RUSD_TOKEN = TESTNET_FUNDING_TOKENS.find((t) => t.symbol === "RUSD")!;

/* ------------------------------------------------------------------------------------------------ network */

test.describe("fiber-byo network helpers", () => {
  test("the hub's CKB network is read from its health; anything else means testnet", () => {
    expect(fiberNetworkOf("testnet")).toBe("testnet");
    expect(fiberNetworkOf("mainnet")).toBe("mainnet");
    expect(fiberNetworkOf("devnet")).toBe("devnet");
    for (const unknown of [null, undefined, "", "signet", "Testnet", "toString", "__proto__", "hasOwnProperty"]) {
      expect(fiberNetworkOf(unknown), String(unknown)).toBe("testnet");
    }
  });

  test("invoice prefixes and fnn currencies per network", () => {
    expect(invoicePrefix("testnet")).toBe("fibt");
    expect(invoicePrefix("mainnet")).toBe("fibb");
    expect(invoicePrefix("devnet")).toBe("fibd");
    expect(FIBER_CURRENCY).toEqual({ mainnet: "Fibb", testnet: "Fibt", devnet: "Fibd" });
  });

  test("RUSD on testnet has a fixed type script", () => {
    // The RUSD script is fnn v0.9.1's testnet whitelist entry (its default testnet config).
    expect(TESTNET_RUSD.script).toEqual({
      codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
      hashType: "type",
      args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
    });
  });
});

/* ------------------------------------------------------------------------------------- the pasted invoice */

test.describe("fiber-byo invoice pre-check", () => {
  test("nothing pasted is not an error", () => {
    expect(checkByoInvoice("", CKB_EXPECTED)).toEqual({ status: "empty" });
    expect(checkByoInvoice("  \n\t ", CKB_EXPECTED)).toEqual({ status: "empty" });
  });

  test("a testnet invoice for exactly the quoted amount passes, trimmed", () => {
    const invoice = demoFiberInvoice("testnet", BigInt(QUOTED));
    expect(checkByoInvoice(`  ${invoice}\n`, CKB_EXPECTED)).toEqual({ status: "ok", invoice, summary: "Fiber invoice for 19,800 CKB on CKB testnet." });
  });

  test("an invoice one base unit off is refused, naming both amounts", () => {
    for (const amount of [BigInt(QUOTED) + BigInt(1), BigInt(QUOTED) - BigInt(1)]) {
      const check = checkByoInvoice(demoFiberInvoice("testnet", amount), CKB_EXPECTED);
      expect(check.status).toBe("invalid");
      if (check.status !== "invalid") continue;
      expect(check.error).toContain(`asks for ${formatAssetAmount(amount, 8, "CKB")}`);
      expect(check.error).toContain("exactly 19,800 CKB");
    }
  });

  test("an invoice without an amount is refused: the hub pays only the quoted amount", () => {
    expect(checkByoInvoice(demoFiberInvoice("testnet", null), CKB_EXPECTED)).toEqual({
      status: "invalid",
      error: "This invoice has no amount. Make one for exactly 19,800 CKB: the hub only pays the quoted amount.",
    });
  });

  test("an invoice for another CKB network is refused with the hub's network", () => {
    expect(checkByoInvoice(demoFiberInvoice("mainnet", BigInt(QUOTED)), CKB_EXPECTED)).toEqual({
      status: "invalid",
      error: "This invoice is for CKB mainnet. The hub runs on CKB testnet: make a fibt… invoice on a testnet node.",
    });
    const devnet = checkByoInvoice(demoFiberInvoice("devnet", BigInt(QUOTED)), CKB_EXPECTED);
    expect(devnet.status === "invalid" && devnet.error).toContain("CKB devnet");
    // A devnet hub wants fibd and refuses fibt.
    const onDevnet = { ...CKB_EXPECTED, network: "devnet" as const };
    expect(checkByoInvoice(demoFiberInvoice("devnet", BigInt(QUOTED)), onDevnet).status).toBe("ok");
    const fibt = checkByoInvoice(demoFiberInvoice("testnet", BigInt(QUOTED)), onDevnet);
    expect(fibt.status === "invalid" && fibt.error).toContain("make a fibd… invoice on a devnet node");
  });

  test("Lightning invoices, CKB addresses and other text are told apart", () => {
    const ln = encodeUnsignedBolt11({ network: "signet", amountSats: 19_800, paymentHash: randomBytes(32), description: "x", expirySeconds: 600 });
    expect(checkByoInvoice(ln, CKB_EXPECTED)).toEqual({
      status: "invalid",
      error: "This is a Lightning invoice. Paste the Fiber invoice (fibt…) your Fiber node made.",
    });
    const address = lockScriptToAddress(secpLock());
    expect(checkByoInvoice(address, CKB_EXPECTED)).toEqual({
      status: "invalid",
      error: "This is a CKB address. The payout goes over Fiber, so paste a Fiber invoice (fibt…) from your node.",
    });
    expect(checkByoInvoice(lockScriptToAddress(secpLock(), "ckb"), CKB_EXPECTED).status).toBe("invalid");
    expect(checkByoInvoice("hello", CKB_EXPECTED)).toEqual({
      status: "invalid",
      error: "This is not a Fiber invoice. Paste the fibt… invoice your Fiber node made.",
    });
  });

  test("a broken checksum, the wrong bech32 variant, mixed case or a zero amount are refused", () => {
    const good = demoFiberInvoice("testnet", BigInt(QUOTED));
    const last = good.at(-1)!;
    const broken = good.slice(0, -1) + (last === "q" ? "p" : "q");
    expect(checkByoInvoice(broken, CKB_EXPECTED)).toEqual({ status: "invalid", error: "Checksum failed. Check that it was copied completely." });
    const truncated = checkByoInvoice(good.slice(0, -10), CKB_EXPECTED);
    expect(truncated.status).toBe("invalid");

    const words = Array.from(randomBytes(120), (b) => b & 31);
    expect(checkByoInvoice(encodeBech32(`fibt${QUOTED}`, words, "bech32"), CKB_EXPECTED)).toEqual({
      status: "invalid",
      error: "Fiber invoices use bech32m; this one uses bech32.",
    });
    expect(checkByoInvoice(good.slice(0, 20).toUpperCase() + good.slice(20), CKB_EXPECTED).status).toBe("invalid");
    expect(checkByoInvoice(encodeBech32("fibt0", words, "bech32m"), CKB_EXPECTED)).toEqual({
      status: "invalid",
      error: "This Fiber invoice asks for 0. Ask for an invoice with an amount.",
    });
    expect(checkByoInvoice(encodeBech32("fibx100", words, "bech32m"), CKB_EXPECTED).status).toBe("invalid");
  });

  test("text longer than the hub accepts is refused before decoding", () => {
    const words = Array.from(randomBytes(MAX_PAYOUT_INVOICE_LENGTH), (b) => b & 31);
    const long = encodeBech32(`fibt${QUOTED}`, words, "bech32m");
    expect(long.length).toBeGreaterThan(MAX_PAYOUT_INVOICE_LENGTH);
    expect(checkByoInvoice(long, CKB_EXPECTED)).toEqual({
      status: "invalid",
      error: "This is longer than any invoice the hub accepts. Check what was copied.",
    });
    expect(MAX_PAYOUT_INVOICE_LENGTH).toBe(4_096);
  });

  test("RUSD amounts are written in RUSD, exactly", () => {
    const rusd: ByoInvoiceExpectation = { network: "testnet", amount: "3960000000", decimals: 8, symbol: "RUSD" };
    expect(checkByoInvoice(demoFiberInvoice("testnet", BigInt("3960000000")), rusd)).toMatchObject({ status: "ok", summary: "Fiber invoice for 39.6 RUSD on CKB testnet." });
    const off = checkByoInvoice(demoFiberInvoice("testnet", BigInt("3960000001")), rusd);
    expect(off.status === "invalid" && off.error).toBe("This invoice asks for 39.60000001 RUSD. Make one for exactly 39.6 RUSD, the amount of this quote.");
    expect(formatAssetAmount(BigInt("123456789012345"), 8, "CKB")).toBe("1,234,567.89012345 CKB");
  });
});

/* -------------------------------------------------------------------------------------------- the guides */

/* ------------------------------------------------------------------------------------------- funding: pure */

test.describe("fiber-byo funding presets and amounts", () => {
  test("presets come from the research's minimums: 600, 200 and 250 CKB, and 20 RUSD", () => {
    expect(ckbPresetAmount(FIBER_FUNDING.PUBLIC_NODE_MIN_CHANNEL_CKB)).toBe(600); // 499 + 61 change + 1 fee, rounded up to 50
    expect(ckbPresetAmount(FIBER_FUNDING.CKB_CHANNEL_RESERVE_CKB)).toBe(200); // 99 + 62
    expect(ckbPresetAmount(FIBER_FUNDING.UDT_CHANNEL_RESERVE_CKB)).toBe(250); // 180 + 62
    expect(FUNDING_PRESETS.map((p) => [p.id, p.amount, p.symbol])).toEqual([
      ["public-channel", 600, "CKB"],
      ["accept-channel", 200, "CKB"],
      ["rusd-reserve", 250, "CKB"],
      ["public-rusd-channel", 20, "RUSD"],
    ]);
    // Each preset covers what it is for, with room for the change cell and the fee.
    expect(600).toBeGreaterThanOrEqual(FIBER_FUNDING.PUBLIC_NODE_MIN_CHANNEL_CKB + FIBER_FUNDING.CHANGE_CELL_CKB);
    expect(FIBER_FUNDING).toMatchObject({ PUBLIC_NODE_MIN_CHANNEL_CKB: 499, CKB_CHANNEL_RESERVE_CKB: 99, UDT_CHANNEL_RESERVE_CKB: 180, CHANGE_CELL_CKB: 61 });
    // bottle/bracer add 250 CKB and keep a 99 CKB reserve: 151 CKB can come back to the visitor.
    expect(FUNDING_PRESETS[0].detail).toContain("up to 151 CKB");
    expect(presetsFor(FUNDING_PRESETS, "CKB").map((p) => p.amount)).toEqual([600, 200, 250]);
    expect(presetsFor(FUNDING_PRESETS, "RUSD").map((p) => p.amount)).toEqual([20]);
    expect(presetsFor(FUNDING_PRESETS, "CWBTC")).toEqual([]);
  });

  test("whole amounts become exact base units; nothing positive is null", () => {
    expect(fundingUnits(600, 8)).toBe(units(600));
    expect(fundingUnits(70.5, 8)).toBe(BigInt(7_050_000_000));
    expect(fundingUnits(0.1 + 0.2, 8)).toBe(BigInt(30_000_000));
    expect(fundingUnits(123.45678901, 8)).toBe(BigInt(12_345_678_901));
    expect(fundingUnits(0.00000001, 8)).toBe(BigInt(1));
    for (const nothing of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.000000001]) expect(fundingUnits(nothing, 8), String(nothing)).toBeNull();
  });

  test("amount checks: something to send, at least one CKB cell, no more than the wallet holds", () => {
    expect(checkFundingAmount(null, CKB_FUNDING_TOKEN, undefined)).toBe("Enter an amount to send.");
    expect(checkFundingAmount(BigInt(0), CKB_FUNDING_TOKEN, undefined)).toBe("Enter an amount to send.");
    expect(checkFundingAmount(units(60), CKB_FUNDING_TOKEN, undefined)).toBe("Send at least 61 CKB: a CKB cell cannot hold less.");
    expect(checkFundingAmount(units(61) - BigInt(1), CKB_FUNDING_TOKEN, units(1_000))).toContain("at least 61 CKB");
    expect(checkFundingAmount(units(61), CKB_FUNDING_TOKEN, units(1_000))).toBeNull();
    // The balance is still being read: no verdict on it yet.
    expect(checkFundingAmount(units(600), CKB_FUNDING_TOKEN, undefined)).toBeNull();
    expect(checkFundingAmount(units(600), CKB_FUNDING_TOKEN, units(600))).toBeNull();
    expect(checkFundingAmount(units(600) + BigInt(1), CKB_FUNDING_TOKEN, units(600))).toBe("Your wallet holds 600 CKB. Send less, or top the wallet up first.");
    // A token has no CKB minimum of its own.
    expect(checkFundingAmount(BigInt(1), RUSD_TOKEN, units(20))).toBeNull();
    expect(checkFundingAmount(units(21), RUSD_TOKEN, units(20))).toBe("Your wallet holds 20 RUSD. Send less, or top the wallet up first.");
    expect(formatFunding(BigInt("123456789012"), CKB_FUNDING_TOKEN)).toBe("1,234.56789012 CKB");
  });
});

test.describe("fiber-byo funding target", () => {
  const nodeLock = secpLock();
  const nodeAddress = lockScriptToAddress(nodeLock);
  const fnnJson = (s: Script) => JSON.stringify({ code_hash: s.codeHash, hash_type: s.hashType, args: s.args });

  test("a lock script becomes the same full-format address CCC writes, on testnet unless told otherwise", () => {
    expect(nodeAddress).toBe(ccc.Address.from({ script: nodeLock, prefix: "ckt" }).toString());
    expect(nodeAddress.startsWith("ckt1")).toBe(true);
    expect(lockScriptToAddress(nodeLock, "ckb")).toBe(ccc.Address.from({ script: nodeLock, prefix: "ckb" }).toString());
    const dataLock: Script = { codeHash: `0x${"12".repeat(32)}`, hashType: "data1", args: "0x" };
    expect(lockScriptToAddress(dataLock)).toBe(ccc.Address.from({ script: dataLock, prefix: "ckt" }).toString());
  });

  test("fnn's default_funding_lock_script JSON is read strictly", () => {
    expect(parseLockScriptJson(fnnJson(nodeLock))).toEqual(nodeLock);
    expect(parseLockScriptJson(`{"code_hash":"0x${"AB".repeat(32)}","hash_type":"data2","args":"0x"}`)).toEqual({ codeHash: `0x${"AB".repeat(32)}`, hashType: "data2", args: "0x" });
    for (const bad of [
      "{",
      "null",
      "[]",
      "{}",
      JSON.stringify({ ...JSON.parse(fnnJson(nodeLock)), code_hash: "0x1234" }),
      JSON.stringify({ ...JSON.parse(fnnJson(nodeLock)), hash_type: "data3" }),
      JSON.stringify({ ...JSON.parse(fnnJson(nodeLock)), hash_type: "__proto__" }),
      JSON.stringify({ ...JSON.parse(fnnJson(nodeLock)), args: "0x123" }),
      JSON.stringify({ ...JSON.parse(fnnJson(nodeLock)), args: "abcd" }),
      JSON.stringify({ codeHash: nodeLock.codeHash, hashType: "type", args: nodeLock.args }),
    ]) {
      expect(parseLockScriptJson(bad), bad).toBeNull();
    }
  });

  test("a ckt1 address or fnn's lock script JSON is accepted, trimmed", () => {
    expect(parseFundingTarget("", undefined)).toEqual({ status: "empty" });
    expect(parseFundingTarget("   ", undefined)).toEqual({ status: "empty" });
    expect(parseFundingTarget(`  ${nodeAddress}\n`, undefined)).toEqual({ status: "ok", address: nodeAddress });
    expect(parseFundingTarget(fnnJson(nodeLock), undefined)).toEqual({ status: "ok", address: nodeAddress });
    expect(parseFundingTarget(`\n  ${JSON.stringify(JSON.parse(fnnJson(nodeLock)), null, 2)}  `, undefined)).toEqual({ status: "ok", address: nodeAddress });
  });

  test("mainnet addresses are refused: only test CKB funds a node here", () => {
    expect(parseFundingTarget(lockScriptToAddress(nodeLock, "ckb"), undefined)).toEqual({
      status: "invalid",
      error: "This is a CKB mainnet address. Fund your node with test CKB: use its testnet address (ckt1…).",
    });
  });

  test("the wallet's own address is refused, in any letter case", () => {
    const wallet = lockScriptToAddress(secpLock());
    const refusal = { status: "invalid", error: "This is your wallet's own address. Paste the address of your Fiber node." };
    expect(parseFundingTarget(wallet, wallet)).toEqual(refusal);
    expect(parseFundingTarget(wallet.toUpperCase(), wallet)).toEqual(refusal);
    expect(parseFundingTarget(nodeAddress, wallet)).toEqual({ status: "ok", address: nodeAddress });
  });

  test("anything else is refused with a reason", () => {
    for (const bad of ["hello", demoFiberInvoice("testnet", BigInt(1)), nodeAddress.slice(0, -1) + (nodeAddress.endsWith("q") ? "p" : "q"), "{not json}", '{"code_hash":"0x1"}']) {
      const target = parseFundingTarget(bad, undefined);
      expect(target.status, bad).toBe("invalid");
      expect(target.status === "invalid" && target.error.length).toBeGreaterThan(10);
    }
  });

  test("the explorer link points at CKB testnet's explorer", () => {
    const hash = `0x${"cd".repeat(32)}`;
    expect(explorerTxUrl(hash)).toBe(`https://testnet.explorer.nervos.org/transaction/${hash}`);
    expect(CKB_TESTNET_EXPLORER_URL).toBe("https://testnet.explorer.nervos.org");
  });
});

test.describe("fiber-byo funding error messages", () => {
  test("a refusal in the wallet says nothing was sent; other failures say the wallet could not send", () => {
    expect(fundingErrorMessage(new FundingError(FUNDING_FAILURE.NOT_ENOUGH_CKB, "Plain sentence."))).toBe("Plain sentence.");
    for (const refused of [new Error("User rejected the request."), new Error("Popup closed"), Object.assign(new Error("x"), { name: "PopupCancelledError" }), "user denied"]) {
      expect(fundingErrorMessage(refused)).toBe("You cancelled in your wallet, so nothing was sent.");
    }
    expect(fundingErrorMessage(new Error("boom"))).toBe("Your wallet could not send it (boom). Try again.");
    expect(fundingErrorMessage(42)).toBe("Your wallet could not send it. Try again.");
    expect(fundingErrorMessage(new Error(""))).toBe("Your wallet could not send it. Try again.");
  });
});

/* -------------------------------------------------------------------------------- funding: on a fake chain */

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

const RUSD_CELL_CKB = 142; // the capacity of an RUSD cell, as research section 2.2 computes it

interface Setup {
  chain: FakeCkbChain;
  signer: ccc.SignerCkbPrivateKey;
  walletLock: Script;
  nodeLock: Script;
  nodeAddress: string;
  close: () => Promise<void>;
}

async function setup(opts: { ckbCells?: number[]; rusdCells?: number[]; rusdCode?: boolean; mainnet?: boolean } = {}): Promise<Setup> {
  const chain = new FakeCkbChain();
  const { url, server } = await startRpc(chain);
  // No fallbacks: a test must never reach the public testnet.
  const client = opts.mainnet ? new ccc.ClientPublicMainnet({ url, fallbacks: [] }) : new ccc.ClientPublicTestnet({ url, fallbacks: [] });
  const signer = new ccc.SignerCkbPrivateKey(client, `0x${randomBytes(32).toString("hex")}`);
  const { script } = await signer.getRecommendedAddressObj();
  const walletLock: Script = { codeHash: script.codeHash, hashType: script.hashType as Script["hashType"], args: script.args };
  for (const ckb of opts.ckbCells ?? [1_000, 1_000, 1_000]) chain.addCell({ lock: walletLock, capacity: units(ckb) });
  for (const rusd of opts.rusdCells ?? []) chain.addCell({ lock: walletLock, capacity: units(RUSD_CELL_CKB), type: TESTNET_RUSD.script, data: udtData(units(rusd)) });
  if (opts.rusdCode ?? true) {
    chain.addCell({
      lock: secpLock(),
      capacity: units(100_000),
      type: { codeHash: TYPE_ID_CODE_HASH, hashType: "type", args: TESTNET_RUSD.codeTypeIdArgs },
      data: `0x${"00".repeat(64)}`,
    });
  }
  const nodeLock = secpLock();
  return {
    chain,
    signer,
    walletLock,
    nodeLock,
    nodeAddress: lockScriptToAddress(nodeLock),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const capacityOf = (tx: RpcTransaction, pick: (i: number) => boolean) =>
  tx.outputs.reduce((sum, o, i) => (pick(i) ? sum + BigInt(o.capacity) : sum), BigInt(0));

test.describe("fiber-byo funding transfer (CCC signer, fake CKB testnet)", () => {
  test("reads the wallet's CKB and RUSD", async () => {
    const s = await setup({ ckbCells: [1_000, 2_500], rusdCells: [15, 30] });
    try {
      const transport = cccFundingTransport(s.signer);
      // Plain CKB only: the RUSD cells' capacity is not spendable CKB.
      expect(await transport.readBalance(CKB_FUNDING_TOKEN)).toBe(units(3_500));
      expect(await transport.readBalance(RUSD_TOKEN)).toBe(units(45));
      expect(s.chain.sent).toEqual([]);
      expect(s.chain.unknown).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("sends exactly the CKB asked for to the node, the change back to the wallet, signed", async () => {
    const s = await setup();
    try {
      const hash = await cccFundingTransport(s.signer).send({ to: s.nodeAddress, token: CKB_FUNDING_TOKEN, units: units(600) });
      expect(s.chain.sent).toHaveLength(1);
      const tx = s.chain.sent[0];
      expect(hash).toBe(rpcTransactionHash(tx));
      // Output 0: the node, exactly 600 CKB, a plain cell.
      expect(sameScript(tx.outputs[0].lock, s.nodeLock)).toBe(true);
      expect(BigInt(tx.outputs[0].capacity)).toBe(units(600));
      expect(tx.outputs[0].type ?? null).toBeNull();
      expect(tx.outputs_data[0]).toBe("0x");
      // Everything else goes back to the wallet; the only cost is a small fee.
      const toNode = tx.outputs.filter((o) => sameScript(o.lock, s.nodeLock));
      expect(toNode).toHaveLength(1);
      expect(tx.outputs.slice(1).every((o) => sameScript(o.lock, s.walletLock))).toBe(true);
      const inputs = tx.inputs.map((i) => s.chain.cells.find((c) => c.txHash === i.previous_output.tx_hash && `0x${c.index.toString(16)}` === i.previous_output.index)!);
      expect(inputs.every((c) => c && sameScript(c.lock, s.walletLock))).toBe(true);
      const fee = inputs.reduce((sum, c) => sum + c.capacity, BigInt(0)) - capacityOf(tx, () => true);
      expect(fee).toBeGreaterThan(BigInt(0));
      expect(fee).toBeLessThan(units(1) / BigInt(100));
      // Signed by the wallet's key (a 65-byte signature in the first witness), with the secp256k1 dep group.
      expect(tx.witnesses[0].length).toBeGreaterThan(2 + 130);
      expect(tx.cell_deps.some((d) => d.dep_type === "dep_group")).toBe(true);
    } finally {
      await s.close();
    }
  });

  test("sends exactly the RUSD asked for, with its code cell as a dep, and keeps the rest of the wallet's RUSD", async () => {
    const s = await setup({ ckbCells: [1_000], rusdCells: [15, 30] });
    try {
      await cccFundingTransport(s.signer).send({ to: s.nodeAddress, token: RUSD_TOKEN, units: units(20) });
      expect(s.chain.sent).toHaveLength(1);
      const tx = s.chain.sent[0];
      expect(sameScript(tx.outputs[0].lock, s.nodeLock)).toBe(true);
      expect(sameScript(tx.outputs[0].type ?? null, TESTNET_RUSD.script)).toBe(true);
      expect(tx.outputs_data[0]).toBe(udtData(units(20)));
      expect(readUdtData(tx.outputs_data[0])).toBe(units(20));
      // RUSD in = RUSD out: 20 to the node, 25 back to the wallet; nothing burnt.
      const rusdOut = tx.outputs.map((o, i) => (sameScript(o.type ?? null, TESTNET_RUSD.script) ? { lock: o.lock, amount: readUdtData(tx.outputs_data[i]) } : null)).filter(Boolean);
      expect(rusdOut).toHaveLength(2);
      expect(sameScript(rusdOut[1]!.lock, s.walletLock)).toBe(true);
      expect(rusdOut[1]!.amount).toBe(units(25));
      const codeCell = s.chain.cells.find((c) => c.type?.codeHash === TYPE_ID_CODE_HASH)!;
      expect(tx.cell_deps).toContainEqual({ out_point: { tx_hash: codeCell.txHash, index: "0x0" }, dep_type: "code" });
      // Only one output goes to the node.
      expect(tx.outputs.filter((o) => sameScript(o.lock, s.nodeLock))).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  test("a wallet on CKB mainnet is refused before anything is read or signed", async () => {
    const s = await setup({ mainnet: true });
    try {
      const send = cccFundingTransport(s.signer).send({ to: s.nodeAddress, token: CKB_FUNDING_TOKEN, units: units(600) });
      await expect(send).rejects.toMatchObject({ code: FUNDING_FAILURE.WRONG_NETWORK });
      await expect(send).rejects.toThrow("Your CKB wallet is not on CKB testnet.");
      expect(s.chain.calls).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("a mainnet recipient is refused by a testnet wallet", async () => {
    const s = await setup();
    try {
      const send = cccFundingTransport(s.signer).send({ to: lockScriptToAddress(s.nodeLock, "ckb"), token: CKB_FUNDING_TOKEN, units: units(600) });
      await expect(send).rejects.toMatchObject({ code: FUNDING_FAILURE.WRONG_NETWORK });
      expect(s.chain.sent).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("too little CKB for the amount, or for the change and fee, is a plain sentence and nothing is sent", async () => {
    const short = await setup({ ckbCells: [500] });
    try {
      const send = cccFundingTransport(short.signer).send({ to: short.nodeAddress, token: CKB_FUNDING_TOKEN, units: units(600) });
      await expect(send).rejects.toMatchObject({ code: FUNDING_FAILURE.NOT_ENOUGH_CKB, message: "Your wallet does not hold enough CKB for this amount and the fee." });
      expect(short.chain.sent).toEqual([]);
    } finally {
      await short.close();
    }
    // 600 of 600 CKB leaves nothing for the fee.
    const exact = await setup({ ckbCells: [600] });
    try {
      const send = cccFundingTransport(exact.signer).send({ to: exact.nodeAddress, token: CKB_FUNDING_TOKEN, units: units(600) });
      await expect(send).rejects.toMatchObject({ code: FUNDING_FAILURE.NOT_ENOUGH_CKB });
      expect(exact.chain.sent).toEqual([]);
    } finally {
      await exact.close();
    }
  });

  test("too little RUSD, or no CKB for the RUSD cell, is a plain sentence and nothing is sent", async () => {
    const s = await setup({ ckbCells: [1_000], rusdCells: [10] });
    try {
      const send = cccFundingTransport(s.signer).send({ to: s.nodeAddress, token: RUSD_TOKEN, units: units(20) });
      await expect(send).rejects.toMatchObject({ code: FUNDING_FAILURE.NOT_ENOUGH_TOKEN, message: "Your wallet does not hold that much RUSD." });
      expect(s.chain.sent).toEqual([]);
    } finally {
      await s.close();
    }
    const noCkb = await setup({ ckbCells: [], rusdCells: [30] });
    try {
      const send = cccFundingTransport(noCkb.signer).send({ to: noCkb.nodeAddress, token: RUSD_TOKEN, units: units(20) });
      await expect(send).rejects.toMatchObject({ code: FUNDING_FAILURE.NOT_ENOUGH_CKB });
      await expect(send).rejects.toThrow("for the RUSD cell's capacity and the fee");
      expect(noCkb.chain.sent).toEqual([]);
    } finally {
      await noCkb.close();
    }
  });

  test("RUSD cannot be sent while its code cell cannot be found", async () => {
    const s = await setup({ ckbCells: [1_000], rusdCells: [30], rusdCode: false });
    try {
      const send = cccFundingTransport(s.signer).send({ to: s.nodeAddress, token: RUSD_TOKEN, units: units(20) });
      await expect(send).rejects.toMatchObject({ code: FUNDING_FAILURE.TOKEN_UNAVAILABLE, message: "The RUSD script cannot be found on CKB testnet right now. Try again later." });
      expect(s.chain.sent).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("a CKB node that rejects the signed transaction is not reported as the visitor cancelling", async () => {
    const s = await setup();
    try {
      s.chain.onSend = () => ({ error: { code: -1104, message: "PoolRejectedTransactionByMinFeeRate: The min fee rate is 1000 shannons/KW, but the transaction fee rate is 500 shannons/KW" } });
      let thrown: unknown;
      try {
        await cccFundingTransport(s.signer).send({ to: s.nodeAddress, token: CKB_FUNDING_TOKEN, units: units(600) });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeDefined();
      // The visitor signed: telling them they cancelled would be false.
      const why = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
      expect(fundingErrorMessage(thrown), `the node answered ${why}`).not.toBe("You cancelled in your wallet, so nothing was sent.");
    } finally {
      await s.close();
    }
  });
});

/* A type-level guard: FundingToken stays the shape the funding form builds its list from. */
const _tokens: readonly FundingToken[] = [CKB_FUNDING_TOKEN, ...TESTNET_FUNDING_TOKENS];
void _tokens;

test.describe("fnn commands for an external node (lib/wallets/fiber-byo/rpc-commands.ts)", () => {
  const RUSD = { codeHash: `0x${"11".repeat(32)}`, hashType: "type" as const, args: `0x${"22".repeat(32)}` };

  test("new_invoice asks for the exact amount in hex, sha256, the network's currency and a one-hour expiry", () => {
    expect(newInvoiceRequest({ amount: "144826974743", network: "testnet", udtTypeScript: null })).toEqual({
      method: "new_invoice",
      params: { amount: "0x21b85c4217", currency: "Fibt", description: "CKBolt swap payout", expiry: "0xe10", hash_algorithm: "sha256" },
    });
    expect(newInvoiceRequest({ amount: BigInt(1), network: "mainnet", udtTypeScript: null }).params.currency).toBe("Fibb");
  });

  test("new_invoice names a token's type script in fnn's snake_case; CKB has none", () => {
    const { params } = newInvoiceRequest({ amount: BigInt(10), network: "testnet", udtTypeScript: RUSD });
    expect(params.udt_type_script).toEqual({ code_hash: RUSD.codeHash, hash_type: "type", args: RUSD.args });
    expect("udt_type_script" in newInvoiceRequest({ amount: BigInt(10), network: "testnet", udtTypeScript: null }).params).toBe(false);
  });

  test("send_payment and connect_peer carry what they are given", () => {
    expect(sendPaymentRequest({ invoice: "fibt1abc", maxFeeAmount: BigInt(500) })).toEqual({ method: "send_payment", params: { invoice: "fibt1abc", max_fee_amount: "0x1f4" } });
    expect(connectPeerRequest("/ip4/1.2.3.4/tcp/8228/p2p/Qm")).toEqual({ method: "connect_peer", params: { address: "/ip4/1.2.3.4/tcp/8228/p2p/Qm" } });
    expect(rpcQuantity(0)).toBe("0x0");
  });

  test("the curl line posts JSON-RPC 2.0 with one object as the param, to fnn's default RPC unless told otherwise", () => {
    const request = sendPaymentRequest({ invoice: "fibt1abc", maxFeeAmount: BigInt(1) });
    expect(rpcBody(request)).toBe('{"jsonrpc":"2.0","id":1,"method":"send_payment","params":[{"invoice":"fibt1abc","max_fee_amount":"0x1"}]}');
    expect(curlCommand(request)).toBe(`curl -s -X POST http://127.0.0.1:8227 -H 'Content-Type: application/json' -d '${rpcBody(request)}'`);
    expect(curlCommand(request, "http://10.0.0.2:8227")).toContain("POST http://10.0.0.2:8227 ");
  });

  test("a single quote in the body cannot break out of the shell's quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

test.describe("an external node's Fiber channel from the hub (lib/wallets/fiber-byo/hub-fiber-channel.ts)", () => {
  const channel = (asset: "CKB" | "RUSD", state: InboundChannelDto["state"], id = "01"): InboundChannelDto => ({
    channelId: `0x${id.repeat(32)}`,
    asset,
    state,
    hubBalance: "100",
    nodeBalance: "0",
  });

  test("shows the token's channel, ready over opening over closing; another token's does not count", () => {
    const list = [channel("RUSD", "ready", "09"), channel("CKB", "closing", "02"), channel("CKB", "opening", "03")];
    expect(shownFiberChannel(list, "CKB")?.channelId).toBe(`0x${"03".repeat(32)}`);
    expect(shownFiberChannel([...list, channel("CKB", "ready", "04")], "CKB")?.state).toBe("ready");
    expect(shownFiberChannel([channel("RUSD", "ready")], "CKB")).toBeNull();
  });

  test("reads opening right after a request the hub does not list yet, none before", () => {
    expect(fiberChannelStatus(null, false)).toBe("none");
    expect(fiberChannelStatus(null, true)).toBe("opening");
    expect(fiberChannelStatus(channel("CKB", "ready"), false)).toBe("ready");
  });

  test("the hub's refusals in plain words, its own sentence kept as the detail", () => {
    expect(fiberChannelError({ code: "conflict", message: "Your Fiber node is not connected." })).toEqual({
      line: FIBER_CHANNEL_MESSAGE.CONNECT_FIRST,
      detail: "Your Fiber node is not connected.",
    });
    expect(fiberChannelError({ code: "insufficient_liquidity", message: "" })).toEqual({ line: FIBER_CHANNEL_MESSAGE.NO_FUNDS, detail: null });
    expect(fiberChannelError({ code: "asset_unavailable", message: "x" }).line).toBe(FIBER_CHANNEL_MESSAGE.ASSET);
    expect(fiberChannelError({ code: "hub_unavailable", message: "x" }).line).toBe(FIBER_CHANNEL_MESSAGE.HUB_UNREACHABLE);
    expect(fiberChannelError({ code: "something_new", message: "x" }).line).toBe(FIBER_CHANNEL_MESSAGE.FAILED);
  });
});
