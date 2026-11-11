import type { Direction, SwapDto, SwapState } from "@/lib/hub/contract";
import { isSwapFinal, type SwapProgress } from "@/lib/hub/lifecycle";
import type { InvoiceCheck } from "@/lib/wallets/lightning/invoice-check";
import type { PayAttempt } from "@/lib/wallets/lightning/pay-attempt";
import { FUNDED_STATES, PAID_OUT_STATES } from "./constants";
import { RUN_ERROR, STEP_LINE, STEP_TITLE } from "./copy";
import type { CreateSwapError, ShortError } from "./errors";

/**
 * The run of one live swap as plain data (docs/live-swap-ui.md, "The run" and "One wallet"): what the Fiber node and
 * the visitor did, what the hub says, the five steps the progress dialog shows, and what to do next. The hub's swap
 * state is the truth; wallet answers only move the dialog along. No React here, so the logic is tested with fakes.
 */

export type StepStatus = "pending" | "active" | "done" | "failed";
export type StepId = "invoice" | "lock" | "pay" | "payout" | "complete";
export const STEP_ORDER: readonly StepId[] = ["invoice", "lock", "pay", "payout", "complete"];

export interface StepView {
  id: StepId;
  /** 1 to 5, as the dialog numbers them (test id `swap-step-<n>`). */
  number: number;
  title: string;
  status: StepStatus;
  line: string | null;
  /** The full reason of a failure, for a "?". */
  detail: string | null;
}

/** Step 1: the payout invoice, from the browser node or pasted on the card. */
export type InvoiceStep =
  | { status: "idle" }
  | { status: "making" }
  /** `pasted`: the visitor's own wallet or node made it and the visitor pasted it on the card. */
  | { status: "made"; invoice: string; pasted: boolean }
  | { status: "failed"; error: ShortError };

/** Step 3: the payment of the hub's hold invoice. */
export type PayStep =
  | { status: "idle" }
  /** Asked; no answer yet (a hold invoice keeps a wallet waiting until the hub settles). */
  | { status: "paying" }
  /** The wallet sent it, or reports it paid; the hub's state says when it arrived. */
  | { status: "sent" }
  /** No clear answer: it may be on its way. Never offered again. */
  | { status: "uncertain" }
  /** The browser node answered that it did not pay: asking again is safe. */
  | { status: "declined"; error: ShortError }
  /** CKBolt will not show or pay this invoice (the hold invoice does not match the swap). */
  | { status: "blocked"; error: ShortError }
  /** The visitor pays by hand: from any Lightning wallet (QR or copy), or from their own Fiber node. */
  | { status: "manual" };

export const INVOICE_IDLE: InvoiceStep = { status: "idle" };
export const PAY_IDLE: PayStep = { status: "idle" };

export interface RunInput {
  direction: Direction;
  invoice: InvoiceStep;
  /** POST /v1/swaps is on its way. */
  creating: boolean;
  createError: CreateSwapError | null;
  swap: SwapDto | null;
  progress: SwapProgress;
  pay: PayStep;
  /** The quote (and so the hold invoice) has expired. */
  expired: boolean;
}

export type RunOutcome = "running" | "complete" | "refunded" | "refund-pending" | "cancelled" | "cancelling";

const inStates = (state: SwapState, states: readonly SwapState[]): boolean => states.includes(state);

/** The hub holds the user's payment, or did at some point. */
export const isFunded = (swap: Pick<SwapDto, "state">, progress: Pick<SwapProgress, "funded">): boolean =>
  progress.funded || inStates(swap.state, FUNDED_STATES);

/**
 * How the run stands: still going, or how it ended (a failed swap is final once the hold is cancelled). The node's
 * History reads a kept swap the same way.
 */
export function runOutcome(swap: Pick<SwapDto, "state" | "refunded"> | null, progress: Pick<SwapProgress, "funded">): RunOutcome {
  if (!swap) return "running";
  if (swap.state === "succeeded") return "complete";
  if (swap.state !== "failed") return "running";
  if (isFunded(swap, progress)) return swap.refunded ? "refunded" : "refund-pending";
  return swap.refunded ? "cancelled" : "cancelling";
}

/** Nothing more will change: the swap succeeded, or failed and its hold was cancelled. */
export const isRunFinal = (swap: SwapDto | null): boolean => swap !== null && isSwapFinal(swap);

