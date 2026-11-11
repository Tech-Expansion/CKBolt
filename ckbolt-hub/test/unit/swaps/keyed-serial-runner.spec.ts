import { KeyedSerialRunner } from "../../../src/application/swaps/keyed-serial-runner";
import { deferred, flushAsync } from "./swaps.fixtures";

/**
 * The per-swap lock behind processSwap: at most one run per key at a time, a call that arrives mid-run triggers one
 * more run afterwards (so it sees fresh state), different keys run independently, and a failing task frees its key.
 */
describe("KeyedSerialRunner", () => {
  it("runs a task and resolves when it is done", async () => {
    const runner = new KeyedSerialRunner();
    const task = jest.fn(async () => undefined);
    await runner.run("a", task);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("never runs one key's task twice at the same time, and runs it once more for a call that arrived mid-run", async () => {
    const runner = new KeyedSerialRunner();
    const gates = [deferred(), deferred()];
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const task = async () => {
      const gate = gates[runs] ?? deferred();
      runs += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate.promise;
      active -= 1;
    };

    const first = runner.run("a", task);
    await flushAsync(1);
    expect(runs).toBe(1);
    const second = runner.run("a", task);
    const third = runner.run("a", task);
    await flushAsync(1);
    expect(runs).toBe(1);

    let secondDone = false;
    void second.then(() => (secondDone = true));
    gates[0]?.resolve();
    await flushAsync(1);
    expect(runs).toBe(2);
    expect(secondDone).toBe(false);

    gates[1]?.resolve();
    await Promise.all([first, second, third]);
    expect(runs).toBe(2);
    expect(maxActive).toBe(1);
  });

  it("serves calls that arrive before the first run started with that run", async () => {
    const runner = new KeyedSerialRunner();
    const task = jest.fn(async () => undefined);
    await Promise.all([runner.run("a", task), runner.run("a", task), runner.run("a", task)]);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("runs different keys side by side", async () => {
    const runner = new KeyedSerialRunner();
    const gate = deferred();
    const started: string[] = [];
    const task = (key: string) => async () => {
      started.push(key);
      await gate.promise;
    };

    const a = runner.run("a", task("a"));
    const b = runner.run("b", task("b"));
    await flushAsync(1);
    expect(started.sort()).toEqual(["a", "b"]);
    gate.resolve();
    await Promise.all([a, b]);
  });

  it("rejects with the task's error and frees the key for the next call", async () => {
    const runner = new KeyedSerialRunner();
    const boom = new Error("boom");
    await expect(runner.run("a", async () => Promise.reject(boom))).rejects.toBe(boom);

    const task = jest.fn(async () => undefined);
    await runner.run("a", task);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("a key is free again after its run, so a later call runs the task again", async () => {
    const runner = new KeyedSerialRunner();
    const task = jest.fn(async () => undefined);
    await runner.run("a", task);
    await runner.run("a", task);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
