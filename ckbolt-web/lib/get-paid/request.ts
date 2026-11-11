import type { DecimalMark } from "@/lib/amount";
import type { AssetDto, FiberAssetId, QuoteDto, SwapDto } from "@/lib/hub/contract";
import { formatSats } from "@/lib/swap/format";
import { readPayAmount } from "@/lib/swap/amount";
import { PAID_OUT_STATES } from "@/lib/swap/constants";
import type { ShortError } from "@/lib/swap/errors";
import { checkLimits, type LimitIssue } from "@/lib/swap/limits";
import type { RunOutcome, StepView } from "@/lib/swap/run-model";
import { INVOICE_NOTE_MAX_LENGTH } from "@/lib/wallets/fiber-browser/constants";
import type { NodeInvoiceStatus } from "@/lib/wallets/fiber-browser/node-port";
import { REQUEST_COPY, REQUEST_ERROR } from "./copy";

/**
 * Get paid on /app (docs/pay-get-paid.md, part C) as plain data: the form's checks, and where each of a request's two
 * invoices stands. The Fiber invoice is the node's own, made with the request. The Lightning invoice is the hub's hold
 * invoice of an ln_to_fiber swap whose payout invoice the node made (the swap card's run, lib/swap/run-model.ts), made
 * only when the visitor opens its tab. No React here.
 */

/**
 * Where one invoice of a request stands, as its tab shows it. `idle`: the Lightning invoice, not asked for yet (it is
 * made when its tab opens).
 */
export type RequestPartStatus = "idle" | "making" | "waiting" | "arriving" | "paid" | "expired" | "cancelled" | "returned" | "failed";

/** A request the visitor created: what it asks for, in the asset's base units. */
export interface OpenRequest {
  /**
   * Drawn when the request is created (a UUID). Both its invoices carry it to the node, which pairs them: once one is
   * paid, the node cancels the other's invoices still open, so a request is not paid twice.
   */
  id: string;
  asset: FiberAssetId;
  /** Base units, decimal, above zero. */
  units: string;
  symbol: string;
  decimals: number;
  note: string | null;
}

/* ------------------------------------------------------------------------------------------------ the form */

export type RequestFormCheck =
  | { ok: true; units: string; note: string | null }
  /** `error` null: nothing typed yet, so nothing to say. */
  | { ok: false; field: "amount" | "note"; error: string | null };

/** The typed amount (in the asset received, any decimal mark) and the optional note, trimmed. */
export function checkRequestForm(input: { amountText: string; note: string; decimals: number; symbol: string; decimalMark: DecimalMark }): RequestFormCheck {
  const amount = readPayAmount(input.amountText, { network: "fiber", decimals: input.decimals }, input.decimalMark);
  if (amount.status === "empty") return { ok: false, field: "amount", error: null };
  if (amount.status !== "ok") return { ok: false, field: "amount", error: REQUEST_ERROR.AMOUNT(input.symbol) };
  const note = input.note.trim();
  if (note.length > INVOICE_NOTE_MAX_LENGTH) return { ok: false, field: "note", error: REQUEST_ERROR.NOTE };
  return { ok: true, units: amount.units, note: note || null };
}

/**
 * The per-swap limits apply to the Lightning invoice: the sats a payer pays, once the hub quoted them; before that, or
 * when the hub refused the amount, the typed units sized at prices it quoted earlier (lib/swap/limits.ts).
 */
export function requestLimit(input: {
  asset: Pick<AssetDto, "minSats" | "maxSats" | "decimals">;
  units: string;
  quote: Pick<QuoteDto, "pay"> | null;
  quoteErrorCode: string | null;
  knownPrices: QuoteDto["prices"] | null;
}): LimitIssue | null {
  const { asset, units, quote, quoteErrorCode, knownPrices } = input;
  if (quote) return checkLimits({ asset, sats: quote.pay.amount, fiberUnits: null, quoteErrorCode: null, knownPrices: null });
  return checkLimits({ asset, sats: null, fiberUnits: units, quoteErrorCode, knownPrices });
}

/** The range line for a limit the Lightning invoice breaks; null for none, or for liquidity (the hub's own sentence says it). */
export const rangeError = (limit: LimitIssue | null, asset: Pick<AssetDto, "minSats" | "maxSats">): ShortError | null =>
  limit && limit.kind !== "liquidity" ? { line: REQUEST_ERROR.RANGE(formatSats(asset.minSats), formatSats(asset.maxSats)), detail: null } : null;

/* ------------------------------------------------------------------------------------- the Lightning invoice */

/** What the request needs of the swap card's run (hooks/use-swap-runner.ts SwapRun). */
export interface RunLike {
  swap: Pick<SwapDto, "state" | "quoteExpiresAt" | "failureReason" | "pay"> | null;
  steps: readonly Pick<StepView, "id" | "status" | "line" | "detail">[];
  outcome: RunOutcome;
  /** The hub's hold invoice while the hub waits for a payer (checked against the swap), or null. */
  manualInvoice: string | null;
}

export interface LightningPart {
  status: RequestPartStatus;
  /** The hub's hold invoice to show while it waits for a payer. */
  invoice: string | null;
  /** What a payer pays, in sats. */
  sats: string | null;
  /** When the hold invoice stops being payable: the quote's expiry (ISO). */
  expiresAt: string | null;
  error: ShortError | null;
}

