/**
 * Runs tasks one at a time, in the order they were queued: a task starts once every earlier one has settled. Each call
 * resolves or rejects with its own task's outcome; a failed task does not stop the ones after it. In memory, per
 * process: for check-then-act sequences that must not interleave (two requests passing the same check).
 *
 * `maxWaiting` bounds how many tasks may wait behind the one running; `isFull` tells a caller to refuse instead of
 * queueing one more (run itself never refuses). Unbounded by default.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  /** Tasks queued and not settled yet, the running one included. */
  private unsettled = 0;

  constructor(private readonly maxWaiting = Number.POSITIVE_INFINITY) {}

  /** True when `maxWaiting` tasks already wait behind the one running. */
  get isFull(): boolean {
    return this.unsettled > this.maxWaiting;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.unsettled += 1;
    const result = this.tail.then(task).finally(() => {
      this.unsettled -= 1;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
