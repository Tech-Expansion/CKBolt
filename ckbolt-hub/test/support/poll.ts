export interface PollOptions {
  timeoutMs: number;
  intervalMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads `read` until `done` holds or the time is up, and returns the last value either way, so the caller's `expect`
 * on it shows what was seen instead of a bare timeout.
 */
export async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, options: PollOptions): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(options.intervalMs);
    value = await read();
  }
  return value;
}
