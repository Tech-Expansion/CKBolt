import type { SwapState } from "../types";
import { SWAP_STATE } from "./swap.state-machine";

/** What the engine does in each state, for "temporary problem" events. */
const STEP_ACTIVITY: Readonly<Record<SwapState, string>> = {
  [SWAP_STATE.PENDING]: "checking for the payment",
  [SWAP_STATE.INCOMING_ACCEPTED]: "starting the payout",
  [SWAP_STATE.OUTGOING_IN_FLIGHT]: "following the payout",
  [SWAP_STATE.OUTGOING_SUCCEEDED]: "collecting the held payment",
  [SWAP_STATE.SUCCEEDED]: "closing the swap",
  [SWAP_STATE.FAILED]: "cancelling the hold invoice",
};

/**
 * Plain sentences for swap events (SwapEvent.detail) and failures (Swap.failureReason). Users read them through the
 * API, so they never carry node error details. The only place these sentences are written.
 */
export const SWAP_REASON = {
  /* --------------------------------------------------------------------------------------------- progress */
  created: (incomingNetwork: string): string => `Swap created. Waiting for the payment of the ${incomingNetwork} hold invoice.`,
  incomingAccepted: "The payment is held. The hub is starting the payout.",
  payoutStarted: "The hub sent the payout.",
  payoutRetried: "The hub is sending the payout again: the paying node had no record of it.",
  payoutSucceeded: "The payout arrived. The hub is collecting the held payment.",
  settled: "The hub collected the held payment. The swap is complete.",
  refunded: "The hub cancelled the held payment, so it goes back to the payer.",
  holdInvoiceCancelledOnRequest: "The hub cancelled the hold invoice, so it can no longer be paid.",

  /* ---------------------------------------------------------------------------------------------- failures */
  quoteExpiredUnpaid: "The quote expired before the payment arrived.",
  cancelledOnRequest: "The swap was cancelled on request.",
  holdInvoiceCancelled: "The hold invoice was cancelled before it was paid.",
  holdInvoiceMissing: "The node has no record of this swap's hold invoice.",
  paidAfterQuoteExpiry: "The payment arrived after the quote expired, so it is refunded.",
  nothingHeld: "The node no longer holds the payment, so the hub cannot pay out.",
  underpaid: (held: bigint, expected: bigint): string =>
    `The held payment of ${held} base units is less than the ${expected} the quote asks for, so it is refunded.`,
  incomingReleased: "The held payment was released before the payout started, so it went back to the payer.",
  payoutFailed: "The payout failed, so the payment is refunded.",
  payoutNotSent: "The hub could not send the payout, so the payment is refunded.",
  peerChannelHoldTooShort: (assumedDelayEpochs: number): string =>
    "The payment came over a channel the payer opened. The hub cannot see that channel's commitment delay and counts " +
    `${assumedDelayEpochs} epochs for it, which leaves this hold too little time to pay out, so the payment is refunded. ` +
    "A payment over a channel the hub opened does not have this limit.",

  /* ------------------------------------------------------------------------------------ alerts (need a person) */
  settledBeforePayout: "The held payment is settled although the hub never paid out. Check this swap by hand.",
  incomingLostAfterPayout: "The payout succeeded but the held payment is gone, so the hub cannot collect it. Check this swap by hand.",
  payoutPreimageInvalid: "The payout reports success without a preimage that matches the payment hash. The hub keeps checking.",
  preimageMissing: "The swap has no saved preimage to collect the held payment with. Check this swap by hand.",
  refundBlocked: "The hub did not cancel the held payment because a payout may exist. Check this swap by hand.",

  /* -------------------------------------------------------------------------------------- temporary problems */
  retrying: (state: SwapState): string => `The hub hit a temporary problem while ${STEP_ACTIVITY[state]} and will try again.`,
} as const;
