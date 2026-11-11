import { createHash, randomBytes, webcrypto } from "node:crypto";
import { expect, test } from "@playwright/test";
import { encodeUnsignedBolt11 } from "../../lib/bolt11";
import { HubApiError } from "../../lib/hub/client";
import { API_ERROR_CODE, HUB_PROXY_ERROR_CODE, type AssetDto, type QuoteDto, type SwapDto, type SwapState } from "../../lib/hub/contract";
import { NO_PROGRESS, accumulateProgress, type SwapProgress } from "../../lib/hub/lifecycle";
import { estimateSats, legUsd, readPayAmount, sanitizeAmountText, unitsToInputText, type PayUnit } from "../../lib/swap/amount";
import { CARD_ERROR, ERROR_HELP_LABEL, LIGHTNING_CHANNEL_TITLE, PRIMARY_LABEL, RESULT_COPY, RUN_ERROR, STEP_LINE, STEP_TITLE } from "../../lib/swap/copy";
import { createSwapError, fiberPayFailure, fiberStepError, quoteError } from "../../lib/swap/errors";
import { fiberShortfall } from "../../lib/swap/fiber-liquidity";
import { compactRateLine, legFigure, pairLine, shortHash } from "../../lib/swap/format";
import { checkLimits, quotable } from "../../lib/swap/limits";
import { checkPreimage } from "../../lib/swap/preimage";
import {
  hashKey,
  isRecordFinal,
  keepSwapRecord,
  mergeSwapRecord,
  readSwapHistory,
  readSwapRecord,
  recordOf,
  saveSwapHistory,
  upsertSwapRecord,
  type SwapRecord,
} from "../../lib/swap/history";
import { primaryButtonState, type PrimaryButtonInput } from "../../lib/swap/primary-button";
import {
  INVOICE_IDLE,
  PAY_IDLE,
  browserPayError,
  isRunSettled,
  lightningPayStep,
  nextRunAction,
  retryAction,
  runOutcome,
  runSteps,
  type InvoiceStep,
  type PayStep,
  type RunAction,
  type RunInput,
} from "../../lib/swap/run-model";
import { BridgeError } from "../../lib/wallets/fiber-browser/bridge-client";
import { BRIDGE_ERROR } from "../../lib/wallets/fiber-browser/bridge-protocol";
import { checkHoldInvoice } from "../../lib/wallets/lightning/invoice-check";
import { WalletAnswerError, WalletNoAnswerError } from "../../lib/wallets/lightning/errors";
import { WEBLN_DECLINED_CODE } from "../../lib/wallets/lightning/constants";
import { attemptFromAnswer, attemptFromError, canPayAgain, PAY_SENDING, type PayAttempt } from "../../lib/wallets/lightning/pay-attempt";

/*
 * The live swap card's logic (docs/live-swap-ui.md, and "One wallet"), without React: amounts, limits, the primary
 * button's states, and the run's steps driven end to end with a fake Fiber node, a visitor who pays by hand, and a fake
 * hub.
 */

const SATS: PayUnit = { network: "lightning", decimals: 0 };
const CKB_UNIT: PayUnit = { network: "fiber", decimals: 8 };
const ASSET: Pick<AssetDto, "minSats" | "maxSats" | "decimals"> = { minSats: "1000", maxSats: "20000", decimals: 8 };
const PRICES: QuoteDto["prices"] = { btcUsd: 80_000, assetUsd: 0.002, source: "Test fixture", at: "2026-10-24T10:00:00.000Z" };
const hex32 = () => randomBytes(32).toString("hex");

const quote = (overrides: Partial<QuoteDto> = {}): QuoteDto => ({
  id: "11111111-1111-4111-8111-111111111111",
  direction: "ln_to_fiber",
  asset: "CKB",
  pay: { network: "lightning", asset: "BTC", amount: "2000", decimals: 0 },
  receive: { network: "fiber", asset: "CKB", amount: "79200000000", decimals: 8 },
  prices: PRICES,
  feeBps: 100,
  purpose: "swap",
  createdAt: "2026-10-24T10:00:00.000Z",
  expiresAt: "2026-10-24T10:02:30.000Z",
  signature: "sig",
  hubPubkey: "02" + "ab".repeat(32),
  ...overrides,
});

const swapOf = (direction: SwapDto["direction"], state: SwapState, overrides: Partial<SwapDto> = {}): SwapDto => ({
  id: "22222222-2222-4222-8222-222222222222",
  quoteId: "11111111-1111-4111-8111-111111111111",
  direction,
  asset: "CKB",
  state,
  paymentHash: hex32(),
  pay:
    direction === "ln_to_fiber"
      ? { network: "lightning", asset: "BTC", amount: "2000", decimals: 0, invoice: "lntbs20u1hold" }
      : { network: "fiber", asset: "CKB", amount: "100000000000", decimals: 8, invoice: "fibt1hold" },
  receive:
    direction === "ln_to_fiber"
      ? { network: "fiber", asset: "CKB", amount: "79200000000", decimals: 8, invoice: "fibt1payout" }
      : { network: "lightning", asset: "BTC", amount: "2475", decimals: 0, invoice: "lntbs1payout" },
  refunded: false,
  failureReason: null,
  preimage: null,
  demo: false,
  quoteExpiresAt: "2026-10-24T10:02:30.000Z",
  createdAt: "2026-10-24T10:00:05.000Z",
  updatedAt: "2026-10-24T10:00:05.000Z",
  links: { self: "/v1/swaps/x", events: "/v1/swaps/x/events" },
  ...overrides,
});

/* ------------------------------------------------------------------------------------------------ amounts */

