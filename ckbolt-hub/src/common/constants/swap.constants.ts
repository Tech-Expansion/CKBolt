import type { Direction, QuotePurpose, QuoteRequest, SwapState } from "../../domain/types";

/**
 * Names and fixed values of quotes and swaps, shared by pricing, the swap engine, the demo wallet and storage. Tunables
 * (poll interval, fee limits, payment timeout, hold delta) live in HubConfig.swaps.
 */

/* ----------------------------------------------------------------------------------------------- directions */

/** Swap directions by name, so code never spells the strings inline. */
export const SWAP_DIRECTION = {
  LN_TO_FIBER: "ln_to_fiber",
  FIBER_TO_LN: "fiber_to_ln",
} as const satisfies Record<string, Direction>;

/** Both swap directions, in the order the API lists them. */
export const SWAP_DIRECTIONS: readonly Direction[] = [SWAP_DIRECTION.LN_TO_FIBER, SWAP_DIRECTION.FIBER_TO_LN];

/** Which amount of a quote request is fixed: what the user pays, or what the user receives. */
export const QUOTE_SIDE = {
  PAY: "pay",
  RECEIVE: "receive",
} as const satisfies Record<string, QuoteRequest["side"]>;

/** What a quote is for (QuotePurpose): a swap now, or a payment request whose invoice waits for its payer. */
export const QUOTE_PURPOSE = {
  SWAP: "swap",
  REQUEST: "request",
} as const satisfies Record<string, QuotePurpose>;

/**
 * The directions a request quote is served for: a request's Lightning invoice is an ln_to_fiber swap (anyone pays sats,
 * the requester's node receives on Fiber). A fiber_to_ln request would hold the hub's Lightning payout for a payer who
 * may never come, with nothing a Get paid page needs from it.
 */
export const REQUEST_QUOTE_DIRECTIONS: readonly Direction[] = [SWAP_DIRECTION.LN_TO_FIBER];

/* --------------------------------------------------------------------------------------------------- states */

/** Swap states by name, so code never spells the strings inline (the state machine is in src/domain/swap). */
export const SWAP_STATE = {
  PENDING: "pending",
  INCOMING_ACCEPTED: "incoming_accepted",
  OUTGOING_IN_FLIGHT: "outgoing_in_flight",
  OUTGOING_SUCCEEDED: "outgoing_succeeded",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
} as const satisfies Record<string, SwapState>;

export const OPEN_SWAP_STATES: readonly SwapState[] = [
  SWAP_STATE.PENDING,
  SWAP_STATE.INCOMING_ACCEPTED,
  SWAP_STATE.OUTGOING_IN_FLIGHT,
  SWAP_STATE.OUTGOING_SUCCEEDED,
];
export const TERMINAL_SWAP_STATES: readonly SwapState[] = [SWAP_STATE.SUCCEEDED, SWAP_STATE.FAILED];

/** Open states whose payout is not sent yet: the hub must keep the payout (and its fee budget) for them. */
export const AWAITING_PAYOUT_SWAP_STATES: readonly SwapState[] = [SWAP_STATE.PENDING, SWAP_STATE.INCOMING_ACCEPTED];

/* --------------------------------------------------------------------------------------------------- events */

/** Machine names for SwapEvent.type. Add new ones here, never inline. */
export const SWAP_EVENT = {
  CREATED: "created",
  INCOMING_ACCEPTED: "incoming_accepted",
  PAYOUT_STARTED: "payout_started",
  PAYOUT_SUCCEEDED: "payout_succeeded",
  PAYOUT_FAILED: "payout_failed",
  SETTLED: "settled",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  ERROR: "error",
  /** The swap's creator cancelled it with its cancel token. */
  CANCELLED_ON_REQUEST: "cancelled_on_request",
  /** The swap failed for a reason other than an expired quote or a failed payout. */
  FAILED: "failed",
  /**
   * The payout is sent again because the paying node had no record of it (e.g. a crash right after saving). Recorded
   * before each such send, so the events count the resends and date the last one.
   */
  PAYOUT_RETRIED: "payout_retried",
  /** Something only a person can resolve, e.g. a payout that succeeded while the held payment is gone. */
  ALERT: "alert",
} as const;

export type SwapEventType = (typeof SWAP_EVENT)[keyof typeof SWAP_EVENT];

/** Events recorded right before the hub sends a payout: the first send, then each resend. */
export const PAYOUT_SEND_EVENTS: readonly SwapEventType[] = [SWAP_EVENT.PAYOUT_STARTED, SWAP_EVENT.PAYOUT_RETRIED];

/* ------------------------------------------------------------------------------------------- invoices, logs */

/** Description (Fiber) or memo (Lightning) of the hold invoices the hub issues. */
export const holdInvoiceDescription = (swapId: string): string => `CKBolt swap ${swapId}`;

/** Random bytes in a swap's cancel token: too many to guess, so a plain hash is enough to keep it by. */
export const CANCEL_TOKEN_BYTES = 32;

/** Unit shown after Lightning amounts in messages. */
export const SATS_UNIT_LABEL = "sats";

/** Logged when a node reports a failed payment without a reason. */
export const UNKNOWN_PAYMENT_FAILURE = "no reason given";
