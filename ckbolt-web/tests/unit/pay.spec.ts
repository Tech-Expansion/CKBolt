import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { ccc } from "@ckb-ccc/connector-react";
import type { AssetDto, FiberNodeDto, Script } from "../../lib/hub/contract";
import { landRead } from "../../components/app/fiber-node/use-activity";
import { classifyPayInput, type PayContext } from "../../lib/pay/classify";
import { PAY_ERROR } from "../../lib/pay/copy";
import { demoFiberInvoice } from "../../lib/payment-request";
import { activityTone } from "../../lib/status-tone";
import {
  activityLabel,
  holdsNode,
  isActivityFinal,
  isPaymentEntry,
  isPollable,
  readHistory,
  saveHistory,
  withPayment,
  type ActivityEntry,
} from "../../lib/wallets/fiber-browser/activity";
import { BridgeClient, BridgeError, type BroadcastLike, type ChannelFactory } from "../../lib/wallets/fiber-browser/bridge-client";
import {
  BRIDGE_ERROR,
  BRIDGE_METHOD,
  isOnChainSendResult,
  isPaymentStatusResult,
  isRequestPaymentResult,
  parseRequest,
  pickInvoicePreview,
  request,
} from "../../lib/wallets/fiber-browser/bridge-protocol";
import { startBridgeServer, type BridgeHandlers } from "../../lib/wallets/fiber-browser/bridge-server";
import { buildExactSend, cccNodeClient, previewSend, sendAmount } from "../../lib/wallets/fiber-browser/ccc-withdraw";
import { scriptToAddress } from "../../lib/wallets/fiber-browser/ckb-address";
import { CONFIRM_MESSAGE, ConfirmationQueue } from "../../lib/wallets/fiber-browser/confirmations";
import { BRIDGE_CHANNEL_NAME, PAY_MAX_FEE_PER_THOUSAND } from "../../lib/wallets/fiber-browser/constants";
import { FiberJsNode, type FiberLike } from "../../lib/wallets/fiber-browser/fiber-js-adapter";
import { readParsedInvoice, UnreadableInvoiceError } from "../../lib/wallets/fiber-browser/invoice-parse";
import { generateNodeKeys, type NodeKeys } from "../../lib/wallets/fiber-browser/keys";
import { decodeMoleculeScript } from "../../lib/wallets/fiber-browser/molecule";
import type { BrowserFiberNode, NodeChannel, NodePayment, ParsedInvoice, SendPaymentOptions } from "../../lib/wallets/fiber-browser/node-port";
import {
  invoicePreviewDto,
  payConfirmedInvoice,
  paymentConfirmView,
  readFiberInvoice,
  readPaymentStatus,
  shortNote,
  type FiberPayDeps,
} from "../../lib/wallets/fiber-browser/pay-requests";
import { checkInvoiceText, checkParsedInvoice, maxFeeOf } from "../../lib/wallets/fiber-browser/payments";
import { NodeRequestError } from "../../lib/wallets/fiber-browser/request-error";
import { walletTokens } from "../../lib/wallets/fiber-browser/tokens";
import { minCellShannons, SEND_MESSAGE, sendBlock, WITHDRAW_BLOCK, WITHDRAW_FAILURE, WithdrawError } from "../../lib/wallets/fiber-browser/withdraw";
import { storageKey, type KeyValueStore } from "../../lib/wallets/fiber-browser/storage";
import { WALLET_PAGES } from "../../lib/wallets/fiber-popup/constants";
import { navigateMessage, parseRelayMessage } from "../../lib/wallets/fiber-popup/relay";
import { FakeCkbChain, rpcTransactionHash, sameScript, secpLock, units, type JsonRpcRequest } from "../e2e/fiber-byo-fakes";
import { amountlessInvoice, lightningInvoice } from "../e2e/fakes/hub";

/*
 * Pay on /app (docs/pay-get-paid.md, part B), its pure parts: what the page reads in the field (a Lightning invoice, a
 * Fiber invoice, a CKB address), the Fiber invoice as the node reads and checks it, the bridge's Pay methods (their
 * validation, nothing secret, a round trip), the node's confirmation queue (the security rule: only the visitor's
 * Confirm in the node pays), the node's handlers (History before send_payment, the max fee), the History's `payment`
 * kind and its recovery, the exact-amount on-chain send on a fake CKB testnet, and the popup's Confirm page in the relay.
 */

