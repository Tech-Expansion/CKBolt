import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { DemoDisabledError } from "../../../src/application/demo/demo.errors";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { DEMO_RATE_LIMIT_WINDOW_MS, HTTP_ERROR_MESSAGE, RATE_LIMIT_WINDOW_MS, UNKNOWN_CLIENT_KEY } from "../../../src/common/constants/http.constants";
import { MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { RateLimitedError } from "../../../src/common/errors/hub.error";
import { DemoEnabledGuard } from "../../../src/interfaces/http/guards/demo-enabled.guard";
import { DemoRateLimitGuard } from "../../../src/interfaces/http/guards/demo-rate-limit.guard";
import { RateLimitGuard } from "../../../src/interfaces/http/guards/rate-limit.guard";
import { clientKeyOf, type ClientRequest } from "../../../src/interfaces/http/rate-limit/client-key";
import { SlidingWindowRateLimiter } from "../../../src/interfaces/http/rate-limit/sliding-window.limiter";
import { FakeClock } from "../../fakes";
import { StubDemoWallet, testConfig } from "./api.fixtures";

const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);
/** More keys than any of these specs uses, unless a spec is about the bound. */
const MAX_KEYS = 10_000;

describe("SlidingWindowRateLimiter", () => {
  it("allows `limit` hits in a window and refuses the next one", () => {
    const limiter = new SlidingWindowRateLimiter(3, MS_PER_MINUTE, MAX_KEYS);
    for (let i = 0; i < 3; i += 1) expect(limiter.hit("a", T0 + i)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(limiter.hit("a", T0 + 3)).toEqual({ allowed: false, retryAfterMs: MS_PER_MINUTE - 3 });
  });

  it("retryAfterMs is the time until the oldest counted hit leaves the window", () => {
    const limiter = new SlidingWindowRateLimiter(2, MS_PER_MINUTE, MAX_KEYS);
    limiter.hit("a", T0);
    limiter.hit("a", T0 + 20_000);
    expect(limiter.hit("a", T0 + 45_000)).toEqual({ allowed: false, retryAfterMs: 15_000 });
  });

  it("a hit exactly one window old no longer counts", () => {
    const limiter = new SlidingWindowRateLimiter(1, MS_PER_MINUTE, MAX_KEYS);
    limiter.hit("a", T0);
    expect(limiter.hit("a", T0 + MS_PER_MINUTE - 1).allowed).toBe(false);
    expect(limiter.hit("a", T0 + MS_PER_MINUTE).allowed).toBe(true);
  });

  it("slides: old hits drop out one by one rather than resetting a fixed window", () => {
    const limiter = new SlidingWindowRateLimiter(2, MS_PER_MINUTE, MAX_KEYS);
    limiter.hit("a", T0);
    limiter.hit("a", T0 + 40_000);
    expect(limiter.hit("a", T0 + 60_000).allowed).toBe(true); // T0 left; T0+40s and T0+60s count
    expect(limiter.hit("a", T0 + 61_000)).toEqual({ allowed: false, retryAfterMs: 39_000 });
  });

  it("refused hits are not counted", () => {
    const limiter = new SlidingWindowRateLimiter(1, MS_PER_MINUTE, MAX_KEYS);
    limiter.hit("a", T0);
    for (let t = 1; t < 60; t += 1) expect(limiter.hit("a", T0 + t * MS_PER_SECOND).allowed).toBe(false);
    expect(limiter.hit("a", T0 + MS_PER_MINUTE).allowed).toBe(true);
  });

  it("keys are independent", () => {
    const limiter = new SlidingWindowRateLimiter(1, MS_PER_MINUTE, MAX_KEYS);
    expect(limiter.hit("a", T0).allowed).toBe(true);
    expect(limiter.hit("b", T0).allowed).toBe(true);
    expect(limiter.hit("a", T0).allowed).toBe(false);
    expect(limiter.hit("c", T0).allowed).toBe(true);
  });

  it("forgets idle clients so memory does not grow with every address ever seen", () => {
    const limiter = new SlidingWindowRateLimiter(5, MS_PER_MINUTE, MAX_KEYS);
    for (let i = 0; i < 1_000; i += 1) limiter.hit(`client-${i}`, T0);
    limiter.hit("late", T0 + 2 * MS_PER_MINUTE);
    const tracked = (limiter as unknown as { hits: Map<string, number[]> }).hits;
    expect([...tracked.keys()]).toEqual(["late"]);
  });

  it("a limit of 1 per hour behaves like the demo budget", () => {
    const limiter = new SlidingWindowRateLimiter(1, MS_PER_HOUR, MAX_KEYS);
    expect(limiter.hit("a", T0).allowed).toBe(true);
    expect(limiter.hit("a", T0 + 59 * MS_PER_MINUTE)).toEqual({ allowed: false, retryAfterMs: MS_PER_MINUTE });
  });

  it("check() answers like hit() but counts nothing", () => {
    const limiter = new SlidingWindowRateLimiter(1, MS_PER_MINUTE, MAX_KEYS);
    for (let i = 0; i < 3; i += 1) expect(limiter.check("a", T0)).toEqual({ allowed: true, retryAfterMs: 0 });
    limiter.hit("a", T0);
    expect(limiter.check("a", T0 + 1)).toEqual({ allowed: false, retryAfterMs: MS_PER_MINUTE - 1 });
  });

  describe("tracks at most maxKeys keys within a window (rotating keys cannot grow the memory)", () => {
    const tracked = (limiter: SlidingWindowRateLimiter): string[] => [...(limiter as unknown as { hits: Map<string, number[]> }).hits.keys()];

    it("forgets the key hit least recently once there are more, and its budget starts over", () => {
      const limiter = new SlidingWindowRateLimiter(1, MS_PER_MINUTE, 3);
      for (const key of ["a", "b", "c"]) limiter.hit(key, T0);
      expect(limiter.hit("a", T0 + 1).allowed).toBe(false);

      for (let i = 0; i < 1_000; i += 1) limiter.hit(`forged-${i}`, T0 + 2);
      expect(tracked(limiter)).toHaveLength(3);
      expect(limiter.hit("a", T0 + 3).allowed).toBe(true);
    });

    it("a key hit again (even refused) counts as recent and stays", () => {
      const limiter = new SlidingWindowRateLimiter(1, MS_PER_MINUTE, 2);
      limiter.hit("a", T0);
      limiter.hit("b", T0 + 1);
      expect(limiter.hit("a", T0 + 2).allowed).toBe(false);
      limiter.hit("c", T0 + 3);

      expect(tracked(limiter)).toEqual(["a", "c"]);
      expect(limiter.hit("a", T0 + 4).allowed).toBe(false);
    });
  });
});

describe("clientKeyOf", () => {
  /** The proxy in front of the hub: on the same host or a private network. */
  const PROXY_ADDRESS = "10.0.0.9";
  const req = (forwardedFor: string | string[] | undefined, socket: { remoteAddress?: string } = { remoteAddress: PROXY_ADDRESS }): ClientRequest => ({
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
    socket,
  });

  it("uses the socket address when the proxy is not trusted, whatever the header says", () => {
    expect(clientKeyOf(req("203.0.113.5"), false)).toBe(PROXY_ADDRESS);
    expect(clientKeyOf(req(undefined), false)).toBe(PROXY_ADDRESS);
  });

  it("uses the last X-Forwarded-For entry behind a trusted proxy", () => {
    expect(clientKeyOf(req("203.0.113.5"), true)).toBe("203.0.113.5");
    expect(clientKeyOf(req("10.0.0.1, 10.0.0.2,203.0.113.5"), true)).toBe("203.0.113.5");
  });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.1.2.3", "172.16.0.5", "172.31.255.254", "192.168.1.20", "::ffff:192.168.1.20", "fd12:3456::1"])(
    "trusts the header from a proxy at the loopback or private address %s",
    (proxy) => {
      expect(clientKeyOf(req("203.0.113.5", { remoteAddress: proxy }), true)).toBe("203.0.113.5");
    },
  );

  it.each(["192.0.2.1", "8.8.8.8", "::ffff:8.8.8.8", "172.32.0.1", "2001:db8::1"])(
    "ignores the header from %s, a client on the internet that reached the hub directly, even with trustProxy",
    (client) => {
      expect(clientKeyOf(req("203.0.113.5", { remoteAddress: client }), true)).toBe(client);
      expect(clientKeyOf(req(`${client}, 198.51.100.7`, { remoteAddress: client }), true)).toBe(client);
    },
  );

  it("trims spaces and ignores empty entries", () => {
    expect(clientKeyOf(req("  203.0.113.5  "), true)).toBe("203.0.113.5");
    expect(clientKeyOf(req("203.0.113.5, "), true)).toBe("203.0.113.5");
  });

  it("joins repeated headers and takes the last entry overall", () => {
    expect(clientKeyOf(req(["10.0.0.1", "10.0.0.2, 203.0.113.9"]), true)).toBe("203.0.113.9");
  });

  it("falls back to the socket address when the header is missing or empty behind a trusted proxy", () => {
    expect(clientKeyOf(req(undefined), true)).toBe(PROXY_ADDRESS);
    expect(clientKeyOf(req(""), true)).toBe(PROXY_ADDRESS);
    expect(clientKeyOf(req(" , ,"), true)).toBe(PROXY_ADDRESS);
  });

  it("uses one shared key when no address is known", () => {
    expect(clientKeyOf(req(undefined, {}), false)).toBe(UNKNOWN_CLIENT_KEY);
    expect(clientKeyOf(req("", {}), true)).toBe(UNKNOWN_CLIENT_KEY);
    expect(clientKeyOf(req("203.0.113.5", {}), false)).toBe(UNKNOWN_CLIENT_KEY);
  });
});

