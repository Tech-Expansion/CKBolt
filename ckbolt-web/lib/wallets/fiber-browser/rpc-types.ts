/**
 * The part of Fiber's node RPC (fnn / fiber-js 0.9.1, `invokeCommand(name, [params])`) the browser node uses, in its
 * wire form: snake_case keys, numbers as 0x hex quantities. Mirrors `@nervosnetwork/fiber-js` dist/types, kept here so
 * the app and the tests' fake node do not depend on the 15 MB bundle's typings.
 */

export const FIBER_RPC = {
  NODE_INFO: "node_info",
  CONNECT_PEER: "connect_peer",
  LIST_PEERS: "list_peers",
  OPEN_CHANNEL: "open_channel",
  ACCEPT_CHANNEL: "accept_channel",
  LIST_CHANNELS: "list_channels",
  SHUTDOWN_CHANNEL: "shutdown_channel",
  NEW_INVOICE: "new_invoice",
  PARSE_INVOICE: "parse_invoice",
  GET_INVOICE: "get_invoice",
  CANCEL_INVOICE: "cancel_invoice",
  SEND_PAYMENT: "send_payment",
  GET_PAYMENT: "get_payment",
} as const;

export type FiberRpcName = (typeof FIBER_RPC)[keyof typeof FIBER_RPC];

export interface RpcScript {
  code_hash: string;
  hash_type: "data" | "type" | "data1" | "data2";
  args: string;
}

export interface RpcNodeInfo {
  version: string;
  pubkey: string;
  default_funding_lock_script: RpcScript;
  channel_count?: string;
  pending_channel_count?: string;
  peers_count?: string;
}

export interface RpcChannel {
  channel_id: string;
  is_public: boolean;
  pubkey: string;
  funding_udt_type_script?: RpcScript | null;
  state: { state_name: string; state_flags?: unknown };
  local_balance: string;
  remote_balance: string;
  offered_tlc_balance?: string;
  received_tlc_balance?: string;
  enabled: boolean;
}

/**
 * shutdown_channel: a cooperative close. `close_script` is the lock that receives this node's share (fnn's default: its
 * `default_funding_lock_script`); fnn 0.9.1 sends it to the peer, which checks only that the shutdown fee covers it.
 */
export interface RpcShutdownChannelParams {
  channel_id: string;
  close_script?: RpcScript;
  fee_rate?: string;
  force?: boolean;
}

export interface RpcNewInvoiceParams {
  amount: string;
  currency: "Fibb" | "Fibt" | "Fibd";
  payment_preimage: string;
  expiry: string;
  description: string;
  hash_algorithm: "sha256" | "ckb_hash";
  udt_type_script?: RpcScript;
}

/** `invoice_address` is the encoded invoice ("fibt1..."). */
export interface RpcInvoiceResult {
  invoice_address: string;
  invoice: { data: { payment_hash: string; attrs?: unknown[] }; amount?: string; currency?: string };
}

export interface RpcGetInvoiceResult extends RpcInvoiceResult {
  status: "Open" | "Cancelled" | "Expired" | "Received" | "Paid";
}

/** An invoice as fnn reads it: `data.timestamp` in ms, `attrs` single-key objects (FIBER_INVOICE_ATTR). */
export interface RpcCkbInvoice {
  currency: string;
  amount?: string | null;
  signature?: string | null;
  data: { timestamp: string; payment_hash: string; attrs?: Record<string, unknown>[] };
}

export interface RpcParseInvoiceResult {
  invoice: RpcCkbInvoice;
}

/**
 * send_payment: the node pays an invoice alone (it carries the payee, amount, hash and token); `max_fee_amount` caps the
 * routing fee (fnn also caps it at its default rate of 0.5 % of the amount). `trampoline_hops` (node ids) sends it
 * through trampoline nodes, which find the route on from the first one (fnn requires `max_fee_amount` with it);
 * `dry_run` builds the route and fee without sending (no route: an RPC error; no payment session is kept).
 */
export interface RpcSendPaymentParams {
  invoice: string;
  max_fee_amount?: string;
  trampoline_hops?: string[];
  dry_run?: boolean;
}

/** open_channel: the peer must be connected first; a token channel names the token's script. */
export interface RpcOpenChannelParams {
  pubkey: string;
  funding_amount: string;
  public: boolean;
  funding_udt_type_script?: RpcScript;
}

/** accept_channel (fnn v0.9.1): `funding_amount` includes the node's channel reserve. */
export interface RpcAcceptChannelParams {
  temporary_channel_id: string;
  funding_amount: string;
  shutdown_script?: RpcScript;
}

export interface RpcAcceptChannelResult {
  /** The channel's final id. */
  channel_id: string;
}

export interface RpcPaymentResult {
  payment_hash: string;
  status: "Created" | "Inflight" | "Success" | "Failed";
  failed_error?: string | null;
  fee?: string;
}