test.describe("swap card amounts", () => {
  test("BTC is typed in whole sats, Fiber assets in token units", () => {
    expect(readPayAmount("", SATS, ".")).toEqual({ status: "empty" });
    expect(readPayAmount("0", SATS, ".")).toEqual({ status: "zero" });
    expect(readPayAmount("2,000", SATS, ".")).toEqual({ status: "ok", units: "2000" });
    expect(readPayAmount("2000.5", SATS, ".")).toEqual({ status: "invalid" });
    expect(readPayAmount("1091.23", CKB_UNIT, ".")).toEqual({ status: "ok", units: "109123000000" });
    expect(readPayAmount("5,5", CKB_UNIT, ",")).toEqual({ status: "ok", units: "550000000" });
    expect(readPayAmount("0.000000001", CKB_UNIT, ".")).toEqual({ status: "zero" });
    expect(readPayAmount("1,5.3", CKB_UNIT, ".")).toEqual({ status: "invalid" });
  });

  test("letters and signs never reach the field", () => {
    expect(sanitizeAmountText("1a2-3 4,5.6e")).toBe("123 4,5.6");
  });

  test("a carried amount reads back to the same units in either decimal convention", () => {
    for (const mark of [".", ","] as const) {
      for (const units of ["123400000", "79200000000", "1"]) {
        const text = unitsToInputText(units, CKB_UNIT, mark);
        expect(readPayAmount(text, CKB_UNIT, mark)).toEqual({ status: "ok", units });
      }
    }
    expect(unitsToInputText("2475", SATS, ",")).toBe("2475");
  });

  test("USD values and sats estimates use the hub's prices", () => {
    expect(legUsd({ network: "lightning", asset: "BTC", amount: "2000", decimals: 0 }, PRICES)).toBeCloseTo(1.6, 6);
    expect(legUsd({ network: "fiber", asset: "CKB", amount: "100000000000", decimals: 8 }, PRICES)).toBeCloseTo(2, 6);
    // 1,000 CKB at $0.002 is $2, which is 2,500 sats at $80,000.
    expect(estimateSats("100000000000", 8, PRICES)).toBe(2500);
    expect(estimateSats("1", 8, { ...PRICES, assetUsd: 0 })).toBeNull();
  });

  test("display helpers stay exact and short", () => {
    expect(compactRateLine(quote(), "CKB")).toBe("1 BTC = 40M CKB");
    expect(legFigure(quote().receive)).toBe("792");
    expect(legFigure(quote().pay)).toBe("2,000");
    expect(pairLine(quote(), "CKB")).toBe("2,000 sats to 792 CKB");
    expect(shortHash("a".repeat(64))).toBe(`${"a".repeat(10)}…${"a".repeat(10)}`);
  });
});

/* ------------------------------------------------------------------------------------------------- limits */

test.describe("swap card limits", () => {
  const sats = (n: string) => ({ asset: ASSET, sats: n, fiberUnits: null, knownPrices: null });
  const fiber = (units: string) => ({ asset: ASSET, sats: null, fiberUnits: units, knownPrices: null });

  test("sats the page knows (BTC typed, or the amount of the visitor's invoice) are checked before any quote", () => {
    expect(checkLimits({ ...sats("999"), quoteErrorCode: null })).toEqual({ kind: "min", sats: "1000" });
    expect(checkLimits({ ...sats("20001"), quoteErrorCode: null })).toEqual({ kind: "max", sats: "20000" });
    expect(checkLimits({ ...sats("1000"), quoteErrorCode: null })).toBeNull();
    expect(checkLimits({ ...sats("20000"), quoteErrorCode: null })).toBeNull();
    expect(quotable(sats("500"))).toBe(false);
    expect(quotable(sats("2475"))).toBe(true);
    // A typed Fiber amount goes to the hub, which sizes the Lightning leg; with nothing typed there is nothing to quote.
    expect(quotable(fiber("1"))).toBe(true);
    expect(quotable({ asset: ASSET, sats: null, fiberUnits: null, knownPrices: null })).toBe(false);
    expect(checkLimits({ asset: ASSET, sats: null, fiberUnits: null, quoteErrorCode: API_ERROR_CODE.INSUFFICIENT_LIQUIDITY, knownPrices: null })).toBeNull();
  });

  test("a Fiber amount the hub refused is sized with earlier prices, or said as a range", () => {
    const refused = { quoteErrorCode: API_ERROR_CODE.VALIDATION };
    // 10 CKB is 25 sats; 10,000,000 CKB is 25,000,000 sats.
    expect(checkLimits({ ...fiber("1000000000"), ...refused, knownPrices: PRICES })).toEqual({ kind: "min", sats: "1000" });
    expect(checkLimits({ ...fiber("1000000000000000"), ...refused, knownPrices: PRICES })).toEqual({ kind: "max", sats: "20000" });
    expect(checkLimits({ ...fiber("1000000000"), ...refused })).toEqual({ kind: "range" });
    // An invoice's sats were checked in the page: the hub's validation refusal is not a range.
    expect(checkLimits({ ...sats("2475"), ...refused })).toBeNull();
  });

  test("the hub's insufficient_liquidity, either way, is a liquidity limit", () => {
    for (const amount of [sats("5000"), fiber("100000000000")]) {
      expect(checkLimits({ ...amount, quoteErrorCode: API_ERROR_CODE.INSUFFICIENT_LIQUIDITY })).toEqual({ kind: "liquidity" });
    }
  });

  test("the browser node is short when it cannot send what is paid or receive what is paid out", () => {
    const liquidity = { CKB: { send: "500", receive: "1000" } };
    expect(fiberShortfall({ direction: "fiber_to_ln", liquidity, asset: "CKB", payUnits: "501", receiveUnits: null })).toBe("send");
    expect(fiberShortfall({ direction: "fiber_to_ln", liquidity, asset: "CKB", payUnits: "500", receiveUnits: null })).toBeNull();
    expect(fiberShortfall({ direction: "ln_to_fiber", liquidity, asset: "CKB", payUnits: null, receiveUnits: "1001" })).toBe("receive");
    // No channel for the token at all: the node can receive none of it.
    expect(fiberShortfall({ direction: "ln_to_fiber", liquidity, asset: "RUSD", payUnits: null, receiveUnits: "1" })).toBe("no-channel");
    expect(fiberShortfall({ direction: "ln_to_fiber", liquidity: { CKB: { send: "500", receive: "0" } }, asset: "CKB", payUnits: null, receiveUnits: "1" })).toBe("no-channel");
    expect(fiberShortfall({ direction: "ln_to_fiber", liquidity: null, asset: "CKB", payUnits: null, receiveUnits: "1001" })).toBeNull();
    // No quote yet: what the node must receive is not known.
    expect(fiberShortfall({ direction: "ln_to_fiber", liquidity, asset: "CKB", payUnits: null, receiveUnits: null })).toBeNull();
  });
});

