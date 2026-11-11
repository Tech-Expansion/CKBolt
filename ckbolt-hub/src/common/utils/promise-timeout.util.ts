/** Raised by withTimeout when the work does not finish in time. */
export class TimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} did not answer within ${timeoutMs} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Resolves or rejects like `work`, or rejects with TimeoutError after `timeoutMs`. The work itself is not cancelled;
 * its late result is ignored. The timer never keeps the process alive.
 */
export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
