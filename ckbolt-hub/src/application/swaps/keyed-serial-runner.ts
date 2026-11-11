type Task = () => Promise<void>;

interface Run {
  /** An `exclusive` call's task: it comes first, and a `run` call that arrives meanwhile cannot replace it. */
  exclusive: Task | null;
  /** The `run` task still to run: set by a call for the key, cleared when it starts. */
  pending: Task | null;
  done: Promise<void>;
}

/**
 * The per-key lock: at most one task per key at a time, whichever method started it.
 *
 * `run` is for a task that reads fresh state and may be repeated (the engine's step). A call for a busy key does not
 * start a second, parallel run: if the task is already running it is run once more afterwards (so the call sees fresh
 * state), and the call resolves when the key is idle again. Calls that arrive before the task has started are served by
 * that first run. Calls for one key must pass the same task.
 *
 * `exclusive` is for a task that must run exactly once and answer its own caller (a cancel). It waits its turn, runs
 * alone, and a `run` call that arrives meanwhile runs after it.
 */
export class KeyedSerialRunner {
  private readonly runs = new Map<string, Run>();

  run(key: string, task: Task): Promise<void> {
    const active = this.runs.get(key);
    if (active) {
      active.pending = task;
      return active.done;
    }
    return this.start(key, { exclusive: null, pending: task }).done;
  }

  /**
   * Runs `task` alone once the key is idle, and answers with its own result or error: a `run` task that follows it on
   * the key neither delays the answer nor shares its failure.
   */
  async exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    for (let active = this.runs.get(key); active; active = this.runs.get(key)) {
      // A failed run is its own callers' business: here it only means the key is free.
      await active.done.catch(() => undefined);
    }
    // No await between the last check above and the start below: nothing else can take the key in between.
    return new Promise<T>((resolve, reject) => {
      const answer: Task = async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      };
      this.start(key, { exclusive: answer, pending: null });
    });
  }

  private start(key: string, work: Pick<Run, "exclusive" | "pending">): Run {
    const run: Run = { ...work, done: Promise.resolve() };
    // Started on the next microtask, so the run is registered before the task can call back into run().
    run.done = Promise.resolve().then(() => this.drain(key, run));
    this.runs.set(key, run);
    return run;
  }

  private async drain(key: string, run: Run): Promise<void> {
    try {
      await run.exclusive?.();
      while (run.pending) {
        const task = run.pending;
        run.pending = null;
        await task();
      }
    } finally {
      this.runs.delete(key);
    }
  }
}
