import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGE_MANIFEST_FILE, UNKNOWN_VERSION } from "../../../src/common/constants/health.constants";
import { basisPointsOfCeil } from "../../../src/common/utils/basis-points.util";
import { describeError } from "../../../src/common/utils/error.util";
import { readPackageVersion } from "../../../src/common/utils/package-version.util";
import { TimeoutError, withTimeout } from "../../../src/common/utils/promise-timeout.util";

/** Helpers the api module added to src/common/utils. */

const HUB_ROOT = join(__dirname, "..", "..", "..");

describe("withTimeout", () => {
  afterEach(() => jest.useRealTimers());

  it("resolves with the work's value when it finishes in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1_000, "work")).resolves.toBe(42);
  });

  it("rejects with the work's own error when it fails in time", async () => {
    const failure = new Error("node said no");
    await expect(withTimeout(Promise.reject(failure), 1_000, "work")).rejects.toBe(failure);
  });

  it("rejects with a TimeoutError naming the label and the limit when the work is too slow", async () => {
    jest.useFakeTimers();
    const outcome = withTimeout(new Promise<never>(() => undefined), 250, "Fiber node").catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(250);
    const error = (await outcome) as TimeoutError;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.label).toBe("Fiber node");
    expect(error.timeoutMs).toBe(250);
    expect(error.message).toContain("Fiber node");
    expect(error.message).toContain("250");
  });

  it("does not time out a moment early", async () => {
    jest.useFakeTimers();
    let settled = false;
    const outcome = withTimeout(new Promise<never>(() => undefined), 250, "x").catch(() => (settled = true));
    await jest.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await outcome;
    expect(settled).toBe(true);
  });

  it("clears its timer once the work settles", async () => {
    jest.useFakeTimers();
    await withTimeout(Promise.resolve("done"), 10_000, "x");
    await withTimeout(Promise.reject(new Error("x")), 10_000, "x").catch(() => undefined);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("ignores a late failure of the work after the timeout (no unhandled rejection)", async () => {
    jest.useFakeTimers();
    let rejectLate: (error: Error) => void = () => undefined;
    const work = new Promise<never>((_, reject) => (rejectLate = reject));
    const outcome = withTimeout(work, 100, "x").catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(100);
    expect(await outcome).toBeInstanceOf(TimeoutError);
    jest.useRealTimers();
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    rejectLate(new Error("late"));
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("readPackageVersion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ckbolt-api-version-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the hub's own version from src/ (as the HealthModule does)", () => {
    const manifest = JSON.parse(readFileSync(join(HUB_ROOT, PACKAGE_MANIFEST_FILE), "utf8")) as { version: string };
    expect(readPackageVersion(join(HUB_ROOT, "src", "application", "health"))).toBe(manifest.version);
  });

  it("walks up to the nearest manifest", () => {
    writeFileSync(join(dir, PACKAGE_MANIFEST_FILE), JSON.stringify({ name: "x", version: "4.5.6" }));
    const nested = join(dir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(readPackageVersion(nested)).toBe("4.5.6");
  });

  it("stops at the nearest manifest even when it has no version", () => {
    writeFileSync(join(dir, PACKAGE_MANIFEST_FILE), JSON.stringify({ name: "outer", version: "1.0.0" }));
    const inner = join(dir, "inner");
    mkdirSync(inner);
    writeFileSync(join(inner, PACKAGE_MANIFEST_FILE), JSON.stringify({ name: "inner" }));
    expect(readPackageVersion(inner)).toBe(UNKNOWN_VERSION);
  });

  it("is UNKNOWN_VERSION when the version is not a string", () => {
    writeFileSync(join(dir, PACKAGE_MANIFEST_FILE), JSON.stringify({ version: 7 }));
    expect(readPackageVersion(dir)).toBe(UNKNOWN_VERSION);
  });
});

describe("describeError", () => {
  it("uses an Error's message", () => {
    expect(describeError(new TypeError("bad type"))).toBe("bad type");
  });

  it("stringifies anything else", () => {
    expect(describeError("text")).toBe("text");
    expect(describeError(12)).toBe("12");
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBe("undefined");
  });

  it("joins the message chain of nested causes (fetch hides ECONNREFUSED in cause)", () => {
    const error = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8227") });
    expect(describeError(error)).toBe("fetch failed: connect ECONNREFUSED 127.0.0.1:8227");
  });
});

describe("basisPointsOfCeil", () => {
  it.each([
    [10_000n, 100, 100n],
    [50_000n, 150, 750n],
    [50_001n, 150, 751n],
    [1n, 1, 1n],
    [10n, 100, 1n],
    [123n, 0, 0n],
    [0n, 500, 0n],
    [10_000n, 10_000, 10_000n],
    [2_000_000_000_001n, 75, 15_000_000_001n],
  ])("%s at %i bps = %s (rounded up)", (amount, bps, expected) => {
    expect(basisPointsOfCeil(amount, bps)).toBe(expected);
  });
});