/** An ExecutionContext with just the HTTP request the guards read. */
const httpContext = (request: ClientRequest): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }) }) as unknown as ExecutionContext;

const fromAddress = (remoteAddress: string, forwardedFor?: string): ExecutionContext =>
  httpContext({ headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {}, socket: { remoteAddress } });

const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
};

describe("RateLimitGuard", () => {
  it("allows server.rateLimitPerMinute requests per client per minute, then throws RateLimitedError", () => {
    const clock = new FakeClock(T0);
    const guard = new RateLimitGuard(testConfig({ server: { rateLimitPerMinute: 2 } }), clock);
    expect(guard.canActivate(fromAddress("192.0.2.1"))).toBe(true);
    expect(guard.canActivate(fromAddress("192.0.2.1"))).toBe(true);
    const error = thrownBy(() => guard.canActivate(fromAddress("192.0.2.1")));
    expect(error).toBeInstanceOf(RateLimitedError);
    const limited = error as RateLimitedError;
    expect(limited.status).toBe(429);
    expect(limited.code).toBe(API_ERROR_CODE.RATE_LIMITED);
    expect(limited.message).toBe(HTTP_ERROR_MESSAGE.RATE_LIMITED);
    expect(limited.retryAfterSeconds).toBe(RATE_LIMIT_WINDOW_MS / MS_PER_SECOND);
  });

  it("reads time from the injected clock", () => {
    const clock = new FakeClock(T0);
    const guard = new RateLimitGuard(testConfig({ server: { rateLimitPerMinute: 1 } }), clock);
    guard.canActivate(fromAddress("192.0.2.1"));
    clock.advance(RATE_LIMIT_WINDOW_MS);
    expect(guard.canActivate(fromAddress("192.0.2.1"))).toBe(true);
  });

  it("Retry-After seconds are rounded up, never 0", () => {
    const clock = new FakeClock(T0);
    const guard = new RateLimitGuard(testConfig({ server: { rateLimitPerMinute: 1 } }), clock);
    guard.canActivate(fromAddress("192.0.2.1"));
    clock.advance(RATE_LIMIT_WINDOW_MS - 1);
    expect((thrownBy(() => guard.canActivate(fromAddress("192.0.2.1"))) as RateLimitedError).retryAfterSeconds).toBe(1);
  });

  it("tracks at most server.rateLimitMaxClients clients: the one idle the longest is forgotten", () => {
    const clock = new FakeClock(T0);
    const guard = new RateLimitGuard(testConfig({ server: { rateLimitPerMinute: 1, rateLimitMaxClients: 2 } }), clock);
    expect(guard.canActivate(fromAddress("192.0.2.1"))).toBe(true);
    expect(() => guard.canActivate(fromAddress("192.0.2.1"))).toThrow(RateLimitedError);
    guard.canActivate(fromAddress("192.0.2.2"));
    guard.canActivate(fromAddress("192.0.2.3"));
    expect(guard.canActivate(fromAddress("192.0.2.1"))).toBe(true);
  });

  it("follows server.trustProxy for the client key", () => {
    const clock = new FakeClock(T0);
    const trusted = new RateLimitGuard(testConfig({ server: { rateLimitPerMinute: 1, trustProxy: true } }), clock);
    expect(trusted.canActivate(fromAddress("10.0.0.1", "203.0.113.1"))).toBe(true);
    expect(trusted.canActivate(fromAddress("10.0.0.1", "203.0.113.2"))).toBe(true);

    const untrusted = new RateLimitGuard(testConfig({ server: { rateLimitPerMinute: 1, trustProxy: false } }), clock);
    expect(untrusted.canActivate(fromAddress("10.0.0.1", "203.0.113.1"))).toBe(true);
    expect(() => untrusted.canActivate(fromAddress("10.0.0.1", "203.0.113.2"))).toThrow(RateLimitedError);
  });
});

