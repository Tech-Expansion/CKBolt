import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { expect, test } from "@playwright/test";
import { demoFiberInvoice } from "../../lib/payment-request";
import type { RateSnapshot } from "../../lib/quote";
import { PAY_TOKENS } from "../../lib/tokens";
import { assetPhrase, assetsServing, FIBER_ASSETS_FALLBACK, toLiveAssets, tokenForAsset } from "../../lib/hub/assets";
import { HubApiError, HubClient, parseHubError, toHubApiError } from "../../lib/hub/client";
import { isLoopbackUrl, parseHubUrl, positiveInt, readHubProxyConfig, secretProblems, type HubProxyConfig } from "../../lib/hub/config";
import {
  HUB_CLIENT_TIMING,
  HUB_CONFIG_PROBLEM,
  HUB_ENV,
  HUB_MESSAGE,
  HUB_PROXY_BASE_PATH,
  HUB_PROXY_DEFAULTS,
  HUB_PROXY_LOG_PREFIX,
  isFiberAssetId,
} from "../../lib/hub/constants";
import {
  API_ERROR_CODE,
  API_ROUTES,
  API_VERSION,
  CKB_ASSET_ID,
  FIBER_ASSET_ID_PATTERN,
  HUB_PROXY_ERROR_CODE,
  HUB_PROXY_HEADER,
  LIGHTNING_ASSET_ID,
  QUOTE_PURPOSE,
  SWAP_CANCEL_TOKEN_HEADER,
  SWAP_EVENT,
  TERMINAL_SWAP_STATES,
  type AssetDto,
  type HealthDto,
  type LightningInboundChannelDto,
  type LightningNodeDto,
  type QuoteDto,
  type SwapDto,
  type SwapEventDto,
  type SwapState,
} from "../../lib/hub/contract";
import { feePercent, formatLeg, formatUnits, lightningNetworkLabel, secondsUntil, toBaseUnits } from "../../lib/hub/format";
import { accumulateProgress, isSwapFinal, NO_PROGRESS, type SwapProgress } from "../../lib/hub/lifecycle";
import {
  clientKey,
  createHubProxy,
  errorResponse,
  forwardedHeaders,
  HubProxy,
  proxiedLocation,
  readBodyWithin,
  requestClient,
  type HubProxyDeps,
} from "../../lib/hub/proxy";
import { FixedWindowRateLimiter, type RateLimitPolicy } from "../../lib/hub/rate-limit";
import { forgedRequestReason, isWriteMethod, mediaTypeOf } from "../../lib/hub/request-guard";
import { HUB_ROUTES, hubResourcePath, matchHubRoute } from "../../lib/hub/routes";
import { readHubStatus } from "../../lib/hub/status";

/* --------------------------------------------------------------------------------------------- fixtures */

const ID = "3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";
const OTHER_ID = "0d9e8f7a-6b5c-4d3e-9f2a-1b0c9d8e7f6a";
const HUB = "http://hub.test:8787";
const NOW = Date.parse("2026-10-23T10:00:00.000Z");
const RATE: RateSnapshot = { btcUsd: 80_000, ethUsd: 2_500, ckbUsd: 0.002, source: "fixture", updatedAt: 0 };

const asset = (overrides: Partial<AssetDto> = {}): AssetDto => ({
  id: "CKB",
  symbol: "CKB",
  name: "Nervos CKB",
  displayName: null,
  iconUrl: null,
  decimals: 8,
  directions: ["ln_to_fiber", "fiber_to_ln"],
  minSats: "1000",
  maxSats: "100000",
  liquidity: { lightningSats: "5000000", fiberAmount: "100000000000000" },
  ...overrides,
});

const HEALTH: HealthDto = {
  status: "ok",
  version: "0.1.0",
  lightning: { reachable: true, network: "signet", synced: true, blockHeight: 2_100_000 },
  fiber: { reachable: true, network: "testnet", version: "0.9.1" },
  demo: { enabled: true },
  swaps: { paused: false },
};

const QUOTE: QuoteDto = {
  id: ID,
  direction: "fiber_to_ln",
  asset: "CKB",
  pay: { network: "fiber", asset: "CKB", amount: "800000000000", decimals: 8 },
  receive: { network: "lightning", asset: "BTC", amount: "19800", decimals: 8 },
  prices: { btcUsd: 80_000, assetUsd: 0.002, source: "median", at: "2026-10-23T10:00:00.000Z" },
  feeBps: 100,
  purpose: "swap",
  createdAt: "2026-10-23T10:00:00.000Z",
  expiresAt: "2026-10-23T10:02:30.000Z",
  signature: "3045022100aa",
  hubPubkey: "02" + "ab".repeat(32),
};

const swap = (state: SwapState, overrides: Partial<SwapDto> = {}): SwapDto => ({
  id: ID,
  quoteId: OTHER_ID,
  direction: "fiber_to_ln",
  asset: "CKB",
  state,
  paymentHash: "aa".repeat(32),
  pay: { ...QUOTE.pay, invoice: "fibt800000000000..." },
  receive: { ...QUOTE.receive, invoice: "lntbs198u1..." },
  refunded: false,
  failureReason: null,
  preimage: null,
  demo: false,
  quoteExpiresAt: QUOTE.expiresAt,
  createdAt: QUOTE.createdAt,
  updatedAt: QUOTE.createdAt,
  links: { self: `/v1/swaps/${ID}`, events: `/v1/swaps/${ID}/events` },
  ...overrides,
});

const event = (type: string): SwapEventDto => ({ at: "2026-10-23T10:00:05.000Z", type, detail: type });

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type Call = { url: string; init: RequestInit };

/** A fetch that records every call and answers with `respond`. */
function recordingFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetch, calls };
}

const POLICY: RateLimitPolicy = { windowMs: 60_000, maxPerClient: 3, maxGlobal: 100, maxTrackedClients: 1_000 };

const proxyConfig = (overrides: Partial<HubProxyConfig> = {}): HubProxyConfig => ({
  hubUrl: HUB,
  timeoutMs: 2_000,
  maxBodyBytes: 64,
  trustProxy: false,
  rateLimit: POLICY,
  proxySecret: null,
  problems: [],
  ...overrides,
});

/** A Lightning wallet's node key, as NWC get_info reports it. */
const PUBKEY = "02" + "cd".repeat(32);
/** A swap's cancel token as the hub draws it: 32 random bytes in hex. */
const CANCEL_TOKEN = "7e".repeat(32);
/** At least 32 characters, as the hub requires of HUB_PROXY_SECRET. */
const SECRET = "s3cr3t-".repeat(6);

const ALLOW_ALL: HubProxyDeps["rateLimiter"] = { take: () => ({ allowed: true, retryAfterMs: 0 }) };

const PROXY_ORIGIN = "http://localhost:3100";
/** A request exactly as given: no header is added. */
const rawProxyRequest = (pathAndQuery: string, init: RequestInit = {}) => new Request(`${PROXY_ORIGIN}/api/hub/${pathAndQuery}`, init);
/** A request as the app's client sends it: a body goes as JSON (lib/hub/client.ts). */
const proxyRequest = (pathAndQuery: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  return rawProxyRequest(pathAndQuery, { ...init, headers });
};
const segmentsOf = (p: string) => p.split("/");

/* ----------------------------------------------------------------------------------------------- routes */

test.describe("hub routes", () => {
  test("the allow-list is exactly the thirteen v1 paths the app calls, each with its own methods", () => {
    const table = HUB_ROUTES.map((r) => `${r.methods.join(",")} /${r.pattern.join("/")}`);
    expect(table).toEqual([
      "GET /v1/health",
      "GET /v1/assets",
      "POST /v1/quotes",
      "POST /v1/swaps",
      "GET /v1/swaps/:id",
      "GET /v1/swaps/:id/events",
      "POST /v1/swaps/:id/cancel",
      "GET /v1/fiber/node",
      "POST /v1/fiber/inbound-channels",
      "GET /v1/fiber/inbound-channels/:nodeId",
      "GET /v1/lightning/node",
      "POST /v1/lightning/inbound-channels",
      "GET /v1/lightning/inbound-channels/:pubkey",
    ]);
  });

  test("matches every path the app calls, with UUID ids in any case and Lightning pubkeys without 0x", () => {
    for (const p of ["v1/health", "v1/assets", "v1/quotes", "v1/swaps", "v1/fiber/node", "v1/lightning/node", "v1/lightning/inbound-channels"]) {
      expect(matchHubRoute(segmentsOf(p)), p).not.toBeNull();
    }
    expect(matchHubRoute(["v1", "swaps", ID.toUpperCase()])?.methods).toEqual(["GET"]);
    expect(matchHubRoute(["v1", "swaps", ID, "events"])?.methods).toEqual(["GET"]);
    expect(matchHubRoute(["v1", "swaps", ID, "cancel"])).toMatchObject({ methods: ["POST"], forwardedHeaders: [SWAP_CANCEL_TOKEN_HEADER] });
    // Only the cancel route passes a browser header on; every other route forwards none.
    expect(HUB_ROUTES.filter((r) => r.forwardedHeaders?.length).map((r) => r.pattern.join("/"))).toEqual(["v1/swaps/:id/cancel"]);
    expect(matchHubRoute(["v1", "lightning", "inbound-channels"])?.methods).toEqual(["POST"]);
    for (const key of [PUBKEY, PUBKEY.toUpperCase(), "03" + "ef".repeat(32)]) {
      expect(matchHubRoute(["v1", "lightning", "inbound-channels", key])?.methods, key).toEqual(["GET"]);
    }
  });

  test("the hub's demo wallet and every path the app does not call are not in the list", () => {
    for (const p of ["v1/demo/invoices", "v1/demo/payments", `v1/quotes/${ID}`, "v1/demo"]) expect(matchHubRoute(segmentsOf(p)), p).toBeNull();
    // They stay in the contract copy, which mirrors the hub's own.
    expect(Object.values(API_ROUTES)).toEqual(expect.arrayContaining(["demo/invoices", "demo/payments"]));
  });

  test("refuses anything else, so no segment can climb out of the API", () => {
    const refused = [
      [],
      [""],
      ["v1"],
      ["v2", "health"],
      ["V1", "health"],
      ["health"],
      ["v1", "health", "extra"],
      ["v1", "swaps", "not-a-uuid"],
      ["v1", "swaps", ".."],
      ["v1", "swaps", "..", "..", "admin"],
      ["v1", "swaps", `${ID}x`],
      ["v1", "swaps", ID, "events", "more"],
      ["v1", "swaps", ID, "cancel", "more"],
      ["v1", "swaps", "not-a-uuid", "cancel"],
      ["v1", "swaps", "cancel"],
      ["v1", "quotes", ID, "cancel"],
      ["v1", "swaps", ID, ".."],
      ["v1", "quotes", ID, "events"],
      ["v1", "demo"],
      ["v1", "demo", "wallets"],
      ["v1", "swaps", "%2e%2e"],
      ["v1", "lightning"],
      ["v1", "lightning", "inbound-channels", `0x${PUBKEY}`],
      ["v1", "lightning", "inbound-channels", PUBKEY.slice(2)],
      ["v1", "lightning", "inbound-channels", "04" + PUBKEY.slice(2)],
      ["v1", "lightning", "inbound-channels", PUBKEY, "x"],
      ["v1", "lightning", "inbound-channels", ".."],
    ];
    for (const segments of refused) expect(matchHubRoute(segments), segments.join("/")).toBeNull();
  });

  test("builds resource paths from API_ROUTES and encodes the id as one segment", () => {
    expect(hubResourcePath(API_ROUTES.HEALTH)).toBe("/v1/health");
    expect(hubResourcePath(API_ROUTES.LIGHTNING_INBOUND_CHANNELS, PUBKEY)).toBe(`/v1/lightning/inbound-channels/${PUBKEY}`);
    expect(hubResourcePath(API_ROUTES.SWAPS, ID, API_ROUTES.SWAP_EVENTS)).toBe(`/v1/swaps/${ID}/events`);
    expect(hubResourcePath(API_ROUTES.SWAPS, ID, API_ROUTES.SWAP_CANCEL)).toBe(`/v1/swaps/${ID}/cancel`);
    expect(hubResourcePath(API_ROUTES.SWAPS, "../admin")).toBe("/v1/swaps/..%2Fadmin");
  });
});