/* ----------------------------------------------------------------------------------------- primary button */

test.describe("swap card primary button", () => {
  const READY: PrimaryButtonInput = {
    run: "none",
    hubLive: true,
    paused: false,
    amount: "ok",
    limit: null,
    fiber: { chosen: true, ready: true, problem: null },
    shortfall: null,
    symbol: "CKB",
    lnInvoice: "not-needed",
    ownInvoice: "not-needed",
    quote: "ready",
  };
  const state = (patch: Partial<PrimaryButtonInput>) => primaryButtonState({ ...READY, ...patch });

  test("every state of the table, in order", () => {
    expect(state({})).toEqual({ label: "Swap", action: "swap", disabled: false });
    expect(state({ hubLive: false, amount: "empty", fiber: { chosen: false, ready: false, problem: null } })).toEqual({
      label: "Hub unavailable",
      action: "none",
      disabled: true,
    });
    expect(state({ amount: "empty", fiber: { chosen: false, ready: false, problem: null } })).toMatchObject({ label: "Enter an amount", disabled: true });
    expect(state({ amount: "zero" })).toMatchObject({ label: "Enter an amount", disabled: true });
    expect(state({ amount: "invalid" })).toMatchObject({ label: PRIMARY_LABEL.INVALID_AMOUNT, disabled: true });
    expect(state({ limit: { kind: "min", sats: "1000" }, fiber: { chosen: false, ready: false, problem: null } })).toMatchObject({
      label: "Min 1,000 sats",
      disabled: true,
    });
    expect(state({ limit: { kind: "max", sats: "20000" } })).toMatchObject({ label: "Max 20,000 sats", disabled: true });
    expect(state({ limit: { kind: "liquidity" } })).toMatchObject({ label: "Not enough liquidity", disabled: true });
    expect(state({ fiber: { chosen: false, ready: false, problem: null }, lnInvoice: "missing" })).toEqual({
      label: "Connect Fiber node",
      action: "connect-fiber",
      disabled: false,
    });
    expect(state({ fiber: { chosen: true, ready: false, problem: "Open your Fiber node" } })).toMatchObject({ label: "Open your Fiber node", action: "connect-fiber" });
    expect(state({ fiber: { chosen: true, ready: false, problem: null } })).toMatchObject({ label: PRIMARY_LABEL.FIBER_NOT_READY });
    expect(state({ shortfall: "send" })).toMatchObject({ label: "Not enough CKB to send", action: "connect-fiber" });
    expect(state({ shortfall: "receive" })).toMatchObject({ label: "Your node can't receive this much CKB", action: "connect-fiber" });
    expect(state({ shortfall: "no-channel", lnInvoice: "missing" })).toMatchObject({ label: "Ask the hub for a channel first", action: "connect-fiber" });
    expect(state({ lnInvoice: "missing", quote: "loading" })).toEqual({ label: "Paste your Lightning invoice", action: "focus-ln-invoice", disabled: false });
    expect(state({ lnInvoice: "invalid", quote: "loading" })).toMatchObject({ label: "Paste your Lightning invoice", action: "focus-ln-invoice" });
    expect(state({ ownInvoice: "missing", quote: "loading" })).toMatchObject({ label: "Paste your Fiber invoice", action: "focus-own-invoice" });
    expect(state({ ownInvoice: "unchecked", quote: "loading" })).toMatchObject({ label: "Getting quote…", disabled: true });
    expect(state({ quote: "expired" })).toMatchObject({ label: "Refresh quote", action: "refresh-quote", disabled: false });
    expect(state({ quote: "failed" })).toMatchObject({ label: PRIMARY_LABEL.QUOTE_FAILED, action: "refresh-quote" });
  });

  test("CKB or RUSD to BTC needs no amount typed: with neither an amount nor an invoice it asks for the invoice", () => {
    expect(state({ amount: "empty", lnInvoice: "missing" })).toEqual({ label: "Paste your Lightning invoice", action: "focus-ln-invoice", disabled: false });
    expect(state({ amount: "zero", lnInvoice: "invalid" })).toMatchObject({ action: "focus-ln-invoice" });
    // A typed amount that is not a number still says so; a limit comes before the invoice.
    expect(state({ amount: "invalid", lnInvoice: "missing" })).toMatchObject({ label: PRIMARY_LABEL.INVALID_AMOUNT, disabled: true });
    expect(state({ limit: { kind: "min", sats: "1000" }, lnInvoice: "ok" })).toMatchObject({ label: "Min 1,000 sats", disabled: true });
    // No Connect Lightning any more: the Lightning side is a QR code or a paste.
    expect(Object.keys(PRIMARY_LABEL)).not.toContain("CONNECT_LIGHTNING");
    expect(state({ lnInvoice: "ok" })).toEqual({ label: "Swap", action: "swap", disabled: false });
  });

  test("the hub's maintenance switch disables it with Swaps paused, whatever the amount or the wallets", () => {
    for (const patch of [{}, { amount: "empty" as const }, { lnInvoice: "missing" as const }, { quote: "failed" as const }]) {
      expect(state({ ...patch, paused: true })).toEqual({ label: PRIMARY_LABEL.PAUSED, action: "none", disabled: true });
    }
    expect(PRIMARY_LABEL.PAUSED).toBe("Swaps paused");
    // A hub that is not live says that first; a run in progress keeps its own way back.
    expect(state({ paused: true, hubLive: false })).toMatchObject({ label: PRIMARY_LABEL.HUB_UNAVAILABLE });
    expect(state({ paused: true, run: "running" })).toMatchObject({ label: PRIMARY_LABEL.RUNNING, action: "view-progress" });
  });

  test("a run comes first: the button never offers a second swap", () => {
    expect(state({ run: "running", hubLive: false })).toEqual({ label: PRIMARY_LABEL.RUNNING, action: "view-progress", disabled: false });
    expect(state({ run: "settled" })).toMatchObject({ label: PRIMARY_LABEL.VIEW_RESULT, action: "view-progress" });
  });
});

