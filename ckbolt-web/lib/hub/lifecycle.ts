import { SWAP_EVENT, TERMINAL_SWAP_STATES, type SwapDto, type SwapEventDto, type SwapState } from "./contract";

/** What has happened to a swap so far. A failed swap no longer shows it in its state, so it is remembered. */
export interface SwapProgress {
  funded: boolean;
  payoutStarted: boolean;
}

export const NO_PROGRESS: SwapProgress = { funded: false, payoutStarted: false };

/** How far each live state has come along pending -> ... -> succeeded. `failed` has no place on that line. */
const STATE_RANK: Record<Exclude<SwapState, "failed">, number> = {
  pending: 0,
  incoming_accepted: 1,
  outgoing_in_flight: 2,
  outgoing_succeeded: 3,
  succeeded: 4,
};

const reached = (state: SwapState, target: Exclude<SwapState, "failed">): boolean =>
  state !== "failed" && STATE_RANK[state] >= STATE_RANK[target];

const hasEvent = (events: readonly SwapEventDto[], type: string): boolean => events.some((e) => e.type === type);

/**
 * Nothing more will change for the user: the swap succeeded, or it failed and the hold was cancelled. A failed swap
 * whose refund is still pending is not final, so it keeps being read until the refund shows.
 */
export const isSwapFinal = (swap: SwapDto): boolean => TERMINAL_SWAP_STATES.includes(swap.state) && (swap.state !== "failed" || swap.refunded);

/** Progress seen so far, never forgetting a step once it showed in a state or an event. */
export function accumulateProgress(previous: SwapProgress, swap: SwapDto, events: readonly SwapEventDto[]): SwapProgress {
  const funded = previous.funded || reached(swap.state, "incoming_accepted") || hasEvent(events, SWAP_EVENT.INCOMING_ACCEPTED);
  const payoutStarted = previous.payoutStarted || reached(swap.state, "outgoing_in_flight") || hasEvent(events, SWAP_EVENT.PAYOUT_STARTED);
  return funded === previous.funded && payoutStarted === previous.payoutStarted ? previous : { funded, payoutStarted };
}