const SHANNONS = BigInt(100_000_000);
const ckb = (whole: number): bigint => BigInt(whole) * SHANNONS;
const NOW = Date.parse("2026-10-30T10:00:00Z");
const HASH = `0x${"ab".repeat(32)}`;
const RUSD_SCRIPT: Script = {
  codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hashType: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const HUB_ID = "02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71";
const HUB_NODE: FiberNodeDto = {
  nodeId: HUB_ID,
  network: "testnet",
  addresses: { p2p: [], ws: [] },
  assets: [
    { id: "CKB", udtTypeScript: null, udtWhitelist: null, peerChannels: null },
    { id: "RUSD", udtTypeScript: RUSD_SCRIPT, udtWhitelist: null, peerChannels: null },
  ],
  inbound: { enabled: true, amounts: {} },
};
const ASSETS: Pick<AssetDto, "id" | "symbol" | "decimals">[] = [
  { id: "CKB", symbol: "CKB", decimals: 8 },
  { id: "RUSD", symbol: "RUSD", decimals: 8 },
];
const TOKENS = walletTokens(HUB_NODE, ASSETS);
const RUSD = TOKENS.find((t) => t.id === "RUSD")!;
const OWN_NODE = `03${"11".repeat(32)}`;
const PAYEE = `02${"5a".repeat(32)}`;

const molecule = (script: Script): string => ccc.hexFrom(ccc.Script.from(script).toBytes());
const hexQ = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

/** parse_invoice's answer as fnn 0.9.1 writes it. */
function rpcInvoice(overrides: { currency?: string; amount?: string | null; attrs?: Record<string, unknown>[]; timestamp?: string } = {}) {
  return {
    currency: overrides.currency ?? "Fibt",
    amount: overrides.amount === undefined ? hexQ(ckb(5)) : overrides.amount,
    signature: "00",
    data: {
      timestamp: overrides.timestamp ?? hexQ(NOW),
      payment_hash: HASH,
      attrs: overrides.attrs ?? [{ hash_algorithm: "sha256" }, { expiry_time: "0xe10" }, { payee_public_key: PAYEE }, { description: "coffee" }],
    },
  };
}

const parsed = (overrides: Partial<ParsedInvoice> = {}): ParsedInvoice => ({
  network: "testnet",
  paymentHash: HASH,
  amount: ckb(5),
  udtTypeScript: null,
  createdAtMs: NOW,
  expiresAtMs: NOW + 3_600_000,
  payee: PAYEE,
  description: null,
  hashAlgorithm: "sha256",
  ...overrides,
});

const channel = (o: { local: bigint; udt?: Script | null; peer?: string; state?: string }): NodeChannel => ({
  channelId: `0x${Math.random().toString(16).slice(2).padEnd(64, "0")}`,
  peerId: o.peer ?? HUB_ID,
  udtTypeScript: o.udt ?? null,
  state: o.state ?? "ChannelReady",
  isPublic: false,
  enabled: true,
  localBalance: o.local,
  remoteBalance: BigInt(0),
});

/* ============================================================================================ the field */

test.describe("what the page reads in Pay's field", () => {
  const ctx: PayContext = { lightningNetwork: "signet", fiberNetwork: "testnet", nowMs: Date.now() };

  test("a Lightning invoice the hub can pay: on its network, with whole sats and a hash, not expired", () => {
    const invoice = lightningInvoice({ sats: 24_750 });
    const read = classifyPayInput(` lightning:${invoice} `, ctx);
    expect(read.kind).toBe("lightning");
    if (read.kind !== "lightning") return;
    expect(read.invoice).toMatchObject({ invoice: invoice.toLowerCase(), sats: "24750" });
  });

  test("a Lightning invoice is refused as part A's checks do: no amount, mainnet, expired", () => {
    const line = (text: string) => {
      const read = classifyPayInput(text, ctx);
      return read.kind === "invalid" ? read.error.line : null;
    };
    expect(line(amountlessInvoice())).toBe("This invoice has no amount. Make one with an amount.");
    expect(line(lightningInvoice({ sats: 1_000, network: "mainnet" }))).toBe("This is a mainnet invoice. Use one on Bitcoin signet.");
    expect(line(lightningInvoice({ sats: 1_000, timestamp: Math.floor(Date.now() / 1000) - 7_200, expirySeconds: 600 }))).toBe(
      "This invoice has expired. Make a new one.",
    );
  });

  test("a Fiber invoice of the node's network, checked in the page before the node reads it", () => {
    const invoice = demoFiberInvoice("testnet", ckb(5));
    expect(classifyPayInput(invoice, ctx)).toEqual({ kind: "fiber", invoice });
    expect(classifyPayInput(demoFiberInvoice("mainnet", ckb(5)), ctx)).toEqual({
      kind: "invalid",
      error: { line: "This invoice is for CKB mainnet. Use a CKB testnet invoice (fibt…).", detail: null },
    });
    const broken = `${invoice.slice(0, -1)}${invoice.endsWith("q") ? "p" : "q"}`;
    expect(classifyPayInput(broken, ctx).kind).toBe("invalid");
  });

  test("a CKB address of the node's network; another network's is refused", () => {
    const testnet = scriptToAddress(secpLock(), "testnet");
    expect(classifyPayInput(testnet, ctx)).toEqual({ kind: "ckb-address", address: testnet });
    expect(classifyPayInput(scriptToAddress(secpLock(), "mainnet"), ctx)).toEqual({
      kind: "invalid",
      error: { line: PAY_ERROR.CKB_WRONG_NETWORK("testnet"), detail: null },
    });
  });

  test("anything else in one line, the reader's own sentence behind a ?; nothing typed is nothing", () => {
    expect(classifyPayInput("   ", ctx)).toEqual({ kind: "empty" });
    for (const text of ["alice@example.com", "lnurl1dp68gurn8ghj7", "hello"]) {
      const read = classifyPayInput(text, ctx);
      expect(read.kind).toBe("invalid");
      if (read.kind === "invalid") {
        expect(read.error.line).toBe(PAY_ERROR.NOT_PAYABLE);
        expect(read.error.detail).toBeTruthy();
      }
    }
  });
});

/* ===================================================================================== Fiber invoices */

test.describe("a Fiber invoice, as the node reads and checks it", () => {
  test("a molecule Script decodes to the script CCC encodes, any hash type; malformed bytes are refused", () => {
    expect(decodeMoleculeScript(molecule(RUSD_SCRIPT))).toEqual(RUSD_SCRIPT);
    for (const hashType of ["data", "type", "data1", "data2"] as const) {
      const script: Script = { codeHash: `0x${"0f".repeat(32)}`, hashType, args: "0x" };
      expect(decodeMoleculeScript(molecule(script))).toEqual(script);
    }
    expect(() => decodeMoleculeScript(molecule(RUSD_SCRIPT).slice(0, -2))).toThrow("size mismatch");
    expect(() => decodeMoleculeScript("0x")).toThrow();
  });

  test("parse_invoice's answer: network, hash, amount, token, times, payee, note; keys in any case", () => {
    const read = readParsedInvoice(
      rpcInvoice({
        attrs: [{ HashAlgorithm: "sha256" }, { ExpiryTime: "0xe10" }, { PayeePublicKey: `0x${PAYEE.toUpperCase()}` }, { udt_script: molecule(RUSD_SCRIPT) }, { description: "coffee" }],
      }),
    );
    expect(read).toEqual({
      network: "testnet",
      paymentHash: HASH,
      amount: ckb(5),
      udtTypeScript: RUSD_SCRIPT,
      createdAtMs: NOW,
      expiresAtMs: NOW + 3_600_000,
      payee: PAYEE,
      description: "coffee",
      hashAlgorithm: "sha256",
    });
    expect(readParsedInvoice(rpcInvoice({ amount: null, attrs: [], currency: "Fibb" }))).toMatchObject({ network: "mainnet", amount: null, expiresAtMs: null, payee: null, hashAlgorithm: "ckb_hash" });
    expect(() => readParsedInvoice(null)).toThrow(UnreadableInvoiceError);
    expect(() => readParsedInvoice(rpcInvoice({ timestamp: "soon" }))).toThrow("timestamp is not a hex quantity");
    expect(() => readParsedInvoice(rpcInvoice({ attrs: [{ udt_script: "0x1234" }] }))).toThrow("token script is malformed");
  });

  test("the page's own check: a Fiber invoice of the network, well formed, not too long", () => {
    expect(checkInvoiceText("  ", "testnet")).toEqual({ status: "empty" });
    expect(checkInvoiceText("lntbs20u1pjexample", "testnet")).toEqual({ status: "invalid", error: "This is a Lightning invoice. Paste a Fiber invoice (fibt…)." });
    expect(checkInvoiceText("fibt".padEnd(5_000, "q"), "testnet")).toEqual({ status: "invalid", error: "This is longer than any Fiber invoice. Check what was copied." });
  });

  test("the max fee is fnn's default rate, 0.5 %, rounded down", () => {
    expect(PAY_MAX_FEE_PER_THOUSAND).toBe(5);
    expect(maxFeeOf(ckb(5))).toBe(BigInt(2_500_000));
    expect(maxFeeOf(BigInt(199))).toBe(BigInt(0));
  });

  test("the node pays only on its network, unexpired, with an amount, in a known token, not its own nor the hub's, within what it can send with the fee", () => {
    const ctx = { network: "testnet" as const, tokens: TOKENS, ownNodeId: OWN_NODE, hubNodeIds: [HUB_ID], nowMs: NOW, sendable: () => ckb(1_000) };
    const verdict = (p: ParsedInvoice, o: Partial<typeof ctx> = {}) => checkParsedInvoice(p, { ...ctx, ...o });
    expect(verdict(parsed({ udtTypeScript: RUSD_SCRIPT, description: "coffee" }))).toEqual({
      ok: true,
      preview: { token: RUSD, amount: ckb(5), maxFee: BigInt(2_500_000), paymentHash: HASH, expiresAtMs: NOW + 3_600_000, payee: PAYEE, description: "coffee" },
    });
    const error = (p: ParsedInvoice, o: Partial<typeof ctx> = {}) => {
      const v = verdict(p, o);
      return v.ok ? null : v.error;
    };
    expect(error(parsed({ network: "mainnet" }))).toBe("This invoice is for CKB mainnet. Use a CKB testnet invoice (fibt…).");
    expect(error(parsed({ expiresAtMs: NOW }))).toBe("This invoice has expired. Ask for a new one.");
    expect(error(parsed({ expiresAtMs: null }))).toBeNull();
    expect(error(parsed({ amount: null }))).toBe("This invoice has no amount. Ask for one with an amount.");
    expect(error(parsed({ udtTypeScript: { ...RUSD_SCRIPT, args: "0x01" } }))).toBe("This invoice asks for a token your node does not hold.");
    expect(error(parsed({ payee: OWN_NODE }))).toBe("This invoice is your own node's. Pay it from another wallet.");
    expect(error(parsed({ payee: HUB_ID }))).toBe("This is the CKBolt hub's invoice. Pay it from Swap.");
    // The amount and its max fee must fit: exactly that is enough, one base unit less is not.
    expect(error(parsed(), { sendable: () => ckb(5) + BigInt(2_500_000) })).toBeNull();
    const short = verdict(parsed(), { sendable: () => ckb(5) });
    expect(short).toEqual({ ok: false, error: "Your channels can send 5 CKB now. Not enough for this and its fee.", cannotSend: true });
  });
});

/* =============================================================================================== bridge */

/** BroadcastChannel semantics in memory: a message reaches every other open channel of the same name, later. */
class Bus {
  readonly channels: Channel[] = [];
  readonly messages: unknown[] = [];
  readonly factory: ChannelFactory = (name) => {
    const c = new Channel(this, name);
    this.channels.push(c);
    return c;
  };
  deliver(from: Channel, data: unknown) {
    this.messages.push(structuredClone(data));
    for (const c of this.channels) if (c !== from && c.name === from.name && !c.closed) setTimeout(() => c.emit(structuredClone(data)), 0);
  }
}

class Channel implements BroadcastLike {
  closed = false;
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  constructor(
    private readonly bus: Bus,
    readonly name: string,
  ) {}
  postMessage(message: unknown) {
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

const FAST = { statusWindowMs: 40, statusLateMs: 200, invoiceTimeoutMs: 300, paymentTimeoutMs: 300, readTimeoutMs: 300, confirmTimeoutMs: 300 };
const PREVIEW = { paymentHash: HASH, asset: "CKB" as const, amount: "500000000", maxFee: "2500000", expiresAt: NOW + 3_600_000, payee: PAYEE, route: "direct" as const };
const ADDRESS = scriptToAddress(secpLock(), "testnet");
const notHere = async () => Promise.reject(new Error("not in this test"));

function payHandlers(overrides: Partial<BridgeHandlers> = {}): BridgeHandlers {
  return {
    presence: () => ({ phase: "running", nodeId: OWN_NODE, network: "testnet", hubConnected: true, liquidity: {} }),
    serves: () => true,
    makeInvoice: notHere,
    payInvoice: notHere,
    readInvoice: async () => PREVIEW,
    requestPayment: async () => ({ paymentHash: HASH, status: "Inflight", maxFee: "2500000" }),
    paymentStatus: async ({ paymentHash }) => ({ paymentHash, status: "Success", fee: "1000", failedError: null }),
    requestOnChain: async ({ amount }) => ({ txHash: `0x${"cd".repeat(32)}`, amount, fee: "1234" }),
    makeReceiveInvoice: notHere,
    invoiceStatus: notHere,
    ...overrides,
  };
}

test.describe("the bridge's Pay methods", () => {
  test("requests are rebuilt from their listed fields only: a password or anything else a page adds never reaches the node", () => {
    const read = parseRequest({ ...request("r", { method: BRIDGE_METHOD.READ_INVOICE, params: { invoice: "fibt1x" } }), params: { invoice: "fibt1x", password: "hunter22" } });
    expect(read).toEqual({ v: 1, kind: "request", id: "r", method: "read-invoice", params: { invoice: "fibt1x" } });
    const pay = parseRequest({ v: 1, kind: "request", id: "p", method: "request-payment", params: { invoice: "fibt1x", maxFee: "999", preimage: "00" } });
    expect(pay).toEqual({ v: 1, kind: "request", id: "p", method: "request-payment", params: { invoice: "fibt1x" } });
    const chain = parseRequest({ v: 1, kind: "request", id: "c", method: "request-on-chain", params: { address: ADDRESS, amount: "10000000000", password: "x", key: "y" } });
    expect(chain).toEqual({ v: 1, kind: "request", id: "c", method: "request-on-chain", params: { address: ADDRESS, amount: "10000000000" } });
    const status = parseRequest({ v: 1, kind: "request", id: "s", method: "payment-status", params: { paymentHash: HASH.toUpperCase().replace("0X", "0x") } });
    expect(status).toEqual({ v: 1, kind: "request", id: "s", method: "payment-status", params: { paymentHash: HASH } });
  });

  test("malformed params are refused: no invoice, too long, a bad hash, a zero or non-decimal amount, an address too long", () => {
    const bad = [
      { method: "read-invoice", params: {} },
      { method: "request-payment", params: { invoice: "f".repeat(5_000) } },
      { method: "payment-status", params: { paymentHash: "0x12" } },
      { method: "request-on-chain", params: { address: ADDRESS, amount: "0" } },
      { method: "request-on-chain", params: { address: ADDRESS, amount: "1.5" } },
      { method: "request-on-chain", params: { address: "c".repeat(300), amount: "1" } },
      { method: "request-on-chain", params: { amount: "1" } },
    ];
    for (const b of bad) expect(parseRequest({ v: 1, kind: "request", id: "x", ...b }), JSON.stringify(b).slice(0, 80)).toBeNull();
  });

  test("answers are checked: a preview keeps its listed fields only; results with the wrong shapes are refused", () => {
    expect(pickInvoicePreview({ ...PREVIEW, description: "secret?", preimage: "00" })).toEqual(PREVIEW);
    // Any asset id as the hub writes them (the node read it from the invoice against its hub's list); nothing else.
    expect(pickInvoicePreview({ ...PREVIEW, asset: "CWBTC" })).toEqual({ ...PREVIEW, asset: "CWBTC" });
    expect(pickInvoicePreview({ ...PREVIEW, asset: "eth" })).toBeNull();
    expect(pickInvoicePreview({ ...PREVIEW, asset: "E" })).toBeNull();
    expect(pickInvoicePreview({ ...PREVIEW, amount: "-1" })).toBeNull();
    expect(pickInvoicePreview({ ...PREVIEW, paymentHash: "0x1" })).toBeNull();
    // The route is its kind only: the hub's, or the node's own; anything else (a hop list, an unknown kind) is refused.
    expect(pickInvoicePreview({ ...PREVIEW, route: "hub", trampolineHops: [HUB_ID] })).toEqual({ ...PREVIEW, route: "hub" });
    expect(pickInvoicePreview({ ...PREVIEW, route: { kind: "hub", trampolineHops: [HUB_ID] } })).toBeNull();
    expect(pickInvoicePreview({ ...PREVIEW, route: "other" })).toBeNull();
    expect(pickInvoicePreview({ ...PREVIEW, route: undefined })).toBeNull();
    expect(isRequestPaymentResult({ paymentHash: HASH, status: "Created", maxFee: "1" })).toBe(true);
    expect(isRequestPaymentResult({ paymentHash: HASH, status: "Created" })).toBe(false);
    expect(isPaymentStatusResult({ paymentHash: HASH, status: "Success", fee: "1", failedError: null })).toBe(true);
    expect(isPaymentStatusResult({ paymentHash: HASH, status: "Success", fee: "x", failedError: null })).toBe(false);
    expect(isOnChainSendResult({ txHash: HASH, amount: "1", fee: "1" })).toBe(true);
    expect(isOnChainSendResult({ txHash: "abc", amount: "1", fee: "1" })).toBe(false);
  });

  test("a round trip of each method between the page and the node tab; refusals arrive as BridgeError with the node's words", async () => {
    const bus = new Bus();
    const stop = startBridgeServer(payHandlers(), bus.factory);
    const client = new BridgeClient(bus.factory, FAST);
    expect(await client.readInvoice({ invoice: "fibt1x" })).toEqual(PREVIEW);
    expect(await client.requestPayment({ invoice: "fibt1x" })).toEqual({ paymentHash: HASH, status: "Inflight", maxFee: "2500000" });
    expect(await client.paymentStatus({ paymentHash: HASH })).toEqual({ paymentHash: HASH, status: "Success", fee: "1000", failedError: null });
    expect(await client.requestOnChainSend({ address: ADDRESS, amount: "10000000000" })).toEqual({ txHash: `0x${"cd".repeat(32)}`, amount: "10000000000", fee: "1234" });
    stop();

    const refusing = new Bus();
    const stopRefusing = startBridgeServer(
      payHandlers({ requestPayment: async () => Promise.reject(new NodeRequestError(BRIDGE_ERROR.DECLINED, CONFIRM_MESSAGE.DECLINED)) }),
      refusing.factory,
    );
    const error = await new BridgeClient(refusing.factory, FAST).requestPayment({ invoice: "fibt1x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: "declined", message: "You declined it in your Fiber node. Nothing was sent." });
    stopRefusing();
    // Nothing secret ever crossed: no password, key or preimage field in any message.
    for (const m of [...bus.messages, ...refusing.messages]) expect(JSON.stringify(m)).not.toMatch(/password|preimage|secret|ckbKey|fiberKey/i);
  });

  test("a tab whose node does not run answers no Pay request", async () => {
    const bus = new Bus();
    const stop = startBridgeServer(payHandlers({ serves: () => false }), bus.factory);
    const error = await new BridgeClient(bus.factory, FAST).readInvoice({ invoice: "fibt1x" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: BRIDGE_ERROR.TIMEOUT });
    stop();
    expect(bus.channels.filter((c) => c.name === BRIDGE_CHANNEL_NAME).length).toBeGreaterThan(0);
  });
});

/* ======================================================================================= confirmations */

const PAY_VIEW = { kind: "fiber-payment" as const, asset: "CKB" as const, amount: "500000000", maxFee: "2500000", payee: PAYEE, note: null, expiresAt: null, route: "direct" as const };
const CHAIN_VIEW = { kind: "on-chain" as const, address: ADDRESS, amount: "10000000000", fee: "1000" };
const rejection = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

test.describe("the node's confirmations: only the visitor's Confirm in the node runs a Pay request", () => {
  test("a request waits; Confirm runs it once and resolves the page's request; the outcome stays for the page", async () => {
    const queue = new ConfirmationQueue();
    let changes = 0;
    queue.subscribe(() => changes++);
    let runs = 0;
    const asked = queue.ask(PAY_VIEW, async () => {
      runs++;
      return "sent";
    }, { timeoutMs: 10_000 });
    const pending = queue.snapshot().pending!;
    expect(pending).toMatchObject({ view: PAY_VIEW, running: false, error: null });
    expect(runs).toBe(0);
    // A second request while one waits is refused, and does not replace it.
    expect(await rejection(queue.ask(CHAIN_VIEW, async () => "x", { timeoutMs: 10_000 }))).toMatchObject({ code: BRIDGE_ERROR.BUSY });
    expect(queue.snapshot().pending?.id).toBe(pending.id);
    // Confirm of another id, or twice, runs nothing more.
    await queue.confirm(pending.id + 1);
    await Promise.all([queue.confirm(pending.id), queue.confirm(pending.id)]);
    expect(await asked).toBe("sent");
    expect(runs).toBe(1);
    expect(queue.snapshot()).toEqual({ pending: null, last: { id: pending.id, kind: "fiber-payment", status: "sent", message: null } });
    expect(changes).toBeGreaterThan(1);
  });

  test("Decline, no answer in time, or the node stopping: nothing runs, the page hears why", async () => {
    const queue = new ConfirmationQueue();
    let runs = 0;
    const action = async () => {
      runs++;
      return "x";
    };
    const declined = queue.ask(PAY_VIEW, action, { timeoutMs: 10_000 });
    queue.decline(queue.snapshot().pending!.id);
    expect(await rejection(declined)).toMatchObject({ code: BRIDGE_ERROR.DECLINED, message: CONFIRM_MESSAGE.DECLINED });
    expect(queue.snapshot().last?.status).toBe("declined");

    const late = queue.ask(PAY_VIEW, action, { timeoutMs: 30 });
    expect(await rejection(late)).toMatchObject({ code: BRIDGE_ERROR.DECLINED, message: CONFIRM_MESSAGE.EXPIRED });
    expect(queue.snapshot().last?.status).toBe("expired");

    const stopped = queue.ask(CHAIN_VIEW, action, { timeoutMs: 10_000 });
    queue.cancel();
    expect(await rejection(stopped)).toMatchObject({ code: BRIDGE_ERROR.NOT_RUNNING, message: CONFIRM_MESSAGE.STOPPED });
    expect(runs).toBe(0);
  });

  test("a wrong password keeps the request up with its reason; the next Confirm with the right one sends; any other failure ends it", async () => {
    const queue = new ConfirmationQueue();
    const passwords: (string | null)[] = [];
    const sent = queue.ask(
      CHAIN_VIEW,
      async (password) => {
        passwords.push(password);
        if (password !== "right") throw new Error("Wrong password.");
        return "0xtx";
      },
      { timeoutMs: 10_000, retryable: (e) => e instanceof Error && e.message === "Wrong password." },
    );
    const { id } = queue.snapshot().pending!;
    await queue.confirm(id, "wrong");
    expect(queue.snapshot().pending).toMatchObject({ id, running: false, error: "Wrong password." });
    await queue.confirm(id, "right");
    expect(await sent).toBe("0xtx");
    expect(passwords).toEqual(["wrong", "right"]);

    const failing = queue.ask(PAY_VIEW, async () => Promise.reject(new Error("no path found")), { timeoutMs: 10_000 });
    await queue.confirm(queue.snapshot().pending!.id);
    expect(await rejection(failing)).toMatchObject({ code: BRIDGE_ERROR.NODE_ERROR, message: "no path found" });
    expect(queue.snapshot().last).toMatchObject({ status: "failed", message: "no path found" });
  });
});

/* ===================================================================================== node handlers */

/** A node for Pay's handlers: reads invoices from a table, records each call in order with History's writes. */
class PayNode implements BrowserFiberNode {
  readonly log: string[] = [];
  channels: NodeChannel[] = [channel({ local: ckb(1_000) }), channel({ local: ckb(100), udt: RUSD_SCRIPT })];
  invoice: ParsedInvoice | Error = parsed();
  payment: Partial<NodePayment> | Error = { status: "Inflight" };
  /** The real sends' options (dry runs are in `probes`). */
  readonly options: (SendPaymentOptions | undefined)[] = [];
  readonly probes: SendPaymentOptions[] = [];
  /** What a dry run finds, as fnn: null builds a route; a string is the RPC error it throws. */
  routes: { direct: string | null; hub: string | null } = { direct: null, hub: null };

  async info() {
    return { nodeId: OWN_NODE, version: "0.9.1", fundingLockScript: secpLock() };
  }
  async connectPeer() {}
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
  async newInvoice(): Promise<never> {
    throw new Error("not in Pay");
  }
  async getInvoiceStatus() {
    return "Open" as const;
  }
  async cancelInvoice(): Promise<never> {
    throw new Error("not in Pay");
  }
  async parseInvoice(invoice: string) {
    this.log.push(`parse_invoice ${invoice}`);
    if (this.invoice instanceof Error) throw this.invoice;
    return this.invoice;
  }
  async sendPayment(invoice: string, options?: SendPaymentOptions): Promise<NodePayment> {
    if (options?.dryRun) {
      const via = options.trampolineHops?.length ? "hub" : "direct";
      this.log.push(`dry_run ${via}`);
      this.probes.push(options);
      const error = this.routes[via];
      if (error) throw new Error(error);
      return { paymentHash: HASH, status: "Created", failedError: null, fee: BigInt(1_000) };
    }
    this.log.push(`send_payment ${invoice}`);
    this.options.push(options);
    if (this.payment instanceof Error) throw this.payment;
    return { paymentHash: HASH, status: "Inflight", failedError: null, fee: BigInt(0), ...this.payment };
  }
  async getPayment(hash: string): Promise<NodePayment> {
    this.log.push(`get_payment ${hash}`);
    return { paymentHash: hash, status: "Success", failedError: null, fee: BigInt(1_000) };
  }
  async stop() {}
}

const payDeps = (node: PayNode, o: Partial<FiberPayDeps> = {}): FiberPayDeps => ({
  node,
  network: "testnet",
  hubNode: HUB_NODE,
  hubNodeIds: [HUB_ID],
  ownNodeId: OWN_NODE,
  now: () => NOW,
  ...o,
});

const INVOICE = demoFiberInvoice("testnet", ckb(5));

test.describe("the node's handlers for Pay", () => {
  test("read: parse_invoice, then every check, over all the node's ready channels in the token; nothing is paid", async () => {
    const node = new PayNode();
    node.invoice = parsed({ udtTypeScript: RUSD_SCRIPT, description: "  a coffee  " });
    const preview = await readFiberInvoice(payDeps(node), { invoice: INVOICE });
    expect(invoicePreviewDto(preview)).toEqual({
      paymentHash: HASH,
      asset: "RUSD",
      amount: ckb(5).toString(),
      maxFee: "2500000",
      expiresAt: NOW + 3_600_000,
      payee: PAYEE,
      route: "direct",
    });
    expect(paymentConfirmView(preview)).toEqual({
      kind: "fiber-payment",
      asset: "RUSD",
      amount: ckb(5).toString(),
      maxFee: "2500000",
      payee: PAYEE,
      note: "a coffee",
      expiresAt: NOW + 3_600_000,
      route: "direct",
    });
    // A dry run of its own route, with the max fee shown; nothing is paid.
    expect(node.log).toEqual([`parse_invoice ${INVOICE}`, "dry_run direct"]);
    expect(node.probes).toEqual([{ maxFeeAmount: BigInt(2_500_000), dryRun: true }]);

    // The page's network check again in the node, before it reads anything.
    expect(await rejection(readFiberInvoice(payDeps(node), { invoice: demoFiberInvoice("mainnet", ckb(5)) }))).toMatchObject({ code: BRIDGE_ERROR.INVALID_REQUEST });
    node.invoice = new Error("Invalid invoice");
    expect(await rejection(readFiberInvoice(payDeps(node), { invoice: INVOICE }))).toMatchObject({ code: BRIDGE_ERROR.REFUSED, message: "Your node could not read this invoice: Invalid invoice" });
    node.invoice = parsed({ amount: ckb(100), udtTypeScript: RUSD_SCRIPT });
    expect(await rejection(readFiberInvoice(payDeps(node), { invoice: INVOICE }))).toMatchObject({ code: BRIDGE_ERROR.NO_OUTBOUND });
    expect(node.log.filter((l) => l.startsWith("send_payment"))).toEqual([]);
  });

  test("pay: History gets the payment with its hash BEFORE send_payment, which gets the max fee shown; then its status", async () => {
    const node = new PayNode();
    const recorded: ActivityEntry[] = [];
    const record = (e: ActivityEntry) => {
      node.log.push(`record ${e.status}`);
      recorded.push(e);
    };
    const preview = await readFiberInvoice(payDeps(node), { invoice: INVOICE });
    const result = await payConfirmedInvoice(payDeps(node), INVOICE, preview, record);
    expect(result).toEqual({ paymentHash: HASH, status: "Inflight", maxFee: "2500000" });
    expect(node.log).toEqual([`parse_invoice ${INVOICE}`, "dry_run direct", "record Created", `send_payment ${INVOICE}`, "record Inflight"]);
    expect(node.options).toEqual([{ maxFeeAmount: BigInt(2_500_000) }]);
    expect(recorded[0]).toEqual({
      id: HASH,
      kind: "payment",
      asset: "CKB",
      amount: ckb(5).toString(),
      status: "Created",
      error: null,
      at: NOW,
      fee: null,
      payment: { maxFee: "2500000", payee: PAYEE },
    });
    // Nothing secret in History: no invoice text, no preimage.
    expect(JSON.stringify(recorded)).not.toContain(INVOICE);

    // Its status, read for the page, follows into History; a hash History does not hold is refused.
    const entries = [recorded.at(-1)!];
    const status = await readPaymentStatus(payDeps(node), entries, { paymentHash: HASH }, record);
    expect(status).toEqual({ paymentHash: HASH, status: "Success", fee: "1000", failedError: null });
    expect(recorded.at(-1)).toMatchObject({ status: "Success", fee: "1000" });
    expect(await rejection(readPaymentStatus(payDeps(node), entries, { paymentHash: `0x${"ef".repeat(32)}` }, record))).toMatchObject({ code: BRIDGE_ERROR.REFUSED });
  });

  test("pay: an invoice that expired while waiting is not sent; send_payment refusing marks the entry failed", async () => {
    const node = new PayNode();
    const recorded: ActivityEntry[] = [];
    const preview = await readFiberInvoice(payDeps(node), { invoice: INVOICE });
    const later = payDeps(node, { now: () => NOW + 3_600_000 });
    expect(await rejection(payConfirmedInvoice(later, INVOICE, preview, (e) => recorded.push(e)))).toMatchObject({ code: BRIDGE_ERROR.REFUSED, message: "This invoice has expired. Ask for a new one." });
    expect(recorded).toEqual([]);
    node.payment = new Error("no path found");
    expect(await rejection(payConfirmedInvoice(payDeps(node), INVOICE, preview, (e) => recorded.push(e)))).toMatchObject({ code: BRIDGE_ERROR.NODE_ERROR, message: "no path found" });
    expect(recorded.map((e) => [e.status, e.error])).toEqual([
      ["Created", null],
      ["Failed", "no path found"],
    ]);
  });

  test("routes: its own route first; through the hub (by hubNode's id, not a stale one) only when that fails; the send uses exactly the route probed", async () => {
    const node = new PayNode();
    node.routes = { direct: "Failed to build route", hub: null };
    const STALE = `02${"77".repeat(32)}`;
    const recorded: ActivityEntry[] = [];
    // hubNodeIds also holds an id kept in this browser from before: the trampoline is the hub's node as it is now.
    const deps = payDeps(node, { hubNodeIds: [STALE, HUB_ID] });
    const preview = await readFiberInvoice(deps, { invoice: INVOICE });
    expect(node.log).toEqual([`parse_invoice ${INVOICE}`, "dry_run direct", "dry_run hub"]);
    expect(node.probes).toEqual([
      { maxFeeAmount: BigInt(2_500_000), dryRun: true },
      { maxFeeAmount: BigInt(2_500_000), trampolineHops: [HUB_ID], dryRun: true },
    ]);
    expect(preview.route).toEqual({ kind: "hub", trampolineHops: [HUB_ID] });
    // Across the bridge and on the Confirm page: the kind only, never the hop.
    expect(invoicePreviewDto(preview).route).toBe("hub");
    expect(paymentConfirmView(preview)).toMatchObject({ route: "hub" });
    expect(JSON.stringify(invoicePreviewDto(preview))).not.toContain(HUB_ID);
    expect(JSON.stringify(paymentConfirmView(preview))).not.toContain(HUB_ID);
    // Dry runs write nothing to History.
    expect(recorded).toEqual([]);

    // Confirmed: the real send carries the trampoline hop it probed, even if the routes changed since.
    node.routes = { direct: null, hub: null };
    await payConfirmedInvoice(deps, INVOICE, preview, (e) => recorded.push(e));
    expect(node.options).toEqual([{ maxFeeAmount: BigInt(2_500_000), trampolineHops: [HUB_ID] }]);
    expect(recorded.map((e) => e.status)).toEqual(["Created", "Inflight"]);

    // A direct route sends as before: no trampoline, no dry run flag.
    const direct = new PayNode();
    await payConfirmedInvoice(payDeps(direct), INVOICE, await readFiberInvoice(payDeps(direct), { invoice: INVOICE }), () => undefined);
    expect(direct.log).toEqual([`parse_invoice ${INVOICE}`, "dry_run direct", `send_payment ${INVOICE}`]);
    expect(direct.options).toEqual([{ maxFeeAmount: BigInt(2_500_000) }]);
  });

  test("no route: without a hub on the node's network it is refused after its own dry run; with one, after both, with fnn's reasons; nothing is sent", async () => {
    const node = new PayNode();
    node.routes = { direct: "Failed to build route", hub: "Failed to build route: no path to trampoline" };
    const noHub = await rejection(readFiberInvoice(payDeps(node, { hubNode: null, hubNodeIds: [HUB_ID] }), { invoice: INVOICE }));
    expect(noHub).toBeInstanceOf(NodeRequestError);
    expect(noHub).toMatchObject({ code: BRIDGE_ERROR.NO_ROUTE, message: "Failed to build route" });
    expect(node.log).toEqual([`parse_invoice ${INVOICE}`, "dry_run direct"]);

    node.log.length = 0;
    const both = await rejection(readFiberInvoice(payDeps(node), { invoice: INVOICE }));
    expect(both).toMatchObject({
      code: BRIDGE_ERROR.NO_ROUTE,
      message: "Direct: Failed to build route; through the CKBolt hub: Failed to build route: no path to trampoline",
    });
    expect(node.log).toEqual([`parse_invoice ${INVOICE}`, "dry_run direct", "dry_run hub"]);

    // The hub is never its own trampoline: an invoice the hub's node pays itself is not tried through it.
    node.log.length = 0;
    node.invoice = parsed({ payee: HUB_ID });
    const hubPayee = await rejection(readFiberInvoice(payDeps(node, { hubNodeIds: [] }), { invoice: INVOICE }));
    expect(hubPayee).toMatchObject({ code: BRIDGE_ERROR.NO_ROUTE, message: "Failed to build route" });
    expect(node.log).toEqual([`parse_invoice ${INVOICE}`, "dry_run direct"]);
    expect(node.options).toEqual([]);

    // A tiny amount: the 0.5 % cap rounds to 0, so fnn finds no route within it; the same refusal, fnn's reason behind it.
    const tiny = new PayNode();
    tiny.invoice = parsed({ amount: BigInt(150) });
    tiny.routes = { direct: "Failed to build route: max fee 0 too low", hub: "max_fee_amount too low for trampoline" };
    expect(await rejection(readFiberInvoice(payDeps(tiny), { invoice: INVOICE }))).toMatchObject({ code: BRIDGE_ERROR.NO_ROUTE });
    expect(tiny.probes.map((o) => o.maxFeeAmount)).toEqual([BigInt(0), BigInt(0)]);
  });

  test("an invoice's note is trimmed and cut short for the Confirm page", () => {
    expect(shortNote(null)).toBeNull();
    expect(shortNote("   ")).toBeNull();
    expect(shortNote("x".repeat(200))).toBe(`${"x".repeat(140)}…`);
  });
});

/* ============================================================================================ History */

const paymentEntry = (o: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: HASH,
  kind: "payment",
  asset: "CKB",
  amount: ckb(5).toString(),
  status: "Created",
  error: null,
  at: NOW,
  fee: null,
  payment: { maxFee: "2500000", payee: PAYEE },
  ...o,
});

/** localStorage in memory. */
class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, string>();
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

test.describe("History's payment kind and its recovery after a reload", () => {
  test("a payment is under way (held, read again with get_payment) until Success or Failed", () => {
    for (const status of ["Created", "Inflight"] as const) {
      const entry = paymentEntry({ status });
      expect(isActivityFinal(entry)).toBe(false);
      expect(holdsNode(entry)).toBe(true);
      expect(isPollable(entry)).toBe(true);
      expect(isPaymentEntry(entry)).toBe(true);
      expect(activityTone(entry)).toBe("pending");
    }
    expect(activityLabel(paymentEntry({ status: "Created" }))).toBe("Sending");
    expect(activityLabel(paymentEntry({ status: "Inflight" }))).toBe("In flight");
    for (const [status, tone, label] of [
      ["Success", "ok", "Paid"],
      ["Failed", "error", "Failed"],
    ] as const) {
      const entry = paymentEntry({ status });
      expect(isActivityFinal(entry)).toBe(true);
      expect(holdsNode(entry)).toBe(false);
      expect(isPollable(entry)).toBe(false);
      expect(activityTone(entry)).toBe(tone);
      expect(activityLabel(entry)).toBe(label);
    }
  });

  test("get_payment moves it on: Success with the fee it took; Failed with fnn's reason", () => {
    expect(withPayment(paymentEntry(), { status: "Success", failedError: null, fee: BigInt(1_000) })).toMatchObject({ status: "Success", fee: "1000", error: null });
    expect(withPayment(paymentEntry(), { status: "Failed", failedError: "no path found", fee: BigInt(0) })).toMatchObject({ status: "Failed", fee: null, error: "no path found" });
  });

  test("a read of get_payment that started before send_payment's answer was recorded does not overwrite it", () => {
    const created = paymentEntry({ status: "Created" });
    const failed = { ...created, status: "Failed" as const, error: "no path found" };
    const staleRead = withPayment(created, { status: "Inflight", failedError: null, fee: BigInt(0) });
    expect(landRead([failed], created, staleRead)).toEqual([failed]);
    // Nothing newer: the read lands.
    expect(landRead([created], created, staleRead)).toEqual([staleRead]);
    // The entry is gone (another node's list): nothing lands.
    expect(landRead([], created, staleRead)).toEqual([]);
  });

  test("kept in this browser and read back after a reload, still pending, so it is read again; a malformed one is dropped", () => {
    const store = new MemoryStore();
    saveHistory(store, "testnet", OWN_NODE, [paymentEntry({ status: "Inflight" })]);
    const back = readHistory(store, "testnet", OWN_NODE);
    expect(back).toEqual([paymentEntry({ status: "Inflight" })]);
    expect(back.filter(isPollable)).toHaveLength(1);
    const key = storageKey("testnet", `history:${OWN_NODE}`);
    store.setItem(key, JSON.stringify([paymentEntry(), { ...paymentEntry(), id: "0x2", payment: null }, { ...paymentEntry(), id: "0x3", payment: { maxFee: "x" } }]));
    expect(readHistory(store, "testnet", OWN_NODE).map((e) => e.id)).toEqual([HASH]);
  });
});

/* ============================================================================ on chain, exact amount */

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

const HEX = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;
const fromCcc = (s: ccc.Script): Script => ({ codeHash: s.codeHash, hashType: s.hashType, args: s.args });
/** A lock like JoyID's: another code hash, hash type data1, 22 bytes of args. */
const otherLock = (): Script => ({ codeHash: HEX(Buffer.alloc(32, 0xd2)), hashType: "data1", args: HEX(Buffer.alloc(22, 0x07)) });

async function chainSetup(cells: number[]) {
  const chain = new FakeCkbChain();
  const { url, server } = await startRpc(chain);
  const client = cccNodeClient(url, "testnet");
  const keys: NodeKeys = generateNodeKeys();
  const nodeLock = fromCcc((await new ccc.SignerCkbPrivateKey(client, HEX(keys.ckbKey)).getRecommendedAddressObj()).script);
  for (const c of cells) chain.addCell({ lock: nodeLock, capacity: units(c) });
  return { chain, client, keys, nodeLock, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const failure = async (p: Promise<unknown>): Promise<WithdrawError> => {
  const e = await rejection(p);
  expect(e).toBeInstanceOf(WithdrawError);
  return e as WithdrawError;
};

test.describe("Pay's on-chain send: exactly the amount, the change back to the node (CCC, fake CKB testnet)", () => {
  test("one output of exactly the amount to the address, the rest minus the fee back to the node's lock; the preview's fee is the fee paid", async () => {
    const s = await chainSetup([600, 400]);
    try {
      const to = secpLock();
      const { fee: previewFee } = await previewSend({ client: s.client, nodeLock: s.nodeLock, to, amount: units(250) });
      expect(s.chain.sent).toEqual([]);
      const receipt = await sendAmount({ client: s.client, keys: s.keys, nodeLock: s.nodeLock, to, amount: units(250) });
      expect(s.chain.sent).toHaveLength(1);
      const tx = s.chain.sent[0];
      expect(receipt.txHash).toBe(rpcTransactionHash(tx));
      expect(receipt.amount).toBe(units(250));
      expect(receipt.fee).toBe(previewFee);
      expect(receipt.fee).toBeGreaterThan(BigInt(0));
      expect(receipt.fee).toBeLessThan(units(1) / BigInt(100));
      expect(tx.outputs).toHaveLength(2);
      expect(sameScript(tx.outputs[0].lock, to)).toBe(true);
      expect(BigInt(tx.outputs[0].capacity)).toBe(units(250));
      expect(sameScript(tx.outputs[1].lock, s.nodeLock)).toBe(true);
      const spent = tx.inputs.reduce((sum, i) => sum + s.chain.cells.find((c) => c.txHash === i.previous_output.tx_hash)!.capacity, BigInt(0));
      expect(BigInt(tx.outputs[1].capacity)).toBe(spent - units(250) - receipt.fee);
      expect(tx.witnesses[0].length).toBeGreaterThan(2 + 130);
      expect(s.keys.ckbKey.every((b) => b === 0)).toBe(true);
      expect(s.chain.unknown).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("refused before anything is signed: below one cell of the address's lock, more than the node holds, a rest too small for a cell", async () => {
    const s = await chainSetup([200]);
    try {
      const signer = new ccc.SignerCkbPrivateKey(s.client, HEX(s.keys.ckbKey));
      const below = await failure(buildExactSend(signer, otherLock(), units(61), s.nodeLock));
      expect(below.code).toBe(WITHDRAW_FAILURE.BELOW_CELL);
      expect(below.message).toBe(SEND_MESSAGE.BELOW_CELL("63"));
      expect((await failure(buildExactSend(signer, secpLock(), units(500), s.nodeLock))).code).toBe(WITHDRAW_FAILURE.NOT_ENOUGH);
      // 200 CKB less 150 leaves 50: too little for the change cell of the node's lock (61 CKB).
      const noChange = await failure(buildExactSend(signer, secpLock(), units(150), s.nodeLock));
      expect(noChange.code).toBe(WITHDRAW_FAILURE.NO_CHANGE);
      expect(s.chain.sent).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("when it may start: not while a channel moves funds, not before the balance is known, not below a cell, not more than held", () => {
    const lock = secpLock();
    expect(minCellShannons(lock)).toBe(units(61));
    expect(minCellShannons(otherLock())).toBe(units(63));
    const ready = [{ state: "ChannelReady" }];
    expect(sendBlock(units(100), lock, units(500), [{ state: "NegotiatingFunding" }])).toBe(WITHDRAW_BLOCK.CHANNELS_MOVING);
    expect(sendBlock(units(100), lock, null, ready)).toBe(WITHDRAW_BLOCK.BALANCE_UNKNOWN);
    expect(sendBlock(units(60), lock, units(500), ready)).toBe(SEND_MESSAGE.BELOW_CELL("61"));
    expect(sendBlock(units(500), lock, units(500), ready)).toBe(SEND_MESSAGE.OVER_BALANCE("500"));
    expect(sendBlock(units(100), lock, units(500), ready)).toBeNull();
  });
});

/* ========================================================================================== adapter */

test.describe("fiber-js: parse_invoice, the max fee and the route", () => {
  test("parse_invoice is read into the app's terms; send_payment carries max_fee_amount, trampoline_hops and dry_run only when given", async () => {
    const calls: { name: string; args: unknown[] | undefined }[] = [];
    const fiber: FiberLike = {
      start: async () => {},
      stop: async () => {},
      invokeCommand: async (name, args) => {
        calls.push({ name, args });
        if (name === "parse_invoice") return { invoice: rpcInvoice() };
        return { payment_hash: HASH, status: "Created", fee: "0x0" };
      },
    };
    const node = new FiberJsNode(fiber);
    expect(await node.parseInvoice("fibt1x")).toMatchObject({ paymentHash: HASH, amount: ckb(5), payee: PAYEE, description: "coffee" });
    await node.sendPayment("fibt1x", { maxFeeAmount: BigInt(2_500_000) });
    await node.sendPayment("fibt1hold");
    // Trampoline hops as plain lower-case node ids (as open_channel's pubkey), dry_run only when asked.
    await node.sendPayment("fibt1x", { maxFeeAmount: BigInt(2_500_000), trampolineHops: [`0x${HUB_ID.toUpperCase()}`], dryRun: true });
    await node.sendPayment("fibt1x", { maxFeeAmount: BigInt(2_500_000), trampolineHops: [], dryRun: false });
    expect(calls).toEqual([
      { name: "parse_invoice", args: [{ invoice: "fibt1x" }] },
      { name: "send_payment", args: [{ invoice: "fibt1x", max_fee_amount: "0x2625a0" }] },
      { name: "send_payment", args: [{ invoice: "fibt1hold" }] },
      { name: "send_payment", args: [{ invoice: "fibt1x", max_fee_amount: "0x2625a0", trampoline_hops: [HUB_ID], dry_run: true }] },
      { name: "send_payment", args: [{ invoice: "fibt1x", max_fee_amount: "0x2625a0" }] },
    ]);
  });
});

/* ============================================================================================ relay */

test.describe("the popup's Confirm page", () => {
  test("is one of the popup's pages, and the page may open the popup on it", () => {
    expect(WALLET_PAGES).toContain("confirm");
    expect(parseRelayMessage(navigateMessage("confirm"))).toEqual(navigateMessage("confirm"));
    expect(parseRelayMessage({ ...navigateMessage("confirm"), page: "pay-now" })).toBeNull();
  });

});
