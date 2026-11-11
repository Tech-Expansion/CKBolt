/** An inbound channel the hub asked its fnn to open: the id fnn lists it under until the peer accepts, to which node, and when. */
export interface InboundOpen {
  /** The temporary channel id open_channel answered, as the caller writes it (InboundOpenRequests: canonical hex). */
  temporaryChannelId: string;
  /** The node the channel goes to. */
  peer: string;
  /** When the hub asked, by its own clock, ms. */
  askedAt: number;
}

/**
 * Durable record of the inbound channels the hub asked its fnn to open, the only pending channels it may abandon
 * unaccepted (application/fiber-node/stale-inbound-opens.ts), so the record survives a restart. Synchronous (SQLite
 * through better-sqlite3), like SwapStore. Implemented in src/infrastructure/persistence and by FakeInboundOpenStore
 * (test/fakes).
 */
export interface InboundOpenStore {
  /** Saves `open`, replacing the one with the same temporary channel id. */
  record(open: InboundOpen): void;
  /** The opens asked for at or before `askedBy` (ms), to `peer` or to any peer, oldest first. */
  listAskedBy(askedBy: number, peer?: string): InboundOpen[];
  /** Deletes the open with this temporary channel id; an unknown id changes nothing. */
  forget(temporaryChannelId: string): void;
}