/* ----------------------------------------------------------------------------------------------- config */

test.describe("hub proxy config", () => {
  test("HUB_URL must be an http(s) URL; the trailing slash is dropped", () => {
    expect(parseHubUrl(undefined)).toBeNull();
    expect(parseHubUrl("")).toBeNull();
    expect(parseHubUrl("   ")).toBeNull();
    expect(parseHubUrl("not a url")).toBeNull();
    expect(parseHubUrl("ftp://hub.test")).toBeNull();
    expect(parseHubUrl("file:///etc/passwd")).toBeNull();
    expect(parseHubUrl("javascript:alert(1)")).toBeNull();
    expect(parseHubUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(parseHubUrl(" http://127.0.0.1:8787/ ")).toBe("http://127.0.0.1:8787");
    expect(parseHubUrl("https://hub.example/base///")).toBe("https://hub.example/base");
  });

  test("numbers from the environment fall back unless they are positive whole numbers", () => {
    for (const raw of [undefined, "", " ", "0", "-5", "1.5", "abc", "1e400", "NaN"]) expect(positiveInt(raw, 7), String(raw)).toBe(7);
    expect(positiveInt(" 42 ", 7)).toBe(42);
    expect(positiveInt("10000", 7)).toBe(10_000);
  });

  test("defaults without any environment: live swaps off, shared budget", () => {
    const config = readHubProxyConfig({});
    expect(config.hubUrl).toBeNull();
    expect(config.trustProxy).toBe(false);
    expect(config.timeoutMs).toBe(HUB_PROXY_DEFAULTS.timeoutMs);
    expect(config.maxBodyBytes).toBe(HUB_PROXY_DEFAULTS.maxBodyBytes);
    expect(config.rateLimit).toEqual({
      windowMs: HUB_PROXY_DEFAULTS.rateWindowMs,
      maxPerClient: HUB_PROXY_DEFAULTS.sharedPerWindow,
      maxGlobal: HUB_PROXY_DEFAULTS.globalPerWindow,
      maxTrackedClients: HUB_PROXY_DEFAULTS.maxTrackedClients,
    });
  });

  test("reads every tunable from its env var; TRUST_PROXY=1 switches to a per-client budget", () => {
    const config = readHubProxyConfig({
      [HUB_ENV.HUB_URL]: "http://hub.local:8787/",
      [HUB_ENV.TIMEOUT_MS]: "2500",
      [HUB_ENV.MAX_BODY_BYTES]: "4096",
      [HUB_ENV.RATE_LIMIT_PER_MINUTE]: "30",
      [HUB_ENV.SHARED_RATE_LIMIT_PER_MINUTE]: "300",
      [HUB_ENV.GLOBAL_RATE_LIMIT_PER_MINUTE]: "900",
      [HUB_ENV.TRUST_PROXY]: "1",
    });
    expect(config).toMatchObject({ hubUrl: "http://hub.local:8787", timeoutMs: 2500, maxBodyBytes: 4096, trustProxy: true });
    expect(config.rateLimit).toMatchObject({ maxPerClient: 30, maxGlobal: 900 });
    // Any other TRUST_PROXY value is not trusted.
    expect(readHubProxyConfig({ [HUB_ENV.TRUST_PROXY]: "true", [HUB_ENV.SHARED_RATE_LIMIT_PER_MINUTE]: "300" })).toMatchObject({
      trustProxy: false,
      rateLimit: { maxPerClient: 300 },
    });
  });

  test("HUB_PROXY_SECRET is read trimmed, and unset or blank means no secret", () => {
    expect(readHubProxyConfig({}).proxySecret).toBeNull();
    expect(readHubProxyConfig({ [HUB_ENV.PROXY_SECRET]: "   " }).proxySecret).toBeNull();
    expect(readHubProxyConfig({ [HUB_ENV.PROXY_SECRET]: ` ${SECRET} ` }).proxySecret).toBe(SECRET);
    // Server only: a NEXT_PUBLIC_ name would put it in the browser bundle.
    expect(HUB_ENV.PROXY_SECRET).toBe("HUB_PROXY_SECRET");
  });

  test("HUB_PROXY_SECRET needs an https HUB_URL and TRUST_PROXY=1; a loopback hub needs neither", () => {
    const env = (hubUrl: string, trustProxy: boolean, secret: string | null = SECRET) =>
      readHubProxyConfig({
        [HUB_ENV.HUB_URL]: hubUrl,
        ...(trustProxy ? { [HUB_ENV.TRUST_PROXY]: "1" } : {}),
        ...(secret ? { [HUB_ENV.PROXY_SECRET]: secret } : {}),
      }).problems;
    // The Vercel setup: https and TRUST_PROXY=1.
    expect(env("https://hub-api.example.org", true)).toEqual([]);
    // The secret in clear text over the network.
    expect(env("http://hub-api.example.org", true)).toEqual([HUB_CONFIG_PROBLEM.SECRET_OVER_HTTP]);
    // Every visitor under one client key.
    expect(env("https://hub-api.example.org", false)).toEqual([HUB_CONFIG_PROBLEM.SECRET_WITHOUT_TRUST_PROXY]);
    // Only "1" turns TRUST_PROXY on.
    expect(readHubProxyConfig({ [HUB_ENV.HUB_URL]: "https://hub.example", [HUB_ENV.PROXY_SECRET]: SECRET, [HUB_ENV.TRUST_PROXY]: "true" }).problems).toEqual([
      HUB_CONFIG_PROBLEM.SECRET_WITHOUT_TRUST_PROXY,
    ]);
    // Both at once are both reported, so one deploy fixes them.
    expect(env("http://10.0.0.5:8787", false)).toEqual([HUB_CONFIG_PROBLEM.SECRET_OVER_HTTP, HUB_CONFIG_PROBLEM.SECRET_WITHOUT_TRUST_PROXY]);
    // A hub on this machine (the SSH tunnel to the testnet hub, the local devnet): plain http and no TRUST_PROXY are fine.
    for (const local of ["http://127.0.0.1:18787", "http://localhost:8787", "http://LOCALHOST:8787/", "http://[::1]:8787"]) {
      expect(env(local, false), local).toEqual([]);
      expect(isLoopbackUrl(parseHubUrl(local)!), local).toBe(true);
    }
    // Names that only start like a loopback host are not one.
    for (const remote of ["http://127.0.0.1.nip.io:8787", "http://localhost.example.org", "http://[::2]:8787", "http://0.0.0.0:8787"]) {
      expect(isLoopbackUrl(remote), remote).toBe(false);
      expect(env(remote, true), remote).toEqual([HUB_CONFIG_PROBLEM.SECRET_OVER_HTTP]);
    }
    // Without a secret nothing is at stake, and without HUB_URL nothing is forwarded.
    expect(env("http://hub-api.example.org", false, null)).toEqual([]);
    expect(readHubProxyConfig({ [HUB_ENV.PROXY_SECRET]: SECRET }).problems).toEqual([]);
    expect(secretProblems(null, SECRET, false)).toEqual([]);
    expect(readHubProxyConfig({}).problems).toEqual([]);
  });

  test("each refusal names the setting to change", () => {
    expect(HUB_CONFIG_PROBLEM.SECRET_OVER_HTTP).toContain("HUB_PROXY_SECRET");
    expect(HUB_CONFIG_PROBLEM.SECRET_OVER_HTTP).toMatch(/https HUB_URL/);
    expect(HUB_CONFIG_PROBLEM.SECRET_OVER_HTTP).toContain("127.0.0.1");
    expect(HUB_CONFIG_PROBLEM.SECRET_WITHOUT_TRUST_PROXY).toContain("HUB_PROXY_SECRET");
    expect(HUB_CONFIG_PROBLEM.SECRET_WITHOUT_TRUST_PROXY).toContain("Set TRUST_PROXY=1");
    for (const line of Object.values(HUB_CONFIG_PROBLEM)) expect(line).not.toContain(SECRET);
  });

  test("the body limit fits the largest contract request (a 4,096-character invoice)", () => {
    const body = JSON.stringify({ quoteId: ID, payoutInvoice: "x".repeat(4_096), demo: true });
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(HUB_PROXY_DEFAULTS.maxBodyBytes);
  });

  test("a swap polled every 2 s fits the per-client budget", () => {
    expect(HUB_CLIENT_TIMING.swapPollMs).toBe(2_000);
    const pollsPerWindow = HUB_PROXY_DEFAULTS.rateWindowMs / HUB_CLIENT_TIMING.swapPollMs;
    // Each poll can also read the events once.
    expect(pollsPerWindow * 2).toBeLessThanOrEqual(HUB_PROXY_DEFAULTS.perClientPerWindow);
  });
});

/* ------------------------------------------------------------------------------------------- rate limit */

test.describe("fixed-window rate limiter", () => {
  test("allows the budget per client, then refuses until the window resets", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(POLICY, () => now);
    for (let i = 0; i < 3; i++) expect(limiter.take("a")).toEqual({ allowed: true, retryAfterMs: 0 });
    now += 15_000;
    expect(limiter.take("a")).toEqual({ allowed: false, retryAfterMs: 45_000 });
    // Another client has its own budget.
    expect(limiter.take("b").allowed).toBe(true);
    now += 45_000;
    expect(limiter.take("a").allowed).toBe(true);
  });

  test("refused requests do not use up budget", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({ ...POLICY, maxPerClient: 1 }, () => now);
    expect(limiter.take("a").allowed).toBe(true);
    for (let i = 0; i < 10; i++) expect(limiter.take("a").allowed).toBe(false);
    now = 60_000;
    expect(limiter.take("a").allowed).toBe(true);
  });

  test("a server-wide cap holds however many client keys are used", () => {
    const now = 0;
    const limiter = new FixedWindowRateLimiter({ ...POLICY, maxGlobal: 5 }, () => now);
    const decisions = Array.from({ length: 8 }, (_, i) => limiter.take(`forged-${i}`).allowed);
    expect(decisions).toEqual([true, true, true, true, true, false, false, false]);
  });

  test("tracks a bounded number of clients and forgets expired windows", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({ ...POLICY, maxPerClient: 1, maxGlobal: 10_000, maxTrackedClients: 3 }, () => now);
    for (const c of ["a", "b", "c"]) expect(limiter.take(c).allowed).toBe(true);
    now = 60_000;
    // The sweep runs here and drops the expired windows; budgets start again.
    for (const c of ["d", "a", "b"]) expect(limiter.take(c).allowed).toBe(true);
    expect(limiter.take("a").allowed).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------------ proxy */

test.describe("hub proxy", () => {
  test("an unknown path is a 404 in the API's error shape, without calling the hub", async () => {
    const { fetch, calls } = recordingFetch(() => json({}));
    const proxy = new HubProxy(proxyConfig(), { fetch, rateLimiter: ALLOW_ALL });
    for (const p of ["v1/admin", "v2/health", "v1/swaps/123", "v1/swaps/..", ""]) {
      const res = await proxy.handle(proxyRequest(p), segmentsOf(p));
      expect(res.status, p).toBe(404);
      expect(await res.json()).toEqual({ error: { code: API_ERROR_CODE.NOT_FOUND, message: HUB_MESSAGE.UNKNOWN_PATH } });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(calls).toHaveLength(0);
  });

  test("a method the path does not take is a 405 with an Allow header", async () => {
    const { fetch, calls } = recordingFetch(() => json({}));
    const proxy = new HubProxy(proxyConfig(), { fetch, rateLimiter: ALLOW_ALL });
    const cases: [string, string, string][] = [
      ["POST", "v1/health", "GET"],
      ["GET", "v1/quotes", "POST"],
      ["DELETE", `v1/swaps/${ID}`, "GET"],
      ["GET", `v1/swaps/${ID}/cancel`, "POST"],
      ["DELETE", `v1/swaps/${ID}/cancel`, "POST"],
      ["PUT", "v1/lightning/inbound-channels", "POST"],
      ["PATCH", "v1/lightning/node", "GET"],
      ["DELETE", `v1/lightning/inbound-channels/${PUBKEY}`, "GET"],
    ];
    for (const [method, p, allow] of cases) {
      const res = await proxy.handle(proxyRequest(p, { method }), segmentsOf(p));
      expect(res.status, `${method} ${p}`).toBe(405);
      expect(res.headers.get("allow")).toBe(allow);
      expect((await res.json()).error.code).toBe(HUB_PROXY_ERROR_CODE.METHOD_NOT_ALLOWED);
    }
    expect(calls).toHaveLength(0);
  });

  test("the hub's demo wallet and GET /v1/quotes/:id are a 404 that never reaches the hub, whatever the method", async () => {
    const { fetch, calls } = recordingFetch(() => json({}, 201));
    let takes = 0;
    const proxy = new HubProxy(proxyConfig({ proxySecret: SECRET }), { fetch, rateLimiter: { take: () => (takes++, { allowed: true, retryAfterMs: 0 }) } });
    for (const [method, p] of [
      ["POST", "v1/demo/invoices"],
      ["POST", "v1/demo/payments"],
      ["GET", "v1/demo/payments"],
      ["GET", `v1/quotes/${ID}`],
    ]) {
      const res = await proxy.handle(proxyRequest(p, { method, body: method === "POST" ? "{}" : undefined }), segmentsOf(p));
      expect(res.status, `${method} ${p}`).toBe(404);
      expect(await res.json()).toEqual({ error: { code: API_ERROR_CODE.NOT_FOUND, message: HUB_MESSAGE.UNKNOWN_PATH } });
    }
    expect(calls).toHaveLength(0);
    expect(takes).toBe(0);
  });

  test("without HUB_URL every contract path answers 503 hub_unavailable and nothing is fetched", async () => {
    const { fetch, calls } = recordingFetch(() => json({}));
    let takes = 0;
    const proxy = new HubProxy(proxyConfig({ hubUrl: null }), { fetch, rateLimiter: { take: () => (takes++, { allowed: true, retryAfterMs: 0 }) } });
    const res = await proxy.handle(proxyRequest("v1/health"), ["v1", "health"]);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, message: HUB_MESSAGE.NOT_CONFIGURED } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toHaveLength(0);
    expect(takes).toBe(0);
  });

  test("a rate-limited caller gets 429 with Retry-After in whole seconds, and the hub is not asked", async () => {
    const { fetch, calls } = recordingFetch(() => json(HEALTH));
    const proxy = new HubProxy(proxyConfig(), { fetch, rateLimiter: { take: () => ({ allowed: false, retryAfterMs: 12_001 }) } });
    const res = await proxy.handle(proxyRequest("v1/health"), ["v1", "health"]);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("13");
    expect(await res.json()).toEqual({ error: { code: API_ERROR_CODE.RATE_LIMITED, message: HUB_MESSAGE.RATE_LIMITED } });
    expect(calls).toHaveLength(0);
  });

  test("the real limiter counts requests per client behind a trusted proxy", async () => {
    const { fetch } = recordingFetch(() => json(HEALTH));
    let now = 0;
    const proxy = new HubProxy(proxyConfig({ trustProxy: true }), { fetch, rateLimiter: new FixedWindowRateLimiter(POLICY, () => now) });
    const from = (ip: string) => proxyRequest("v1/health", { headers: { "x-forwarded-for": `6.6.6.6, ${ip}` } });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await proxy.handle(from("10.0.0.1"), ["v1", "health"])).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await proxy.handle(from("10.0.0.2"), ["v1", "health"])).status).toBe(200);
    now = 60_000;
    expect((await proxy.handle(from("10.0.0.1"), ["v1", "health"])).status).toBe(200);
  });

  test("the real limiter counts an IPv6 client by its /64, so new addresses from one network get no new budget", async () => {
    const { fetch } = recordingFetch(() => json(HEALTH));
    const proxy = new HubProxy(proxyConfig({ trustProxy: true }), { fetch, rateLimiter: new FixedWindowRateLimiter(POLICY, () => 0) });
    const from = (ip: string) => proxyRequest("v1/health", { headers: { "x-forwarded-for": ip } });
    const statuses = [];
    for (const host of ["1", "2", "a:b:c", "ffff"]) statuses.push((await proxy.handle(from(`2001:db8:1:2::${host}`), ["v1", "health"])).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await proxy.handle(from("2001:db8:1:3::1"), ["v1", "health"])).status).toBe(200);
    // The IPv4 form of a mapped address is the same client as the IPv4 address.
    for (let i = 0; i < 3; i++) expect((await proxy.handle(from("192.0.2.9"), ["v1", "health"])).status).toBe(200);
    expect((await proxy.handle(from("::ffff:192.0.2.9"), ["v1", "health"])).status).toBe(429);
  });

  test("a body over the limit is refused with 413, by its declared length or while it streams", async () => {
    const { fetch, calls } = recordingFetch(() => json({}, 201));
    const proxy = new HubProxy(proxyConfig({ maxBodyBytes: 64 }), { fetch, rateLimiter: ALLOW_ALL });
    const declared = proxyRequest("v1/quotes", { method: "POST", body: "{}", headers: { "content-length": "100000" } });
    const r1 = await proxy.handle(declared, ["v1", "quotes"]);
    expect(r1.status).toBe(413);
    expect((await r1.json()).error).toEqual({ code: HUB_PROXY_ERROR_CODE.PAYLOAD_TOO_LARGE, message: HUB_MESSAGE.BODY_TOO_LARGE });

    const chunks = [new Uint8Array(40).fill(65), new Uint8Array(40).fill(66), new Uint8Array(40).fill(67)];
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled < chunks.length) controller.enqueue(chunks[pulled++]);
        else controller.close();
      },
    });
    const streamed = proxyRequest("v1/swaps", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    const r2 = await proxy.handle(streamed, ["v1", "swaps"]);
    expect(r2.status).toBe(413);
    // It stopped reading once the limit was passed.
    expect(pulled).toBeLessThan(chunks.length + 1);
    expect(calls).toHaveLength(0);
  });

  test("a body at the limit goes through unchanged", async () => {
    const { fetch, calls } = recordingFetch(() => json({}, 201));
    // Multi-byte characters: the limit counts bytes, not characters.
    const body = JSON.stringify({ swapId: ID, pad: "é€".repeat(4) });
    const bytes = new TextEncoder().encode(body).byteLength;
    expect(bytes).toBeGreaterThan(body.length);
    const proxy = new HubProxy(proxyConfig({ maxBodyBytes: bytes }), { fetch, rateLimiter: ALLOW_ALL });
    const res = await proxy.handle(proxyRequest("v1/swaps", { method: "POST", body }), ["v1", "swaps"]);
    expect(res.status).toBe(201);
    expect(calls[0].init.body).toBe(body);
    // One byte more is refused.
    const over = new HubProxy(proxyConfig({ maxBodyBytes: bytes - 1 }), { fetch, rateLimiter: ALLOW_ALL });
    expect((await over.handle(proxyRequest("v1/swaps", { method: "POST", body }), ["v1", "swaps"])).status).toBe(413);
    expect(calls).toHaveLength(1);
  });

  test("forwards GET to HUB_URL with no body, no cache, no redirects and a timeout", async () => {
    const { fetch, calls } = recordingFetch(() => json(HEALTH));
    const proxy = new HubProxy(proxyConfig(), { fetch, rateLimiter: ALLOW_ALL });
    const res = await proxy.handle(proxyRequest(`v1/swaps/${ID}/events`), ["v1", "swaps", ID, "events"]);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(`${HUB}/v1/swaps/${ID}/events`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({ accept: "application/json" });
  });

  test("forwards POST bodies as JSON text and passes the hub's status and body back", async () => {
    const quoteBody = JSON.stringify({ direction: "fiber_to_ln", asset: "CKB", side: "pay", amount: "800000000000" });
    const { fetch, calls } = recordingFetch(() => json(QUOTE, 201, { location: `/v1/quotes/${ID}` }));
    const proxy = new HubProxy(proxyConfig({ maxBodyBytes: HUB_PROXY_DEFAULTS.maxBodyBytes }), { fetch, rateLimiter: ALLOW_ALL });
    const res = await proxy.handle(proxyRequest("v1/quotes", { method: "POST", body: quoteBody }), ["v1", "quotes"]);
    expect(calls[0].init).toMatchObject({ method: "POST", body: quoteBody, headers: { "content-type": "application/json" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(QUOTE);
    expect(res.headers.get("location")).toBe(`${HUB_PROXY_BASE_PATH}/v1/quotes/${ID}`);
  });

  test("passes the hub's errors through as they are", async () => {
    const body = { error: { code: API_ERROR_CODE.QUOTE_EXPIRED, message: "This quote has expired. Ask for a new one." } };
    const { fetch } = recordingFetch(() => json(body, 422));
    const proxy = new HubProxy(proxyConfig({ maxBodyBytes: HUB_PROXY_DEFAULTS.maxBodyBytes }), { fetch, rateLimiter: ALLOW_ALL });
    const res = await proxy.handle(proxyRequest("v1/swaps", { method: "POST", body: "{}" }), ["v1", "swaps"]);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(body);
  });

  test("passes back only content-type and retry-after, and is never cached", async () => {
    const upstream = new Response("{}", {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "retry-after": "30",
        "set-cookie": "session=hub",
        "x-powered-by": "Express",
        "cache-control": "public, max-age=3600",
        "access-control-allow-origin": "*",
      },
    });
    const { fetch } = recordingFetch(() => upstream);
    const proxy = new HubProxy(proxyConfig(), { fetch, rateLimiter: ALLOW_ALL });
    const res = await proxy.handle(proxyRequest("v1/assets"), ["v1", "assets"]);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("cache-control")).toBe("no-store");
    for (const dropped of ["set-cookie", "x-powered-by", "access-control-allow-origin"]) expect(res.headers.get(dropped), dropped).toBeNull();
  });

  test("forwards the client's address only behind a trusted proxy, and only its last X-Forwarded-For entry", async () => {
    const { fetch, calls } = recordingFetch(() => json(HEALTH));
    const headers = { "x-forwarded-for": "1.2.3.4, 9.9.9.9 " };
    await new HubProxy(proxyConfig({ trustProxy: false }), { fetch, rateLimiter: ALLOW_ALL }).handle(proxyRequest("v1/health", { headers }), ["v1", "health"]);
    expect(calls[0].init.headers).not.toHaveProperty("x-forwarded-for");
    await new HubProxy(proxyConfig({ trustProxy: true }), { fetch, rateLimiter: ALLOW_ALL }).handle(proxyRequest("v1/health", { headers }), ["v1", "health"]);
    expect(calls[1].init.headers).toMatchObject({ "x-forwarded-for": "9.9.9.9" });
  });

  test("with HUB_PROXY_SECRET it sends the secret and its own client key; without it, neither", async () => {
    const { fetch, calls } = recordingFetch(() => json(HEALTH));
    const headers = { "x-forwarded-for": "1.2.3.4, 9.9.9.9", [HUB_PROXY_HEADER.SECRET]: "forged", [HUB_PROXY_HEADER.CLIENT]: "forged" };
    const send = (config: Partial<HubProxyConfig>) =>
      new HubProxy(proxyConfig(config), { fetch, rateLimiter: ALLOW_ALL }).handle(proxyRequest("v1/health", { headers }), ["v1", "health"]);

    // Behind a trusted proxy (TRUST_PROXY=1 on Vercel): the client is the last forwarded entry, as for the rate limit.
    await send({ trustProxy: true, proxySecret: SECRET });
    expect(calls[0].init.headers).toEqual({
      accept: "application/json",
      "x-forwarded-for": "9.9.9.9",
      [HUB_PROXY_HEADER.SECRET]: SECRET,
      [HUB_PROXY_HEADER.CLIENT]: "9.9.9.9",
    });
    // Without a trusted proxy every caller shares one key, and the hub is told so.
    await send({ trustProxy: false, proxySecret: SECRET });
    expect(calls[1].init.headers).toEqual({ accept: "application/json", [HUB_PROXY_HEADER.SECRET]: SECRET, [HUB_PROXY_HEADER.CLIENT]: "shared" });
    // No secret: the browser's own copies of these headers are never passed on.
    await send({ trustProxy: true, proxySecret: null });
    expect(calls[2].init.headers).toEqual({ accept: "application/json", "x-forwarded-for": "9.9.9.9" });
  });

  test("POST /v1/swaps/:id/cancel passes the swap's cancel token on to the hub, with an empty JSON body", async () => {
    const cancelled = swap("failed", { refunded: true, failureReason: "Cancelled by its creator before anyone paid." });
    const { fetch, calls } = recordingFetch(() => json(cancelled));
    const proxy = new HubProxy(proxyConfig({ trustProxy: true, proxySecret: SECRET }), { fetch, rateLimiter: ALLOW_ALL });
    const headers = { [SWAP_CANCEL_TOKEN_HEADER]: CANCEL_TOKEN, "x-forwarded-for": "9.9.9.9" };
    const res = await proxy.handle(proxyRequest(`v1/swaps/${ID}/cancel`, { method: "POST", body: "{}", headers }), ["v1", "swaps", ID, "cancel"]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(cancelled);
    expect(calls[0].url).toBe(`${HUB}/v1/swaps/${ID}/cancel`);
    expect(calls[0].init).toMatchObject({ method: "POST", body: "{}" });
    expect(calls[0].init.headers).toEqual({
      [SWAP_CANCEL_TOKEN_HEADER]: CANCEL_TOKEN,
      accept: "application/json",
      "content-type": "application/json",
      "x-forwarded-for": "9.9.9.9",
      [HUB_PROXY_HEADER.SECRET]: SECRET,
      [HUB_PROXY_HEADER.CLIENT]: "9.9.9.9",
    });
    // The token never comes back in the proxy's answer headers.
    expect([...res.headers.values()].join(" ")).not.toContain(CANCEL_TOKEN);
  });

  test("the cancel token goes nowhere else, and only as one short run of visible characters; the hub's 403 passes back", async () => {
    const { fetch, calls } = recordingFetch((url) => (url.endsWith("/cancel") ? json({ error: { code: API_ERROR_CODE.CANCEL_REFUSED, message: "No token." } }, 403) : json(QUOTE, 201)));
    const proxy = new HubProxy(proxyConfig({ maxBodyBytes: HUB_PROXY_DEFAULTS.maxBodyBytes }), { fetch, rateLimiter: ALLOW_ALL });
    const quoteBody = JSON.stringify({ direction: "fiber_to_ln", asset: "CKB", side: "pay", amount: "800000000000" });
    await proxy.handle(proxyRequest("v1/quotes", { method: "POST", body: quoteBody, headers: { [SWAP_CANCEL_TOKEN_HEADER]: CANCEL_TOKEN } }), ["v1", "quotes"]);
    await proxy.handle(proxyRequest(`v1/swaps/${ID}`, { headers: { [SWAP_CANCEL_TOKEN_HEADER]: CANCEL_TOKEN } }), ["v1", "swaps", ID]);
    for (const call of calls) expect(call.init.headers, call.url).not.toHaveProperty(SWAP_CANCEL_TOKEN_HEADER);

    const cancel = (token: string | null) =>
      proxy.handle(
        proxyRequest(`v1/swaps/${ID}/cancel`, { method: "POST", body: "{}", headers: token === null ? {} : { [SWAP_CANCEL_TOKEN_HEADER]: token } }),
        ["v1", "swaps", ID, "cancel"],
      );
    for (const token of [null, "", "x".repeat(129), "two words", "caf\u00e9"]) {
      const res = await cancel(token);
      expect(res.status, String(token)).toBe(403);
      expect((await res.json()).error.code).toBe(API_ERROR_CODE.CANCEL_REFUSED);
      expect(calls.at(-1)!.init.headers, String(token)).not.toHaveProperty(SWAP_CANCEL_TOKEN_HEADER);
    }
    await cancel(` ${CANCEL_TOKEN} `);
    expect(calls.at(-1)!.init.headers).toMatchObject({ [SWAP_CANCEL_TOKEN_HEADER]: CANCEL_TOKEN });
    expect(forwardedHeaders(new Request("http://x.test", { headers: { [SWAP_CANCEL_TOKEN_HEADER]: CANCEL_TOKEN } }), {})).toEqual({});
  });

  test("an IPv6 client: the hub gets its address as forwarded, and its /64 as the client key", async () => {
    const { fetch, calls } = recordingFetch(() => json(HEALTH));
    const proxy = new HubProxy(proxyConfig({ trustProxy: true, proxySecret: SECRET }), { fetch, rateLimiter: ALLOW_ALL });
    await proxy.handle(proxyRequest("v1/health", { headers: { "x-forwarded-for": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" } }), ["v1", "health"]);
    expect(calls[0].init.headers).toEqual({
      accept: "application/json",
      "x-forwarded-for": "2001:db8:1:2:aaaa:bbbb:cccc:dddd",
      [HUB_PROXY_HEADER.SECRET]: SECRET,
      [HUB_PROXY_HEADER.CLIENT]: "2001:db8:1:2::/64",
    });
    // A forwarded entry that is not an address is not passed on, and counts under one shared key.
    await proxy.handle(proxyRequest("v1/health", { headers: { "x-forwarded-for": "1.2.3.4, my-own-key" } }), ["v1", "health"]);
    expect(calls[1].init.headers).toEqual({ accept: "application/json", [HUB_PROXY_HEADER.SECRET]: SECRET, [HUB_PROXY_HEADER.CLIENT]: "unknown" });
  });

  test("the secret never goes back to the browser: not in headers, not in the proxy's own errors", async () => {
    const echo = new Response(JSON.stringify(HEALTH), {
      status: 200,
      headers: { "content-type": "application/json", [HUB_PROXY_HEADER.SECRET]: SECRET, [HUB_PROXY_HEADER.CLIENT]: "9.9.9.9" },
    });
    const proxy = new HubProxy(proxyConfig({ proxySecret: SECRET }), { fetch: recordingFetch(() => echo).fetch, rateLimiter: ALLOW_ALL });
    const res = await proxy.handle(proxyRequest("v1/health"), ["v1", "health"]);
    expect(res.headers.get(HUB_PROXY_HEADER.SECRET)).toBeNull();
    expect(res.headers.get(HUB_PROXY_HEADER.CLIENT)).toBeNull();
    const down = new HubProxy(proxyConfig({ proxySecret: SECRET }), {
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      rateLimiter: ALLOW_ALL,
    });
    const failed = await down.handle(proxyRequest("v1/health"), ["v1", "health"]);
    expect(await failed.text()).not.toContain(SECRET);
    expect([...failed.headers.values()].join(" ")).not.toContain(SECRET);
  });

  test("client keys: shared without a trusted proxy, the last forwarded entry with one", () => {
    const req = (xff?: string) => proxyRequest("v1/health", { headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
    expect(clientKey(req("1.1.1.1"), false)).toBe("shared");
    expect(clientKey(req("1.1.1.1, 2.2.2.2"), true)).toBe("2.2.2.2");
    expect(clientKey(req(" 3.3.3.3 "), true)).toBe("3.3.3.3");
    expect(clientKey(req(), true)).toBe("local");
    expect(clientKey(req(""), true)).toBe("local");
    // IPv6 by its /64; IPv4-mapped IPv6 as IPv4; an entry that is not an address under one key, never its own text.
    expect(clientKey(req("1.1.1.1, 2001:db8:1:2::7"), true)).toBe("2001:db8:1:2::/64");
    expect(clientKey(req("::ffff:2.2.2.2"), true)).toBe("2.2.2.2");
    expect(clientKey(req("2.2.2.2, attacker-chosen"), true)).toBe("unknown");
    expect(clientKey(req("2001:db8::1"), false)).toBe("shared");
    expect(requestClient(req("2001:db8:1:2::7"), true)).toEqual({ address: "2001:db8:1:2::7", key: "2001:db8:1:2::/64" });
    expect(requestClient(req("not-an-ip"), true)).toEqual({ address: null, key: "unknown" });
    expect(requestClient(req("1.1.1.1"), false)).toEqual({ address: null, key: "shared" });
  });

  test("a hub that does not answer in time is a 504; one that cannot be reached is a 503", async () => {
    const timeout = new HubProxy(proxyConfig(), {
      fetch: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
      rateLimiter: ALLOW_ALL,
    });
    const r1 = await timeout.handle(proxyRequest("v1/health"), ["v1", "health"]);
    expect(r1.status).toBe(504);
    expect(await r1.json()).toEqual({ error: { code: HUB_PROXY_ERROR_CODE.HUB_TIMEOUT, message: HUB_MESSAGE.TIMEOUT } });

    const down = new HubProxy(proxyConfig(), {
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      rateLimiter: ALLOW_ALL,
    });
    const r2 = await down.handle(proxyRequest("v1/health"), ["v1", "health"]);
    expect(r2.status).toBe(503);
    expect(await r2.json()).toEqual({ error: { code: HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, message: HUB_MESSAGE.UNREACHABLE } });
  });

  test("Location headers from the hub point at the proxy", () => {
    expect(proxiedLocation(`/v1/swaps/${ID}`)).toBe(`/api/hub/v1/swaps/${ID}`);
    expect(proxiedLocation("/v1/quotes/x")).toBe("/api/hub/v1/quotes/x");
    // Anything that is not a v1 path is left as the hub sent it.
    expect(proxiedLocation("/v2/swaps/x")).toBe("/v2/swaps/x");
  });

  test("the contract lists the proxy's own codes next to the hub's, and none reuses a hub code", () => {
    const hubCodes: string[] = Object.values(API_ERROR_CODE);
    const proxyCodes: string[] = Object.values(HUB_PROXY_ERROR_CODE);
    expect(proxyCodes.sort()).toEqual(["forbidden", "hub_timeout", "hub_unavailable", "method_not_allowed", "payload_too_large"]);
    for (const code of proxyCodes) expect(hubCodes, code).not.toContain(code);
    expect(hubCodes).toEqual(expect.arrayContaining(["conflict", "asset_unavailable", "unauthorized", "maintenance"]));
  });

  test("the hub's conflict and asset_unavailable errors reach the app with their code and sentence", () => {
    const conflict = { error: { code: API_ERROR_CODE.CONFLICT, message: "This swap is no longer waiting for a payment." } };
    expect(parseHubError(409, conflict)).toMatchObject({ status: 409, code: "conflict", message: conflict.error.message });
    const unavailable = { error: { code: API_ERROR_CODE.ASSET_UNAVAILABLE, message: "RUSD is not available right now." } };
    expect(parseHubError(422, unavailable)).toMatchObject({ status: 422, code: "asset_unavailable", message: unavailable.error.message });
  });

  test("errorResponse writes the API's error shape", async () => {
    const res = errorResponse(418, API_ERROR_CODE.BAD_REQUEST, "No.", { "x-extra": "1" });
    expect(res.status).toBe(418);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-extra")).toBe("1");
    expect(await res.json()).toEqual({ error: { code: "bad_request", message: "No." } });
  });

  test("readBodyWithin reads UTF-8 text split across chunks", async () => {
    const bytes = new TextEncoder().encode('{"a":"é€"}');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const b of bytes) controller.enqueue(Uint8Array.of(b));
        controller.close();
      },
    });
    const req = new Request("http://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(await readBodyWithin(req, 64)).toBe('{"a":"é€"}');
    expect(await readBodyWithin(new Request("http://x/"), 64)).toBe("");
  });
});

/* ------------------------------------------------------------------ writes only from the app's own pages */

test.describe("hub proxy: writes only from the app's own pages (CSRF)", () => {
  const QUOTE_BODY = JSON.stringify({ direction: "fiber_to_ln", asset: "CKB", side: "pay", amount: "800000000000" });
  const EVIL = "https://evil.example";
  const quotes = ["v1", "quotes"];

  /** A proxy that records whether anything reached the hub or the rate limiter. */
  function guarded(config: Partial<HubProxyConfig> = {}) {
    const { fetch, calls } = recordingFetch(() => json(QUOTE, 201));
    let takes = 0;
    const proxy = new HubProxy(proxyConfig({ maxBodyBytes: HUB_PROXY_DEFAULTS.maxBodyBytes, ...config }), {
      fetch,
      rateLimiter: { take: () => (takes++, { allowed: true, retryAfterMs: 0 }) },
    });
    return { proxy, calls, takes: () => takes };
  }

  const expectForbidden = async (res: Response, message: string) => {
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: { code: HUB_PROXY_ERROR_CODE.FORBIDDEN, message } });
  };

  test("the exploit: another site's no-cors POST with a text/plain body is refused before the hub and the rate limit", async () => {
    // What `fetch(proxy, { method: "POST", mode: "no-cors", body })` from another site sends: a string body is
    // text/plain;charset=UTF-8, and the browser adds Origin and Sec-Fetch-Site. No preflight asks first.
    const forged = rawProxyRequest("v1/quotes", {
      method: "POST",
      body: QUOTE_BODY,
      headers: { origin: EVIL, "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" },
    });
    expect(forged.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
    const { proxy, calls, takes } = guarded();
    await expectForbidden(await proxy.handle(forged, quotes), HUB_MESSAGE.CROSS_SITE);
    expect(calls).toHaveLength(0);
    expect(takes()).toBe(0);
  });

  test("the same body from an older browser that sends neither Sec-Fetch-Site nor Origin is still refused: it is not JSON", async () => {
    const { proxy, calls } = guarded();
    for (const contentType of [
      undefined,
      "text/plain",
      "text/plain;charset=UTF-8",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/jsonp",
      "application/json-patch+json",
      "text/json",
      "application/ json",
    ]) {
      const headers: Record<string, string> = contentType ? { "content-type": contentType } : {};
      const res = await proxy.handle(rawProxyRequest("v1/quotes", { method: "POST", body: new TextEncoder().encode(QUOTE_BODY), headers }), quotes);
      await expectForbidden(res, HUB_MESSAGE.NOT_JSON);
    }
    expect(calls).toHaveLength(0);
  });

  test("a write marked by the browser as from anywhere but this origin is refused", async () => {
    const { proxy, calls } = guarded();
    for (const site of ["cross-site", "same-site", "none", "CROSS-SITE", ""]) {
      const res = await proxy.handle(proxyRequest("v1/quotes", { method: "POST", body: QUOTE_BODY, headers: { "sec-fetch-site": site } }), quotes);
      await expectForbidden(res, HUB_MESSAGE.CROSS_SITE);
    }
    expect(calls).toHaveLength(0);
  });

  test("a write whose Origin is not this server is refused, opaque and malformed origins included", async () => {
    const { proxy, calls } = guarded();
    for (const origin of [EVIL, "null", "http://localhost:3101", "http://localhost", "https://localhost:3100.evil.example", "file://", "not a url", ""]) {
      const res = await proxy.handle(proxyRequest("v1/quotes", { method: "POST", body: QUOTE_BODY, headers: { origin } }), quotes);
      await expectForbidden(res, HUB_MESSAGE.CROSS_SITE);
    }
    // A forged X-Forwarded-Host cannot come from another site's page: it would need a preflight, which is never allowed.
    expect(calls).toHaveLength(0);
  });

  test("the app's own JSON writes go through: same origin, any JSON content type with parameters", async () => {
    const { proxy, calls } = guarded();
    const accepted: Record<string, string>[] = [
      // What the app's pages send from the browser.
      { origin: PROXY_ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      // Older browsers: Origin without Sec-Fetch-Site.
      { origin: PROXY_ORIGIN, "content-type": "application/json; charset=utf-8" },
      // Neither header (a server-side caller, a test): JSON is enough.
      { "content-type": "Application/JSON ; charset=UTF-8" },
      { "sec-fetch-site": " Same-Origin ", "content-type": "application/json" },
    ];
    for (const headers of accepted) {
      const res = await proxy.handle(rawProxyRequest("v1/quotes", { method: "POST", body: QUOTE_BODY, headers }), quotes);
      expect(res.status, JSON.stringify(headers)).toBe(201);
    }
    expect(calls).toHaveLength(accepted.length);
    // The hub always gets plain application/json.
    for (const call of calls) expect(call.init.headers).toMatchObject({ "content-type": "application/json" });
  });

  test("behind the platform's proxy the Origin is compared with the Host and X-Forwarded-Host it sets", async () => {
    const { proxy, calls } = guarded();
    // On Vercel the function may see an internal URL; the visitor's host arrives in Host and X-Forwarded-Host.
    const behind = (origin: string, headers: Record<string, string>) =>
      new Request("http://10.0.0.7:3000/api/hub/v1/quotes", {
        method: "POST",
        body: QUOTE_BODY,
        headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
      });
    expect((await proxy.handle(behind("https://ckbolt.example", { host: "ckbolt.example" }), quotes)).status).toBe(201);
    expect((await proxy.handle(behind("https://ckbolt.example", { "x-forwarded-host": "ckbolt.example" }), quotes)).status).toBe(201);
    expect((await proxy.handle(behind("https://CKBolt.example", { "x-forwarded-host": "ckbolt.example, internal.vercel" }), quotes)).status).toBe(201);
    expect((await proxy.handle(behind("https://preview-1.vercel.app", { host: "ckbolt.example" }), quotes)).status).toBe(403);
    expect(calls).toHaveLength(3);
  });

  test("reads are not guarded: another site cannot read the answers, and links and health checks keep working", async () => {
    const { proxy, calls } = guarded();
    const res = await proxy.handle(rawProxyRequest("v1/health", { headers: { origin: EVIL, "sec-fetch-site": "cross-site" } }), ["v1", "health"]);
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(isWriteMethod("GET")).toBe(false);
    expect(isWriteMethod("head")).toBe(false);
    for (const method of ["POST", "put", "PATCH", "DELETE"]) expect(isWriteMethod(method), method).toBe(true);
  });

  test("a cancel is a write like any other: another site's, or one that is not JSON, never reaches the hub", async () => {
    const { proxy, calls, takes } = guarded();
    const cancel = ["v1", "swaps", ID, "cancel"];
    const forged = rawProxyRequest(`v1/swaps/${ID}/cancel`, {
      method: "POST",
      body: "{}",
      headers: { origin: EVIL, "sec-fetch-site": "cross-site", [SWAP_CANCEL_TOKEN_HEADER]: CANCEL_TOKEN },
    });
    await expectForbidden(await proxy.handle(forged, cancel), HUB_MESSAGE.CROSS_SITE);
    const bodiless = rawProxyRequest(`v1/swaps/${ID}/cancel`, { method: "POST", headers: { [SWAP_CANCEL_TOKEN_HEADER]: CANCEL_TOKEN } });
    await expectForbidden(await proxy.handle(bodiless, cancel), HUB_MESSAGE.NOT_JSON);
    expect(calls).toHaveLength(0);
    expect(takes()).toBe(0);
  });

  test("the guard runs before everything that costs: without HUB_URL a forged write is still a 403, not a 503", async () => {
    const { proxy, takes } = guarded({ hubUrl: null });
    await expectForbidden(await proxy.handle(rawProxyRequest("v1/swaps", { method: "POST", body: "{}" }), ["v1", "swaps"]), HUB_MESSAGE.NOT_JSON);
    expect(takes()).toBe(0);
    // A wrong method is still a 405 first.
    expect((await proxy.handle(rawProxyRequest("v1/health", { method: "POST", body: "{}" }), ["v1", "health"])).status).toBe(405);
  });

  test("mediaTypeOf drops parameters and case", () => {
    expect(mediaTypeOf(null)).toBe("");
    expect(mediaTypeOf("application/json")).toBe("application/json");
    expect(mediaTypeOf(" Application/JSON;charset=utf-8")).toBe("application/json");
    expect(mediaTypeOf("text/plain;charset=UTF-8")).toBe("text/plain");
  });

  test("every POST the hub client makes passes the guard as the browser sends it", async () => {
    const { fetch, calls } = recordingFetch((url) => json(url.endsWith("/quotes") ? QUOTE : {}, 201));
    const client = new HubClient({ fetch });
    await client.createQuote({ direction: "fiber_to_ln", asset: "CKB", side: "pay", amount: "800000000000" });
    await client.createSwap({ quoteId: ID, payoutInvoice: "lntbs1", demo: false });
    await client.requestInboundChannel({ nodeId: "03" + "ab".repeat(32), asset: "CKB" });
    await client.requestLightningInboundChannel({ pubkey: PUBKEY });
    await client.cancelSwap(ID, CANCEL_TOKEN);
    // The client calls every POST path of the allow-list.
    const postPaths = HUB_ROUTES.filter((r) => r.methods.includes("POST")).map((r) => `${HUB_PROXY_BASE_PATH}/${r.pattern.join("/").replace(":id", ID)}`);
    expect(calls.map((c) => c.url).sort()).toEqual(postPaths.sort());
    for (const call of calls) {
      expect(call.init.method, call.url).toBe("POST");
      expect(call.init.headers, call.url).toMatchObject({ "content-type": "application/json" });
      // The browser adds Origin and Sec-Fetch-Site to the app's same-origin fetch.
      const headers = { ...(call.init.headers as Record<string, string>), origin: PROXY_ORIGIN, "sec-fetch-site": "same-origin" };
      const sent = new Request(`${PROXY_ORIGIN}${call.url}`, { ...call.init, headers });
      expect(forgedRequestReason(sent), call.url).toBeNull();
    }
  });
});

/* --------------------------------------------------------------------------- unsafe settings stop the proxy */

test.describe("hub proxy with unsafe settings", () => {
  test("HUB_PROXY_SECRET without TRUST_PROXY or over http: 503 hub_unavailable, nothing forwarded, the fix logged once", async () => {
    const { fetch, calls } = recordingFetch(() => json(HEALTH));
    const lines: string[] = [];
    let takes = 0;
    const config = readHubProxyConfig({ [HUB_ENV.HUB_URL]: "http://hub-api.example.org", [HUB_ENV.PROXY_SECRET]: SECRET });
    const proxy = new HubProxy(config, { fetch, rateLimiter: { take: () => (takes++, { allowed: true, retryAfterMs: 0 }) }, log: (line) => lines.push(line) });
    for (let i = 0; i < 3; i++) {
      const res = await proxy.handle(proxyRequest("v1/health"), ["v1", "health"]);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: { code: HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, message: HUB_MESSAGE.MISCONFIGURED } });
    }
    expect(calls).toHaveLength(0);
    expect(takes).toBe(0);
    expect(lines).toEqual([
      `${HUB_PROXY_LOG_PREFIX} ${HUB_CONFIG_PROBLEM.SECRET_OVER_HTTP}`,
      `${HUB_PROXY_LOG_PREFIX} ${HUB_CONFIG_PROBLEM.SECRET_WITHOUT_TRUST_PROXY}`,
    ]);
    // The browser is told nothing about the settings, and never the secret.
    const res = await proxy.handle(proxyRequest("v1/health"), ["v1", "health"]);
    expect(await res.text()).not.toMatch(/TRUST_PROXY|HUB_PROXY_SECRET|https/);
  });

  test("the same settings with TRUST_PROXY=1 and an https hub forward as usual, and log nothing", async () => {
    const { fetch, calls } = recordingFetch(() => json(HEALTH));
    const lines: string[] = [];
    const config = readHubProxyConfig({ [HUB_ENV.HUB_URL]: "https://hub-api.example.org", [HUB_ENV.PROXY_SECRET]: SECRET, [HUB_ENV.TRUST_PROXY]: "1" });
    const proxy = new HubProxy(config, { fetch, rateLimiter: ALLOW_ALL, log: (line) => lines.push(line) });
    const res = await proxy.handle(proxyRequest("v1/health", { headers: { "x-forwarded-for": "203.0.113.7" } }), ["v1", "health"]);
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe("https://hub-api.example.org/v1/health");
    expect(calls[0].init.headers).toMatchObject({ [HUB_PROXY_HEADER.CLIENT]: "203.0.113.7" });
    expect(lines).toEqual([]);
  });

  test("a loopback hub (an SSH tunnel) takes the secret over http without TRUST_PROXY, for local tests", async () => {
    const { fetch, calls } = recordingFetch(() => json(HEALTH));
    const config = readHubProxyConfig({ [HUB_ENV.HUB_URL]: "http://127.0.0.1:18787", [HUB_ENV.PROXY_SECRET]: SECRET });
    const res = await new HubProxy(config, { fetch, rateLimiter: ALLOW_ALL }).handle(proxyRequest("v1/health"), ["v1", "health"]);
    expect(res.status).toBe(200);
    expect(calls[0].init.headers).toMatchObject({ [HUB_PROXY_HEADER.SECRET]: SECRET, [HUB_PROXY_HEADER.CLIENT]: "shared" });
  });
});

/* -------------------------------------------------------------------- proxy against a real HTTP server */

test.describe("hub proxy over HTTP", () => {
  let server: Server;
  let base: string;
  const seen: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;

  test.beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(req, res, body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  test("creates a swap through the real fetch and rewrites the Location", async () => {
    handler = (_req, res) => {
      res.writeHead(201, { "content-type": "application/json", location: `/v1/swaps/${ID}`, "set-cookie": "a=b" });
      res.end(JSON.stringify(swap("pending")));
    };
    const proxy = createHubProxy(proxyConfig({ hubUrl: base, maxBodyBytes: 16_384 }));
    const body = JSON.stringify({ quoteId: OTHER_ID, payoutInvoice: "lntbs1...", demo: false });
    const res = await proxy.handle(proxyRequest("v1/swaps", { method: "POST", body }), ["v1", "swaps"]);
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(`/api/hub/v1/swaps/${ID}`);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await res.json()).state).toBe("pending");
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ method: "POST", url: "/v1/swaps", body });
    expect(last.headers["content-type"]).toBe("application/json");
  });

  test("a hub behind HUB_PROXY_SECRET receives the secret and the client key over the wire", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(HEALTH));
    };
    const proxy = createHubProxy(proxyConfig({ hubUrl: base, trustProxy: true, proxySecret: SECRET }));
    const res = await proxy.handle(proxyRequest("v1/health", { headers: { "x-forwarded-for": "7.7.7.7" } }), ["v1", "health"]);
    expect(res.status).toBe(200);
    const last = seen.at(-1)!;
    expect(last.headers[HUB_PROXY_HEADER.SECRET]).toBe(SECRET);
    expect(last.headers[HUB_PROXY_HEADER.CLIENT]).toBe("7.7.7.7");
  });

  test("another site's no-cors text/plain POST never reaches the hub over the wire", async () => {
    handler = (_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end("{}");
    };
    const proxy = createHubProxy(proxyConfig({ hubUrl: base, trustProxy: true, proxySecret: SECRET }));
    const count = seen.length;
    const forged = rawProxyRequest("v1/swaps", {
      method: "POST",
      body: JSON.stringify({ quoteId: OTHER_ID, payoutInvoice: "lntbs1...", demo: false }),
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "x-forwarded-for": "7.7.7.7" },
    });
    const res = await proxy.handle(forged, ["v1", "swaps"]);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe(HUB_PROXY_ERROR_CODE.FORBIDDEN);
    expect(seen.length).toBe(count);
  });

  test("gives up on a hub that never answers after the configured timeout", async () => {
    handler = () => undefined; // never answers
    const proxy = createHubProxy(proxyConfig({ hubUrl: base, timeoutMs: 300 }));
    const started = Date.now();
    const res = await proxy.handle(proxyRequest("v1/health"), ["v1", "health"]);
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe(HUB_PROXY_ERROR_CODE.HUB_TIMEOUT);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("does not follow a redirect from the hub", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      res.end();
    };
    const proxy = createHubProxy(proxyConfig({ hubUrl: base }));
    const count = seen.length;
    const res = await proxy.handle(proxyRequest("v1/assets"), ["v1", "assets"]);
    expect(seen.length).toBe(count + 1);
    expect(res.status).not.toBe(200);
  });

  test("a closed port is a 503 hub_unavailable", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const proxy = createHubProxy(proxyConfig({ hubUrl: `http://127.0.0.1:${port}` }));
    const res = await proxy.handle(proxyRequest("v1/health"), ["v1", "health"]);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe(HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE);
  });
});