/**
 * Nothing more happens without the user: the swap is final, or it was never created and a step failed. A settled run
 * may be put away; an unsettled one may only be hidden.
 */
export const isRunSettled = (run: { final: boolean; swap: SwapDto | null; retry: RetryAction | null }): boolean =>
  run.final || (run.swap === null && run.retry !== null);

/* ------------------------------------------------------------------------------------------------ steps */

type Part = Pick<StepView, "status" | "line" | "detail">;

const part = (status: StepStatus, line: string | null = null, detail: string | null = null): Part => ({ status, line, detail });
const failed = (error: ShortError): Part => part("failed", error.line, error.detail);
const quoteExpired = (): Part => part("failed", RUN_ERROR.QUOTE_EXPIRED);

/**
 * The quote ran out before the swap was asked for: the run cannot go on (the hub would refuse it), so the step it
 * stopped at fails and "Try again" means a new quote. Once POST /v1/swaps is on its way, the hub's answer decides.
 */
const expiredBeforeSwap = ({ swap, creating, expired }: RunInput): boolean => swap === null && expired && !creating;

function invoicePart(input: RunInput): Part {
  const { invoice, swap } = input;
  if (swap) return part("done", invoice.status === "made" && invoice.pasted ? STEP_LINE.INVOICE_PASTED : STEP_LINE.INVOICE_MADE);
  switch (invoice.status) {
    case "idle":
    case "making":
      return expiredBeforeSwap(input) ? quoteExpired() : part("active", STEP_LINE.INVOICE_MAKING);
    case "made":
      return part("done", invoice.pasted ? STEP_LINE.INVOICE_PASTED : STEP_LINE.INVOICE_MADE);
    case "failed":
      return failed(invoice.error);
  }
}

function lockPart(input: RunInput): Part {
  const { invoice, creating, createError, swap } = input;
  if (swap) return part("done", STEP_LINE.LOCKED);
  if (createError && !creating) return failed(createError);
  if (creating) return part("active", STEP_LINE.LOCKING);
  if (invoice.status !== "made") return part("pending");
  return expiredBeforeSwap(input) ? quoteExpired() : part("active", STEP_LINE.LOCKING);
}

function payPart({ direction, swap, progress, pay, expired }: RunInput): Part {
  if (!swap) return part("pending");
  if (isFunded(swap, progress)) return part("done", STEP_LINE.HELD);
  if (pay.status === "declined" || pay.status === "blocked") return failed(pay.error);
  if (swap.state === "failed") return part("failed", STEP_LINE.NOT_PAID);
  switch (pay.status) {
    case "idle":
      return expired ? part("failed", STEP_LINE.EXPIRED) : part("active", STEP_LINE.PAYING);
    case "paying":
      return part("active", STEP_LINE.PAYING);
    case "sent":
    case "uncertain":
      return part("active", STEP_LINE.SENT);
    case "manual":
      return expired ? part("failed", STEP_LINE.EXPIRED) : part("active", STEP_LINE.MANUAL[direction]);
  }
}

function payoutPart({ swap, progress }: RunInput): Part {
  if (!swap) return part("pending");
  if (inStates(swap.state, PAID_OUT_STATES)) return part("done", STEP_LINE.PAID_OUT);
  if (swap.state === "incoming_accepted" || swap.state === "outgoing_in_flight") return part("active", STEP_LINE.PAYING_OUT);
  if (swap.state === "failed" && progress.payoutStarted) return part("failed", STEP_LINE.PAYOUT_FAILED);
  return part("pending");
}

const ENDED_LINE: Record<Exclude<RunOutcome, "running" | "complete">, string> = {
  refunded: STEP_LINE.REFUNDED,
  "refund-pending": STEP_LINE.REFUND_PENDING,
  cancelled: STEP_LINE.CANCELLED,
  cancelling: STEP_LINE.CANCELLING,
};

function completePart({ swap, progress }: RunInput): Part {
  if (!swap) return part("pending");
  const outcome = runOutcome(swap, progress);
  if (outcome === "complete") return part("done", STEP_LINE.COMPLETE);
  if (outcome !== "running") return part("failed", ENDED_LINE[outcome]);
  return swap.state === "outgoing_succeeded" ? part("active", STEP_LINE.SETTLING) : part("pending");
}

