import type { Logger } from "@nestjs/common";
import { MS_PER_SECOND } from "../../common/constants/protocol.constants";
import { describeError } from "../../common/utils/error.util";
import { canonicalHex } from "../../common/utils/hex.util";
import type { FiberChannel, FiberPort } from "../ports/fiber.port";
import type { InboundOpenStore } from "../ports/inbound-open-store.port";
import { isInboundChannel } from "./inbound-channel.rules";

/**
 * Inbound channels nobody accepts. A browser node accepts the hub's CKB channel itself (accept_channel, with the amount
 * its visitor chose), so a channel the hub opens stays NegotiatingFunding when the tab closes or the accept fails. fnn
 * aborts it only after its funding timeout (one day by default) and nothing is funded meanwhile, but the hub still
 * counts it: it keeps the node from asking again ("already has a channel"), holds a place under `maxOpen`, and its
 * funding is taken off the inbound funding room. So the hub abandons such a channel once it has waited longer than
 * `acceptTimeoutSeconds`, whenever it reads its inbound channels.
 *
 * Only a channel the hub asked for (InboundOpenRequests): fnn v0.9.1 lists every channel still waiting for its peer
 * (list_channels `only_pending`) with `is_public: false`, so a public channel an operator opened over fnn's RPC would
 * look like an inbound one. The record is in the hub's database (InboundOpenStore), so an open still waiting from before
 * a restart is given up after it like any other, by the time the hub asked (its own clock). Only an open whose
 * open_channel answer was lost (the hub never learnt its id) is left to fnn's funding timeout; until then it blocks that
 * node's next request in its asset and counts against `maxOpen` and the funding room.
 */

/**
 * The inbound channels the hub asked fnn to open, by temporary channel id (fnn lists a channel under it until the peer
 * accepts), each given up after `timeoutSeconds` without an accept. Ids are kept as canonical hex, so any spelling of
 * one finds it.
 */
export class InboundOpenRequests {
  constructor(private readonly store: InboundOpenStore, readonly timeoutSeconds: number) {}

  remember(temporaryChannelId: string, peer: string, askedAt: number): void {
    this.store.record({ temporaryChannelId: canonicalHex(temporaryChannelId), peer, askedAt });
  }

  /** The temporary ids of the requests to `peer` (or to any peer) that have waited `timeoutSeconds` by `nowMs`. */
  overdue(nowMs: number, peer?: string): string[] {
    const askedBy = nowMs - this.timeoutSeconds * MS_PER_SECOND;
    return this.store.listAskedBy(askedBy, peer).map(({ temporaryChannelId }) => temporaryChannelId);
  }

  forget(temporaryChannelId: string): void {
    this.store.forget(canonicalHex(temporaryChannelId));
  }
}

/** An inbound channel whose peer has not accepted it yet: nothing is funded, so fnn can abandon it. */
const isAwaitingAccept = (channel: FiberChannel): boolean => isInboundChannel(channel) && channel.awaitingAcceptSince !== undefined;

/**
 * Abandons every overdue request of `requests` that `channels` (read for `peer`, or for every peer) still shows waiting
 * for its peer, and returns the channels left. An overdue request no longer waiting (accepted, failed, abandoned, or
 * gone with the node's data) is forgotten. A request is looked at only once overdue: by then it was asked well before
 * the listing started, so a channel missing from it no longer exists, whereas a listing can miss an open made while it
 * ran. One fnn refuses (accepted in between) stays in the list and on record, and is tried again next time; the refusal
 * is only logged. A channel the hub did not ask for is never abandoned.
 */
export async function abandonStaleInboundOpens(
  fiber: Pick<FiberPort, "abandonChannel">,
  requests: InboundOpenRequests,
  { channels, peer }: { channels: readonly FiberChannel[]; peer?: string },
  nowMs: number,
  logger: Pick<Logger, "log" | "warn">,
): Promise<FiberChannel[]> {
  const abandoned = new Set<string>();
  for (const id of requests.overdue(nowMs, peer)) {
    const channel = channels.find((candidate) => canonicalHex(candidate.channelId) === id);
    if (!channel || !isAwaitingAccept(channel)) {
      requests.forget(id);
      continue;
    }
    try {
      await fiber.abandonChannel(channel.channelId);
      requests.forget(id);
      abandoned.add(channel.channelId);
      logger.log(`Abandoned inbound channel ${channel.channelId} to ${channel.peer}: not accepted within ${requests.timeoutSeconds} s`);
    } catch (error) {
      logger.warn(`Could not abandon inbound channel ${channel.channelId} to ${channel.peer}: ${describeError(error)}`);
    }
  }
  return channels.filter((channel) => !abandoned.has(channel.channelId));
}
