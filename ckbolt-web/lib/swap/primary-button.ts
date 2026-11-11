import type { PayAmount } from "./amount";
import { PRIMARY_LABEL } from "./copy";
import type { FiberShortfall } from "./fiber-liquidity";
import { formatSats } from "./format";
import type { LimitIssue } from "./limits";

/** What the card's one button does when pressed. */
export type PrimaryAction =
  | "none"
  /** A swap runs: show its progress. */
  | "view-progress"
  | "connect-fiber"
  /** CKB or a token to BTC: the visitor's own Lightning invoice is missing or refused. */
  | "focus-ln-invoice"
  | "focus-own-invoice"
  | "refresh-quote"
  | "swap";

export interface PrimaryButtonState {
  label: string;
  action: PrimaryAction;
  disabled: boolean;
}

/** The quote as the button sees it. */
export type QuoteStatus = "loading" | "ready" | "expired" | "failed";

/** Own node, BTC to Fiber: the pasted payout invoice. `unchecked` until a quote gives the amount it must ask for. */
export type OwnInvoiceStatus = "not-needed" | "unchecked" | "ok" | "missing";

/**
 * CKB or a token to BTC: the visitor's own Lightning invoice, which the hub pays out to. `not-needed` the other way;
 * `missing` until one is pasted, `invalid` when the page refuses it (one line says why).
 */
export type LnInvoiceStatus = "not-needed" | "missing" | "invalid" | "ok";

/** The card's run: none, still going, or ended (or stuck before a swap existed) and not put away yet. */
export type RunPresence = "none" | "running" | "settled";

export interface PrimaryButtonInput {
  run: RunPresence;
  /** The hub is live and serves the chosen asset in this direction. */
  hubLive: boolean;
  /** The hub's maintenance switch is on: its health says so, or it refused a quote with `maintenance`. */
  paused: boolean;
  /** What fixes the swap's amount: the typed amount, or (fiber_to_ln) the pasted invoice's ("ok" once it is valid). */
  amount: PayAmount["status"];
  limit: LimitIssue | null;
  fiber: { chosen: boolean; ready: boolean; problem: string | null };
  /** The browser node cannot carry this swap. */
  shortfall: FiberShortfall | null;
  /** The Fiber asset's symbol, for "Not enough CKB to send" and "Your node can't receive this much CKB". */
  symbol: string;
  lnInvoice: LnInvoiceStatus;
  ownInvoice: OwnInvoiceStatus;
  quote: QuoteStatus;
}

const disabled = (label: string): PrimaryButtonState => ({ label, action: "none", disabled: true });
const acting = (label: string, action: PrimaryAction): PrimaryButtonState => ({ label, action, disabled: false });

function limitLabel(limit: LimitIssue): string {
  switch (limit.kind) {
    case "min":
      return PRIMARY_LABEL.MIN(formatSats(limit.sats));
    case "max":
      return PRIMARY_LABEL.MAX(formatSats(limit.sats));
    case "liquidity":
      return PRIMARY_LABEL.NO_LIQUIDITY;
    case "range":
      return PRIMARY_LABEL.OUT_OF_RANGE;
  }
}

/**
 * The card's primary button: the first matching state wins (docs/live-swap-ui.md, "The primary button" and "One
 * wallet"). A running swap comes first, so the button never offers a second swap while one runs. CKB or a token to BTC
 * needs no amount typed: the visitor's invoice fixes it, so with neither the button asks for the invoice.
 */
export function primaryButtonState(input: PrimaryButtonInput): PrimaryButtonState {
  if (input.run === "running") return acting(PRIMARY_LABEL.RUNNING, "view-progress");
  if (input.run === "settled") return acting(PRIMARY_LABEL.VIEW_RESULT, "view-progress");
  if (!input.hubLive) return disabled(PRIMARY_LABEL.HUB_UNAVAILABLE);
  if (input.paused) return disabled(PRIMARY_LABEL.PAUSED);
  if (input.amount === "empty" || input.amount === "zero") {
    return input.lnInvoice === "not-needed" ? disabled(PRIMARY_LABEL.ENTER_AMOUNT) : acting(PRIMARY_LABEL.PASTE_LN_INVOICE, "focus-ln-invoice");
  }
  if (input.amount === "invalid") return disabled(PRIMARY_LABEL.INVALID_AMOUNT);
  if (input.limit) return disabled(limitLabel(input.limit));
  if (!input.fiber.chosen) return acting(PRIMARY_LABEL.CONNECT_FIBER, "connect-fiber");
  if (!input.fiber.ready) return acting(input.fiber.problem ?? PRIMARY_LABEL.FIBER_NOT_READY, "connect-fiber");
  if (input.shortfall === "send") return acting(PRIMARY_LABEL.SHORT_TO_SEND(input.symbol), "connect-fiber");
  if (input.shortfall === "receive") return acting(PRIMARY_LABEL.SHORT_TO_RECEIVE(input.symbol), "connect-fiber");
  if (input.shortfall === "no-channel") return acting(PRIMARY_LABEL.NO_CHANNEL, "connect-fiber");
  if (input.lnInvoice === "missing" || input.lnInvoice === "invalid") return acting(PRIMARY_LABEL.PASTE_LN_INVOICE, "focus-ln-invoice");
  if (input.ownInvoice === "missing") return acting(PRIMARY_LABEL.PASTE_FIBER_INVOICE, "focus-own-invoice");
  if (input.quote === "loading") return disabled(PRIMARY_LABEL.QUOTE_LOADING);
  if (input.quote === "expired") return acting(PRIMARY_LABEL.QUOTE_EXPIRED, "refresh-quote");
  if (input.quote === "failed") return acting(PRIMARY_LABEL.QUOTE_FAILED, "refresh-quote");
  return acting(PRIMARY_LABEL.READY, "swap");
}