/* ------------------------------------------------------------------------------------------------- errors */

test.describe("swap card errors", () => {
  test("quote errors are one short line with the hub's sentence behind it", () => {
    expect(quoteError({ code: API_ERROR_CODE.QUOTE_UNAVAILABLE, message: "No fresh market price is available right now." })).toEqual({
      line: "No fresh price right now. Try again soon.",
      detail: "No fresh market price is available right now.",
    });
    expect(quoteError({ code: HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, message: "x" }).line).toBe("The hub did not answer. Try again.");
  });

  test("maintenance: a refused quote or swap says swaps are paused, and a paused swap is not asked again", () => {
    const paused = { code: API_ERROR_CODE.MAINTENANCE, message: "Swaps are paused for maintenance. Running swaps finish." };
    expect(quoteError(paused)).toEqual({ line: CARD_ERROR.MAINTENANCE, detail: paused.message });
    expect(createSwapError(new HubApiError(503, paused.code, paused.message))).toEqual({ line: RUN_ERROR.MAINTENANCE, detail: paused.message, retryable: false });
  });

  test("only a busy or unreachable hub makes a failed swap request worth repeating", () => {
    expect(createSwapError(new HubApiError(503, HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, "down")).retryable).toBe(true);
    expect(createSwapError(new HubApiError(429, API_ERROR_CODE.RATE_LIMITED, "slow down")).retryable).toBe(true);
    expect(createSwapError(new HubApiError(410, API_ERROR_CODE.QUOTE_EXPIRED, "gone"))).toMatchObject({ line: RUN_ERROR.QUOTE_EXPIRED, retryable: false });
    expect(createSwapError(new HubApiError(409, API_ERROR_CODE.CONFLICT, "taken"))).toMatchObject({ line: RUN_ERROR.QUOTE_TAKEN, retryable: false });
    expect(createSwapError(new HubApiError(422, API_ERROR_CODE.INVOICE_INVALID, "Use sha256."))).toEqual({
      line: RUN_ERROR.INVOICE_REFUSED,
      detail: "Use sha256.",
      retryable: false,
    });
  });

  test("a Fiber payment that timed out counts as sent; any other refusal may be retried", () => {
    expect(fiberPayFailure(new BridgeError(BRIDGE_ERROR.TIMEOUT, "late"))).toEqual({ status: "uncertain" });
    expect(fiberPayFailure(new BridgeError(BRIDGE_ERROR.NO_OUTBOUND, "Your node cannot send this much CKB yet. Long sentence."))).toEqual({
      status: "declined",
      error: { line: RUN_ERROR.NODE_NO_OUTBOUND, detail: "Your node cannot send this much CKB yet. Long sentence." },
    });
    expect(fiberStepError(new Error("Peer not found"))).toEqual({ line: "Peer not found", detail: null });
    expect(fiberStepError("weird")).toEqual({ line: RUN_ERROR.NODE_FAILED, detail: null });
  });
});

/* ------------------------------------------------------------------------------------------------ wallets */

test.describe("swap card wallet answers", () => {
  test("BTC to CKB: the visitor pays the hold invoice by hand; the browser wallet's attempt, once asked, moves the step", () => {
    const ok = { ok: true as const, invoice: "lntbs20u1hold" };
    // No swap yet, then the checked hold invoice to pay (QR, copy, a wallet on this device), or a mismatch never shown.
    expect(lightningPayStep(undefined, null)).toEqual(PAY_IDLE);
    expect(lightningPayStep(undefined, ok)).toEqual({ status: "manual" });
    expect(lightningPayStep(undefined, { ok: false, error: "mismatch" })).toEqual({ status: "blocked", error: { line: "mismatch", detail: null } });
    // The browser wallet (WebLN): asked, paid, or no clear answer (a closed prompt): never offered again.
    expect(lightningPayStep(PAY_SENDING, ok)).toEqual({ status: "paying" });
    expect(lightningPayStep(attemptFromAnswer({ status: "paid", preimage: null }), ok)).toEqual({ status: "sent" });
    const silent = attemptFromError(new WalletNoAnswerError("Prompt was closed"));
    expect(lightningPayStep(silent, ok)).toEqual({ status: "uncertain" });
    expect(canPayAgain(silent)).toBe(false);
    expect(browserPayError(silent)).toBeNull();
    // A refusal leaves the invoice to pay, by QR or by the browser wallet again, with the wallet's reason beside it.
    const declined = attemptFromError(new WalletAnswerError("User rejected", WEBLN_DECLINED_CODE));
    expect(lightningPayStep(declined, ok)).toEqual({ status: "manual" });
    expect(canPayAgain(declined)).toBe(true);
    expect(browserPayError(declined)).toEqual({ line: RUN_ERROR.WALLET_DECLINED, detail: "User rejected." });
    expect(browserPayError(undefined)).toBeNull();
  });

  test("the hub's hold invoice is checked against the swap before the wallet pays", () => {
    const hash = randomBytes(32);
    const hold = encodeUnsignedBolt11({ network: "signet", amountSats: 2000, paymentHash: hash, description: "hold", expirySeconds: 600 });
    const expected = { amountSats: "2000", paymentHash: hash.toString("hex"), hubNetwork: "signet" };
    expect(checkHoldInvoice(hold, expected).ok).toBe(true);
    expect(checkHoldInvoice(hold, { ...expected, paymentHash: hex32() }).ok).toBe(false);
    expect(checkHoldInvoice(hold, { ...expected, amountSats: "2001" }).ok).toBe(false);
  });

  test("sha256(preimage) = payment hash is checked with Web Crypto", async () => {
    const preimage = randomBytes(32);
    const hash = createHash("sha256").update(preimage).digest("hex");
    const subtle = webcrypto.subtle as unknown as SubtleCrypto;
    expect(await checkPreimage(preimage.toString("hex"), hash, subtle)).toBe("match");
    expect(await checkPreimage(preimage.toString("hex"), `0x${hash.toUpperCase()}`, subtle)).toBe("match");
    expect(await checkPreimage(hex32(), hash, subtle)).toBe("mismatch");
    expect(await checkPreimage("not hex", hash, subtle)).toBe("mismatch");
    expect(await checkPreimage(preimage.toString("hex"), hash, null)).toBe("unavailable");
  });
});

