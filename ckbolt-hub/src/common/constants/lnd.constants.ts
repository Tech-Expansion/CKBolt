import { MS_PER_SECOND } from "./protocol.constants";

/**
 * Wire facts of LND v0.21.4 over gRPC and of the `lightning` npm package 13.1.7 that wraps it
 * (docs/research/lnd.md sections 1-3). Protocol values only; connection settings and payment policy come from HubConfig.
 */

/* ------------------------------------------------------------------------------------------------------- gRPC */

/** gRPC status codes the hub reacts to (grpc/doc/statuscodes.md). */
export const GRPC_STATUS = {
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

/** The call may not have reached LND, or its answer was lost: the outcome is unknown. */
export const GRPC_TRANSPORT_FAILURE_CODES: readonly number[] = [GRPC_STATUS.UNAVAILABLE, GRPC_STATUS.DEADLINE_EXCEEDED];

/** LND refused the macaroon, or the macaroon lacks the permission the call needs. */
export const GRPC_ACCESS_DENIED_CODES: readonly number[] = [GRPC_STATUS.PERMISSION_DENIED, GRPC_STATUS.UNAUTHENTICATED];

/* ------------------------------------------------------------------------------------------------ LND (v0.21.4) */

/** LND RPC names, for error messages and logs. */
export const LND_RPC = {
  GET_INFO: "GetInfo",
  DECODE_PAY_REQ: "DecodePayReq",
  ADD_HOLD_INVOICE: "AddHoldInvoice",
  ADD_INVOICE: "AddInvoice",
  LOOKUP_INVOICE: "LookupInvoice",
  SETTLE_INVOICE: "SettleInvoice",
  CANCEL_INVOICE: "CancelInvoice",
  SEND_PAYMENT: "SendPaymentV2",
  TRACK_PAYMENT: "TrackPaymentV2",
  CHANNEL_BALANCE: "ChannelBalance",
  WALLET_BALANCE: "WalletBalance",
  LIST_PEERS: "ListPeers",
  LIST_CHANNELS: "ListChannels",
  PENDING_CHANNELS: "PendingChannels",
  OPEN_CHANNEL_SYNC: "OpenChannelSync",
} as const;

/**
 * lnrpc.CommitmentType of the channels the hub opens to wallets: static_remote_key, without anchor outputs. LDK wallets
 * (Alby Hub) refuse an anchor channel unless they keep an on-chain reserve to bump its fees, which a new wallet lacks.
 */
export const LND_STATIC_REMOTE_KEY_COMMITMENT = "STATIC_REMOTE_KEY";

/** How the hub has LND fund a channel it opens to a wallet (OpenChannelSync). */
export const LND_OPEN_CHANNEL = {
  /** Blocks the funding transaction's fee aims to confirm in: the `lightning` package's openChannel default. */
  CONF_TARGET_BLOCKS: 6,
  /** Spend only confirmed outputs, the ones the hub checks the wallet balance of before it opens. */
  MIN_CONFS: 1,
  /**
   * How long the call may take: LND answers once the peer has accepted the channel and the funding is published, a few
   * seconds. A peer that never answers (or stalls on purpose) would otherwise hold the queue of opens, so it is short.
   */
  DEADLINE_MS: 20 * MS_PER_SECOND,
} as const;

/** Error texts LND puts in the gRPC status details. Matched as substrings. */
export const LND_ERROR_DETAILS = {
  /** invoices.ErrInvoiceNotFound */
  INVOICE_NOT_FOUND: "unable to locate invoice",
  /** invoices.ErrNoInvoicesCreated: the node has never created an invoice. */
  NO_INVOICES_YET: "there are no existing invoices",
  /** invoices.ErrInvoiceAlreadySettled: SettleInvoice already treats it as success; kept as a guard. */
  INVOICE_ALREADY_SETTLED: "invoice already settled",
  /** invoices.ErrInvoiceAlreadyCanceled: CancelInvoice already treats it as success; kept as a guard. */
  INVOICE_ALREADY_CANCELED: "invoice already canceled",
  /** invoices.ErrDuplicateInvoice from AddHoldInvoice. */
  DUPLICATE_INVOICE: "invoice with payment hash already exists",
  /** zpay32.Decode: the BOLT11 prefix does not match the node's network. */
  WRONG_NETWORK_INVOICE: "invoice not for current active network",
  /** Macaroon checks. */
  PERMISSION_DENIED: "permission denied",
} as const;

/** lnrpc.PaymentFailureReason names, as LnPaymentStatus.failureReason reports them. */
export const LND_PAYMENT_FAILURE_REASON = {
  TIMEOUT: "FAILURE_REASON_TIMEOUT",
  NO_ROUTE: "FAILURE_REASON_NO_ROUTE",
  ERROR: "FAILURE_REASON_ERROR",
  INCORRECT_PAYMENT_DETAILS: "FAILURE_REASON_INCORRECT_PAYMENT_DETAILS",
  INSUFFICIENT_BALANCE: "FAILURE_REASON_INSUFFICIENT_BALANCE",
  CANCELED: "FAILURE_REASON_CANCELED",
} as const;

/** Failure reasons for payments refused before LND was asked to send: no HTLC was ever in flight. */
export const LN_PAYMENT_REFUSAL_REASON = {
  /** cltv_limit does not exceed the invoice's final CLTV plus LND's block padding, so no route can fit. */
  CLTV_LIMIT_TOO_LOW: "CLTV_LIMIT_TOO_LOW",
  /** The invoice requires a feature LND cannot pay (AMP feature bits). */
  UNSUPPORTED_INVOICE_FEATURE: "UNSUPPORTED_INVOICE_FEATURE",
} as const;

/* ------------------------------------------------------------------------------------- `lightning` 13.1.7 */

/** Error names in the `[code, name, details]` arrays the `lightning` package rejects with. */
export const LIGHTNING_LIB_ERROR = {
  /** getPayment: LND has no payment for that hash ("payment isn't initiated"). */
  PAYMENT_NOT_FOUND: "SentPaymentNotFound",
  /** subscribeToPay: max_timeout_height leaves less than the invoice's final CLTV plus 3 blocks. */
  MAX_TIMEOUT_TOO_NEAR: "MaxTimeoutTooNearCurrentHeightToMakePayment",
  /** subscribeToPay: the invoice requires AMP feature bits. */
  UNSUPPORTED_PAYMENT_FEATURE: "UnsupportedPaymentFeatureInPayRequest",
  /** getWalletInfo: the gRPC call could not connect (UNAVAILABLE or a connection text); the gRPC error is dropped. */
  DAEMON_UNREACHABLE: "FailedToConnectToDaemon",
  /** getWalletInfo: the wallet is locked, so LND does not serve lnrpc.Lightning yet; the gRPC error is dropped. */
  LND_LOCKED: "LndLocked",
} as const;

/** Errors the package raises in place of LND's gRPC error when the node cannot serve calls at all. */
export const LIGHTNING_LIB_NODE_UNAVAILABLE_ERRORS: readonly string[] = [LIGHTNING_LIB_ERROR.DAEMON_UNREACHABLE, LIGHTNING_LIB_ERROR.LND_LOCKED];

/** Refusals the `lightning` package raises before it calls SendPaymentV2, by error name: nothing was sent. */
export const LIGHTNING_LIB_PAY_REFUSALS: Readonly<Record<string, string>> = {
  [LIGHTNING_LIB_ERROR.MAX_TIMEOUT_TOO_NEAR]: LN_PAYMENT_REFUSAL_REASON.CLTV_LIMIT_TOO_LOW,
  [LIGHTNING_LIB_ERROR.UNSUPPORTED_PAYMENT_FEATURE]: LN_PAYMENT_REFUSAL_REASON.UNSUPPORTED_INVOICE_FEATURE,
};

/**
 * The OpenChannelSync method on the authenticated client's `default` service (grpc-js names methods in lowerCamelCase).
 * The package's own openChannel uses the OpenChannel stream and cannot ask for a commitment type other than anchors.
 */
export const LIGHTNING_LIB_OPEN_CHANNEL_SYNC_METHOD = "openChannelSync";

/** Events of the `lightning` package's subscription emitters. */
export const LIGHTNING_LIB_EVENT = {
  PAYING: "paying",
  CONFIRMED: "confirmed",
  FAILED: "failed",
  ERROR: "error",
  END: "end",
  INVOICE_UPDATED: "invoice_updated",
} as const;

/* ------------------------------------------------------------------------------------------------------ BOLT 11 */

/** min_final_cltv_expiry of an invoice without a `c` field (BOLT 11). */
export const BOLT11_DEFAULT_MIN_FINAL_CLTV_EXPIRY = 18;
