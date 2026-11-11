import { preimageMatches } from "../../common/utils/hex.util";
import { legsOf, lightningIsIncoming } from "../pricing/legs";
import type { Direction, Hex32, Swap } from "../types";

/**
 * The two legs of a swap, seen from the hub: the incoming leg is the hold invoice the user pays, the outgoing leg is the
 * payout to the user's invoice. Node states are mapped onto the leg states below by the direction flows, so the engine
 * decides the same way for both directions.
 */

export const LEG_NETWORK = { LIGHTNING: "lightning", FIBER: "fiber" } as const;
export type LegNetwork = (typeof LEG_NETWORK)[keyof typeof LEG_NETWORK];

/** Network names for messages. */
export const LEG_NETWORK_NAME: Readonly<Record<LegNetwork, string>> = {
  [LEG_NETWORK.LIGHTNING]: "Lightning",
  [LEG_NETWORK.FIBER]: "Fiber",
};

export interface SwapLegNetworks {
  /** Where the user pays the hub's hold invoice. */
  incoming: LegNetwork;
  /** Where the hub pays out to the user's invoice. */
  outgoing: LegNetwork;
}

export const legNetworks = (direction: Direction): SwapLegNetworks =>
  lightningIsIncoming(direction)
    ? { incoming: LEG_NETWORK.LIGHTNING, outgoing: LEG_NETWORK.FIBER }
    : { incoming: LEG_NETWORK.FIBER, outgoing: LEG_NETWORK.LIGHTNING };

type SwapAmounts = Pick<Swap, "direction" | "sats" | "fiberAmount">;

/** What the user must pay into the hold invoice: sats (ln_to_fiber) or asset base units (fiber_to_ln). */
export const expectedIncomingAmount = (swap: SwapAmounts): bigint => legsOf(swap.direction, swap).incoming;

/** What the hub pays out: asset base units (ln_to_fiber) or sats (fiber_to_ln). */
export const expectedPayoutAmount = (swap: SwapAmounts): bigint => legsOf(swap.direction, swap).outgoing;

/* ------------------------------------------------------------------------------------------- incoming leg */

export const INCOMING_LEG_STATE = {
  /** The node has no invoice for the hash. */
  MISSING: "missing",
  /** Issued, nothing paid yet. */
  OPEN: "open",
  /** A payment is held (LND ACCEPTED, Fiber Received). */
  HELD: "held",
  /** Collected (LND SETTLED, Fiber Paid): final. */
  SETTLED: "settled",
  /** Cancelled or expired: nothing is held and nothing can be paid any more. */
  CANCELLED: "cancelled",
  /**
   * Nothing is held any more, but the node is still removing what was (settling it with the preimage, or failing it
   * back) and has not reported the outcome yet: fnn shows this for a moment after settle_invoice. Wait for the outcome.
   */
  RESOLVING: "resolving",
} as const;
export type IncomingLegState = (typeof INCOMING_LEG_STATE)[keyof typeof INCOMING_LEG_STATE];

export interface IncomingLegView {
  state: IncomingLegState;
  /** What is held right now, in the leg's base units (sats or asset base units); 0 unless held. */
  heldAmount: bigint;
  /**
   * When the earliest held payment stops being collectable, null when nothing is held. Lightning: the earliest HTLC's
   * expiry height (the timing policy applies LND's auto-cancel margin). Fiber: the instant fnn fails the earliest held
   * TLC, ms since the epoch (its expiry less the early-fail margin of the channel it arrived on).
   */
  holdDeadline: number | null;
}

export const incomingLeg = (state: Exclude<IncomingLegState, typeof INCOMING_LEG_STATE.HELD>): IncomingLegView => ({
  state,
  heldAmount: 0n,
  holdDeadline: null,
});

export const heldIncomingLeg = (heldAmount: bigint, holdDeadline: number | null): IncomingLegView => ({
  state: INCOMING_LEG_STATE.HELD,
  heldAmount,
  holdDeadline,
});

/** True when the node holds nothing the hub could cancel: the payer was never charged or already has the funds back. */
export const isIncomingReleased = (leg: Pick<IncomingLegView, "state">): boolean =>
  leg.state === INCOMING_LEG_STATE.CANCELLED || leg.state === INCOMING_LEG_STATE.MISSING;

/**
 * True when the node still holds a payment the hub can collect. fnn keeps an invoice Received after its held TLC timed
 * out, so a held leg with nothing held counts as holding nothing.
 */
export const holdsFunds = (leg: Pick<IncomingLegView, "state" | "heldAmount">): boolean =>
  leg.state === INCOMING_LEG_STATE.HELD && leg.heldAmount > 0n;

/**
 * True when the node has no payment for this leg, arriving or leaving, so the swap may still be cancelled on request: an
 * open invoice, one already released, or a held leg holding nothing (fnn's Received after its TLC timed out).
 */
export const hasNoPayment = (leg: Pick<IncomingLegView, "state" | "heldAmount">): boolean =>
  leg.state === INCOMING_LEG_STATE.OPEN || isIncomingReleased(leg) || (leg.state === INCOMING_LEG_STATE.HELD && !holdsFunds(leg));

/* ------------------------------------------------------------------------------------------- outgoing leg */

export const PAYOUT_LEG_STATE = {
  /** The paying node has no record of a payment for the hash. */
  NOT_SENT: "not_sent",
  IN_FLIGHT: "in_flight",
  SUCCEEDED: "succeeded",
  /** Terminal failure: the payout can no longer succeed. */
  FAILED: "failed",
} as const;
export type PayoutLegState = (typeof PAYOUT_LEG_STATE)[keyof typeof PAYOUT_LEG_STATE];

export interface PayoutLegView {
  state: PayoutLegState;
  /**
   * Set once a payment part succeeded, whatever the state says; the engine checks it against the payment hash before
   * trusting it, and a matching preimage means the payout succeeded.
   */
  preimage: Hex32 | null;
  /** The node's failure reason once failed. */
  failureReason: string | null;
}

export const PAYOUT_NOT_SENT: PayoutLegView = { state: PAYOUT_LEG_STATE.NOT_SENT, preimage: null, failureReason: null };

/** A preimage that hashes to the payment hash proves the payee was paid, whatever state the paying node reports. */
export const provesPayment = (payout: PayoutLegView, paymentHash: Hex32): payout is PayoutLegView & { preimage: Hex32 } =>
  payout.preimage !== null && preimageMatches(payout.preimage, paymentHash);

/** The payout definitely failed: the node says so (nothing of it is out) and holds no proof that the payee was paid. */
export const isPayoutFailed = (payout: PayoutLegView, paymentHash: Hex32): boolean =>
  payout.state === PAYOUT_LEG_STATE.FAILED && !provesPayment(payout, paymentHash);