/* ---------------------------------------------------------------------------------------------------- run */

/**
 * A run with fake wallets and a fake hub, driven as the runner hook drives it: after every change, do what
 * nextRunAction asks for. Wallet and hub behaviour are scripted per test; `calls` records what was asked.
 */
class FakeRun {
  invoice: InvoiceStep = INVOICE_IDLE;
  creating = false;
  createError: ReturnType<typeof createSwapError> | null = null;
  swap: SwapDto | null = null;
  progress: SwapProgress = NO_PROGRESS;
  pay: PayStep = PAY_IDLE;
  expired = false;
  readonly calls: RunAction[] = [];
  /** Lightning attempts by payment hash, as the page's wallet store keeps them. */
  readonly attempts = new Map<string, PayAttempt>();

  constructor(
    readonly direction: SwapDto["direction"],
    readonly wallets: {
      invoice: () => InvoiceStep;
      createSwap: () => SwapDto | { error: HubApiError };
      pay: (swap: SwapDto) => PayStep;
    },
  ) {}

  get input(): RunInput {
    return {
      direction: this.direction,
      invoice: this.invoice,
      creating: this.creating,
      createError: this.createError,
      swap: this.swap,
      progress: this.progress,
      pay: this.pay,
      expired: this.expired,
    };
  }

  perform(action: RunAction) {
    this.calls.push(action);
    if (action === "make-invoice") this.invoice = this.wallets.invoice();
    if (action === "create-swap") {
      const created = this.wallets.createSwap();
      if ("error" in created) this.createError = createSwapError(created.error);
      else {
        this.createError = null;
        this.swap = created;
      }
    }
    if (action === "pay" && this.swap) this.pay = this.wallets.pay(this.swap);
  }

  /** Runs every call the model asks for by itself. */
  settle() {
    for (let action = nextRunAction(this.input); action; action = nextRunAction(this.input)) this.perform(action);
  }

  retry() {
    const action = retryAction(this.input);
    if (action && action !== "new-quote") this.perform(action);
    this.settle();
  }

  /** The hub's engine moves the swap along. */
  hub(state: SwapState, patch: Partial<SwapDto> = {}) {
    if (!this.swap) throw new Error("no swap");
    this.swap = { ...this.swap, ...patch, state };
    this.progress = accumulateProgress(this.progress, this.swap, []);
    this.settle();
  }

  statuses() {
    return runSteps(this.input).map((s) => s.status);
  }
}

const madeInvoice = (): InvoiceStep => ({ status: "made", invoice: "payout", pasted: false });

/** BTC to CKB or RUSD: once the swap exists, the runner shows the checked hold invoice for the visitor to pay. */
const holdShown = (): PayStep => lightningPayStep(undefined, { ok: true, invoice: "lntbs20u1hold" });

