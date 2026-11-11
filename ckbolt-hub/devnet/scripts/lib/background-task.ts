import { describeError } from "../../../src/common/utils/error.util";

/**
 * Work that runs while the caller does something else (a payer blocked on a hold invoice). Its outcome is captured,
 * so an early failure never becomes an unhandled rejection and the caller can check it at any time.
 */
export class BackgroundTask {
  private outcome: { error?: unknown } | undefined;
  private readonly settled: Promise<void>;

  constructor(
    private readonly label: string,
    work: Promise<unknown>,
  ) {
    this.settled = work.then(
      () => void (this.outcome = {}),
      (error: unknown) => void (this.outcome = { error }),
    );
  }

  /** Throws if the task has already finished: the caller expected it to still be running. */
  assertRunning(): void {
    if (this.outcome === undefined) return;
    const reason = this.outcome.error === undefined ? "it returned early" : describeError(this.outcome.error);
    throw new Error(`${this.label} finished too early: ${reason}`);
  }

  /** Waits for the task and rethrows its error. */
  async result(): Promise<void> {
    await this.settled;
    if (this.outcome?.error !== undefined) throw this.outcome.error;
  }
}