/* ----------------------------------------------------------------------------------------------- client */

const LIGHTNING_NODE: LightningNodeDto = {
  pubkey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  network: "signet",
  uris: ["0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798@203.0.113.10:9735"],
  inbound: { enabled: true, capacitySats: "30000", pushSats: "20000" },
};
const LIGHTNING_OPENING = { pubkey: PUBKEY, capacitySats: "30000", pushSats: "20000", fundingTxid: "ab".repeat(32) };
const LIGHTNING_CHANNEL: LightningInboundChannelDto = {
  channelPoint: `${"ab".repeat(32)}:0`,
  state: "opening",
  capacitySats: "30000",
  hubBalanceSats: "10000",
  walletBalanceSats: "20000",
};

test.describe("hub client", () => {
  test("parses the { error: { code, message } } body, and anything else as unreadable", () => {
    const e = parseHubError(422, { error: { code: "quote_expired", message: "This quote has expired." } });
    expect(e).toBeInstanceOf(HubApiError);
    expect(e).toMatchObject({ status: 422, code: "quote_expired", message: "This quote has expired.", name: "HubApiError" });
    for (const body of [null, "oops", { error: "x" }, { error: { code: 1, message: "m" } }, { message: "m" }]) {
      expect(parseHubError(500, body)).toMatchObject({ status: 500, code: API_ERROR_CODE.INTERNAL, message: HUB_MESSAGE.UNREADABLE });
    }
  });

  test("toHubApiError keeps a HubApiError and wraps anything else", () => {
    const original = new HubApiError(409, "duplicate_hash", "That payment hash was used before.");
    expect(toHubApiError(original)).toBe(original);
    expect(toHubApiError(new Error("boom"))).toMatchObject({ status: 0, code: API_ERROR_CODE.INTERNAL, message: HUB_MESSAGE.UNEXPECTED });
  });

  test("calls the same-origin proxy by default, with JSON headers and no cache", async () => {
    const { fetch, calls } = recordingFetch(() => json(QUOTE, 201));
    const client = new HubClient({ fetch });
    const body = { direction: "fiber_to_ln" as const, asset: "CKB" as const, side: "pay" as const, amount: "800000000000" };
    expect(await client.createQuote(body)).toEqual(QUOTE);
    expect(calls[0].url).toBe("/api/hub/v1/quotes");
    expect(calls[0].init).toMatchObject({
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(body),
      headers: { accept: "application/json", "content-type": "application/json" },
    });
  });

  test("builds every resource path and unwraps collections", async () => {
    const { fetch, calls } = recordingFetch((url) => {
      if (url.endsWith("/assets")) return json({ data: [asset()] });
      if (url.endsWith("/events")) return json({ data: [event("created")] });
      if (url.endsWith("/lightning/node")) return json(LIGHTNING_NODE);
      if (url.endsWith("/lightning/inbound-channels")) return json(LIGHTNING_OPENING, 202);
      if (url.includes("/lightning/inbound-channels/")) return json({ data: [LIGHTNING_CHANNEL] });
      return json(swap("pending"), url.endsWith("/swaps") ? 201 : 200);
    });
    const client = new HubClient({ baseUrl: "https://web.test/api/hub//", fetch });
    expect(await client.listAssets()).toEqual([asset()]);
    expect((await client.createSwap({ quoteId: ID, payoutInvoice: "lntbs1", demo: true })).state).toBe("pending");
    expect((await client.getSwap(ID)).id).toBe(ID);
    expect(await client.listSwapEvents(ID)).toEqual([event("created")]);
    expect(await client.getLightningNode()).toEqual(LIGHTNING_NODE);
    expect(await client.requestLightningInboundChannel({ pubkey: PUBKEY })).toEqual(LIGHTNING_OPENING);
    expect(await client.listLightningInboundChannels(PUBKEY)).toEqual([LIGHTNING_CHANNEL]);
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "GET https://web.test/api/hub/v1/assets",
      "POST https://web.test/api/hub/v1/swaps",
      `GET https://web.test/api/hub/v1/swaps/${ID}`,
      `GET https://web.test/api/hub/v1/swaps/${ID}/events`,
      "GET https://web.test/api/hub/v1/lightning/node",
      "POST https://web.test/api/hub/v1/lightning/inbound-channels",
      `GET https://web.test/api/hub/v1/lightning/inbound-channels/${PUBKEY}`,
    ]);
    expect(calls[5].init.body).toBe(JSON.stringify({ pubkey: PUBKEY }));
    // Every call the client makes is one the proxy forwards: nothing it sends can meet the proxy's 404.
    for (const call of calls) {
      const segments = new URL(call.url).pathname.replace(/^\/api\/hub\//, "").split("/");
      expect(matchHubRoute(segments)?.methods, call.url).toContain(call.init.method);
    }
    // GETs carry no body and no content-type.
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[0].init.headers).toEqual({ accept: "application/json" });
  });

  test("createSwap answers the swap with its cancel token; cancelSwap sends it in its header, with an empty JSON body", async () => {
    const created = { ...swap("pending"), cancelToken: CANCEL_TOKEN };
    const cancelled = swap("failed", { refunded: true });
    const { fetch, calls } = recordingFetch((url) => (url.endsWith("/cancel") ? json(cancelled) : json(created, 201)));
    const client = new HubClient({ fetch });
    expect(await client.createSwap({ quoteId: ID, payoutInvoice: "fibt1" })).toEqual(created);
    expect(await client.cancelSwap(ID, CANCEL_TOKEN)).toEqual(cancelled);
    expect(calls[1].url).toBe(`/api/hub/v1/swaps/${ID}/cancel`);
    expect(calls[1].init).toMatchObject({
      method: "POST",
      body: "{}",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json", [SWAP_CANCEL_TOKEN_HEADER]: CANCEL_TOKEN },
    });
    // Only the cancel carries the token.
    expect(calls[0].init.headers).not.toHaveProperty(SWAP_CANCEL_TOKEN_HEADER);
    // The hub's refusal reaches the caller with its code.
    const refusing = new HubClient({ fetch: async () => json({ error: { code: API_ERROR_CODE.CANCEL_REFUSED, message: "No token." } }, 403) });
    await expect(refusing.cancelSwap(ID, "wrong")).rejects.toMatchObject({ status: 403, code: API_ERROR_CODE.CANCEL_REFUSED });
  });

  test("an id is encoded as one path segment", async () => {
    const { fetch, calls } = recordingFetch(() => json(swap("pending")));
    await new HubClient({ fetch }).getSwap("../../v1/admin");
    expect(calls[0].url).toBe("/api/hub/v1/swaps/..%2F..%2Fv1%2Fadmin");
  });

  test("health: a 503 that carries a health report is a report, not an error", async () => {
    const degraded: HealthDto = { ...HEALTH, status: "degraded", fiber: { reachable: false, network: null, version: null } };
    expect(await new HubClient({ fetch: recordingFetch(() => json(HEALTH)).fetch }).health()).toEqual(HEALTH);
    expect(await new HubClient({ fetch: recordingFetch(() => json(degraded, 503)).fetch }).health()).toEqual(degraded);
    const notConfigured = { error: { code: "hub_unavailable", message: HUB_MESSAGE.NOT_CONFIGURED } };
    await expect(new HubClient({ fetch: recordingFetch(() => json(notConfigured, 503)).fetch }).health()).rejects.toMatchObject({
      status: 503,
      code: "hub_unavailable",
      message: HUB_MESSAGE.NOT_CONFIGURED,
    });
    // A 200 that is not a health report is not trusted.
    await expect(new HubClient({ fetch: recordingFetch(() => json({ status: "fine" })).fetch }).health()).rejects.toBeInstanceOf(HubApiError);
    // Nor is a health report with an error status other than 503.
    await expect(new HubClient({ fetch: recordingFetch(() => json(HEALTH, 500)).fetch }).health()).rejects.toBeInstanceOf(HubApiError);
  });

  test("a failed answer throws the hub's error; a non-JSON one throws a plain sentence", async () => {
    const hubError = { error: { code: "insufficient_liquidity", message: "The hub cannot pay out that much right now." } };
    await expect(new HubClient({ fetch: recordingFetch(() => json(hubError, 422)).fetch }).createQuote({
      direction: "ln_to_fiber",
      asset: "CKB",
      side: "pay",
      amount: "1",
    })).rejects.toMatchObject({ status: 422, code: "insufficient_liquidity", message: hubError.error.message });
    const html = () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
    await expect(new HubClient({ fetch: recordingFetch(html).fetch }).getSwap(ID)).rejects.toMatchObject({
      status: 502,
      code: API_ERROR_CODE.INTERNAL,
      message: HUB_MESSAGE.UNREADABLE,
    });
  });

  test("a network failure is hub_unavailable with status 0", async () => {
    const client = new HubClient({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(client.listAssets()).rejects.toMatchObject({ status: 0, code: HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, message: HUB_MESSAGE.UNREACHABLE });
  });
});

