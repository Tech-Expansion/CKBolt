import { CHANNEL_FEE_MARGIN_CKB, HUB_ACCEPT_RETRY_DELAYS_MS, MIN_CHANNEL_CONTRIBUTION_CKB } from "./constants";
import { largestContribution, parseContribution } from "./channel-contribution";
import { ckbToShannons } from "./channels";
import { fiberErrorMessage } from "./errors";
import type { BrowserFiberNode } from "./node-port";

/**
 * The browser node accepts the hub's CKB channel itself (its config turns fnn's automatic acceptance of CKB channels off,
 * NODE_AUTO_ACCEPT_CKB_FUNDING_SHANNONS), so what it puts in is the amount the visitor chose for this request:
 *
 * 1. planHubContribution checks the amount before the hub is asked: whole CKB from MIN_CHANNEL_CONTRIBUTION_CKB (more
 *    than the 99 CKB reserve), and no more than the node holds on chain less the fee margin;
 * 2. the hub opens the channel and answers with its temporary channel id;
 * 3. acceptHubChannel calls accept_channel with that id and the amount. The hub's open_channel message can reach the
 *    node a moment after the hub's answer, and fnn then says "No channel with temp id ... found": it is tried again
 *    after each of HUB_ACCEPT_RETRY_DELAYS_MS. Any other refusal is final.
 *
 * fnn takes the request off its waiting list before it checks the amount, so a refused accept cannot be tried again:
 * the hub drops its side of the open after a while (ckbolt-hub FIBER_INBOUND_ACCEPT_TIMEOUT_SECONDS).
 */

export const HUB_ACCEPT_MESSAGE = {
  AMOUNT: (min: string) => `Whole CKB, at least ${min}.`,
  NO_BALANCE: "Wait until the node has read its CKB balance.",
  TOO_MUCH: (largest: string) => `Your node can put in at most ${largest} CKB now.`,
  FUND_FIRST: (ckb: string) => `Fund the node with at least ${ckb} CKB first.`,
  // The hub answers 409 for this node and asset until it abandons its open (ckbolt-hub FIBER_INBOUND_ACCEPT_TIMEOUT_SECONDS,
  // 10 minutes by default); the open still counts toward the hub's channels per node a day (the hub channel's "?").
  NOT_ARRIVED: "The hub's channel did not arrive. Try again in 10 minutes.",
  REFUSED: (reason: string) => `Your node could not accept the hub's channel: ${reason}`,
} as const;

const formatCkb = (ckb: number): string => ckb.toLocaleString("en-US");

export type ContributionPlan = { ok: true; ckb: number; shannons: bigint } | { ok: false; error: string };

/**
 * The amount the node puts into the hub's CKB channel, typed (`text`) or chosen, checked against what it holds on chain
 * (`balance` shannons, null until read). The reserve is part of the amount, so the minimum covers it.
 */
export function planHubContribution(text: string, balance: bigint | null): ContributionPlan {
  const ckb = parseContribution(text);
  if (ckb === null) return { ok: false, error: HUB_ACCEPT_MESSAGE.AMOUNT(formatCkb(MIN_CHANNEL_CONTRIBUTION_CKB)) };
  if (balance === null) return { ok: false, error: HUB_ACCEPT_MESSAGE.NO_BALANCE };
  const largest = largestContribution(balance);
  if (largest < MIN_CHANNEL_CONTRIBUTION_CKB) {
    return { ok: false, error: HUB_ACCEPT_MESSAGE.FUND_FIRST(formatCkb(ckb + CHANNEL_FEE_MARGIN_CKB)) };
  }
  if (ckb > largest) return { ok: false, error: HUB_ACCEPT_MESSAGE.TOO_MUCH(formatCkb(largest)) };
  return { ok: true, ckb, shannons: ckbToShannons(ckb) };
}

/** fnn's answer to accept_channel while the opener's open_channel message has not arrived (fnn v0.9.1 network.rs). */
const NOT_ARRIVED = /no channel with temp id/i;

export const isChannelNotArrived = (error: unknown): boolean => NOT_ARRIVED.test(fiberErrorMessage(error));

export interface HubAcceptDeps {
  delaysMs: readonly number[];
  sleep: (ms: number) => Promise<void>;
}

export const browserHubAcceptDeps = (): HubAcceptDeps => ({
  delaysMs: HUB_ACCEPT_RETRY_DELAYS_MS,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/**
 * Accepts the hub's channel `temporaryChannelId` with `fundingAmount` shannons, trying again while the hub's open has not
 * reached the node. Throws a sentence for the visitor. The node's share goes back to its own lock on close, as for the
 * channels it opens (Close can still send it to the visitor's wallet).
 */
export async function acceptHubChannel(
  node: Pick<BrowserFiberNode, "acceptChannel">,
  args: { temporaryChannelId: string; fundingAmount: bigint },
  deps: HubAcceptDeps = browserHubAcceptDeps(),
): Promise<{ channelId: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await node.acceptChannel(args);
    } catch (error) {
      if (!isChannelNotArrived(error)) throw new Error(HUB_ACCEPT_MESSAGE.REFUSED(fiberErrorMessage(error)));
      if (attempt >= deps.delaysMs.length) throw new Error(HUB_ACCEPT_MESSAGE.NOT_ARRIVED);
      await deps.sleep(deps.delaysMs[attempt]);
    }
  }
}
