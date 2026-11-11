import type { RequestPartStatus } from "@/lib/get-paid/request";
import type { HubLiveState } from "@/lib/hub/status";
import type { RunOutcome, StepStatus } from "@/lib/swap/run-model";
import { isActivityFinal, type ActivityEntry } from "@/lib/wallets/fiber-browser/activity";
import type { HistoryItem } from "@/lib/wallets/fiber-browser/history";
import type { NodePhase } from "@/lib/wallets/fiber-browser/bridge-protocol";
import { CHANNEL_STATE, PAYMENT_STATUS } from "@/lib/wallets/fiber-browser/constants";

/**
 * The status colours (docs/style-guide.md, Colour): colour carries state, never decoration, and every coloured state
 * keeps its words. `ok` is Fiber green (alive, ready, done), `pending` amber (in progress, waiting, needs a look),
 * `error` red (failed), `off` neutral grey (locked, stopped, not set up, closed).
 */
export type StatusTone = "ok" | "pending" | "error" | "off";

/** The browser node: running, starting, held by another tab, failed, or locked. */
const PHASE_TONE: Readonly<Record<NodePhase, StatusTone>> = {
  running: "ok",
  starting: "pending",
  "other-tab": "pending",
  failed: "error",
  locked: "off",
};
export const nodePhaseTone = (phase: NodePhase): StatusTone => PHASE_TONE[phase];

/** Channel states that ended badly, as fnn names them (none in 0.9.1's happy path; any "failed" or "abandoned" one). */
const FAILED_CHANNEL = /fail|abandon/i;

/** A Fiber channel: Ready, closed, failed, or anything on its way (opening, awaiting confirmations, closing). */
export function channelStateTone(state: string): StatusTone {
  if (state === CHANNEL_STATE.READY) return "ok";
  if (state === CHANNEL_STATE.CLOSED) return "off";
  if (FAILED_CHANNEL.test(state)) return "error";
  return "pending";
}

/** A step of the swap's run: done, the current one, failed, or still to come. */
const STEP_TONE: Readonly<Record<StepStatus, StatusTone>> = { done: "ok", active: "pending", failed: "error", pending: "off" };
export const stepTone = (status: StepStatus): StatusTone => STEP_TONE[status];

/** How a swap ended: complete, money on its way back or back (amber: the visitor's swap did not happen), cancelled. */
const OUTCOME_TONE: Readonly<Record<Exclude<RunOutcome, "running">, StatusTone>> = {
  complete: "ok",
  refunded: "pending",
  "refund-pending": "pending",
  cancelling: "pending",
  cancelled: "off",
};
export const outcomeTone = (outcome: Exclude<RunOutcome, "running">): StatusTone => OUTCOME_TONE[outcome];

/** A swap leg's statuses that mean it went through: the hold invoice paid, the payout received. */
const SWAP_DONE: readonly string[] = [PAYMENT_STATUS.SUCCESS, "Paid"];

/**
 * An activity entry: a swap's leg through (paid or received), failed, given up (cancelled or expired) or under way; a
 * payment from Pay paid, failed or on its way; an invoice made for Get paid received, given up or waiting; a channel
 * open or closed (done), or on its way; a withdrawal sent.
 */
export function activityTone(entry: Pick<ActivityEntry, "kind" | "status" | "swap">): StatusTone {
  switch (entry.kind) {
    case "swap":
      if (SWAP_DONE.includes(entry.status)) return "ok";
      if (entry.status === PAYMENT_STATUS.FAILED) return "error";
      return isActivityFinal(entry) ? "off" : "pending";
    case "payment":
      if (entry.status === PAYMENT_STATUS.SUCCESS) return "ok";
      return entry.status === PAYMENT_STATUS.FAILED ? "error" : "pending";
    case "request":
      if (entry.status === "Paid") return "ok";
      return isActivityFinal(entry) ? "off" : "pending";
    case "channel":
      return isActivityFinal(entry) ? "ok" : "pending";
    default:
      return "ok";
  }
}

/**
 * An entry of the node's History: a swap the app kept by how it stands at the hub, read as the run reads its outcome
 * (runOutcome; outcomeTone: complete green, under way and refunds amber, cancelled grey), anything else by the node's
 * own entry (activityTone). Read here from the record's fields, so the header's button, which uses this module, does
 * not load History and the run model.
 */
export function historyTone(item: Pick<HistoryItem, "entry" | "swap">): StatusTone {
  const swap = item.swap;
  if (!swap) return item.entry ? activityTone(item.entry) : "off";
  if (swap.state === "succeeded") return outcomeTone("complete");
  if (swap.state !== "failed") return "pending";
  if (swap.funded) return outcomeTone(swap.refunded ? "refunded" : "refund-pending");
  return outcomeTone(swap.refunded ? "cancelled" : "cancelling");
}

/**
 * One invoice of a Get paid request (its Lightning or Fiber tab): paid (done), on its way or waiting for a payer
 * (pending), not asked for yet, expired or cancelled (off: nobody paid it), not made or returned to the payer (error).
 */
const REQUEST_PART_TONE: Readonly<Record<RequestPartStatus, StatusTone>> = {
  idle: "off",
  making: "pending",
  waiting: "pending",
  arriving: "pending",
  paid: "ok",
  expired: "off",
  cancelled: "off",
  returned: "error",
  failed: "error",
};
export const requestPartTone = (status: RequestPartStatus): StatusTone => REQUEST_PART_TONE[status];

/** The CKBolt hub as the page reads it: live, degraded or paused (pending), unreachable (error), not set up (off). */
export function hubStateTone(state: HubLiveState, paused: boolean): StatusTone {
  if (state === "live") return paused ? "pending" : "ok";
  if (state === "degraded" || state === "checking") return "pending";
  return state === "offline" ? "error" : "off";
}