/* ----------------------------------------------------------------------------------------------- status */

test.describe("hub status", () => {
  const client = (health: () => Promise<HealthDto>, assets: () => Promise<AssetDto[]>) => ({ health, listAssets: assets });
  const fail = async (): Promise<never> => {
    throw new HubApiError(503, "hub_unavailable", "down");
  };

  test("offline when the hub is not configured or cannot be reached", async () => {
    let assetsAsked = false;
    const s = await readHubStatus(client(fail, async () => ((assetsAsked = true), [asset()])));
    expect(s).toEqual({ state: "offline", health: null, assets: [] });
    expect(assetsAsked).toBe(false);
  });

  test("degraded when a node is down; assets are not offered", async () => {
    const degraded = { ...HEALTH, status: "degraded" as const };
    expect(await readHubStatus(client(async () => degraded, async () => [asset()]))).toEqual({ state: "degraded", health: degraded, assets: [] });
  });

  test("live with the assets that have at least one direction", async () => {
    const none = asset({ id: "CWBTC", symbol: "cWBTC", directions: [] });
    const s = await readHubStatus(client(async () => HEALTH, async () => [asset(), none, asset({ id: "RUSD", symbol: "RUSD", directions: ["fiber_to_ln"] })]));
    expect(s.state).toBe("live");
    expect(s.assets.map((a) => a.id)).toEqual(["CKB", "RUSD"]);
  });

  test("degraded when the hub has nothing to swap or its assets cannot be read", async () => {
    expect((await readHubStatus(client(async () => HEALTH, async () => []))).state).toBe("degraded");
    expect((await readHubStatus(client(async () => HEALTH, async () => [asset({ directions: [] })]))).state).toBe("degraded");
    expect(await readHubStatus(client(async () => HEALTH, fail))).toEqual({ state: "degraded", health: HEALTH, assets: [] });
  });
});

