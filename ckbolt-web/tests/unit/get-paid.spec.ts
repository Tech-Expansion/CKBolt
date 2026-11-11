import { expect, test } from "@playwright/test";
import { historyTitle, type HistoryNames } from "../../components/app/fiber-node/history-list";
import { REQUEST_COPY, REQUEST_ERROR } from "../../lib/get-paid/copy";
import {
  canRenew,
  checkRequestForm,
  fiberPart,
  lightningPart,
  rangeError,
  requestLimit,
  requestPayments,
  shouldCancelSwap,
  type FiberAsk,
  type RunLike,
} from "../../lib/get-paid/request";
import type { AssetDto, FiberNodeDto, QuoteDto, Script, SwapDto } from "../../lib/hub/contract";
import { secondsUntil } from "../../lib/hub/format";
import { demoFiberInvoice } from "../../lib/payment-request";
import { activityTone, requestPartTone } from "../../lib/status-tone";
import { NO_PROGRESS } from "../../lib/hub/lifecycle";
import { runOutcome, runSteps, type PayStep, type RunInput } from "../../lib/swap/run-model";
import { activityLabel, holdsNode, isActivityFinal, isPaymentEntry, isPollable, readHistory, saveHistory, type ActivityEntry } from "../../lib/wallets/fiber-browser/activity";
import { inHistoryFilter, mergeHistory } from "../../lib/wallets/fiber-browser/history";
import { BridgeClient, BridgeError, type BroadcastLike, type ChannelFactory } from "../../lib/wallets/fiber-browser/bridge-client";
import { BRIDGE_ERROR, isInvoiceStatusResult, parseRequest, pickReceiveInvoice, request } from "../../lib/wallets/fiber-browser/bridge-protocol";
import { startBridgeServer, type BridgeHandlers } from "../../lib/wallets/fiber-browser/bridge-server";
import { INVOICE_NOTE_MAX_LENGTH, RECEIVE_INVOICE_EXPIRY_SECONDS } from "../../lib/wallets/fiber-browser/constants";
import type { BrowserFiberNode, NewInvoiceArgs, NodeChannel, NodeInvoiceStatus } from "../../lib/wallets/fiber-browser/node-port";
import { NodeRequestError } from "../../lib/wallets/fiber-browser/request-error";
import { makeReceiveInvoice, readRequestInvoiceStatus, receiveInvoiceArgs, requestEntry, requestNote, type RequestInvoiceDeps } from "../../lib/wallets/fiber-browser/request-invoices";
import { storageKey, type KeyValueStore } from "../../lib/wallets/fiber-browser/storage";
import { checkNodeInvoice } from "../../lib/wallets/fiber-wallet/invoice-check";

/*
 * Get paid on /app (docs/pay-get-paid.md, part C), its pure parts: the form's checks (the amount in the asset received,
 * the note, the per-swap limits on the Lightning invoice), where the request's Lightning invoice stands from the swap
 * card's run (its countdown and expiry, "New invoice"), where its Fiber invoice stands, the receipt's payments, the
 * bridge's Get paid methods (validation, nothing secret, a round trip), the node's handlers (the invoice it makes, the
 * preimage wiped, History without the invoice text, the status of its own request invoices only), and History's
 * `request` kind.
 */

