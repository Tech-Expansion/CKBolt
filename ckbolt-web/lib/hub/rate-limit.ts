/** A fixed-window budget per client, plus a server-wide cap. */
export interface RateLimitPolicy {
  windowMs: number;
  maxPerClient: number;
  /** Caps every client together, because forwarded-for headers can be forged. */
  maxGlobal: number;
  /** Expired client windows are swept once more clients than this are tracked. */
  maxTrackedClients: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** When a refused client may try again, in ms; 0 when allowed. */
  retryAfterMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly clients = new Map<string, Bucket>();
  private global: Bucket = { count: 0, resetAt: 0 };

  constructor(
    private readonly policy: RateLimitPolicy,
    private readonly now: () => number,
  ) {}

  /** Counts one request for `client` and says whether it may go ahead. */
  take(client: string): RateLimitDecision {
    const now = this.now();
    if (this.global.resetAt <= now) this.global = this.freshBucket(now);
    if (this.global.count >= this.policy.maxGlobal) return this.refuse(this.global, now);

    const bucket = this.bucketFor(client, now);
    if (bucket.count >= this.policy.maxPerClient) return this.refuse(bucket, now);
    bucket.count += 1;
    this.global.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  private bucketFor(client: string, now: number): Bucket {
    const current = this.clients.get(client);
    if (current && current.resetAt > now) return current;
    if (this.clients.size >= this.policy.maxTrackedClients) this.sweep(now);
    const fresh = this.freshBucket(now);
    this.clients.set(client, fresh);
    return fresh;
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.clients) if (bucket.resetAt <= now) this.clients.delete(key);
  }

  private freshBucket(now: number): Bucket {
    return { count: 0, resetAt: now + this.policy.windowMs };
  }

  private refuse(bucket: Bucket, now: number): RateLimitDecision {
    return { allowed: false, retryAfterMs: Math.max(0, bucket.resetAt - now) };
  }
}
