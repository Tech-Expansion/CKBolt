/**
 * Wire facts of the fnn v0.9.1 JSON-RPC API (docs/research/fiber-node.md sections 2 and 7). Protocol values only;
 * Fiber policy, connection settings and client timings (RPC timeout, pubsub reconnect delay) come from HubConfig.
 */

/* ---------------------------------------------------------------------------------------------- JSON-RPC 2.0 */

export const JSON_RPC_VERSION = "2.0";

/** HTTP transport: JSON-RPC requests are POSTed as JSON to the RPC root (default port 8227). */
export const FIBER_RPC_HTTP = {
  METHOD: "POST",
  CONTENT_TYPE: "application/json",
  CONTENT_TYPE_HEADER: "content-type",
  AUTHORIZATION_HEADER: "authorization",
  /** Biscuit tokens travel as `Authorization: Bearer <token>`. */
  AUTH_SCHEME: "Bearer",
} as const;

/** The WebSocket endpoint shares the HTTP RPC host and port; only the scheme changes. */
export const FIBER_WS_PROTOCOL_BY_HTTP: Readonly<Record<string, string>> = {
  "http:": "ws:",
  "https:": "wss:",
};

/* --------------------------------------------------------------------------------------------- Method names */

/** RPC methods the hub calls over HTTP. */
export const FIBER_RPC_METHOD = {
  NODE_INFO: "node_info",
  NEW_INVOICE: "new_invoice",
  PARSE_INVOICE: "parse_invoice",
  GET_INVOICE: "get_invoice",
  SETTLE_INVOICE: "settle_invoice",
  CANCEL_INVOICE: "cancel_invoice",
  SEND_PAYMENT: "send_payment",
  GET_PAYMENT: "get_payment",
  LIST_CHANNELS: "list_channels",
  LIST_PEERS: "list_peers",
  OPEN_CHANNEL: "open_channel",
  ABANDON_CHANNEL: "abandon_channel",
  SHUTDOWN_CHANNEL: "shutdown_channel",
} as const;

/** Push notifications (module `pubsub`, WebSocket only). Events are live only: no replay, no `Expired` event. */
export const FIBER_PUBSUB = {
  SUBSCRIBE_METHOD: "subscribe_store_changes",
  NOTIFICATION_METHOD: "store_changes",
} as const;

/* ------------------------------------------------------------------------------------------ Invoice details */

/** Keys of the single-key objects in `CkbInvoice.data.attrs`. */
export const FIBER_INVOICE_ATTR = {
  HASH_ALGORITHM: "hash_algorithm",
  /** u64 hex, ms. Written by new_invoice from `final_expiry_delta`. */
  FINAL_EXPIRY_DELTA: "final_htlc_minimum_expiry_delta",
  /** u64 hex, seconds after `data.timestamp`. Absent: the invoice never expires. */
  EXPIRY_TIME: "expiry_time",
  PAYEE_PUBLIC_KEY: "payee_public_key",
  /** 0x hex of a molecule-encoded CKB Script. */
  UDT_SCRIPT: "udt_script",
  /** Feature names the invoice sets, e.g. ["BASIC_MPP_OPTIONAL"] when it was made with `allow_mpp`. */
  FEATURE: "feature",
} as const;

/** Invoice feature names that let a payer split the payment into parts (fnn `allow_mpp()`: basic MPP supported). */
export const FIBER_MPP_FEATURES: readonly string[] = ["BASIC_MPP_REQUIRED", "BASIC_MPP_OPTIONAL"];

/** Hash algorithm fnn assumes when an invoice has no `hash_algorithm` attribute (blake2b). */
export const FIBER_DEFAULT_HASH_ALGORITHM = "ckb_hash" as const;

/* ---------------------------------------------------------------------------------------- Channels and TLCs */

/** `Channel.state.state_name` of a channel that can carry payments. */
export const FIBER_CHANNEL_READY_STATE = "ChannelReady";
/**
 * `state_name` of a channel this node asked a peer to open that the peer has not accepted yet (fnn v0.9.1: the opener
 * leaves it for CollaboratingFundingTx once the peer's AcceptChannel arrives). Nothing is funded yet.
 */
export const FIBER_CHANNEL_NEGOTIATING_STATE = "NegotiatingFunding";
/** `state_name` of a channel being closed cooperatively or by force. */
export const FIBER_CHANNEL_CLOSING_STATE = "ShuttingDown";
/**
 * `state_name` of a closed channel (list_channels shows it only with `include_closed`). Every state before ChannelReady
 * (NegotiatingFunding, CollaboratingFundingTx, SigningCommitment, AwaitingTxSignatures, AwaitingChannelReady) is a
 * channel being opened.
 */
export const FIBER_CHANNEL_CLOSED_STATE = "Closed";

/** `pending_tlcs[].status` is `{ <direction>: <state> }`; a held incoming TLC is Inbound and Committed. */
export const FIBER_TLC_DIRECTION_INBOUND = "Inbound";
/** A TLC this node offered (sent): a payment part. */
export const FIBER_TLC_DIRECTION_OUTBOUND = "Outbound";
/**
 * The one outbound TLC state in which the part is settled for good: the peer's removal (fulfil or fail) is acknowledged
 * on both commitments. fnn v0.9.1 keeps such a TLC in `pending_tlcs` until the channel's next update; every other
 * outbound state (LocalAnnounced, Committed, RemoteRemoved, RemoveWaitPrevAck, RemoveWaitAck) can still be claimed.
 */
export const FIBER_OUTBOUND_TLC_STATE_RESOLVED = "RemoveAckConfirmed";
export const FIBER_TLC_STATE_COMMITTED = "Committed";

/**
 * Inbound TLC states after the receiver removed the TLC (fulfilled it with the preimage, or failed it back) and before
 * the peer's acknowledgement drops it from `pending_tlcs`. Right after settle_invoice fnn v0.9.1 still reports the
 * invoice Received while its TLC passes through these states, for a few tens of milliseconds, then Paid.
 */
export const FIBER_TLC_REMOVAL_STATES: readonly string[] = ["LocalRemoved", "RemoveAckConfirmed"];

/* ------------------------------------------------------------------------------------------------ Payments */

/** `max_fee_rate` of send_payment is per mille: max_fee_amount is clamped to amount x rate / 1000. */
export const FIBER_FEE_RATE_DENOMINATOR = 1_000n;

/**
 * `max_parts` of every send_payment the hub makes: one part. fnn refuses it for an invoice that allows MPP, so a payment
 * never splits into parts a payee could hold back while the session already reads Failed.
 */
export const FIBER_SINGLE_PART_MAX_PARTS = 1;

/* ---------------------------------------------------------------------------------------------- RPC errors */

/**
 * fnn error texts the adapter turns into outcomes (code wins over README, see research 2.1). The "not found" ones are
 * the exact texts of each method: a lookup that resolves null lets the engine resend a payout, so any other error that
 * happens to say "not found" (a channel, a peer) must stay an error.
 */
export const FIBER_RPC_ERROR_PATTERN = {
  /** get_invoice on a hash this node has no invoice for (rpc/invoice.rs): "invoice not found". */
  INVOICE_NOT_FOUND: /^invoice not found$/,
  /** get_payment on a hash this node never paid (network.rs on_get_payment): "InvalidParameter: Payment session not found: ...". */
  PAYMENT_NOT_FOUND: /^(InvalidParameter: )?Payment session not found(: |$)/,
  /** new_invoice on a payment hash this node already has an invoice for. */
  INVOICE_ALREADY_EXISTS: /already exists|duplicated invoice/i,
} as const;