/* -------------------------------------------------------------------------------------------- lifecycle */

test.describe("live swap lifecycle", () => {
  test("only a succeeded swap, or a failed one whose hold was cancelled, is final", () => {
    expect(TERMINAL_SWAP_STATES).toEqual(["succeeded", "failed"]);
    expect(isSwapFinal(swap("succeeded"))).toBe(true);
    expect(isSwapFinal(swap("failed", { refunded: true }))).toBe(true);
    expect(isSwapFinal(swap("failed", { refunded: false }))).toBe(false);
    for (const s of ["pending", "incoming_accepted", "outgoing_in_flight", "outgoing_succeeded"] as const) expect(isSwapFinal(swap(s)), s).toBe(false);
  });

  test("progress never forgets a step, whether seen in a state or only in the events", () => {
    let p: SwapProgress = NO_PROGRESS;
    p = accumulateProgress(p, swap("pending"), []);
    expect(p).toBe(NO_PROGRESS);
    p = accumulateProgress(p, swap("incoming_accepted"), []);
    expect(p).toEqual({ funded: true, payoutStarted: false });
    p = accumulateProgress(p, swap("outgoing_in_flight"), []);
    expect(p).toEqual({ funded: true, payoutStarted: true });
    const same = accumulateProgress(p, swap("failed"), []);
    expect(same).toBe(p);

    const fromEvents = accumulateProgress(NO_PROGRESS, swap("failed", { refunded: true }), [
      event(SWAP_EVENT.CREATED),
      event(SWAP_EVENT.INCOMING_ACCEPTED),
      event(SWAP_EVENT.PAYOUT_STARTED),
      event(SWAP_EVENT.PAYOUT_FAILED),
    ]);
    expect(fromEvents).toEqual({ funded: true, payoutStarted: true });
  });
});

