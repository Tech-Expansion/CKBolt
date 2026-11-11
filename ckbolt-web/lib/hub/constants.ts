/**
 * Web-side facts and defaults for talking to a CKBolt hub. The hub's own contract, and the error codes the proxy adds
 * to it, are in ./contract.ts; tunables of the server-side proxy are read from the environment in ./config.ts, with the
 * defaults below.
 */

import { FIBER_ASSET_ID_PATTERN, type FiberAssetId } from "./contract";

/**
 * A Fiber asset id as the hub writes them (the hub's fiberAssetSchema: its ASSET_ID_PATTERN), for ids that arrive at
 * run time over the bridge or from storage. Which ids are served is the hub's to say (GET /v1/assets, GET
 * /v1/fiber/node), so the app keeps no list of its own: a new token in the hub's FIBER_ASSETS needs no web change.
 */
export const isFiberAssetId = (v: unknown): v is FiberAssetId => typeof v === "string" && FIBER_ASSET_ID_PATTERN.test(v);

/** Same-origin path of the proxy (`app/api/hub/[...path]`) that the browser calls. */
export const HUB_PROXY_BASE_PATH = "/api/hub";

/** Environment variables the proxy reads. */
export const HUB_ENV = {
  /** Base URL of the hub, such as http://127.0.0.1:8787. Unset: the app says the hub is not available. */
  HUB_URL: "HUB_URL",
  TIMEOUT_MS: "HUB_PROXY_TIMEOUT_MS",
  MAX_BODY_BYTES: "HUB_PROXY_MAX_BODY_BYTES",
  /** Requests per minute per client, when TRUST_PROXY=1 identifies clients. */
  RATE_LIMIT_PER_MINUTE: "HUB_PROXY_RATE_LIMIT_PER_MINUTE",
  /** Requests per minute for all callers together, when clients cannot be told apart. */
  SHARED_RATE_LIMIT_PER_MINUTE: "HUB_PROXY_SHARED_RATE_LIMIT_PER_MINUTE",
  /** Server-wide cap, because forwarded-for headers can be forged. */
  GLOBAL_RATE_LIMIT_PER_MINUTE: "HUB_PROXY_GLOBAL_RATE_LIMIT_PER_MINUTE",
  /** "1" behind our own reverse proxy: the last X-Forwarded-For entry identifies the client. */
  TRUST_PROXY: "TRUST_PROXY",
  /**
   * Server only, never NEXT_PUBLIC: the shared secret the hub requires (its own HUB_PROXY_SECRET). When set, the proxy
   * sends it with the client key on every request (contract.ts HUB_PROXY_HEADER). Unset: neither header is sent. It
   * needs an https HUB_URL and TRUST_PROXY=1, unless the hub is on a loopback address (HUB_CONFIG_PROBLEM).
   */
  PROXY_SECRET: "HUB_PROXY_SECRET",
} as const;

export const TRUST_PROXY_ENABLED = "1";

/**
 * Hosts of a hub on this machine, such as one reached through an SSH tunnel (as `URL.hostname` writes them). Only such
 * a hub may get HUB_PROXY_SECRET over plain http, or without TRUST_PROXY.
 */
export const LOOPBACK_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Settings the proxy refuses to run with: it answers 503 hub_unavailable and logs the line, which names the fix, once
 * per server process.
 */
export const HUB_CONFIG_PROBLEM = {
  SECRET_OVER_HTTP:
    `${HUB_ENV.PROXY_SECRET} is set but ${HUB_ENV.HUB_URL} is not https, so the secret would cross the network in clear ` +
    `text. Use an https ${HUB_ENV.HUB_URL} (plain http only for a hub on ${LOOPBACK_HOSTNAMES.join(", ")}).`,
  SECRET_WITHOUT_TRUST_PROXY:
    `${HUB_ENV.PROXY_SECRET} is set but ${HUB_ENV.TRUST_PROXY} is not ${TRUST_PROXY_ENABLED}, so every visitor would ` +
    `share one client key at the hub. Set ${HUB_ENV.TRUST_PROXY}=${TRUST_PROXY_ENABLED} behind the platform's proxy ` +
    `(Vercel), or use a ${HUB_ENV.HUB_URL} on ${LOOPBACK_HOSTNAMES.join(", ")} for local tests.`,
} as const;

/** Prefix of the proxy's server log lines. */
export const HUB_PROXY_LOG_PREFIX = "[ckbolt hub proxy]";