test.describe("swap run", () => {
  test("CKB to BTC runs by itself from one click to complete: the pasted invoice, the swap, the node's payment", () => {
    const run = new FakeRun("fiber_to_ln", {
      invoice: () => ({ status: "made", invoice: "lntbs1pasted", pasted: true }),
      createSwap: () => swapOf("fiber_to_ln", "pending"),
      pay: () => ({ status: "sent" }),
    });
    expect(run.statuses()).toEqual(["active", "pending", "pending", "pending", "pending"]);
    run.settle();
    expect(run.calls).toEqual(["make-invoice", "create-swap", "pay"]);
    expect(run.statuses()).toEqual(["done", "done", "active", "pending", "pending"]);
    expect(runSteps(run.input)[0]).toMatchObject({ title: "Your invoice", line: STEP_LINE.INVOICE_PASTED });
    expect(runSteps(run.input)[2].line).toBe(STEP_LINE.SENT);

    run.hub("incoming_accepted");
    expect(run.statuses()).toEqual(["done", "done", "done", "active", "pending"]);
    run.hub("outgoing_in_flight");
    run.hub("outgoing_succeeded");
    expect(run.statuses()).toEqual(["done", "done", "done", "done", "active"]);
    run.hub("succeeded", { preimage: hex32() });
    expect(run.statuses()).toEqual(["done", "done", "done", "done", "done"]);
    expect(runOutcome(run.swap, run.progress)).toBe("complete");
    expect(isRunSettled({ final: true, swap: run.swap, retry: retryAction(run.input) })).toBe(true);
    // Nothing was asked twice.
    expect(run.calls).toEqual(["make-invoice", "create-swap", "pay"]);
  });

  test("BTC to CKB: the node's invoice and the swap by themselves, then the visitor pays; the hub's state moves the run", () => {
    const run = new FakeRun("ln_to_fiber", { invoice: madeInvoice, createSwap: () => swapOf("ln_to_fiber", "pending"), pay: () => ({ status: "sent" }) });
    run.settle();
    // The run never pays a Lightning invoice by itself.
    expect(run.calls).toEqual(["make-invoice", "create-swap"]);
    run.pay = holdShown();
    run.settle();
    expect(run.calls).toEqual(["make-invoice", "create-swap"]);
    expect(runSteps(run.input)[2]).toMatchObject({ status: "active", title: STEP_TITLE.pay.ln_to_fiber, line: "Pay the invoice below" });
    expect(retryAction(run.input)).toBeNull();

    run.hub("incoming_accepted");
    expect(run.statuses()).toEqual(["done", "done", "done", "active", "pending"]);
    run.hub("outgoing_in_flight");
    run.hub("succeeded", { preimage: hex32() });
    expect(runOutcome(run.swap, run.progress)).toBe("complete");
    expect(run.calls).toEqual(["make-invoice", "create-swap"]);
  });

  test("own node, Fiber to BTC: the payment is the user's to make, and the hub's state moves the run", () => {
    const run = new FakeRun("fiber_to_ln", { invoice: madeInvoice, createSwap: () => swapOf("fiber_to_ln", "pending"), pay: () => ({ status: "manual" }) });
    run.settle();
    expect(runSteps(run.input)[2]).toMatchObject({ status: "active", line: STEP_LINE.MANUAL.fiber_to_ln });
    expect(retryAction(run.input)).toBeNull();
    run.hub("incoming_accepted");
    expect(run.statuses()[2]).toBe("done");
  });

  test("own node, BTC to Fiber: the pasted invoice is step 1", () => {
    const run = new FakeRun("ln_to_fiber", {
      invoice: () => ({ status: "made", invoice: "fibt1pasted", pasted: true }),
      createSwap: () => swapOf("ln_to_fiber", "pending"),
      pay: () => ({ status: "paying" }),
    });
    run.settle();
    expect(runSteps(run.input)[0]).toMatchObject({ status: "done", line: STEP_LINE.INVOICE_PASTED });
  });

  test("a refused invoice step shows its error and is tried again on request", () => {
    let answers = [() => ({ status: "failed", error: { line: "Your wallet did not answer.", detail: null } }) as InvoiceStep, madeInvoice];
    const run = new FakeRun("fiber_to_ln", {
      invoice: () => answers.shift()!(),
      createSwap: () => swapOf("fiber_to_ln", "pending"),
      pay: () => ({ status: "sent" }),
    });
    run.settle();
    expect(run.calls).toEqual(["make-invoice"]);
    expect(runSteps(run.input)[0]).toMatchObject({ status: "failed", line: "Your wallet did not answer.", detail: null });
    expect(retryAction(run.input)).toBe("make-invoice");
    run.retry();
    expect(run.calls).toEqual(["make-invoice", "make-invoice", "create-swap", "pay"]);
    answers = [];
  });

  test("a hub that did not answer is asked again with the same quote; a taken quote needs a new one", () => {
    const answers: (SwapDto | { error: HubApiError })[] = [
      { error: new HubApiError(503, HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, "down") },
      { error: new HubApiError(409, API_ERROR_CODE.CONFLICT, "taken") },
    ];
    const run = new FakeRun("ln_to_fiber", { invoice: madeInvoice, createSwap: () => answers.shift()!, pay: () => ({ status: "sent" }) });
    run.settle();
    expect(run.statuses().slice(0, 2)).toEqual(["done", "failed"]);
    expect(retryAction(run.input)).toBe("create-swap");
    run.retry();
    expect(retryAction(run.input)).toBe("new-quote");
    expect(isRunSettled({ final: false, swap: run.swap, retry: retryAction(run.input) })).toBe(true);
    expect(run.calls).toEqual(["make-invoice", "create-swap", "create-swap"]);
  });

  test("a payment the node declined may be tried again; a payment without an answer is never sent again", () => {
    const answers: PayStep[] = [{ status: "declined", error: { line: RUN_ERROR.NODE_NO_OUTBOUND, detail: null } }, { status: "uncertain" }];
    const run = new FakeRun("fiber_to_ln", { invoice: madeInvoice, createSwap: () => swapOf("fiber_to_ln", "pending"), pay: () => answers.shift()! });
    run.settle();
    expect(run.statuses()[2]).toBe("failed");
    expect(retryAction(run.input)).toBe("pay");
    run.retry();
    expect(runSteps(run.input)[2]).toMatchObject({ status: "active", line: "Sent; waiting for the hub" });
    expect(retryAction(run.input)).toBeNull();
    run.settle();
    expect(run.calls.filter((c) => c === "pay")).toHaveLength(2);
  });

  test("a browser wallet with no route to the hub (LDK RouteNotFound) says so in plain words, pointing to a channel", () => {
    const noRoute = attemptFromError(new WalletAnswerError("Failed to send payment: RouteNotFound", WEBLN_DECLINED_CODE));
    const ok = { ok: true as const, invoice: "lntbs20u1hold" };
    // The invoice stays to pay, by QR or by the browser wallet again once it has its channel.
    const pay = lightningPayStep(noRoute, ok);
    expect(pay).toEqual({ status: "manual" });
    expect(browserPayError(noRoute)).toEqual({ line: RUN_ERROR.NO_ROUTE, detail: "Failed to send payment: RouteNotFound.", help: "lightning-channel" });
    const run = new FakeRun("ln_to_fiber", { invoice: madeInvoice, createSwap: () => swapOf("ln_to_fiber", "pending"), pay: () => pay });
    run.settle();
    run.pay = pay;
    expect(runSteps(run.input)[2]).toMatchObject({ status: "active", line: STEP_LINE.MANUAL.ln_to_fiber });
    expect(retryAction(run.input)).toBeNull();
    expect(RUN_ERROR.NO_ROUTE).toBe("Your wallet found no route to the hub.");
    expect(ERROR_HELP_LABEL["lightning-channel"]).toBe(LIGHTNING_CHANNEL_TITLE);
    expect(LIGHTNING_CHANNEL_TITLE).toBe("Get a Lightning channel from the hub");
    // Any other refusal keeps the wallet's own words behind a "?", and offers no channel.
    expect(browserPayError(attemptFromError(new WalletAnswerError("Insufficient balance", WEBLN_DECLINED_CODE)))).toEqual({
      line: "Your browser wallet did not pay.",
      detail: "Insufficient balance.",
    });
  });

  test("an expired quote takes the hold invoice off the step, and the hub's cancel offers a new try", () => {
    const run = new FakeRun("ln_to_fiber", { invoice: madeInvoice, createSwap: () => swapOf("ln_to_fiber", "pending"), pay: () => ({ status: "sent" }) });
    run.perform("make-invoice");
    run.perform("create-swap");
    run.pay = holdShown();
    run.expired = true;
    run.settle();
    expect(run.calls).not.toContain("pay");
    expect(runSteps(run.input)[2]).toMatchObject({ status: "failed", line: STEP_LINE.EXPIRED });
    run.hub("failed", { refunded: false });
    expect(runOutcome(run.swap, run.progress)).toBe("cancelling");
    run.hub("failed", { refunded: true });
    expect(runOutcome(run.swap, run.progress)).toBe("cancelled");
    expect(retryAction(run.input)).toBe("new-quote");
    expect(runSteps(run.input)[4]).toMatchObject({ status: "failed", line: STEP_LINE.CANCELLED });
  });

  test("a browser node's payment is not sent once the quote expired", () => {
    const run = new FakeRun("fiber_to_ln", { invoice: madeInvoice, createSwap: () => swapOf("fiber_to_ln", "pending"), pay: () => ({ status: "sent" }) });
    run.perform("make-invoice");
    run.perform("create-swap");
    run.expired = true;
    run.settle();
    expect(run.calls).toEqual(["make-invoice", "create-swap"]);
    expect(runSteps(run.input)[2]).toMatchObject({ status: "failed", line: STEP_LINE.EXPIRED });
  });

  test("a failed payout after the hub held the payment ends in a refund", () => {
    const run = new FakeRun("fiber_to_ln", { invoice: madeInvoice, createSwap: () => swapOf("fiber_to_ln", "pending"), pay: () => ({ status: "sent" }) });
    run.settle();
    run.hub("incoming_accepted");
    run.hub("outgoing_in_flight");
    run.hub("failed", { failureReason: "No route to your invoice." });
    expect(runOutcome(run.swap, run.progress)).toBe("refund-pending");
    expect(run.statuses()).toEqual(["done", "done", "done", "failed", "failed"]);
    run.hub("failed", { refunded: true, failureReason: "No route to your invoice." });
    expect(runOutcome(run.swap, run.progress)).toBe("refunded");
    expect(RESULT_COPY.REFUNDED).toBe("Refunded: your payment went back to your wallet");
    expect(retryAction(run.input)).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------- history */

test.describe("the swaps the app keeps for the node's History", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { data, store: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } };
  };
  const id = (n: number) => `${String(n).padStart(8, "0")}-2222-4222-8222-222222222222`;
  const at = (minute: number) => `2026-10-27T10:${String(minute).padStart(2, "0")}:00.000Z`;

  test("a swap is final once it succeeded or failed with its hold cancelled; a held payment is remembered", () => {
    const record = (state: SwapState, refunded = false, held = false) => recordOf(swapOf("ln_to_fiber", state, { refunded }), "CKB", held);
    expect(isRecordFinal(record("succeeded"))).toBe(true);
    for (const state of ["pending", "incoming_accepted", "outgoing_in_flight", "outgoing_succeeded"] as const) expect(isRecordFinal(record(state))).toBe(false);
    expect(isRecordFinal(record("failed", false))).toBe(false);
    expect(isRecordFinal(record("failed", true))).toBe(true);
    // The hub held the payment: from its state, or from the run's progress (or the swap's events) once it failed.
    expect(record("incoming_accepted").funded).toBe(true);
    expect(record("failed", true).funded).toBe(false);
    expect(record("failed", true, true).funded).toBe(true);
  });

  test("two writers merge: the state that got further wins, an older read never moves a swap back, refunded and funded stay", () => {
    const pending = recordOf(swapOf("ln_to_fiber", "pending", { id: id(1) }), "CKB", false);
    const held = recordOf(swapOf("ln_to_fiber", "incoming_accepted", { id: id(1) }), "", false);
    const failed = recordOf(swapOf("ln_to_fiber", "failed", { id: id(1), refunded: true }), "", false);
    expect(mergeSwapRecord(pending, held)).toMatchObject({ state: "incoming_accepted", symbol: "CKB", funded: true });
    expect(mergeSwapRecord(held, pending)).toMatchObject({ state: "incoming_accepted", funded: true });
    // Once held, a failure is a refund, whoever wrote last.
    expect(mergeSwapRecord(held, failed)).toMatchObject({ state: "failed", refunded: true, funded: true, symbol: "" });
    expect(mergeSwapRecord(pending, failed)).toMatchObject({ state: "failed", refunded: true, funded: false, symbol: "CKB" });
    expect(mergeSwapRecord(failed, pending)).toMatchObject({ state: "failed", refunded: true });
    const done = recordOf(swapOf("ln_to_fiber", "succeeded", { id: id(1) }), "CKB", false);
    expect(mergeSwapRecord(done, held).state).toBe("succeeded");
  });

  test("kept newest first, merged in place, the newest 100 per network; nothing secret, nothing malformed read back", () => {
    const { data, store } = memory();
    let list: SwapRecord[] = [];
    for (let n = 0; n < 105; n++) list = upsertSwapRecord(list, recordOf(swapOf("ln_to_fiber", "pending", { id: id(n), createdAt: at(n % 60) }), "CKB", false));
    expect(list).toHaveLength(100);
    const updated = upsertSwapRecord(list, recordOf(swapOf("ln_to_fiber", "succeeded", { id: list[3].id, createdAt: list[3].createdAt }), "CKB", false));
    expect(updated).toHaveLength(100);
    expect(updated[3]).toMatchObject({ id: list[3].id, state: "succeeded" });
    // A stale write of the same swap leaves it where it got.
    expect(upsertSwapRecord(updated, list[3])[3]).toMatchObject({ id: list[3].id, state: "succeeded" });

    const swap = swapOf("fiber_to_ln", "succeeded", { preimage: "aa".repeat(32), createdAt: at(1) });
    saveSwapHistory(store, "testnet", [recordOf(swap, "CKB", false)]);
    const stored = data.get("ckbolt:swap-history:testnet")!;
    for (const secret of [swap.pay.invoice, swap.receive.invoice, swap.preimage!]) expect(stored).not.toContain(secret);
    expect(readSwapHistory(store, "testnet")).toEqual([
      {
        id: swap.id,
        direction: "fiber_to_ln",
        asset: "CKB",
        symbol: "CKB",
        paymentHash: swap.paymentHash,
        pay: { network: "fiber", asset: "CKB", amount: "100000000000", decimals: 8 },
        receive: { network: "lightning", asset: "BTC", amount: "2475", decimals: 0 },
        createdAt: at(1),
        state: "succeeded",
        refunded: false,
        funded: true,
      },
    ]);
    expect(readSwapHistory(store, "mainnet")).toEqual([]);
    data.set(
      "ckbolt:swap-history:testnet",
      JSON.stringify([{ ...JSON.parse(stored)[0], id: "not-a-uuid" }, { ...JSON.parse(stored)[0], state: "done" }, { ...JSON.parse(stored)[0], invoice: "fibt1x" }]),
    );
    expect(readSwapHistory(store, "testnet")).toHaveLength(1);
    expect(JSON.stringify(readSwapHistory(store, "testnet"))).not.toContain("fibt1x");
    data.set("ckbolt:swap-history:testnet", "{oops");
    expect(readSwapHistory(store, "testnet")).toEqual([]);
    expect(readSwapHistory(null, "testnet")).toEqual([]);
  });

  test("each write reads what the other document stored first, so neither drops the other's swaps", () => {
    const { store } = memory();
    const fromCard = recordOf(swapOf("ln_to_fiber", "pending", { id: id(1), createdAt: at(1) }), "CKB", false);
    keepSwapRecord(store, "testnet", fromCard);
    // The node read the hub meanwhile and keeps what it learned; then the card writes its older view again.
    keepSwapRecord(store, "testnet", { ...fromCard, state: "failed", refunded: true });
    const fromPay = recordOf(swapOf("fiber_to_ln", "pending", { id: id(2), createdAt: at(2) }), "RUSD", false);
    const after = keepSwapRecord(store, "testnet", fromPay);
    expect(keepSwapRecord(store, "testnet", fromCard).map((r) => [r.id, r.state])).toEqual([
      [id(2), "pending"],
      [id(1), "failed"],
    ]);
    expect(after.map((r) => r.id)).toEqual([id(2), id(1)]);
    expect(keepSwapRecord(null, "testnet", fromCard)).toEqual([fromCard]);
  });

  test("read again from the hub: a failed swap that never showed a held payment asks its events", async () => {
    const asked: string[] = [];
    const hub = (swap: SwapDto, events: { type: string }[] = []) => ({
      getSwap: async (swapId: string) => (asked.push(`swap ${swapId}`), swap),
      listSwapEvents: async (swapId: string) => (asked.push(`events ${swapId}`), events.map((e) => ({ at: at(3), type: e.type, detail: "" }))),
    });
    const kept = recordOf(swapOf("ln_to_fiber", "pending", { id: id(4) }), "CKB", false);
    const paid = await readSwapRecord(hub(swapOf("ln_to_fiber", "succeeded", { id: id(4) })), kept);
    expect(paid.record).toMatchObject({ state: "succeeded", symbol: "CKB", funded: true });
    expect(asked).toEqual([`swap ${id(4)}`]);
    const refunded = await readSwapRecord(hub(swapOf("ln_to_fiber", "failed", { id: id(4), refunded: true }), [{ type: "incoming_accepted" }]), kept);
    expect(refunded.record).toMatchObject({ state: "failed", refunded: true, funded: true });
    expect(refunded.swap.id).toBe(id(4));
    const cancelled = await readSwapRecord(hub(swapOf("ln_to_fiber", "failed", { id: id(4), refunded: true })), kept);
    expect(cancelled.record.funded).toBe(false);
    expect(asked.filter((a) => a.startsWith("events"))).toHaveLength(2);
  });

  test("a payment hash is keyed with 0x and in lowercase, as fnn writes it; the hub writes it bare", () => {
    const hash = "AB".repeat(32);
    expect(hashKey(hash)).toBe(`0x${"ab".repeat(32)}`);
    expect(hashKey(`0x${hash}`)).toBe(`0x${"ab".repeat(32)}`);
  });
});
