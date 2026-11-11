import type { FiberChannel } from "../../application/ports/fiber.port";
import { canonicalHex } from "../../common/utils/hex.util";
import type { Script } from "../../domain/types";

/** A channel the node asked a peer to open: the peer's node id (as toPubkey writes it) and the asset. */
export interface ChannelOpenRequest {
  peer: string;
  /** null for a CKB channel. */
  udtTypeScript: Script | null;
}

/**
 * The asset of each channel the adapter asked fnn to open, by temporary channel id, until the peer accepts it. fnn v0.9.1
 * lists such a channel (list_channels `only_pending`) from its channel-opening record, which keeps no UDT, so a UDT
 * channel still waiting for its peer would read as a CKB channel. Once the peer accepts, fnn lists the channel under its
 * final id with its UDT and the entry is dropped. In memory: after a restart, a channel still waiting for its peer reads
 * as fnn lists it.
 */
export class ChannelOpenRequests {
  private readonly byTemporaryId = new Map<string, ChannelOpenRequest>();

  remember(temporaryChannelId: string, request: ChannelOpenRequest): void {
    this.byTemporaryId.set(canonicalHex(temporaryChannelId), request);
  }

  /** The temporary ids remembered now, of channels to `peer` or to any peer: what a listing starting now may drop. */
  idsTo(peer?: string): string[] {
    return [...this.byTemporaryId].filter(([, request]) => peer === undefined || request.peer === peer).map(([id]) => id);
  }

  /** The channel in the asset it was opened in, when fnn lists it under a temporary id remembered here. */
  withAsset(channel: FiberChannel): FiberChannel {
    const request = this.byTemporaryId.get(canonicalHex(channel.channelId));
    return request ? { ...channel, udtTypeScript: request.udtTypeScript } : channel;
  }

  /**
   * Drops the `ids` that the node no longer lists: the peer accepted the channel (it is listed under its final id) or it
   * failed to open. Only ids remembered before the listing started: a channel opened while it ran may not be in it yet.
   */
  dropUnlisted(ids: readonly string[], listed: readonly FiberChannel[]): void {
    const listedIds = new Set(listed.map((channel) => canonicalHex(channel.channelId)));
    for (const id of ids) if (!listedIds.has(id)) this.byTemporaryId.delete(id);
  }
}