const SHANNONS = BigInt(100_000_000);
const ckb = (whole: number): bigint => BigInt(whole) * SHANNONS;
const NOW = Date.parse("2026-10-30T10:00:00Z");
const HASH = `0x${"ab".repeat(32)}`;
const OTHER_HASH = `0x${"cd".repeat(32)}`;
const OWN_NODE = `03${"11".repeat(32)}`;
const HUB_ID = "02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71";
const RUSD_SCRIPT: Script = {
  codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hashType: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const HUB_ASSETS: FiberNodeDto["assets"] = [
  { id: "CKB", udtTypeScript: null, udtWhitelist: null, peerChannels: null },
  { id: "RUSD", udtTypeScript: RUSD_SCRIPT, udtWhitelist: null, peerChannels: null },
];
const ASSET: Pick<AssetDto, "minSats" | "maxSats" | "decimals"> = { minSats: "1000", maxSats: "100000", decimals: 8 };
const PRICES: QuoteDto["prices"] = { btcUsd: 80_000, assetUsd: 0.002, source: "test", at: new Date(NOW).toISOString() };
const INVOICE = demoFiberInvoice("testnet", ckb(1_000));

/* ============================================================================================== the form */

test.describe("Get paid's form", () => {
  const form = (amountText: string, note = "", decimalMark: "." | "," = ".") => checkRequestForm({ amountText, note, decimals: 8, symbol: "CKB", decimalMark });

  test("the amount in the asset received (any decimal mark, base units out); the note trimmed, optional, short", () => {
    expect(form("")).toEqual({ ok: false, field: "amount", error: null });
    expect(form("   ")).toEqual({ ok: false, field: "amount", error: null });
    expect(form("0")).toEqual({ ok: false, field: "amount", error: "Enter an amount of CKB above zero." });
    expect(form("0.000000001")).toEqual({ ok: false, field: "amount", error: REQUEST_ERROR.AMOUNT("CKB") });
    expect(form("1.2.3")).toEqual({ ok: false, field: "amount", error: REQUEST_ERROR.AMOUNT("CKB") });
    expect(form("1,000")).toEqual({ ok: true, units: ckb(1_000).toString(), note: null });
    expect(form("12,5", "", ",")).toEqual({ ok: true, units: "1250000000", note: null });
    expect(form("5", "  Table 4  ")).toEqual({ ok: true, units: ckb(5).toString(), note: "Table 4" });
    expect(form("5", "x".repeat(INVOICE_NOTE_MAX_LENGTH))).toMatchObject({ ok: true });
    expect(form("5", "x".repeat(INVOICE_NOTE_MAX_LENGTH + 1))).toEqual({ ok: false, field: "note", error: "Keep the note to 100 characters." });
  });

  test("the per-swap limits apply to the Lightning invoice: the sats the hub quoted, or the amount sized at earlier prices", () => {
    const quote = (sats: number) => ({ pay: { network: "lightning" as const, asset: "BTC" as const, amount: String(sats), decimals: 8 } });
    const limit = (o: { sats?: number; code?: string | null; prices?: QuoteDto["prices"] | null; units?: bigint }) =>
      requestLimit({
        asset: ASSET,
        units: (o.units ?? ckb(1_000)).toString(),
        quote: o.sats === undefined ? null : quote(o.sats),
        quoteErrorCode: o.code ?? null,
        knownPrices: o.prices ?? null,
      });
    expect(limit({ sats: 2_526 })).toBeNull();
    expect(limit({ sats: 1_000 })).toBeNull();
    expect(limit({ sats: 100_000 })).toBeNull();
    expect(limit({ sats: 999 })).toEqual({ kind: "min", sats: "1000" });
    expect(limit({ sats: 100_001 })).toEqual({ kind: "max", sats: "100000" });
    // The hub refused the amount: earlier prices tell which side (1 CKB is 2.5 sats; 100,000 CKB 250,000 sats).
    expect(limit({ code: "validation_failed", prices: PRICES, units: ckb(1) })).toEqual({ kind: "min", sats: "1000" });
    expect(limit({ code: "validation_failed", prices: PRICES, units: ckb(100_000) })).toEqual({ kind: "max", sats: "100000" });
    expect(limit({ code: "validation_failed" })).toEqual({ kind: "range" });
    expect(limit({ code: "insufficient_liquidity" })).toEqual({ kind: "liquidity" });
    expect(limit({})).toBeNull();
    // One line for a range, in sats; liquidity is the hub's own sentence.
    expect(rangeError({ kind: "min", sats: "1000" }, ASSET)).toEqual({ line: "On Lightning, requests run from 1,000 to 100,000 sats.", detail: null });
    expect(rangeError({ kind: "range" }, ASSET)?.line).toBe(REQUEST_ERROR.RANGE("1,000", "100,000"));
    expect(rangeError({ kind: "liquidity" }, ASSET)).toBeNull();
    expect(rangeError(null, ASSET)).toBeNull();
  });
});

/* =================================================================================== the Lightning invoice */

const QUOTE_EXPIRES = new Date(NOW + 180_000).toISOString();
const HOLD_INVOICE = "lntbs25260n1fakeholdinvoice";

const swapDto = (o: Partial<SwapDto> = {}): SwapDto => ({
  id: "6f0d1f8e-0000-4000-8000-000000000001",
  quoteId: "q",
  direction: "ln_to_fiber",
  asset: "CKB",
  state: "pending",
  paymentHash: "ab".repeat(32),
  pay: { network: "lightning", asset: "BTC", amount: "2526", decimals: 8, invoice: HOLD_INVOICE },
  receive: { network: "fiber", asset: "CKB", amount: ckb(1_000).toString(), decimals: 8, invoice: INVOICE },
  refunded: false,
  failureReason: null,
  preimage: null,
  demo: false,
  quoteExpiresAt: QUOTE_EXPIRES,
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  links: { self: "/v1/swaps/x", events: "/v1/swaps/x/events" },
  ...o,
});

/** The swap card's run as the runner shows it: the model's steps and outcome for this swap, the hold invoice while it waits. */
function runOf(swap: SwapDto | null, o: { pay?: PayStep; nowMs?: number; funded?: boolean; invoiceFailed?: boolean } = {}): RunLike {
  const nowMs = o.nowMs ?? NOW;
  const expired = Date.parse(swap?.quoteExpiresAt ?? QUOTE_EXPIRES) <= nowMs;
  const progress = o.funded ? { funded: true, payoutStarted: false } : NO_PROGRESS;
  const pay: PayStep = o.pay ?? (swap ? { status: "manual" } : { status: "idle" });
  const input: RunInput = {
    direction: "ln_to_fiber",
    invoice: o.invoiceFailed ? { status: "failed", error: { line: "Your node cannot receive this much yet.", detail: "ask the hub" } } : swap ? { status: "made", invoice: INVOICE, pasted: false } : { status: "making" },
    creating: false,
    createError: null,
    swap,
    progress,
    pay,
    expired,
  };
  return {
    swap,
    steps: runSteps(input),
    outcome: runOutcome(swap, progress),
    manualInvoice: pay.status === "manual" && swap?.state === "pending" && !expired ? swap.pay.invoice : null,
  };
}

test.describe("the request's Lightning invoice, from the swap's run", () => {
  test("not made until its tab opens: idle, whatever else is known; nothing to renew", () => {
    expect(lightningPart({ quoteError: null, run: null, nowMs: NOW, requested: false })).toEqual({ status: "idle", invoice: null, sats: null, expiresAt: null, error: null });
    expect(lightningPart({ quoteError: { line: "Refused.", detail: null }, run: runOf(swapDto()), nowMs: NOW, requested: false }).status).toBe("idle");
    expect(canRenew("idle")).toBe(false);
    // Left out, it was asked for (the swap card's way of reading a run).
    expect(lightningPart({ quoteError: null, run: null, nowMs: NOW }).status).toBe("making");
  });

  test("its copy says the payer pays BTC and the requester receives the asset, in at most 12 words; the conversion's sats are a Lightning payer's", () => {
    for (const symbol of ["CKB", "RUSD"]) {
      const line = REQUEST_COPY.LIGHTNING_LABEL(symbol);
      expect(line).toBe(`They pay BTC on Lightning. You receive ${symbol}.`);
      expect(line.split(/\s+/).length).toBeLessThanOrEqual(12);
    }
    expect(REQUEST_COPY.CONVERSION("≈ $2.00", "2,526")).toBe("≈ $2.00 · 2,526 sats on Lightning");
    for (const line of [REQUEST_COPY.LIGHTNING_MAKING, REQUEST_COPY.STATUS.idle]) expect(line.split(/\s+/).length).toBeLessThanOrEqual(12);
    // The detail is behind the "?": the swap, no BTC held, the request's lifetime, the cancel.
    expect(REQUEST_COPY.LIGHTNING_TIP).toContain("you never hold BTC");
    expect(REQUEST_COPY.LIGHTNING_TIP).toContain("15 minutes");
    expect(REQUEST_COPY.CONVERSION_TIP).toContain("made only when you open its tab");
  });

  test("the page cancels its swap at the hub only while the hub last said nobody paid it", () => {
    expect(shouldCancelSwap(null)).toBe(false);
    expect(shouldCancelSwap(swapDto())).toBe(true);
    for (const state of ["incoming_accepted", "outgoing_in_flight", "outgoing_succeeded", "succeeded", "failed"] as const) {
      expect(shouldCancelSwap(swapDto({ state })), state).toBe(false);
    }
  });

  test("making until the hub's hold invoice is there; then waiting, with the sats a payer pays and the quote's expiry", () => {
    expect(lightningPart({ quoteError: null, run: null, nowMs: NOW })).toEqual({ status: "making", invoice: null, sats: null, expiresAt: null, error: null });
    expect(lightningPart({ quoteError: null, run: runOf(null), nowMs: NOW }).status).toBe("making");
    // The swap exists but its hold invoice is not checked yet: still making.
    expect(lightningPart({ quoteError: null, run: runOf(swapDto(), { pay: { status: "idle" } }), nowMs: NOW }).status).toBe("making");
    expect(lightningPart({ quoteError: null, run: runOf(swapDto()), nowMs: NOW })).toEqual({
      status: "waiting",
      invoice: HOLD_INVOICE,
      sats: "2526",
      expiresAt: QUOTE_EXPIRES,
      error: null,
    });
  });

  test("the countdown runs to the quote's expiry; once it passes unpaid the invoice is expired and New invoice is offered", () => {
    expect(secondsUntil(QUOTE_EXPIRES, NOW)).toBe(180);
    expect(secondsUntil(QUOTE_EXPIRES, NOW + 179_001)).toBe(1);
    expect(secondsUntil(QUOTE_EXPIRES, NOW + 180_000)).toBe(0);
    expect(lightningPart({ quoteError: null, run: runOf(swapDto(), { nowMs: NOW + 179_999 }), nowMs: NOW + 179_999 }).status).toBe("waiting");
    const expired = lightningPart({ quoteError: null, run: runOf(swapDto(), { nowMs: NOW + 180_000 }), nowMs: NOW + 180_000 });
    expect(expired).toMatchObject({ status: "expired", invoice: null });
    expect(canRenew(expired.status)).toBe(true);
    // The hub then cancels it: still expired, not an error.
    const cancelled = swapDto({ state: "failed", refunded: true, failureReason: "The quote expired unpaid." });
    expect(lightningPart({ quoteError: null, run: runOf(cancelled, { nowMs: NOW + 200_000 }), nowMs: NOW + 200_000 }).status).toBe("expired");
    // Cancelled by the hub before its time: the hub's reason behind a "?".
    expect(lightningPart({ quoteError: null, run: runOf(swapDto({ state: "failed", refunded: true, failureReason: "Paused." })), nowMs: NOW })).toMatchObject({
      status: "cancelled",
      error: { line: REQUEST_COPY.CANCELLED, detail: "Paused." },
    });
  });

  test("a payer's sats held: arriving, whatever the clock; paid once the hub paid the node; returned when it could not", () => {
    const late = NOW + 600_000;
    for (const state of ["incoming_accepted", "outgoing_in_flight"] as const) {
      expect(lightningPart({ quoteError: null, run: runOf(swapDto({ state }), { nowMs: late, funded: true }), nowMs: late }).status).toBe("arriving");
    }
    for (const state of ["outgoing_succeeded", "succeeded"] as const) {
      const paid = lightningPart({ quoteError: null, run: runOf(swapDto({ state }), { funded: true }), nowMs: NOW });
      expect(paid).toMatchObject({ status: "paid", sats: "2526" });
      expect(canRenew(paid.status)).toBe(false);
    }
    const returned = lightningPart({ quoteError: null, run: runOf(swapDto({ state: "failed", refunded: true }), { funded: true }), nowMs: NOW });
    expect(returned.status).toBe("returned");
    expect(canRenew(returned.status)).toBe(true);
  });

  test("a quote the hub refused, or a step that failed, is failed with its line; New invoice tries again", () => {
    const refused = lightningPart({ quoteError: { line: "The hub cannot pay out that much now.", detail: null }, run: null, nowMs: NOW });
    expect(refused).toMatchObject({ status: "failed", error: { line: "The hub cannot pay out that much now." } });
    const noInbound = lightningPart({ quoteError: null, run: runOf(null, { invoiceFailed: true }), nowMs: NOW });
    expect(noInbound).toMatchObject({ status: "failed", error: { line: "Your node cannot receive this much yet.", detail: "ask the hub" } });
    expect(canRenew(noInbound.status)).toBe(true);
    for (const status of ["making", "waiting", "arriving", "paid"] as const) expect(canRenew(status)).toBe(false);
  });
});

/* ======================================================================================= the Fiber invoice */

const made = (invoiceStatus: NodeInvoiceStatus, expiresAt = NOW + 3_600_000): FiberAsk => ({ status: "made", invoice: INVOICE, paymentHash: HASH, expiresAt, invoiceStatus });

test.describe("the request's Fiber invoice and the receipt", () => {
  test("its status as the node reports it; an open one past its expiry by the page's clock reads expired", () => {
    expect(fiberPart(null, NOW).status).toBe("making");
    expect(fiberPart({ status: "making" }, NOW).status).toBe("making");
    expect(fiberPart({ status: "failed", error: { line: "Your node cannot receive this much yet.", detail: null } }, NOW)).toMatchObject({ status: "failed", error: { line: "Your node cannot receive this much yet." } });
    expect(fiberPart(made("Open"), NOW)).toEqual({ status: "waiting", invoice: INVOICE, expiresAt: NOW + 3_600_000, error: null });
    expect(fiberPart(made("Open"), NOW + 3_600_000)).toMatchObject({ status: "expired", invoice: null });
    expect(fiberPart(made("Received"), NOW).status).toBe("arriving");
    expect(fiberPart(made("Paid"), NOW)).toMatchObject({ status: "paid", invoice: null });
    expect(fiberPart(made("Expired"), NOW).status).toBe("expired");
    expect(fiberPart(made("Cancelled"), NOW).status).toBe("cancelled");
  });

  test("the receipt lists what was paid, Lightning first, both when a payer paid both; each tab's tone", () => {
    const lnPaid = lightningPart({ quoteError: null, run: runOf(swapDto({ state: "succeeded" }), { funded: true }), nowMs: NOW });
    const lnWaiting = lightningPart({ quoteError: null, run: runOf(swapDto()), nowMs: NOW });
    const fbPaid = fiberPart(made("Paid"), NOW);
    const fbWaiting = fiberPart(made("Open"), NOW);
    expect(requestPayments(lnWaiting, fbWaiting, { lightning: null, fiber: null })).toEqual([]);
    expect(requestPayments(lnPaid, fbWaiting, { lightning: NOW, fiber: null })).toEqual([{ network: "lightning", at: NOW, sats: "2526" }]);
    expect(requestPayments(lnWaiting, fbPaid, { lightning: null, fiber: NOW + 1 })).toEqual([{ network: "fiber", at: NOW + 1, sats: null }]);
    expect(requestPayments(lnPaid, fbPaid, { lightning: NOW, fiber: NOW + 1 }).map((p) => p.network)).toEqual(["lightning", "fiber"]);
    // Seen paid but not stamped yet (the render before the page notes the time): not listed yet.
    expect(requestPayments(lnPaid, fbWaiting, { lightning: null, fiber: null })).toEqual([]);
    expect(
      (["idle", "making", "waiting", "arriving", "paid", "expired", "cancelled", "returned", "failed"] as const).map((s) => [s, requestPartTone(s), REQUEST_COPY.STATUS[s]]),
    ).toEqual([
      ["idle", "off", "Not made yet"],
      ["making", "pending", "Making…"],
      ["waiting", "pending", "Waiting"],
      ["arriving", "pending", "Arriving"],
      ["paid", "ok", "Paid"],
      ["expired", "off", "Expired"],
      ["cancelled", "off", "Cancelled"],
      ["returned", "error", "Returned"],
      ["failed", "error", "Failed"],
    ]);
  });

  test("the page checks the invoice the node made: a Fiber testnet invoice for exactly the amount", () => {
    expect(checkNodeInvoice(INVOICE, { amount: ckb(1_000).toString(), network: "testnet" })).toEqual({ ok: true });
    expect(checkNodeInvoice(INVOICE, { amount: ckb(999).toString(), network: "testnet" }).ok).toBe(false);
    expect(checkNodeInvoice(demoFiberInvoice("mainnet", ckb(1_000)), { amount: ckb(1_000).toString(), network: "testnet" }).ok).toBe(false);
    expect(checkNodeInvoice("not an invoice", { amount: "1", network: "testnet" }).ok).toBe(false);
  });
});

/* ================================================================================================ bridge */

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
const notHere = async () => Promise.reject(new Error("not in this test"));

function handlers(overrides: Partial<BridgeHandlers> = {}): BridgeHandlers {
  return {
    presence: () => ({ phase: "running", nodeId: OWN_NODE, network: "testnet", hubConnected: true, liquidity: {} }),
    serves: () => true,
    makeInvoice: notHere,
    payInvoice: notHere,
    readInvoice: notHere,
    requestPayment: notHere,
    paymentStatus: notHere,
    requestOnChain: notHere,
    makeReceiveInvoice: async () => ({ invoice: INVOICE, paymentHash: HASH, expiresAt: NOW + 3_600_000 }),
    invoiceStatus: async ({ paymentHash }) => ({ paymentHash, status: "Paid" }),
    ...overrides,
  };
}

test.describe("the bridge's Get paid methods", () => {
  test("requests are rebuilt from their listed fields only: a preimage or anything else a page adds never reaches the node", () => {
    const make = parseRequest({ v: 1, kind: "request", id: "m", method: "make-receive-invoice", params: { asset: "RUSD", amount: "500", note: "Table 4", preimage: "00", expiry: 99 } });
    expect(make).toEqual({ v: 1, kind: "request", id: "m", method: "make-receive-invoice", params: { asset: "RUSD", amount: "500", note: "Table 4" } });
    // The note is optional: missing or null is no note.
    expect(parseRequest({ v: 1, kind: "request", id: "m", method: "make-receive-invoice", params: { asset: "CKB", amount: "1" } })).toMatchObject({ params: { note: null } });
    expect(parseRequest(request("m", { method: "make-receive-invoice", params: { asset: "CKB", amount: "1", note: null } }))).toMatchObject({ params: { note: null } });
    const status = parseRequest({ v: 1, kind: "request", id: "s", method: "invoice-status", params: { paymentHash: HASH.toUpperCase().replace("0X", "0x"), invoice: INVOICE } });
    expect(status).toEqual({ v: 1, kind: "request", id: "s", method: "invoice-status", params: { paymentHash: HASH } });
  });

  test("both invoices of a request carry its id to the node: a UUID (in lower case), left out for a swap, refused otherwise", () => {
    const id = "33333333-3333-4333-8333-33333333AAAA";
    const raw = (method: string, params: Record<string, unknown>) => parseRequest({ v: 1, kind: "request", id: "r", method, params });
    const receive = { asset: "CKB", amount: "1", note: null, request: id };
    expect(raw("make-receive-invoice", receive)).toMatchObject({ params: { request: id.toLowerCase() } });
    const payout = { asset: "CKB", amount: "1", quoteExpiresAt: "2026-10-30T10:03:00.000Z", network: "testnet" };
    expect(raw("make-invoice", { ...payout, request: id })).toEqual({ v: 1, kind: "request", id: "r", method: "make-invoice", params: { ...payout, request: id.toLowerCase() } });
    // A swap's payout invoice has none; null is none too; and only the listed fields come through.
    expect(raw("make-invoice", { ...payout, request: null, preimage: "00" })).toEqual({ v: 1, kind: "request", id: "r", method: "make-invoice", params: payout });
    for (const bad of ["x", 42, "../33333333-3333-4333-8333-333333333333", {}]) {
      expect(raw("make-receive-invoice", { ...receive, request: bad }), String(bad)).toBeNull();
      expect(raw("make-invoice", { ...payout, request: bad }), String(bad)).toBeNull();
    }
  });

  test("malformed params are refused: an unknown asset, a zero or non-decimal amount, a note too long or not text, a bad hash", () => {
    const bad = [
      { method: "make-receive-invoice", params: { asset: "btc", amount: "1" } },
      { method: "make-receive-invoice", params: { asset: "C", amount: "1" } },
      { method: "make-receive-invoice", params: { asset: "CKB", amount: "0" } },
      { method: "make-receive-invoice", params: { asset: "CKB", amount: "1.5" } },
      { method: "make-receive-invoice", params: { asset: "CKB", amount: "-1" } },
      { method: "make-receive-invoice", params: { asset: "CKB", amount: "1", note: "x".repeat(INVOICE_NOTE_MAX_LENGTH + 1) } },
      { method: "make-receive-invoice", params: { asset: "CKB", amount: "1", note: 42 } },
      { method: "make-receive-invoice", params: { amount: "1" } },
      { method: "invoice-status", params: { paymentHash: "0x12" } },
      { method: "invoice-status", params: {} },
    ];
    for (const b of bad) expect(parseRequest({ v: 1, kind: "request", id: "x", ...b }), JSON.stringify(b).slice(0, 90)).toBeNull();
  });

  test("answers are checked: the made invoice keeps its listed fields only; a status fnn does not have is refused", () => {
    const answer = { invoice: INVOICE, paymentHash: HASH.toUpperCase().replace("0X", "0x"), expiresAt: NOW };
    expect(pickReceiveInvoice({ ...answer, preimage: "0x00", note: "x" })).toEqual({ invoice: INVOICE, paymentHash: HASH, expiresAt: NOW });
    expect(pickReceiveInvoice({ ...answer, invoice: "" })).toBeNull();
    expect(pickReceiveInvoice({ ...answer, invoice: "f".repeat(5_000) })).toBeNull();
    expect(pickReceiveInvoice({ ...answer, paymentHash: "0x1" })).toBeNull();
    expect(pickReceiveInvoice({ ...answer, expiresAt: "soon" })).toBeNull();
    expect(isInvoiceStatusResult({ paymentHash: HASH, status: "Paid" })).toBe(true);
    expect(isInvoiceStatusResult({ paymentHash: HASH, status: "Settled" })).toBe(false);
    expect(isInvoiceStatusResult({ paymentHash: "0x1", status: "Paid" })).toBe(false);
  });

  test("a round trip of each method between the page and the node tab, with nothing secret on the wire; refusals as BridgeError", async () => {
    const bus = new Bus();
    const stop = startBridgeServer(handlers(), bus.factory);
    const client = new BridgeClient(bus.factory, FAST);
    expect(await client.makeReceiveInvoice({ asset: "CKB", amount: ckb(1_000).toString(), note: "Table 4" })).toEqual({ invoice: INVOICE, paymentHash: HASH, expiresAt: NOW + 3_600_000 });
    expect(await client.invoiceStatus({ paymentHash: HASH })).toEqual({ paymentHash: HASH, status: "Paid" });
    stop();
    for (const m of bus.messages) expect(JSON.stringify(m)).not.toMatch(/preimage|password|secret|ckbKey|fiberKey/i);

    const refusing = new Bus();
    const stopRefusing = startBridgeServer(
      handlers({ invoiceStatus: async () => Promise.reject(new NodeRequestError(BRIDGE_ERROR.REFUSED, "no")) }),
      refusing.factory,
    );
    const error = await new BridgeClient(refusing.factory, FAST).invoiceStatus({ paymentHash: HASH }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: "refused", message: "no" });
    stopRefusing();

    // A tab whose node does not run answers no Get paid request.
    const idle = new Bus();
    const stopIdle = startBridgeServer(handlers({ serves: () => false }), idle.factory);
    expect(await new BridgeClient(idle.factory, FAST).makeReceiveInvoice({ asset: "CKB", amount: "1", note: null }).catch((e: unknown) => e)).toMatchObject({ code: BRIDGE_ERROR.TIMEOUT });
    stopIdle();
  });
});

