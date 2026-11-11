import { FIBER_NODE_ID_PATTERN } from "../../../src/common/constants/protocol.constants";
import { isMultiaddr, isWebSocketMultiaddr } from "../../../src/common/utils/multiaddr.util";
import { isFiberNodeId, toNodeId } from "../../../src/common/utils/node-id.util";
import { SerialQueue } from "../../../src/common/utils/serial-queue.util";
import { SlidingWindowRateLimiter as HttpLayerLimiter } from "../../../src/interfaces/http/rate-limit/sliding-window.limiter";
import { SlidingWindowRateLimiter } from "../../../src/common/utils/sliding-window-limiter.util";
import { BROWSER_NODE, P2P_ADDR, WS_ADDR, WSS_ADDR } from "./fiber-access.fixtures";

/** The shared helpers the Fiber node routes added to common/utils. */

describe("multiaddr.util", () => {
  it.each([P2P_ADDR, WS_ADDR, WSS_ADDR, "/dns4/bottle.fiber.channel/tcp/8119/p2p/QmXen3eUHhywmutEzydCsW4hXBoeVmdET2FJvMX69XJ1Eo", "/ip6/::1/tcp/8228/ws"])(
    "reads %s as a multiaddr",
    (address) => expect(isMultiaddr(address)).toBe(true),
  );

  it.each(["", "/", "//", "ip4/1.2.3.4/tcp/8228", "/ip4//tcp/8228", "/ip4/1.2.3.4/tcp/8228/", "ws://1.2.3.4:8228", "1.2.3.4:8228"])(
    "refuses %j as a multiaddr",
    (address) => expect(isMultiaddr(address)).toBe(false),
  );

  it.each([WS_ADDR, WSS_ADDR, "/ip4/0.0.0.0/tcp/8228/ws/p2p/QmeBMP2oD7yGmFysdMKAuJRymBDtheZJERdF7xuXH2yuQf"])(
    "reads %s as an address a browser node can dial",
    (address) => expect(isWebSocketMultiaddr(address)).toBe(true),
  );

  it.each([P2P_ADDR, "/ip4/1.2.3.4/tcp/8228/wsx", "/ip4/1.2.3.4/tcp/8228/websocket", "ws://1.2.3.4:8228", "/ws/"])(
    "refuses %s as a WebSocket multiaddr",
    (address) => expect(isWebSocketMultiaddr(address)).toBe(false),
  );
});

describe("node-id.util", () => {
  const UPPER = BROWSER_NODE.toUpperCase();

  it("accepts a compressed public key (02 or 03 and 32 more bytes), with or without 0x, in either case", () => {
    expect(isFiberNodeId(BROWSER_NODE)).toBe(true);
    expect(isFiberNodeId(`0x${BROWSER_NODE}`)).toBe(true);
    expect(isFiberNodeId(UPPER)).toBe(true);
    expect(isFiberNodeId(`03${"ff".repeat(32)}`)).toBe(true);
  });

  it.each([
    ["an uncompressed key prefix (04)", `04${"ab".repeat(32)}`],
    ["one byte short", `02${"ab".repeat(31)}`],
    ["one byte long", `02${"ab".repeat(33)}`],
    ["a non-hex character", `02${"ab".repeat(31)}zz`],
    ["a libp2p peer id", "QmeBMP2oD7yGmFysdMKAuJRymBDtheZJERdF7xuXH2yuQf"],
    ["an upper-case 0X prefix", `0X${BROWSER_NODE}`],
    ["surrounding spaces", ` ${BROWSER_NODE} `],
    ["an empty string", ""],
  ])("refuses %s", (_what, value) => expect(isFiberNodeId(value)).toBe(false));

  it("writes node ids the way fnn does: lower-case hex without 0x", () => {
    expect(toNodeId(`0x${UPPER}`)).toBe(BROWSER_NODE);
    expect(toNodeId(UPPER)).toBe(BROWSER_NODE);
    expect(toNodeId(BROWSER_NODE)).toBe(BROWSER_NODE);
  });

  it("matches the whole string only (no partial match on a longer value)", () => {
    expect(FIBER_NODE_ID_PATTERN.test(`${BROWSER_NODE}00`)).toBe(false);
    expect(FIBER_NODE_ID_PATTERN.test(`xx${BROWSER_NODE}`)).toBe(false);
  });
});

describe("SerialQueue", () => {
  /** A task the test finishes by hand. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("starts a task only once every earlier one has settled, in the order they were queued", async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    const first = deferred<string>();
    const second = deferred<string>();
    const a = queue.run(async () => {
      log.push("a starts");
      return first.promise;
    });
    const b = queue.run(async () => {
      log.push("b starts");
      return second.promise;
    });
    const c = queue.run(async () => {
      log.push("c starts");
      return "c";
    });
    await Promise.resolve();
    expect(log).toEqual(["a starts"]);
    first.resolve("a");
    await expect(a).resolves.toBe("a");
    await Promise.resolve();
    expect(log).toEqual(["a starts", "b starts"]);
    second.resolve("b");
    await expect(b).resolves.toBe("b");
    await expect(c).resolves.toBe("c");
    expect(log).toEqual(["a starts", "b starts", "c starts"]);
  });

  it("rejects a failed task with its own error and still runs the ones after it", async () => {
    const queue = new SerialQueue();
    const failing = queue.run(async () => {
      throw new Error("boom");
    });
    const next = queue.run(async () => "after");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("after");
  });

  it("does not interleave two check-then-act sequences", async () => {
    const queue = new SerialQueue();
    let open = 0;
    let maxConcurrent = 0;
    const task = async (): Promise<void> => {
      open += 1;
      maxConcurrent = Math.max(maxConcurrent, open);
      await new Promise((resolve) => setImmediate(resolve));
      open -= 1;
    };
    await Promise.all([queue.run(task), queue.run(task), queue.run(task)]);
    expect(maxConcurrent).toBe(1);
  });
});

describe("SlidingWindowRateLimiter (moved to common/utils)", () => {
  it("is the same class the HTTP layer imports", () => {
    expect(HttpLayerLimiter).toBe(SlidingWindowRateLimiter);
  });

  it("check() never counts; hit() counts only allowed hits", () => {
    const limiter = new SlidingWindowRateLimiter(1, 1_000, 10);
    expect(limiter.check("k", 0)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(limiter.check("k", 0)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(limiter.hit("k", 0).allowed).toBe(true);
    expect(limiter.check("k", 400)).toEqual({ allowed: false, retryAfterMs: 600 });
    expect(limiter.hit("k", 400).allowed).toBe(false);
    expect(limiter.check("k", 1_000).allowed).toBe(true);
  });
});