export const HUB_PROXY_DEFAULTS = {
  timeoutMs: 10_000,
  /** The largest request body is a swap with a 4,096-character invoice. */
  maxBodyBytes: 16 * 1024,
  rateWindowMs: 60_000,
  /** A swap polled every 2 s costs 30 requests a minute; quotes and channel checks come on top. */
  perClientPerWindow: 120,
  sharedPerWindow: 600,
  globalPerWindow: 1_200,
  maxTrackedClients: 5_000,
} as const;

/**
 * Rate-limit keys when the client cannot be identified: `shared` without a trusted proxy, `local` behind one that sent
 * no X-Forwarded-For, `unknown` when its last entry is not an IP address (such callers share a key, they cannot pick one).
 */
export const RATE_LIMIT_KEY = { SHARED: "shared", LOCAL: "local", UNKNOWN: "unknown" } as const;

/**
 * Writes (every method but these) must come from the app's own pages: same origin, JSON body (./request-guard.ts).
 */
export const SAFE_HTTP_METHODS: readonly string[] = ["GET", "HEAD"];

/** The only Sec-Fetch-Site value a write may carry. */
export const SEC_FETCH_SITE_SAME_ORIGIN = "same-origin";

/** Plain sentences for errors raised on the web side (the hub writes its own). */
export const HUB_MESSAGE = {
  NOT_CONFIGURED: "Live swaps are not set up on this server.",
  MISCONFIGURED: "Live swaps are not set up correctly on this server.",
  CROSS_SITE: "Requests to the hub must come from this site.",
  NOT_JSON: "Requests to the hub must send JSON.",
  UNREACHABLE: "The CKBolt hub cannot be reached right now. Try again in a minute.",
  TIMEOUT: "The CKBolt hub did not answer in time. Try again.",
  UNKNOWN_PATH: "This is not a CKBolt hub API path.",
  METHOD_NOT_ALLOWED: "This method is not allowed on this hub API path.",
  BODY_TOO_LARGE: "The request is too large.",
  RATE_LIMITED: "Too many requests to the hub. Try again in a minute.",
  UNREADABLE: "The hub sent an answer CKBolt could not read.",
  UNEXPECTED: "Something went wrong while talking to the hub. Try again.",
} as const;

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;

export const HTTP_HEADER = {
  ACCEPT: "accept",
  ALLOW: "allow",
  CACHE_CONTROL: "cache-control",
  CONTENT_LENGTH: "content-length",
  CONTENT_TYPE: "content-type",
  FORWARDED_FOR: "x-forwarded-for",
  FORWARDED_HOST: "x-forwarded-host",
  HOST: "host",
  LOCATION: "location",
  ORIGIN: "origin",
  RETRY_AFTER: "retry-after",
  SEC_FETCH_SITE: "sec-fetch-site",
} as const;

export const JSON_CONTENT_TYPE = "application/json";
export const NO_STORE = "no-store";

export type HttpMethod = "GET" | "POST";

/** Ids in hub paths are UUIDs (the contract validates them with zod's `uuid()`). */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fiber node ids in hub paths: a compressed secp256k1 public key, 66 hex characters, 0x optional (as the hub accepts). */
export const FIBER_NODE_ID_PATTERN = /^(0x)?0[23][0-9a-f]{64}$/i;

/** Lightning node public keys in hub paths and bodies: 33-byte compressed secp256k1, 66 hex characters, no 0x. */
export const LIGHTNING_PUBKEY_PATTERN = /^0[23][0-9a-f]{64}$/i;

/**
 * A browser header the proxy passes on to the hub (a swap's cancel token, 64 hex characters from the hub): 1 to 128
 * visible ASCII characters once trimmed, as the hub reads its own headers. Anything else is dropped.
 */
export const FORWARDED_HEADER_VALUE_PATTERN = /^[\x21-\x7e]{1,128}$/;

/** Browser-side timings of the live swap form. */
export const HUB_CLIENT_TIMING = {
  /** An open swap is read again this often until it is final. */
  swapPollMs: 2_000,
  /** A live or degraded hub is checked again this often; an unconfigured one is not. */
  statusRefreshMs: 60_000,
  /** Typing pauses this long before a quote is requested, so each keystroke does not create one. */
  quoteDebounceMs: 400,
  /** A Lightning channel from the hub is read again this often while it opens (Mutinynet confirms it in minutes). */
  lightningChannelPollMs: 10_000,
  /** An external node's Fiber channel from the hub is read again this often while it opens (CKB confirms in minutes). */
  fiberChannelPollMs: 10_000,
} as const;

/** The page's tag when a hub is live. */
export const LIVE_TAG = "Live on testnet";

export const MS_PER_SECOND = 1_000;
export const SATS_PER_BTC = 100_000_000;
export const BASIS_POINTS_PER_PERCENT = 100;
