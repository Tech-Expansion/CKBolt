import type { ChannelOpenKind } from "../../common/constants/channel-opens.constants";

/** One channel one of the hub's nodes opened on request, as the daily caps count it. */
export interface ChannelOpen {
  kind: ChannelOpenKind;
  /** The HTTP layer's client key that asked for it (the one the rate limits count). */
  clientKey: string;
  /** The node or wallet the channel goes to. */
  peer: string;
  /** Sats the hub gave the peer at open (an inbound Lightning channel's push); 0 when it gave nothing. */
  pushedSats: bigint;
  /** When the hub counted it, ms. */
  openedAt: number;
}

/**
 * Durable log of the channels the hub's nodes opened on request (inbound Fiber and Lightning channels), so the daily
 * caps on them survive a restart. Synchronous (SQLite through better-sqlite3), like SwapStore. Implemented in
 * src/infrastructure/persistence and by FakeChannelOpenLog (test/fakes).
 */
export interface ChannelOpenLog {
  record(open: ChannelOpen): void;
  /** The opens of `kind` after `after` (not at it), oldest first. */
  listAfter(kind: ChannelOpenKind, after: number): ChannelOpen[];
  /** Deletes every open from before `before`, of every kind. */
  forgetBefore(before: number): void;
}