const part = (status: RequestPartStatus, o: Partial<Omit<LightningPart, "status">> = {}): LightningPart => ({
  status,
  invoice: null,
  sats: null,
  expiresAt: null,
  error: null,
  ...o,
});

const PAID_OUT: readonly string[] = PAID_OUT_STATES;

/**
 * Where the Lightning invoice stands: not asked for yet (its tab never opened); the quote, the payout invoice and the
 * swap being made (no run yet: the quote is on its way); waiting for a payer (its QR code); the payer's
 * sats held while the hub pays the node; paid once the payout went through; expired once the quote ran out unpaid;
 * returned when the hub held the payment but could not pay the node; failed with the step's reason. "New invoice"
 * makes a fresh one after any end but paid. `requested` left out means it was asked for.
 */
export function lightningPart(input: { quoteError: ShortError | null; run: RunLike | null; nowMs: number; requested?: boolean }): LightningPart {
  const { quoteError, run, nowMs, requested = true } = input;
  if (!requested) return part("idle");
  if (quoteError) return part("failed", { error: quoteError });
  if (!run) return part("making");
  const { swap } = run;
  const facts = swap ? { sats: swap.pay.amount, expiresAt: swap.quoteExpiresAt } : {};
  if (swap && PAID_OUT.includes(swap.state)) return part("paid", facts);
  if (run.outcome === "refunded" || run.outcome === "refund-pending") return part("returned", facts);
  const funded = run.steps.some((s) => s.id === "pay" && s.status === "done");
  if (funded) return part("arriving", facts);
  if (swap) {
    const expired = Date.parse(swap.quoteExpiresAt) <= nowMs;
    if (expired) return part("expired", facts);
    if (run.outcome === "cancelled" || run.outcome === "cancelling") {
      return part("cancelled", { ...facts, error: { line: REQUEST_COPY.CANCELLED, detail: swap.failureReason } });
    }
  }
  const failed = run.steps.find((s) => s.status === "failed");
  if (failed) return part("failed", { ...facts, error: { line: failed.line ?? REQUEST_COPY.STATUS.failed, detail: failed.detail } });
  if (run.manualInvoice) return part("waiting", { ...facts, invoice: run.manualInvoice });
  return part("making", facts);
}

/** A Lightning invoice that ended unpaid (or was never made): "New invoice" makes another for the same request. */
export const canRenew = (status: RequestPartStatus): boolean => status === "expired" || status === "cancelled" || status === "returned" || status === "failed";

/**
 * Whether the page cancels the Lightning invoice's swap at the hub (POST /v1/swaps/:id/cancel) once the request no
 * longer needs it (paid on Fiber, "New request", or "New invoice" in its place): only while the hub last said nobody
 * paid it. A held or paid one goes on (a payer who paid both is "Paid twice"); a failed one is over already. The hub
 * decides in the end: it refuses (409) once a payment arrived.
 */
export const shouldCancelSwap = (swap: Pick<SwapDto, "state"> | null): boolean => swap?.state === "pending";

/* ---------------------------------------------------------------------------------------- the Fiber invoice */

/** The node's Fiber invoice for the request: being made, refused, or made with its status as get_invoice reports it. */
export type FiberAsk =
  | { status: "making" }
  | { status: "failed"; error: ShortError }
  | { status: "made"; invoice: string; paymentHash: string; expiresAt: number; invoiceStatus: NodeInvoiceStatus };

export interface FiberPart {
  status: RequestPartStatus;
  invoice: string | null;
  /** Epoch ms it stops being payable. */
  expiresAt: number | null;
  error: ShortError | null;
}

const INVOICE_PART: Readonly<Record<NodeInvoiceStatus, RequestPartStatus>> = {
  Open: "waiting",
  Received: "arriving",
  Paid: "paid",
  Expired: "expired",
  Cancelled: "cancelled",
};

/** Where the Fiber invoice stands; an open one past its expiry by this page's clock reads expired before fnn says so. */
export function fiberPart(ask: FiberAsk | null, nowMs: number): FiberPart {
  if (!ask || ask.status === "making") return { status: "making", invoice: null, expiresAt: null, error: null };
  if (ask.status === "failed") return { status: "failed", invoice: null, expiresAt: null, error: ask.error };
  const status = ask.invoiceStatus === "Open" && ask.expiresAt <= nowMs ? "expired" : INVOICE_PART[ask.invoiceStatus];
  return { status, invoice: status === "waiting" ? ask.invoice : null, expiresAt: ask.expiresAt, error: null };
}

/* ----------------------------------------------------------------------------------------------- the receipt */

export type PaidNetwork = "lightning" | "fiber";

/** One payment the request received: on which network, when the page saw it, and the sats a Lightning payer paid. */
export interface RequestPayment {
  network: PaidNetwork;
  at: number;
  sats: string | null;
}

/** The payments the request received so far, Lightning first; both when a payer (rarely) paid both invoices. */
export function requestPayments(lightning: LightningPart, fiber: FiberPart, paidAt: Readonly<Record<PaidNetwork, number | null>>): RequestPayment[] {
  const out: RequestPayment[] = [];
  if (lightning.status === "paid" && paidAt.lightning !== null) out.push({ network: "lightning", at: paidAt.lightning, sats: lightning.sats });
  if (fiber.status === "paid" && paidAt.fiber !== null) out.push({ network: "fiber", at: paidAt.fiber, sats: null });
  return out;
}
