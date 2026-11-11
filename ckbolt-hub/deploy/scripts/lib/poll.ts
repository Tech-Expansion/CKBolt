import { describeError } from "../../../src/common/utils/error.util";

/** Time source for waits, injectable so waits can be tested without real time. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  /** Treat a thrown error as "not yet" (a node still starting) instead of failing the wait at once. */
  retryErrors?: boolean;
  clock: Clock;
}

/**
 * Polls `probe` until it returns a value other than undefined and returns that value. Throws on timeout with the
 * description (and the last error, when errors are retried).
 */
export async function waitFor<T>(description: string, probe: () => Promise<T | undefined>, options: WaitOptions): Promise<T> {
  const { clock } = options;
  const deadline = clock.now() + options.timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      if (!options.retryErrors) throw error;
      lastError = error;
    }
    if (clock.now() >= deadline) {
      const cause = lastError === undefined ? "" : ` (last error: ${describeError(lastError)})`;
      throw new Error(`Timed out after ${Math.round(options.timeoutMs / 1000)} s waiting for ${description}${cause}`);
    }
    await clock.sleep(options.intervalMs);
  }
}
