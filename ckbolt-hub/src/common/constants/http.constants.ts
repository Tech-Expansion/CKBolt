import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE, type ApiErrorCode } from "./api.constants";
import { MS_PER_HOUR, MS_PER_MINUTE } from "./protocol.constants";

/**
 * HTTP conventions of the REST API: header names, route parameters, rate-limit windows, and how framework errors map
 * to the `{ error: { code, message } }` body. Routes and error codes themselves are in api.constants.ts.
 */

export const HTTP_HEADER = {
  LOCATION: "Location",
  RETRY_AFTER: "Retry-After",
  /** Node lower-cases incoming header names. */
  FORWARDED_FOR: "x-forwarded-for",
  /** X-CKBolt-Proxy-Secret: HUB_PROXY_SECRET, sent by the web app's proxy (and the deploy kit) on every request. */
  PROXY_SECRET: "x-ckbolt-proxy-secret",
  /** X-CKBolt-Client: the visitor the web app's proxy forwards, trusted only on a request with the proxy secret. */
  PROXIED_CLIENT: "x-ckbolt-client",
  /** X-CKBolt-Cancel-Token: the cancel token POST /v1/swaps answered with, on POST /v1/swaps/:id/cancel. */
  CANCEL_TOKEN: "x-ckbolt-cancel-token",
} as const;

/** Route parameter names, and the path segments that capture a resource id, a Fiber node id and a Lightning pubkey. */
export const ROUTE_PARAM = { ID: "id", NODE_ID: "nodeId", PUBKEY: "pubkey" } as const;
export const ID_PATH_SEGMENT = `:${ROUTE_PARAM.ID}`;
export const NODE_ID_PATH_SEGMENT = `:${ROUTE_PARAM.NODE_ID}`;
export const PUBKEY_PATH_SEGMENT = `:${ROUTE_PARAM.PUBKEY}`;

/**
 * The largest JSON body the hub reads (body-parser's size syntax). Its largest request is a swap with a payout invoice
 * of a few kilobytes at most; anything bigger answers 413.
 */
export const JSON_BODY_LIMIT = "16kb";

/** HUB_PROXY_SECRET's shortest length: a value people could guess or brute-force is refused at start-up. */
export const PROXY_SECRET_MIN_LENGTH = 32;
/**
 * An X-CKBolt-Client value the hub counts a client by, once trimmed: 1 to 128 printable ASCII characters (an IPv6
 * address with a zone fits). Anything else falls back to the request's own address.
 */
export const PROXIED_CLIENT_KEY_PATTERN = /^[\x20-\x7e]{1,128}$/;

/** X-Forwarded-For reads "client, proxy1, proxy2": the last entry is the address our own proxy saw. */
export const FORWARDED_FOR_SEPARATOR = ",";
/** Rate-limit key for a request whose address cannot be read (all such requests share one bucket). */
export const UNKNOWN_CLIENT_KEY = "unknown";
/** Rate-limit key of a budget every client shares (DemoRateLimitGuard's hourly total). */
export const ALL_CLIENTS_KEY = "*";

/**
 * Loopback and private address ranges (RFC 1918, IPv6 unique local fc00::/7). A proxy the hub trusts with
 * X-Forwarded-For connects from one of them, and HUB_TRUST_PROXY needs HUB_HOST to be one of them: a client on the
 * internet that reaches the hub directly would otherwise choose its own rate-limit key.
 */
export const LOCAL_NETWORKS: readonly { address: string; prefix: number; family: "ipv4" | "ipv6" }[] = [
  { address: "127.0.0.0", prefix: 8, family: "ipv4" },
  { address: "10.0.0.0", prefix: 8, family: "ipv4" },
  { address: "172.16.0.0", prefix: 12, family: "ipv4" },
  { address: "192.168.0.0", prefix: 16, family: "ipv4" },
  { address: "::1", prefix: 128, family: "ipv6" },
  { address: "fc00::", prefix: 7, family: "ipv6" },
];
/** The host name every system resolves to its loopback address. */
export const LOCALHOST_NAME = "localhost";
/**
 * Bind addresses that mean "every interface". Allowed with HUB_TRUST_PROXY because a container must bind them to be
 * reached through its published port; X-Forwarded-For is then still trusted only from a LOCAL_NETWORKS peer.
 */