/* ----------------------------------------------------------------------------------------------- format */

test.describe("hub amounts and formatting", () => {
  test("base units as grouped decimals, exactly", () => {
    expect(formatUnits("800000000000", 8)).toBe("8,000");
    expect(formatUnits("1234567890", 8)).toBe("12.3456789");
    expect(formatUnits("123456789012345678901234567890", 8)).toBe("1,234,567,890,123,456,789,012.3456789");
    expect(formatUnits("1", 8)).toBe("0.00000001");
    expect(formatUnits("1000000", 6)).toBe("1");
  });

  test("legs: sats on Lightning, the asset's symbol on Fiber", () => {
    expect(formatLeg(QUOTE.receive)).toBe("19,800 sats");
    expect(formatLeg(QUOTE.pay)).toBe("8,000 CKB");
    expect(formatLeg({ network: "fiber", asset: "CWBTC", amount: "150000000", decimals: 8 }, "cWBTC")).toBe("1.5 cWBTC");
  });

  test("typed amounts become exact base units, or null", () => {
    expect(toBaseUnits(8000, 8)).toBe("800000000000");
    expect(toBaseUnits(100000.5, 8)).toBe("10000050000000");
    expect(toBaseUnits(0.1, 8)).toBe("10000000");
    expect(toBaseUnits(16, 6)).toBe("16000000");
    expect(toBaseUnits(0.00000001, 8)).toBe("1");
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.000000001]) expect(toBaseUnits(v, 8), String(v)).toBeNull();
    // Every result is something the hub's amount schema accepts.
    for (const v of [1, 8000.5, 0.12345678, 999999.99]) expect(toBaseUnits(v, 8)).toMatch(/^[1-9]\d{0,29}$/);
  });

  test("countdown seconds round up and never go negative", () => {
    const iso = new Date(NOW + 150_000).toISOString();
    expect(secondsUntil(iso, NOW)).toBe(150);
    expect(secondsUntil(iso, NOW + 149_001)).toBe(1);
    expect(secondsUntil(iso, NOW + 150_000)).toBe(0);
    expect(secondsUntil(iso, NOW + 999_999)).toBe(0);
    expect(secondsUntil("not a date", NOW)).toBe(0);
  });

  test("fee and network labels", () => {
    expect(feePercent(100)).toBe("1%");
    expect(feePercent(35)).toBe("0.35%");
    expect(lightningNetworkLabel("signet")).toBe("Bitcoin signet");
    expect(lightningNetworkLabel(null)).toBe("Bitcoin test network");
  });
});

