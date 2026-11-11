/** REST API conventions. Routes are resource nouns under a version prefix. */
export const API_VERSION = "1";

export const API_ROUTES = {
  HEALTH: "health",
  ASSETS: "assets",
  QUOTES: "quotes",
  SWAPS: "swaps",
  SWAP_EVENTS: "events",
  /** A sub-resource of one swap: POST /v1/swaps/:id/cancel. */
  SWAP_CANCEL: "cancel",
  DEMO_INVOICES: "demo/invoices",
  DEMO_PAYMENTS: "demo/payments",
  /** The hub's Fiber node as other Fiber nodes (a browser node) see it. */
  FIBER_NODE: "fiber/node",
  /** Channels the hub's Fiber node opens to a connected node, so that node can receive. */
  FIBER_INBOUND_CHANNELS: "fiber/inbound-channels",
  /** The hub's Lightning node as Lightning wallets see it. */
  LIGHTNING_NODE: "lightning/node",
  /** Channels the hub's Lightning node opens to a connected wallet, so that wallet can pay the hub directly. */
  LIGHTNING_INBOUND_CHANNELS: "lightning/inbound-channels",
} as const;

/**
 * Error codes in the `{ error: { code, message } }` body. Add new ones here and to the table in docs/architecture.md,
 * which gives the HTTP status each one is sent with.
 */
export const API_ERROR_CODE = {
  BAD_REQUEST: "bad_request",
  /** HUB_PROXY_SECRET is set and the request does not carry it: only the web app's proxy may call the hub. */
  UNAUTHORIZED: "unauthorized",
  VALIDATION: "validation_failed",
  NOT_FOUND: "not_found",
  /** The request conflicts with the resource's current state (a quote that already has a swap, a swap already paid). */
  CONFLICT: "conflict",
  QUOTE_EXPIRED: "quote_expired",
  QUOTE_UNAVAILABLE: "quote_unavailable",
  /** A quote `purpose` the hub does not serve for the direction asked: request quotes are ln_to_fiber only. */
  PURPOSE_UNSUPPORTED: "purpose_unsupported",
  /** POST /v1/swaps/:id/cancel without the swap's cancel token: the same answer whether it is missing or wrong. */
  CANCEL_REFUSED: "cancel_refused",
  /** A valid asset the hub does not serve on its network. */
  ASSET_UNAVAILABLE: "asset_unavailable",
  INVOICE_INVALID: "invoice_invalid",
  DUPLICATE_HASH: "duplicate_hash",
  INSUFFICIENT_LIQUIDITY: "insufficient_liquidity",
  DEMO_DISABLED: "demo_disabled",
  /** The hub does not open inbound channels of that kind (FIBER_INBOUND_ENABLED or LN_INBOUND_ENABLED is off). */
  INBOUND_DISABLED: "inbound_disabled",
  RATE_LIMITED: "rate_limited",
  UPSTREAM_UNAVAILABLE: "upstream_unavailable",
  /** SWAPS_PAUSED: the hub takes no new quote or swap; the swaps already running finish. */
  MAINTENANCE: "maintenance",
  INTERNAL: "internal_error",
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODE)[keyof typeof API_ERROR_CODE];

/** Resource names used in "<name> was not found." messages. */
export const RESOURCE_NAME = { QUOTE: "Quote", SWAP: "Swap" } as const;