const PARTS: Record<StepId, (input: RunInput) => Part> = {
  invoice: invoicePart,
  lock: lockPart,
  pay: payPart,
  payout: payoutPart,
  complete: completePart,
};

const titleOf = (id: StepId, direction: Direction): string => {
  const title = STEP_TITLE[id];
  return typeof title === "string" ? title : title[direction];
};

/** The five steps of the run, each pending, active, done or failed, with one short line. */
export const runSteps = (input: RunInput): StepView[] =>
  STEP_ORDER.map((id, i) => ({ id, number: i + 1, title: titleOf(id, input.direction), ...PARTS[id](input) }));

/* ----------------------------------------------------------------------------------------------- actions */

/** A Fiber node or hub call the run makes. Each is safe to repeat: none of them can pay twice. */
export type RunAction = "make-invoice" | "create-swap" | "pay";

/** What "Try again" does: repeat a step, or start over with a new quote. */
export type RetryAction = RunAction | "new-quote";

/**
 * The next call the run makes by itself: the payout invoice, then the swap, then (CKB or a token to BTC, browser node) the
 * payment once the hub waits for it. Null while a call is on its way, after a failure (the user decides), or once the
 * rest is the visitor's to do (paying a hold invoice by hand) or the hub's.
 */
export function nextRunAction(input: RunInput): RunAction | null {
  const { swap, invoice } = input;
  if (!swap) {
    if (input.expired) return null;
    if (invoice.status === "idle") return "make-invoice";
    if (invoice.status === "made" && !input.creating && input.createError === null) return "create-swap";
    return null;
  }
  // BTC to CKB or a token: the visitor pays the hub's hold invoice; nothing to call.
  if (input.direction === "ln_to_fiber") return null;
  return swap.state === "pending" && input.pay.status === "idle" && !input.expired ? "pay" : null;
}

/**
 * What "Try again" does after a failure, or null when there is nothing to try: a payment may be on its way, or the hub
 * is ending the swap by itself. A payment is asked again only after the node answered that it did not pay.
 */
export function retryAction(input: RunInput): RetryAction | null {
  const { swap, invoice, createError } = input;
  if (!swap) {
    // While POST /v1/swaps is on its way, the hub's answer decides; before it, an expired quote ends the run.
    if (input.creating) return null;
    if (expiredBeforeSwap(input)) return "new-quote";
    if (invoice.status === "failed") return "make-invoice";
    if (createError) return createError.retryable ? "create-swap" : "new-quote";
    return null;
  }
  if (swap.state === "pending" && input.pay.status === "declined" && !input.expired) return "pay";
  return runOutcome(swap, input.progress) === "cancelled" ? "new-quote" : null;
}

/* --------------------------------------------------------------------------------------- wallet answers */

/**
 * Step 3 of BTC to CKB or a token: the visitor pays the hub's hold invoice by hand (QR code, copy, a wallet on this
 * device), unless the hold invoice does not match the swap. The browser wallet (WebLN), when the visitor asks it, moves
 * the step on from what the page's store recorded for the payment hash: a recorded attempt wins, since the store never
 * asks twice. A refusal leaves the invoice to pay; the dialog says why the wallet did not (`browserPayError`).
 */
export function lightningPayStep(attempt: PayAttempt | undefined, holdCheck: InvoiceCheck | null): PayStep {
  if (attempt?.status === "sending") return { status: "paying" };
  if (attempt?.status === "paid") return { status: "sent" };
  if (attempt?.status === "uncertain") return { status: "uncertain" };
  if (!holdCheck) return PAY_IDLE;
  return holdCheck.ok ? { status: "manual" } : { status: "blocked", error: { line: holdCheck.error, detail: null } };
}

/** Why the browser wallet did not pay, beside its button: its own words behind a "?", and a channel when it found no route. */
export function browserPayError(attempt: PayAttempt | undefined): ShortError | null {
  if (attempt?.status !== "declined") return null;
  return attempt.noRoute
    ? { line: RUN_ERROR.NO_ROUTE, detail: attempt.message, help: "lightning-channel" }
    : { line: RUN_ERROR.WALLET_DECLINED, detail: attempt.message };
}