/* ----------------------------------------------------------------------------------------------- assets */

test.describe("hub assets in the app", () => {
  const known = PAY_TOKENS;

  test("a known asset keeps the app's token, with the hub's decimals", () => {
    const ckb = tokenForAsset(asset(), known);
    expect(ckb).toBe(known.find((t) => t.symbol === "CKB"));
    const rusd6 = tokenForAsset(asset({ id: "RUSD", symbol: "rusd", decimals: 6 }), known);
    expect(rusd6.symbol).toBe("RUSD");
    expect(rusd6.decimals).toBe(6);
    expect(known.find((t) => t.symbol === "RUSD")!.decimals).toBe(8);
  });

  test("an asset the app does not know is shown from the hub's own data", () => {
    // A token a hub adds by config (its FIBER_ASSETS) needs no web change: the card shows it from GET /v1/assets.
    const t = tokenForAsset(asset({ id: "XTEST", symbol: "xTEST", name: "Some test token", decimals: 6 }), known);
    expect(t).toMatchObject({ symbol: "xTEST", name: "Some test token", decimals: 6, status: "Not quoted", priceNote: "Priced by the hub" });
    expect(t.icon).toBeUndefined();
    expect(t.usdPrice(RATE)).toBeNull();
  });

  test("cWBTC is a known token: CCH Wrapped BTC (test), its own icon, quoted 1:1 with BTC, testnet only", () => {
    const cwbtc = PAY_TOKENS.find((t) => t.symbol === "cWBTC")!;
    expect(cwbtc).toMatchObject({ name: "CCH Wrapped BTC (test)", decimals: 8, icon: "/tokens/cwbtc.svg", status: "Quoted 1:1 with BTC" });
    expect(cwbtc.priceNote).toBe("Testnet only: 1 cWBTC counts as 1 BTC of test value");
    expect(cwbtc.usdPrice(RATE)).toBe(RATE.btcUsd);
    // A local file, nothing fetched from another site.
    expect(existsSync(path.join(WEB, "public/tokens/cwbtc.svg"))).toBe(true);
    expect(readFileSync(path.join(WEB, "public/tokens/cwbtc.svg"), "utf8")).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    // The hub's cWBTC (id CWBTC, symbol cWBTC, the hub's own name) shows as the app's token, by symbol.
    const t = tokenForAsset(asset({ id: "CWBTC", symbol: "cWBTC", name: "CCH Wrapped BTC" }), known);
    expect(t).toBe(cwbtc);
  });

  test("assetPhrase: the hub's symbols in its order, or CKB tokens before it lists any", () => {
    expect(assetPhrase(["CKB", "RUSD", "cWBTC"])).toBe("CKB, RUSD, and cWBTC");
    expect(assetPhrase(["CKB", "RUSD", "cWBTC"], "or")).toBe("CKB, RUSD, or cWBTC");
    expect(assetPhrase(["CKB"])).toBe("CKB");
    expect(assetPhrase([])).toBe(FIBER_ASSETS_FALLBACK);
    expect(FIBER_ASSETS_FALLBACK).toBe("CKB tokens");
  });

  test("filters by direction", () => {
    const live = toLiveAssets(
      [asset(), asset({ id: "RUSD", symbol: "RUSD", directions: ["fiber_to_ln"] }), asset({ id: "CWBTC", symbol: "cWBTC", directions: ["ln_to_fiber"] })],
      known,
    );
    expect(assetsServing(live, "fiber_to_ln").map((a) => a.dto.id)).toEqual(["CKB", "RUSD"]);
    expect(assetsServing(live, "ln_to_fiber").map((a) => a.dto.id)).toEqual(["CKB", "CWBTC"]);
  });
});

