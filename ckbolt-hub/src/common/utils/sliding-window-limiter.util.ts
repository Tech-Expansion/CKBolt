export interface RateLimitDecision {
  allowed: boolean;
  /** When refused: ms until the oldest counted hit leaves the window. 0 when allowed. */
  retryAfterMs: number;
}

const ALLOWED: RateLimitDecision = { allowed: true, retryAfterMs: 0 };

/**
 * Sliding-log rate limiter: each key may make `limit` hits in any `windowMs` span. Refused hits are not counted, so a
 * client that keeps retrying is not locked out for longer. In memory, per process; time comes from the caller.
 *
 * At most `maxKeys` keys are tracked: past that, the key hit least recently is forgotten and its budget starts over.
 * A client rotating its key cannot grow the memory, and only clients idle the longest lose their count.
 */
export class SlidingWindowRateLimiter {
  /** Hit times by key, the key hit least recently first (a hit moves its key to the end). */
  private readonly hits = new Map<string, number[]>();
  private lastSweepAt: number | null = null;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number,
  ) {}

  /** Whether `key` may make one more hit now. Counts nothing. */
  check(key: string, now: number): RateLimitDecision {
    return this.decide(this.recentHits(key, now), now);
  }

  /** Counts one hit for `key` when its budget allows it. */
  hit(key: string, now: number): RateLimitDecision {
    this.sweepIfDue(now);
    const recent = this.recentHits(key, now);
    const decision = this.decide(recent, now);
    this.remember(key, decision.allowed ? [...recent, now] : recent);
    return decision;
  }

  private decide(recent: readonly number[], now: number): RateLimitDecision {
    if (recent.length < this.limit) return ALLOWED;
    const oldest = recent[0] ?? now;
    return { allowed: false, retryAfterMs: oldest + this.windowMs - now };
  }

  private recentHits(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
  }

  /** Stores the key as the one hit most recently, then forgets the one hit least recently while there are too many. */
  private remember(key: string, recent: number[]): void {
    this.hits.delete(key);
    this.hits.set(key, recent);
    for (const leastRecent of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) return;
      this.hits.delete(leastRecent);
    }
  }

  /** Forgets keys with no hit left in the window, at most once per window, so idle clients do not pile up. */
  private sweepIfDue(now: number): void {
    if (this.lastSweepAt !== null && now - this.lastSweepAt < this.windowMs) return;
    this.lastSweepAt = now;
    for (const key of [...this.hits.keys()]) {
      if (this.recentHits(key, now).length === 0) this.hits.delete(key);
    }
  }
}