describe("DemoRateLimitGuard", () => {
  it("allows demo.maxActionsPerHour actions per client per hour with its own message", () => {
    const clock = new FakeClock(T0);
    const guard = new DemoRateLimitGuard(testConfig({ demo: { maxActionsPerHour: 2 }, server: { rateLimitPerMinute: 1 } }), clock);
    expect(guard.canActivate(fromAddress("192.0.2.1"))).toBe(true);
    expect(guard.canActivate(fromAddress("192.0.2.1"))).toBe(true);
    const limited = thrownBy(() => guard.canActivate(fromAddress("192.0.2.1"))) as RateLimitedError;
    expect(limited).toBeInstanceOf(RateLimitedError);
    expect(limited.message).toBe(HTTP_ERROR_MESSAGE.DEMO_RATE_LIMITED);
    expect(limited.retryAfterSeconds).toBe(DEMO_RATE_LIMIT_WINDOW_MS / MS_PER_SECOND);
    expect(guard.canActivate(fromAddress("192.0.2.2"))).toBe(true);
  });

  it("caps demo.maxTotalActionsPerHour for every client together, with its own message", () => {
    const clock = new FakeClock(T0);
    const guard = new DemoRateLimitGuard(testConfig({ demo: { maxActionsPerHour: 2, maxTotalActionsPerHour: 3 } }), clock);
    expect(guard.canActivate(fromAddress("192.0.2.1"))).toBe(true);
    expect(guard.canActivate(fromAddress("192.0.2.2"))).toBe(true);
    expect(guard.canActivate(fromAddress("192.0.2.3"))).toBe(true);

    const limited = thrownBy(() => guard.canActivate(fromAddress("192.0.2.4"))) as RateLimitedError;
    expect(limited).toBeInstanceOf(RateLimitedError);
    expect(limited.message).toBe(HTTP_ERROR_MESSAGE.DEMO_TOTAL_RATE_LIMITED);
    expect(limited.retryAfterSeconds).toBe(DEMO_RATE_LIMIT_WINDOW_MS / MS_PER_SECOND);

    clock.advance(DEMO_RATE_LIMIT_WINDOW_MS);
    expect(guard.canActivate(fromAddress("192.0.2.4"))).toBe(true);
  });

  it("holds the total however many client keys forged X-Forwarded-For headers make up", () => {
    const clock = new FakeClock(T0);
    const guard = new DemoRateLimitGuard(testConfig({ server: { trustProxy: true }, demo: { maxActionsPerHour: 1, maxTotalActionsPerHour: 5 } }), clock);
    const allowed = Array.from({ length: 8 }, (_, i) => {
      try {
        return guard.canActivate(fromAddress("127.0.0.1", `198.51.100.${i}`));
      } catch {
        return false;
      }
    });
    expect(allowed).toEqual([true, true, true, true, true, false, false, false]);
  });

  it("a request the total refuses uses none of its client's own budget", () => {
    const clock = new FakeClock(T0);
    const guard = new DemoRateLimitGuard(testConfig({ demo: { maxActionsPerHour: 1, maxTotalActionsPerHour: 1 } }), clock);
    expect(guard.canActivate(fromAddress("192.0.2.1"))).toBe(true);
    expect(() => guard.canActivate(fromAddress("192.0.2.2"))).toThrow(HTTP_ERROR_MESSAGE.DEMO_TOTAL_RATE_LIMITED);

    // Once the total frees up, 192.0.2.2 still has its whole budget.
    clock.advance(DEMO_RATE_LIMIT_WINDOW_MS);
    expect(guard.canActivate(fromAddress("192.0.2.1"))).toBe(true);
    clock.advance(DEMO_RATE_LIMIT_WINDOW_MS);
    expect(guard.canActivate(fromAddress("192.0.2.2"))).toBe(true);
  });

  it("its window is an hour", () => {
    expect(DEMO_RATE_LIMIT_WINDOW_MS).toBe(MS_PER_HOUR);
    const clock = new FakeClock(T0);
    const guard = new DemoRateLimitGuard(testConfig({ demo: { maxActionsPerHour: 1 } }), clock);
    guard.canActivate(fromAddress("192.0.2.1"));
    clock.advance(MS_PER_HOUR - 1);
    expect(() => guard.canActivate(fromAddress("192.0.2.1"))).toThrow(RateLimitedError);
    clock.advance(1);
    expect(guard.canActivate(fromAddress("192.0.2.1"))).toBe(true);
  });
});

describe("DemoEnabledGuard", () => {
  it("lets requests through when the demo wallet is enabled", () => {
    const wallet = new StubDemoWallet();
    expect(new DemoEnabledGuard(wallet).canActivate()).toBe(true);
  });

  it("throws DemoDisabledError (404 demo_disabled) when it is not", () => {
    const wallet = new StubDemoWallet();
    wallet.enabled = false;
    const error = thrownBy(() => new DemoEnabledGuard(wallet).canActivate()) as DemoDisabledError;
    expect(error).toBeInstanceOf(DemoDisabledError);
    expect(error.status).toBe(404);
    expect(error.code).toBe(API_ERROR_CODE.DEMO_DISABLED);
  });
});