/* =============================================================================================== handlers */

const channel = (o: { remote: bigint; udt?: Script | null; peer?: string; state?: string }): NodeChannel => ({
  channelId: `0x${Math.random().toString(16).slice(2).padEnd(64, "0")}`,
  peerId: o.peer ?? HUB_ID,
  udtTypeScript: o.udt ?? null,
  state: o.state ?? "ChannelReady",
  isPublic: false,
  enabled: true,
  localBalance: BigInt(0),
  remoteBalance: o.remote,
});

/** A node for Get paid's handlers: makes invoices, reports their status, and logs each call. */
class RequestNode implements BrowserFiberNode {
  readonly log: string[] = [];
  readonly invoiceArgs: NewInvoiceArgs[] = [];
  channels: NodeChannel[] = [channel({ remote: ckb(2_000) }), channel({ remote: ckb(50), udt: RUSD_SCRIPT, peer: `02${"77".repeat(32)}` })];
  status: NodeInvoiceStatus | Error = "Open";
  fail: Error | null = null;

  async info() {
    return { nodeId: OWN_NODE, version: "0.9.1", fundingLockScript: { codeHash: "0x00", hashType: "type" as const, args: "0x" } };
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
  async newInvoice(args: NewInvoiceArgs) {
    this.log.push("new_invoice");
    // What fnn keeps: a copy of the arguments, taken when it is called.
    this.invoiceArgs.push({ ...args });
    if (this.fail) throw this.fail;
    return { invoice: INVOICE, paymentHash: HASH.toUpperCase().replace("0X", "0x") };
  }
  async getInvoiceStatus(hash: string) {
    this.log.push(`get_invoice ${hash}`);
    if (this.status instanceof Error) throw this.status;
    return this.status;
  }
  async cancelInvoice(hash: string) {
    this.log.push(`cancel_invoice ${hash}`);
    return "Cancelled" as const;
  }
  async parseInvoice(): Promise<never> {
    throw new Error("not in Get paid");
  }
  async sendPayment(): Promise<never> {
    throw new Error("Get paid never pays");
  }
  async getPayment(): Promise<never> {
    throw new Error("not in Get paid");
  }
  async stop() {}
}

/** Random bytes the test keeps hold of, to see them wiped. */
function keptRandom() {
  const drawn: Uint8Array[] = [];
  return {
    drawn,
    random: (length: number) => {
      const bytes = new Uint8Array(length).fill(7);
      drawn.push(bytes);
      return bytes;
    },
  };
}

const deps = (node: RequestNode, o: Partial<RequestInvoiceDeps> = {}): RequestInvoiceDeps => ({
  node,
  network: "testnet",
  hubNode: { assets: HUB_ASSETS },
  random: keptRandom().random,
  now: () => NOW,
  ...o,
});

const rejection = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

test.describe("the node's handlers for Get paid", () => {
  test("make: a regular sha256 invoice for exactly the amount, valid an hour, with the note; the preimage wiped; History without the invoice text", async () => {
    const node = new RequestNode();
    const recorded: ActivityEntry[] = [];
    const { drawn, random } = keptRandom();
    const result = await makeReceiveInvoice(deps(node, { random }), { asset: "CKB", amount: ckb(1_000).toString(), note: "  Table 4 " }, (e) => recorded.push(e));
    expect(result).toEqual({ invoice: INVOICE, paymentHash: HASH, expiresAt: NOW + RECEIVE_INVOICE_EXPIRY_SECONDS * 1_000 });
    expect(node.invoiceArgs).toEqual([
      { amount: ckb(1_000), currency: "Fibt", preimage: `0x${"07".repeat(32)}`, expirySeconds: 3_600, description: "Table 4", udtTypeScript: null },
    ]);
    // The preimage the node drew is wiped once fnn has it.
    expect(drawn).toHaveLength(1);
    expect([...drawn[0]].every((b) => b === 0)).toBe(true);
    expect(recorded).toEqual([
      { id: HASH, kind: "request", asset: "CKB", amount: ckb(1_000).toString(), status: "Open", error: null, at: NOW, request: { note: "Table 4", expiresAt: NOW + 3_600_000 } },
    ]);
    expect(JSON.stringify(recorded)).not.toContain(INVOICE);
    expect(JSON.stringify(recorded)).not.toContain("07070707");

    // RUSD with the hub's script, over any peer's channel; no note writes the default description.
    await makeReceiveInvoice(deps(node), { asset: "RUSD", amount: ckb(50).toString(), note: null }, () => undefined);
    expect(node.invoiceArgs[1]).toMatchObject({ udtTypeScript: RUSD_SCRIPT, description: "CKBolt request", amount: ckb(50) });
    expect(receiveInvoiceArgs({ amount: BigInt(1), network: "testnet", udtTypeScript: null, note: null, preimage: new Uint8Array(32) }).description).toBe("CKBolt request");
  });

  test("make: the request's id goes to History with the invoice, so the node can pair it with the request's Lightning invoice", async () => {
    const node = new RequestNode();
    const recorded: ActivityEntry[] = [];
    const id = "33333333-3333-4333-8333-333333333333";
    await makeReceiveInvoice(deps(node), { asset: "CKB", amount: ckb(1_000).toString(), note: null, request: id }, (e) => recorded.push(e));
    expect(recorded[0].request).toEqual({ note: null, expiresAt: NOW + 3_600_000, id });
    // Kept and read back; an entry kept with a malformed id is dropped.
    const store = new MemoryStore();
    saveHistory(store, "testnet", OWN_NODE, [recorded[0], { ...recorded[0], id: OTHER_HASH, request: { note: null, expiresAt: NOW, id: "not-an-id" } }]);
    expect(readHistory(store, "testnet", OWN_NODE)).toEqual([recorded[0]]);
  });

  test("make: refused before any invoice when the node cannot receive that much, the hub lists no script, or the note is not one short line", async () => {
    const node = new RequestNode();
    const record = () => undefined;
    expect(await rejection(makeReceiveInvoice(deps(node), { asset: "CKB", amount: (ckb(2_000) + BigInt(1)).toString(), note: null }, record))).toMatchObject({
      code: BRIDGE_ERROR.NO_INBOUND,
      message: "Your node cannot receive this much CKB yet. Ask the hub for a bigger channel, then try again.",
    });
    expect(await rejection(makeReceiveInvoice(deps(node, { hubNode: null }), { asset: "RUSD", amount: "1", note: null }, record))).toMatchObject({ code: BRIDGE_ERROR.HUB_ERROR });
    expect(await rejection(makeReceiveInvoice(deps(node), { asset: "CKB", amount: "1", note: "line one\nline two" }, record))).toMatchObject({ code: BRIDGE_ERROR.INVALID_REQUEST });
    expect(await rejection(makeReceiveInvoice(deps(node), { asset: "CKB", amount: "0", note: null }, record))).toMatchObject({ code: BRIDGE_ERROR.INVALID_REQUEST });
    // A channel that is not ready, or a disabled one, receives nothing.
    node.channels = [channel({ remote: ckb(5_000), state: "AwaitingChannelReady" })];
    expect(await rejection(makeReceiveInvoice(deps(node), { asset: "CKB", amount: "1", note: null }, record))).toMatchObject({ code: BRIDGE_ERROR.NO_INBOUND });
    expect(node.log).toEqual([]);
    expect(requestNote(null)).toBeNull();
    expect(requestNote("   ")).toBeNull();
    expect(requestNote(" a ")).toBe("a");

    // fnn refusing: its words, the preimage wiped all the same, nothing in History.
    const failing = new RequestNode();
    failing.fail = new Error('ErrorObject { code: ServerError(-32000), message: "Duplicated invoice found" }');
    const { drawn, random } = keptRandom();
    const recorded: ActivityEntry[] = [];
    expect(await rejection(makeReceiveInvoice(deps(failing, { random }), { asset: "CKB", amount: "1", note: null }, (e) => recorded.push(e)))).toMatchObject({
      code: BRIDGE_ERROR.NODE_ERROR,
      message: "Duplicated invoice found",
    });
    expect([...drawn[0]].every((b) => b === 0)).toBe(true);
    expect(recorded).toEqual([]);
  });

  test("status: only for an invoice the node made for Get paid; its History entry follows get_invoice", async () => {
    const node = new RequestNode();
    const entry = requestEntry({ paymentHash: HASH, asset: "CKB", amount: ckb(5), note: null, atMs: NOW, expiresAt: NOW + 3_600_000 });
    const swapLeg: ActivityEntry = { id: OTHER_HASH, kind: "swap", asset: "CKB", amount: "1", status: "Open", error: null, at: NOW, swap: { id: null, leg: "invoice", lightningSats: null } };
    const recorded: ActivityEntry[] = [];
    node.status = "Received";
    expect(await readRequestInvoiceStatus({ node }, [entry, swapLeg], { paymentHash: HASH }, (e) => recorded.push(e))).toEqual({ paymentHash: HASH, status: "Received" });
    expect(recorded).toEqual([{ ...entry, status: "Received" }]);
    // The same status again: nothing new to record.
    await readRequestInvoiceStatus({ node }, [{ ...entry, status: "Received" }], { paymentHash: HASH }, (e) => recorded.push(e));
    expect(recorded).toHaveLength(1);
    // A swap's payout invoice, or a hash History does not hold, is not answered.
    expect(await rejection(readRequestInvoiceStatus({ node }, [entry, swapLeg], { paymentHash: OTHER_HASH }, () => undefined))).toMatchObject({
      code: BRIDGE_ERROR.REFUSED,
      message: "This invoice is not one your node made for Get paid.",
    });
    node.status = new Error("Invoice not found");
    expect(await rejection(readRequestInvoiceStatus({ node }, [entry], { paymentHash: HASH }, () => undefined))).toMatchObject({ code: BRIDGE_ERROR.NODE_ERROR, message: "Invoice not found" });
    expect(node.log).toEqual([`get_invoice ${HASH}`, `get_invoice ${HASH}`, `get_invoice ${HASH}`]);
  });
});

/* ================================================================================================ History */

/** localStorage in memory. */
class MemoryStore implements KeyValueStore {
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

const NAMES: HistoryNames = {
  amount: (asset, amount) => `${Number(BigInt(amount) / SHANNONS).toLocaleString("en-US")} ${asset}`,
  symbol: (asset) => asset,
  look: (asset) => ({ symbol: asset, name: asset, icons: [] }),
  peer: (id) => id.slice(0, 6),
};
const entryOf = (status: NodeInvoiceStatus, note: string | null = "Table 4"): ActivityEntry => ({
  ...requestEntry({ paymentHash: HASH, asset: "CKB", amount: ckb(1_000), note, atMs: NOW, expiresAt: NOW + 3_600_000 }),
  status,
});

test.describe("History's request kind", () => {
  test("an invoice for Get paid is read again until paid, expired or cancelled, without holding the node", () => {
    for (const status of ["Open", "Received"] as const) {
      const entry = entryOf(status);
      expect(isActivityFinal(entry)).toBe(false);
      expect(isPollable(entry)).toBe(true);
      // An hour-long invoice (often paid on Lightning instead) does not keep Lock waiting or ask before leaving.
      expect(holdsNode(entry)).toBe(false);
      expect(isPaymentEntry(entry)).toBe(false);
      expect(activityTone(entry)).toBe("pending");
      expect(historyTitle(entry, NAMES)).toBe("Request for 1,000 CKB");
    }
    expect(activityLabel(entryOf("Open"))).toBe("Waiting");
    expect(activityLabel(entryOf("Received"))).toBe("Arriving");
    for (const [status, tone, label, title] of [
      ["Paid", "ok", "Received", "Received 1,000 CKB"],
      ["Expired", "off", "Expired", "Request for 1,000 CKB"],
      ["Cancelled", "off", "Cancelled", "Request for 1,000 CKB"],
    ] as const) {
      const entry = entryOf(status);
      expect(isActivityFinal(entry)).toBe(true);
      expect(isPollable(entry)).toBe(false);
      expect(activityTone(entry)).toBe(tone);
      expect(activityLabel(entry)).toBe(label);
      expect(historyTitle(entry, NAMES)).toBe(title);
    }
    // All and Payments show it, not Swaps: the request's Lightning invoice is a swap of its own.
    const [item] = mergeHistory([entryOf("Open")], []);
    expect(inHistoryFilter(item, "all")).toBe(true);
    expect(inHistoryFilter(item, "payments")).toBe(true);
    expect(inHistoryFilter(item, "swaps")).toBe(false);
  });

  test("kept in this browser and read back after a reload, still open, so it is read again; a malformed one is dropped", () => {
    const store = new MemoryStore();
    saveHistory(store, "testnet", OWN_NODE, [entryOf("Open"), entryOf("Open", null)]);
    const back = readHistory(store, "testnet", OWN_NODE);
    expect(back).toEqual([entryOf("Open"), entryOf("Open", null)]);
    expect(back.filter(isPollable)).toHaveLength(2);
    for (const secret of ["preimage", "fibt1", "0707"]) expect([...store.map.values()].join("")).not.toContain(secret);
    const key = storageKey("testnet", `history:${OWN_NODE}`);
    store.setItem(
      key,
      JSON.stringify([
        entryOf("Open"),
        { ...entryOf("Open"), id: "0x2", request: undefined },
        { ...entryOf("Open"), id: "0x3", request: { note: 5, expiresAt: NOW } },
        { ...entryOf("Open"), id: "0x4", request: { note: null, expiresAt: "later" } },
      ]),
    );
    expect(readHistory(store, "testnet", OWN_NODE).map((e) => e.id)).toEqual([HASH]);
  });
});