export const ALL_INTERFACES_ADDRESSES: readonly string[] = ["0.0.0.0", "::"];

/** Retry-After is at least this many seconds: 0 would invite an immediate retry. */
export const MIN_RETRY_AFTER_SECONDS = 1;

/** HubConfig.server.rateLimitPerMinute counts requests per client in this window. */
export const RATE_LIMIT_WINDOW_MS = MS_PER_MINUTE;
/** HubConfig.demo.maxActionsPerHour counts demo-wallet actions per client in this window. */
export const DEMO_RATE_LIMIT_WINDOW_MS = MS_PER_HOUR;

/** DemoPaymentDto.status values. */
export const DEMO_PAYMENT_STATUS = { SUBMITTED: "submitted" } as const;

/** HTTP status of GET /v1/health by report status. */
export const HEALTH_HTTP_STATUS = {
  ok: HttpStatus.OK,
  degraded: HttpStatus.SERVICE_UNAVAILABLE,
} as const;

/** Error code for a status raised by the framework rather than by a HubError (unknown route, unreadable body...). */
export const ERROR_CODE_BY_STATUS: Readonly<Partial<Record<number, ApiErrorCode>>> = {
  [HttpStatus.BAD_REQUEST]: API_ERROR_CODE.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: API_ERROR_CODE.UNAUTHORIZED,
  [HttpStatus.NOT_FOUND]: API_ERROR_CODE.NOT_FOUND,
  [HttpStatus.TOO_MANY_REQUESTS]: API_ERROR_CODE.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: API_ERROR_CODE.UPSTREAM_UNAVAILABLE,
};

/** Plain sentences for errors that carry no user-facing message of their own. */
export const HTTP_ERROR_MESSAGE = {
  INTERNAL: "The hub hit an unexpected error. Try again later.",
  CLIENT: "The hub could not handle this request. Check the method, the path and the body.",
  BAD_REQUEST: "The request could not be read. Send a JSON body that matches the API.",
  NOT_FOUND: "This route does not exist. Check the method and the path.",
  PAYLOAD_TOO_LARGE: "The request body is too large.",
  RATE_LIMITED: "Too many requests from this client. Wait a moment and try again.",
  DEMO_RATE_LIMITED: "This client has used the demo wallet too often. Try again later.",
  DEMO_TOTAL_RATE_LIMITED: "The demo wallet has been used too often in the last hour. Try again later.",
  UNAUTHORIZED: "This hub answers only the CKBolt web app. Use the app instead of calling the hub directly.",
  MAINTENANCE:
    "The hub is paused for maintenance and takes no new swaps or channels right now. Swaps already started finish as usual; try again later.",
} as const;

/** Message for a framework error by status; anything else uses HTTP_ERROR_MESSAGE.CLIENT or .INTERNAL. */
export const ERROR_MESSAGE_BY_STATUS: Readonly<Partial<Record<number, string>>> = {
  [HttpStatus.BAD_REQUEST]: HTTP_ERROR_MESSAGE.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: HTTP_ERROR_MESSAGE.UNAUTHORIZED,
  [HttpStatus.NOT_FOUND]: HTTP_ERROR_MESSAGE.NOT_FOUND,
  [HttpStatus.PAYLOAD_TOO_LARGE]: HTTP_ERROR_MESSAGE.PAYLOAD_TOO_LARGE,
  [HttpStatus.TOO_MANY_REQUESTS]: HTTP_ERROR_MESSAGE.RATE_LIMITED,
};

/** How validation issues are joined into one message: "Invalid request. quoteId: Invalid uuid; amount: Required." */
export const VALIDATION_MESSAGE = {
  PREFIX: "Invalid request.",
  PATH_SEPARATOR: ".",
  FIELD_SEPARATOR: ": ",
  ISSUE_SEPARATOR: "; ",
  END: ".",
} as const;