/* ------------------------------------------------------------------------- the contract copy vs the hub */

const HUB_REPO = path.resolve(__dirname, "../../../ckbolt-hub");
const hubFile = (p: string) => path.join(HUB_REPO, p);
const hasHub = existsSync(hubFile("src/interfaces/http/contract/responses.ts"));

/** Loads a hub source file as CommonJS, with its imports resolved from the hub repo (its own zod). */
function loadHubModule(rel: string): Record<string, any> {
  const file = hubFile(rel);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  const module = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", outputText)(createRequire(file), module, module.exports);
  return module.exports;
}

/** `export interface X { ... }` blocks, without comments and whitespace. */
function interfaces(source: string): Record<string, string> {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const out: Record<string, string> = {};
  for (const m of noComments.matchAll(/export interface (\w+)(<[^>]*>)?\s*\{/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    while (depth > 0 && i < noComments.length) {
      if (noComments[i] === "{") depth++;
      if (noComments[i] === "}") depth--;
      i++;
    }
    out[m[1]] = noComments.slice(m.index!, i).replace(/\s+/g, "");
  }
  return out;
}

test.describe("contract copy matches the hub (when ../ckbolt-hub is checked out)", () => {
  test.skip(!hasHub, "the sibling hub repo is not present");

  test("response DTOs are identical", () => {
    const hub = interfaces(readFileSync(hubFile("src/interfaces/http/contract/responses.ts"), "utf8"));
    const web = interfaces(readFileSync(path.resolve(__dirname, "../../lib/hub/contract.ts"), "utf8"));
    expect(Object.keys(hub).length).toBeGreaterThan(5);
    for (const [name, body] of Object.entries(hub)) expect(web[name], name).toBe(body);
  });

  test("routes, version, error codes and states are identical", async () => {
    const api = loadHubModule("src/common/constants/api.constants.ts");
    expect(API_VERSION).toBe(api.API_VERSION);
    expect(API_ROUTES).toEqual(api.API_ROUTES);
    expect(API_ERROR_CODE).toEqual(api.API_ERROR_CODE);
    const swaps = loadHubModule("src/common/constants/swap.constants.ts");
    expect(TERMINAL_SWAP_STATES).toEqual(swaps.TERMINAL_SWAP_STATES);
    expect(QUOTE_PURPOSE).toEqual(swaps.QUOTE_PURPOSE);
  });

  test("asset ids: the same pattern, CKB's id and the Lightning leg's name as the hub's; any id it can serve passes the bridge", async () => {
    const assets = loadHubModule("src/common/constants/assets.constants.ts");
    expect(FIBER_ASSET_ID_PATTERN.source).toBe(assets.ASSET_ID_PATTERN.source);
    expect(FIBER_ASSET_ID_PATTERN.flags).toBe(assets.ASSET_ID_PATTERN.flags);
    expect(CKB_ASSET_ID).toBe(assets.CKB_ASSET_ID);
    expect(LIGHTNING_ASSET_ID).toBe(assets.LIGHTNING_ASSET_ID);
    const schemas = loadHubModule("src/interfaces/http/contract/requests.ts");
    for (const id of ["CKB", "RUSD", "CWBTC", "XUDT2", "A".repeat(16), "cwbtc", "C", "1INCH", "C-KB"]) {
      expect(isFiberAssetId(id), id).toBe(schemas.fiberAssetSchema.safeParse(id).success);
    }
  });

  test("every swap event the hub can send is known to the web copy", async () => {
    const swaps = loadHubModule("src/common/constants/swap.constants.ts");
    expect(SWAP_EVENT).toEqual(swaps.SWAP_EVENT);
  });

  test("Direction, FiberAssetId and SwapState match the hub's domain types", () => {
    const domain = readFileSync(hubFile("src/domain/types.ts"), "utf8").replace(/\s+/g, " ");
    const web = readFileSync(path.resolve(__dirname, "../../lib/hub/contract.ts"), "utf8").replace(/\s+/g, " ");
    for (const name of ["Direction", "FiberAssetId", "SwapState", "QuotePurpose"]) {
      const pick = (src: string) =>
        src
          .match(new RegExp(`export type ${name} =([^;]+);`))?.[1]
          .split("|")
          .map((v) => v.trim())
          .filter(Boolean)
          .join(" | ");
      expect(pick(web), name).toBe(pick(domain));
    }
  });

  test("the bodies the web app sends pass the hub's own request schemas", async () => {
    const schemas = loadHubModule("src/interfaces/http/contract/requests.ts");
    const amount = toBaseUnits(8000.5, 8)!;
    expect(schemas.createQuoteBodySchema.safeParse({ direction: "fiber_to_ln", asset: "CKB", side: "pay", amount }).success).toBe(true);
    expect(schemas.createQuoteBodySchema.safeParse({ direction: "ln_to_fiber", asset: "RUSD", side: "pay", amount: "50000" }).success).toBe(true);
    // cWBTC both ways, and as Get paid's request quote.
    expect(schemas.createQuoteBodySchema.safeParse({ direction: "ln_to_fiber", asset: "CWBTC", side: "pay", amount: "2000" }).success).toBe(true);
    expect(schemas.createQuoteBodySchema.safeParse({ direction: "fiber_to_ln", asset: "CWBTC", side: "receive", amount: "24750" }).success).toBe(true);
    expect(schemas.createQuoteBodySchema.safeParse({ direction: "ln_to_fiber", asset: "CWBTC", side: "receive", amount, purpose: QUOTE_PURPOSE.REQUEST }).success).toBe(true);
    // Get paid's request quote (the conversion line and the Lightning invoice).
    expect(schemas.createQuoteBodySchema.safeParse({ direction: "ln_to_fiber", asset: "CKB", side: "receive", amount, purpose: QUOTE_PURPOSE.REQUEST }).success).toBe(true);
    expect(schemas.createQuoteBodySchema.safeParse({ direction: "ln_to_fiber", asset: "CKB", side: "receive", amount, purpose: QUOTE_PURPOSE.SWAP }).success).toBe(false);
    // The cancel token travels in the header the hub reads.
    expect(SWAP_CANCEL_TOKEN_HEADER).toBe(schemas.REQUEST_HEADER.CANCEL_TOKEN);
    expect([HUB_PROXY_HEADER.SECRET, HUB_PROXY_HEADER.CLIENT]).toEqual([schemas.REQUEST_HEADER.PROXY_SECRET, schemas.REQUEST_HEADER.CLIENT]);
    expect(schemas.createSwapBodySchema.safeParse({ quoteId: ID, payoutInvoice: demoFiberInvoice("testnet", null), demo: false }).success).toBe(true);
    expect(schemas.createDemoInvoiceBodySchema.safeParse({ direction: "fiber_to_ln", asset: "CKB", amount: QUOTE.receive.amount }).success).toBe(true);
    expect(schemas.createDemoPaymentBodySchema.safeParse({ swapId: ID }).success).toBe(true);
    // The node page asks for inbound liquidity with its node id as fiber-js reports it, with or without 0x.
    const nodeId = `02${"ab".repeat(32)}`;
    for (const id of [nodeId, `0x${nodeId}`]) {
      expect(schemas.createInboundChannelBodySchema.safeParse({ nodeId: id, asset: "CKB" }).success, id).toBe(true);
    }
    expect(schemas.createInboundChannelBodySchema.safeParse({ nodeId, asset: "CWBTC" }).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------- copy fixes */

const WEB = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(WEB, p), "utf8");
const filesIn = (dir: string, ext: RegExp) => readdirSync(path.join(WEB, dir)).filter((f) => ext.test(f)).map((f) => `${dir}/${f}`);

test.describe("copy fixes", () => {
  test("Fiber's minimum hold is 160 minutes everywhere; 16 hours appears only as the stale upstream figure", () => {
    const files = ["README.md", ...filesIn("docs", /\.md$/), ...filesIn("components/landing", /\.tsx$/), ...filesIn("components/app", /\.tsx$/)];
    for (const f of files) {
      for (const line of read(f).split("\n")) {
        if (/16[ -]hours?|16h\b/i.test(line)) expect(line, f).toMatch(/older|stale/i);
      }
    }
    expect(read("components/landing/faq-section.tsx")).toContain("160 minutes");
    expect(read("README.md")).toContain("160 minutes");
  });

  test("USDI is not offered anywhere; where it is named, it is as discontinued", () => {
    expect(PAY_TOKENS.map((t) => t.symbol)).not.toContain("USDI");
    expect(existsSync(path.join(WEB, "public/tokens/usdi.svg"))).toBe(false);
    const files = ["README.md", "lib/tokens.ts", ...filesIn("docs", /\.md$/), ...filesIn("components/landing", /\.tsx$/), ...filesIn("components/app", /\.tsx$/)];
    for (const f of files) {
      for (const line of read(f).split("\n")) {
        if (line.includes("USDI")) expect(line, f).toMatch(/discontinued/i);
      }
    }
    const hero = read("components/landing/hero-section.tsx");
    expect(hero.match(/const words = \[([^\]]*)\]/)?.[1]).not.toContain("USDI");
    const pricing = read("components/landing/pricing-section.tsx");
    const stage3 = pricing.slice(pricing.indexOf("Real swaps on testnet"), pricing.indexOf("Real swaps on testnet") + 800);
    expect(stage3).not.toContain("USDI");
    const readme = read("README.md");
    const stage3Row = readme.split("\n").find((l) => l.startsWith("| 3. Live testnet swaps"))!;
    expect(stage3Row).not.toContain("USDI");
  });

  test("price-source copy says what the hub does: a median of exchange prices with its spread, no CKB DEX or oracle", () => {
    const files = ["README.md", ...filesIn("docs", /\.md$/), ...filesIn("components/landing", /\.tsx$/), ...filesIn("components/app", /\.tsx$/)];
    for (const f of files) {
      for (const line of read(f).split("\n")) {
        if (/oracle|decentralized price|DEX price/i.test(line)) expect(line, f).toMatch(/no (live )?CKB DEX or oracle/i);
      }
    }
    const faq = read("components/landing/faq-section.tsx");
    expect(faq).toContain("median of those exchange prices, with its spread on top");
    expect(faq).toContain("UTXOSwap shut down in October 2026");
  });
});
