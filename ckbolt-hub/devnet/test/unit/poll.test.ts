import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BackgroundTask } from "../../scripts/lib/background-task";
import { doneWhen, waitFor, type Clock } from "../../scripts/lib/poll";

/** A clock that only moves when the code under test sleeps. */
function fakeClock(): Clock & { sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

describe("waitFor", () => {
  it("returns the first defined value without sleeping when it is ready at once", async () => {
    const clock = fakeClock();
    assert.equal(await waitFor("x", async () => 0, { timeoutMs: 10, intervalMs: 1, clock }), 0);
    assert.deepEqual(clock.sleeps, []);
  });

  it("polls at the interval until the probe is done", async () => {
    const clock = fakeClock();
    let calls = 0;
    const value = await waitFor("x", async () => (++calls === 3 ? "ready" : undefined), { timeoutMs: 1_000, intervalMs: 50, clock });
    assert.equal(value, "ready");
    assert.deepEqual(clock.sleeps, [50, 50]);
  });

  it("times out with the description", async () => {
    const clock = fakeClock();
    await assert.rejects(waitFor("the thing", async () => undefined, { timeoutMs: 100, intervalMs: 30, clock }), /Timed out after 100 ms waiting for the thing$/);
  });

  it("fails at once on an error unless errors are retried", async () => {
    const clock = fakeClock();
    await assert.rejects(
      waitFor("x", async () => Promise.reject(new Error("boom")), { timeoutMs: 100, intervalMs: 10, clock }),
      /^Error: boom$/,
    );
    assert.deepEqual(clock.sleeps, []);
  });

  it("retries errors when asked and reports the last one on timeout", async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      waitFor("the node", async () => Promise.reject(new Error(`down ${++calls}`)), { timeoutMs: 20, intervalMs: 10, retryErrors: true, clock }),
      /waiting for the node \(last error: down 3\)/,
    );
  });

  it("recovers when a retried error clears", async () => {
    const clock = fakeClock();
    let calls = 0;
    const value = await waitFor(
      "x",
      async () => {
        if (++calls < 3) throw new Error("starting");
        return true;
      },
      { timeoutMs: 1_000, intervalMs: 10, retryErrors: true, clock },
    );
    assert.equal(value, true);
  });

  it("doneWhen maps a condition to a wait result", () => {
    assert.equal(doneWhen(true), true);
    assert.equal(doneWhen(false), undefined);
  });
});

describe("BackgroundTask", () => {
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("is running while its work is pending", () => {
    const work = deferred();
    assert.doesNotThrow(() => new BackgroundTask("payer", work.promise).assertRunning());
  });

  it("reports an early return", async () => {
    const work = deferred();
    const task = new BackgroundTask("payer", work.promise);
    work.resolve();
    await tick();
    assert.throws(() => task.assertRunning(), /^Error: payer finished too early: it returned early$/);
    await task.result();
  });

  it("reports an early failure with its reason and rethrows it from result()", async () => {
    const work = deferred();
    const task = new BackgroundTask("payer", work.promise);
    const failure = new Error("no route");
    work.reject(failure);
    await tick();
    assert.throws(() => task.assertRunning(), /payer finished too early: no route/);
    await assert.rejects(task.result(), (error) => error === failure);
  });

  it("never leaves an unhandled rejection when nobody awaits it", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      new BackgroundTask("payer", Promise.reject(new Error("ignored")));
      await tick();
      await tick();
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
