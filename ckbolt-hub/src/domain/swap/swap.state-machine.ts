import { OPEN_SWAP_STATES, SWAP_STATE } from "../../common/constants/swap.constants";
import type { Swap, SwapState } from "../types";

/**
 * The swap state machine, the same as Fiber's Cross-Chain Hub (docs/research/cch.md 1.3) without its self-loops:
 *   pending -> incoming_accepted -> outgoing_in_flight -> outgoing_succeeded -> succeeded
 *   pending | incoming_accepted | outgoing_in_flight -> failed (the incoming leg is cancelled: a refund)
 * `outgoing_succeeded` never fails: the preimage is known and the hub must collect the incoming leg.
 */

export { SWAP_STATE };

/** Every allowed transition, as data. */
export const SWAP_TRANSITIONS: Readonly<Record<SwapState, readonly SwapState[]>> = {
  [SWAP_STATE.PENDING]: [SWAP_STATE.INCOMING_ACCEPTED, SWAP_STATE.FAILED],
  [SWAP_STATE.INCOMING_ACCEPTED]: [SWAP_STATE.OUTGOING_IN_FLIGHT, SWAP_STATE.FAILED],
  [SWAP_STATE.OUTGOING_IN_FLIGHT]: [SWAP_STATE.OUTGOING_SUCCEEDED, SWAP_STATE.FAILED],
  [SWAP_STATE.OUTGOING_SUCCEEDED]: [SWAP_STATE.SUCCEEDED],
  [SWAP_STATE.SUCCEEDED]: [],
  [SWAP_STATE.FAILED]: [],
};

export const SWAP_STATES = Object.keys(SWAP_TRANSITIONS) as SwapState[];

/** The state every new swap starts in. */
export const INITIAL_SWAP_STATE: SwapState = SWAP_STATE.PENDING;

/** Most changes one swap can go through: one per state, plus the refund of a failed swap. */
export const MAX_SWAP_PROGRESS_STEPS = SWAP_STATES.length + 1;

/**
 * States in which the hub may cancel the incoming hold invoice. Nothing has been paid out in them: the payout is sent
 * only after `outgoing_in_flight` is saved, and `failed` is reached from there only on a definite payout failure.
 */
export const INCOMING_CANCELLABLE_STATES: readonly SwapState[] = [
  SWAP_STATE.PENDING,
  SWAP_STATE.INCOMING_ACCEPTED,
  SWAP_STATE.FAILED,
];

export const canTransition = (from: SwapState, to: SwapState): boolean => SWAP_TRANSITIONS[from].includes(to);

/** A transition the state machine does not allow: always a bug in the caller. */
export class InvalidSwapTransitionError extends Error {
  constructor(
    readonly from: SwapState,
    readonly to: SwapState,
  ) {
    super(`A swap cannot go from ${from} to ${to}.`);
    this.name = "InvalidSwapTransitionError";
  }
}

/** Guard for every state change: throws InvalidSwapTransitionError unless SWAP_TRANSITIONS allows it. */
export function assertTransition(from: SwapState, to: SwapState): void {
  if (!canTransition(from, to)) throw new InvalidSwapTransitionError(from, to);
}

/**
 * The never-cancel rule (docs/phase-3-plan.md section 3): the incoming leg may be cancelled only while no preimage is
 * known and no payout can be in flight.
 */
export const canCancelIncoming = (swap: Pick<Swap, "state" | "preimage">): boolean =>
  swap.preimage === null && INCOMING_CANCELLABLE_STATES.includes(swap.state);

/** True for a failed swap whose incoming leg is not cancelled yet. */
export const needsRefund = (swap: Pick<Swap, "state" | "refunded">): boolean =>
  swap.state === SWAP_STATE.FAILED && !swap.refunded;

/** The engine still has work on this swap (the same rule as SwapStore.listOpenSwaps). */
export const isSwapOpen = (swap: Pick<Swap, "state" | "refunded">): boolean =>
  OPEN_SWAP_STATES.includes(swap.state) || needsRefund(swap);

/** True when a processing step changed the swap's state or its refund. */
export const hasSwapProgressed = (before: Pick<Swap, "state" | "refunded">, after: Pick<Swap, "state" | "refunded">): boolean =>
  before.state !== after.state || before.refunded !== after.refunded;
