import { API_ERROR_CODE, HUB_PROXY_ERROR_CODE, type HubErrorCode } from "@/lib/hub/contract";
import { BridgeError } from "@/lib/wallets/fiber-browser/bridge-client";
import { BRIDGE_ERROR, type BridgeErrorCode } from "@/lib/wallets/fiber-browser/bridge-protocol";
import { CARD_ERROR, RUN_ERROR } from "./copy";

/**
 * A next step the page offers beside an error line, other than "Try again":
 * - `lightning-channel`: the browser wallet found no route to the hub; a channel from the hub (the guide's hub card)
 *   fixes that.
 */
export type ErrorHelp = "lightning-channel";

/**
 * Errors as the card and the progress dialog show them: one short line, and the full reason (the hub's or the
 * wallet's own sentence) behind a "?" when it says more.
 */
export interface ShortError {
  line: string;
  /** The full reason, or null when the line already says it all. */
  detail: string | null;
  /** A way forward the page offers beside the line, when there is one. */
  help?: ErrorHelp;
}

const short = (line: string, detail: string | null = null): ShortError => ({
  line,
  detail: detail && detail.trim() && detail.trim() !== line ? detail.trim() : null,
});

/** What the browser learns of a failed hub call: its code and the hub's sentence. */
export interface HubErrorLike {
  code: HubErrorCode | string;
  message: string;
}

const UNREACHABLE: readonly string[] = [HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, HUB_PROXY_ERROR_CODE.HUB_TIMEOUT];
const NO_PRICE: readonly string[] = [API_ERROR_CODE.QUOTE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE];

/** The card's error line for a quote the hub refused (limits and liquidity are the button's to say). */
export function quoteError(error: HubErrorLike): ShortError {
  if (UNREACHABLE.includes(error.code)) return short(CARD_ERROR.HUB_UNREACHABLE, error.message);
  if (NO_PRICE.includes(error.code)) return short(CARD_ERROR.NO_PRICE, error.message);
  if (error.code === API_ERROR_CODE.RATE_LIMITED) return short(CARD_ERROR.RATE_LIMITED);
  if (error.code === API_ERROR_CODE.ASSET_UNAVAILABLE) return short(CARD_ERROR.ASSET_UNAVAILABLE, error.message);
  if (error.code === API_ERROR_CODE.MAINTENANCE) return short(CARD_ERROR.MAINTENANCE, error.message);
  if (error.code === API_ERROR_CODE.INSUFFICIENT_LIQUIDITY) return short(CARD_ERROR.LIQUIDITY, error.message);
  return short(CARD_ERROR.QUOTE_FAILED, error.message);
}

/** Failures worth asking again with the same quote and invoice: the hub or the way to it was busy or down. */
const TRANSIENT: readonly string[] = [
  ...UNREACHABLE,
  API_ERROR_CODE.RATE_LIMITED,
  API_ERROR_CODE.UPSTREAM_UNAVAILABLE,
  API_ERROR_CODE.INTERNAL,
];

export interface CreateSwapError extends ShortError {
  /** Asking again with the same quote and invoice can work; otherwise the run needs a new quote. */
  retryable: boolean;
}

/** Why POST /v1/swaps failed, and whether the same request may be sent again. */
export function createSwapError(error: HubErrorLike): CreateSwapError {
  const retryable = TRANSIENT.includes(error.code);
  if (UNREACHABLE.includes(error.code)) return { ...short(RUN_ERROR.HUB_UNREACHABLE, error.message), retryable };
  switch (error.code) {
    case API_ERROR_CODE.RATE_LIMITED:
      return { ...short(RUN_ERROR.RATE_LIMITED), retryable };
    case API_ERROR_CODE.QUOTE_EXPIRED:
      return { ...short(RUN_ERROR.QUOTE_EXPIRED, error.message), retryable };
    case API_ERROR_CODE.CONFLICT:
    case API_ERROR_CODE.DUPLICATE_HASH:
      return { ...short(RUN_ERROR.QUOTE_TAKEN, error.message), retryable };
    case API_ERROR_CODE.INVOICE_INVALID:
      return { ...short(RUN_ERROR.INVOICE_REFUSED, error.message), retryable };
    case API_ERROR_CODE.MAINTENANCE:
      return { ...short(RUN_ERROR.MAINTENANCE, error.message), retryable };
    default:
      return { ...short(RUN_ERROR.SWAP_FAILED, error.message), retryable };
  }
}

const BRIDGE_LINE: Partial<Record<BridgeErrorCode, string>> = {
  [BRIDGE_ERROR.NO_NODE]: RUN_ERROR.NODE_NO_TAB,
  [BRIDGE_ERROR.NOT_RUNNING]: RUN_ERROR.NODE_LOCKED,
  [BRIDGE_ERROR.WRONG_NETWORK]: RUN_ERROR.NODE_WRONG_NETWORK,
  [BRIDGE_ERROR.NO_INBOUND]: RUN_ERROR.NODE_NO_INBOUND,
  [BRIDGE_ERROR.NO_OUTBOUND]: RUN_ERROR.NODE_NO_OUTBOUND,
  [BRIDGE_ERROR.REFUSED]: RUN_ERROR.NODE_REFUSED,
};

const messageOf = (e: unknown): string | null => (e instanceof Error && e.message.trim() ? e.message : null);

/** A Fiber node step that failed, as a short line with the node's own sentence behind it. */
export function fiberStepError(e: unknown): ShortError {
  const line = e instanceof BridgeError ? BRIDGE_LINE[e.code] : undefined;
  return short(line ?? messageOf(e) ?? RUN_ERROR.NODE_FAILED, line ? messageOf(e) : null);
}

/**
 * How a failed Fiber payment ends for the run. Only a timeout leaves it open whether the node sent the payment, so it
 * counts as sent and is never offered again. Every other refusal comes before the node pays (its tab checks with the
 * hub that the swap still waits, and Fiber refuses a second payment of the same hash), so asking again is safe.
 */
export type FiberPayFailure = { status: "uncertain" } | { status: "declined"; error: ShortError };

export function fiberPayFailure(e: unknown): FiberPayFailure {
  if (e instanceof BridgeError && e.code === BRIDGE_ERROR.TIMEOUT) return { status: "uncertain" };
  return { status: "declined", error: fiberStepError(e) };
}

/** A wallet's own sentence as the step's line. */
export const walletError = (message: string): ShortError => short(message);
