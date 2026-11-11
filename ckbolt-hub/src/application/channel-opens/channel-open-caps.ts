import { CHANNEL_OPEN_CAP_WINDOW_MS, CHANNEL_OPEN_LOG_RETENTION_MS, type ChannelOpenKind } from "../../common/constants/channel-opens.constants";
import { MIN_RETRY_AFTER_SECONDS } from "../../common/constants/http.constants";
import type { HubError } from "../../common/errors/hub.error";
import { sumOf } from "../../common/utils/amount.util";
import { nextUtcDayStart, secondsToWait, utcDayStart } from "../../common/utils/time.util";
import type { ChannelOpen, ChannelOpenLog } from "../ports/channel-open-log.port";

/** How many channels may be opened, and how much pushed, before the next open is refused. */
export interface ChannelOpenLimits {
  /** Per client (the HTTP layer's client key), over a sliding day. */
  perClient: number;
  /** Per peer (the node or wallet the channel goes to), over a sliding day. */
  perPeer: number;
  /** Every client together, in the UTC day, closed channels included. */
  perDay: number;
}

/** The 429 each cap answers with, given its cap and the seconds until an open would pass it again. */
export interface ChannelOpenRefusals {
  client(cap: number, retryAfterSeconds: number): HubError;
  peer(cap: number, retryAfterSeconds: number): HubError;
  day(cap: number, retryAfterSeconds: number): HubError;
}

/** Sats the opens of a UTC day may push to peers together, and the 429 an open past it answers with. */
export interface ChannelPushBudget {
  satsPerDay: bigint;
  refusal(budgetSats: bigint, retryAfterSeconds: number): HubError;
}

/** One open being asked for: who asks, for which peer, and what it would push. */
export interface ChannelOpenRequest {
  clientKey: string;
  peer: string;
  pushedSats: bigint;
}

/** Whole seconds from `now` to `at`, at least MIN_RETRY_AFTER_SECONDS. */
const retryAfterSeconds = (at: number, now: number): number => Math.max(MIN_RETRY_AFTER_SECONDS, secondsToWait(at, now));

/**
 * The caps on channels the hub's nodes open on request, one implementation for inbound Fiber and Lightning channels:
 * per client and per peer over a sliding day, and for every client together a count (and, for channels that push sats
 * to the peer, a push budget) for the UTC day. Every open is saved in the ChannelOpenLog (the hub's database), so a
 * restart keeps the counts; opens a day old are deleted, client keys with them. Only record() counts: a refused request
 * costs nothing.
 *
 * Callers serialise check and record (SerialQueue), so two requests cannot both pass a cap with one slot left.
 */
export class ChannelOpenCaps {
  constructor(
    private readonly log: ChannelOpenLog,
    private readonly kind: ChannelOpenKind,
    private readonly limits: ChannelOpenLimits,
    private readonly refusals: ChannelOpenRefusals,
    private readonly pushBudget: ChannelPushBudget | null = null,
  ) {}

  /** Throws the first cap's 429 the open would pass: the client's, the peer's, the day's count, the day's push budget. */
  assertAllowed(request: ChannelOpenRequest, now: number): void {
    // Less than a day old: an open leaves the sliding day the instant it is a full day old.
    const lastDay = this.log.listAfter(this.kind, now - CHANNEL_OPEN_CAP_WINDOW_MS);
    this.assertUnderSlidingCap(lastDay.filter((open) => open.clientKey === request.clientKey), this.limits.perClient, now, this.refusals.client);
    this.assertUnderSlidingCap(lastDay.filter((open) => open.peer === request.peer), this.limits.perPeer, now, this.refusals.peer);
    const today = lastDay.filter((open) => open.openedAt >= utcDayStart(now));
    const untilTomorrow = retryAfterSeconds(nextUtcDayStart(now), now);
    if (today.length >= this.limits.perDay) throw this.refusals.day(this.limits.perDay, untilTomorrow);
    if (this.pushBudget === null) return;
    const { satsPerDay, refusal } = this.pushBudget;
    const pushedToday = sumOf(today.map((open) => open.pushedSats));
    if (pushedToday + request.pushedSats > satsPerDay) throw refusal(satsPerDay, untilTomorrow);
  }

  /** Counts one open, and forgets the opens that no cap counts any more. */
  record(request: ChannelOpenRequest, now: number): void {
    this.log.record({ kind: this.kind, ...request, openedAt: now });
    this.log.forgetBefore(now - CHANNEL_OPEN_LOG_RETENTION_MS);
  }

  /** `opens` (oldest first) hold `cap` or more: an open passes again once enough of them leave the sliding day. */
  private assertUnderSlidingCap(opens: readonly ChannelOpen[], cap: number, now: number, refuse: ChannelOpenRefusals["client"]): void {
    const leaving = opens[opens.length - cap];
    if (leaving === undefined) return;
    throw refuse(cap, retryAfterSeconds(leaving.openedAt + CHANNEL_OPEN_CAP_WINDOW_MS, now));
  }
}
