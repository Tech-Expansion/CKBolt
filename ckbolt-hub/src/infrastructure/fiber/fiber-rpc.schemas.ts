import { z } from "zod";
import { FIBER_PUBSUB, FIBER_RPC_METHOD } from "../../common/constants/fiber-rpc.constants";

/**
 * fnn v0.9.1 wire format (docs/research/fiber-node.md 2.0): snake_case fields, u64/u128 as 0x hex strings, Hash256 as
 * 0x hex, Script as {code_hash, hash_type, args}. Results are validated here; hex values are converted by the mappers.
 * Only the fields the hub reads are listed; anything else the node sends is dropped.
 */

/* ------------------------------------------------------------------------------------------------- Envelope */

const jsonRpcErrorSchema = z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() });

/** A JSON-RPC 2.0 response or notification. */
export const jsonRpcMessageSchema = z.object({
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: jsonRpcErrorSchema.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});

export type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>;

/* -------------------------------------------------------------------------------------------------- Results */

const hexString = z.string();

export const rpcScriptSchema = z.object({ code_hash: hexString, hash_type: z.string(), args: hexString });

const ckbInvoiceSchema = z.object({
  currency: z.string(),
  amount: hexString.nullish(),
  data: z.object({
    timestamp: hexString,
    payment_hash: hexString,
    attrs: z.array(z.record(z.string(), z.unknown())).default([]),
  }),
});

const invoiceResultSchema = z.object({ invoice_address: z.string(), invoice: ckbInvoiceSchema });
const parseInvoiceResultSchema = z.object({ invoice: ckbInvoiceSchema });
const getInvoiceResultSchema = invoiceResultSchema.extend({ status: z.string() });

const paymentResultSchema = z.object({
  payment_hash: hexString,
  status: z.string(),
  payment_preimage: hexString.nullish(),
  fee: hexString.nullish(),
  failed_error: z.string().nullish(),
});

const pendingTlcSchema = z.object({
  amount: hexString,
  payment_hash: hexString,
  /** Absolute, ms since the epoch. */
  expiry: hexString,
  forwarding_channel_id: hexString.nullish(),
  /** `{ "Inbound": "Committed" }` style; read leniently by the mappers. */
  status: z.unknown(),
});

const channelSchema = z.object({
  channel_id: hexString,
  /** The peer's public key (was `peer_id` before v0.8.0). */
  pubkey: z.string(),
  funding_udt_type_script: rpcScriptSchema.nullish(),
  state: z.object({ state_name: z.string() }),
  /** True when the peer opened the channel (and so chose its commitment delay). */
  is_acceptor: z.boolean().optional(),
  /** Announced to the network. */
  is_public: z.boolean().optional(),
  local_balance: hexString,
  remote_balance: hexString,
  enabled: z.boolean().optional(),
  pending_tlcs: z.array(pendingTlcSchema).default([]),
  /** u64 hex, ms since the epoch: when the channel (or the request to open it) was made. */
  created_at: hexString.optional(),
});

const listChannelsResultSchema = z.object({ channels: z.array(channelSchema) });
/** `chain_hash` is the genesis hash of the CKB chain the node runs on. */
const nodeInfoResultSchema = z.object({ version: z.string(), pubkey: z.string(), chain_hash: hexString });
/** A connected peer; fnn also sends its address, which the hub does not read. */
const peerSchema = z.object({ pubkey: z.string() });
const listPeersResultSchema = z.object({ peers: z.array(peerSchema) });
const openChannelResultSchema = z.object({ temporary_channel_id: hexString });
/** settle_invoice and cancel_invoice results carry nothing the hub needs. */
const ignoredResultSchema = z.unknown();

export type RpcScript = z.infer<typeof rpcScriptSchema>;
export type RpcCkbInvoice = z.infer<typeof ckbInvoiceSchema>;
export type RpcInvoiceResult = z.infer<typeof invoiceResultSchema>;
export type RpcParseInvoiceResult = z.infer<typeof parseInvoiceResultSchema>;
export type RpcGetInvoiceResult = z.infer<typeof getInvoiceResultSchema>;
export type RpcPaymentResult = z.infer<typeof paymentResultSchema>;
export type RpcPendingTlc = z.infer<typeof pendingTlcSchema>;
export type RpcChannel = z.infer<typeof channelSchema>;
export type RpcListChannelsResult = z.infer<typeof listChannelsResultSchema>;
export type RpcNodeInfoResult = z.infer<typeof nodeInfoResultSchema>;
export type RpcListPeersResult = z.infer<typeof listPeersResultSchema>;
export type RpcOpenChannelResult = z.infer<typeof openChannelResultSchema>;

/* ------------------------------------------------------------------------------------------------ Params */

export interface RpcNewInvoiceParams {
  amount: string;
  currency: string;
  description: string;
  hash_algorithm: string;
  expiry: string;
  payment_hash?: string;
  payment_preimage?: string;
  final_expiry_delta?: string;
  udt_type_script?: RpcScript;
}

export interface RpcParseInvoiceParams {
  invoice: string;
}

export interface RpcPaymentHashParams {
  payment_hash: string;
}

export interface RpcSettleInvoiceParams extends RpcPaymentHashParams {
  payment_preimage: string;
}

export interface RpcSendPaymentParams {
  invoice: string;
  max_fee_amount: string;
  tlc_expiry_limit: string;
  max_parts: string;
  max_fee_rate?: string;
}

/**
 * Every field is optional: without `pubkey` fnn lists the channels with every peer. Without a flag it lists the channels
 * it keeps a state for, closed ones left out. `only_pending` lists only the channels still opening or that failed to
 * open, including one the node asked a peer to open that the peer has not accepted yet, which the plain listing leaves
 * out. fnn refuses `only_pending` together with `include_closed` (which the hub does not use).
 */
export interface RpcListChannelsParams {
  pubkey?: string;
  only_pending?: boolean;
}

/** open_channel: the peer must be connected. Fields left out keep fnn's defaults (commitment delay 1 epoch, fees). */
export interface RpcOpenChannelParams {
  pubkey: string;
  funding_amount: string;
  public: boolean;
  funding_udt_type_script?: RpcScript;
}

/** abandon_channel: a channel that is not funded yet, by its temporary or final id. */
export interface RpcAbandonChannelParams {
  channel_id: string;
}

/** shutdown_channel with `force`: fnn broadcasts its latest commitment (close_script and fee_rate are then ignored). */
export interface RpcShutdownChannelParams {
  channel_id: string;
  force: boolean;
}

/* ------------------------------------------------------------------------------------------- Method registry */

/** Params (as the positional array fnn expects: one object, or none) and result per method. */
export interface FiberRpcCalls {
  [FIBER_RPC_METHOD.NODE_INFO]: { params: []; result: RpcNodeInfoResult };
  [FIBER_RPC_METHOD.NEW_INVOICE]: { params: [RpcNewInvoiceParams]; result: RpcInvoiceResult };
  [FIBER_RPC_METHOD.PARSE_INVOICE]: { params: [RpcParseInvoiceParams]; result: RpcParseInvoiceResult };
  [FIBER_RPC_METHOD.GET_INVOICE]: { params: [RpcPaymentHashParams]; result: RpcGetInvoiceResult };
  [FIBER_RPC_METHOD.SETTLE_INVOICE]: { params: [RpcSettleInvoiceParams]; result: unknown };
  [FIBER_RPC_METHOD.CANCEL_INVOICE]: { params: [RpcPaymentHashParams]; result: unknown };
  [FIBER_RPC_METHOD.SEND_PAYMENT]: { params: [RpcSendPaymentParams]; result: RpcPaymentResult };
  [FIBER_RPC_METHOD.GET_PAYMENT]: { params: [RpcPaymentHashParams]; result: RpcPaymentResult };
  [FIBER_RPC_METHOD.LIST_CHANNELS]: { params: [RpcListChannelsParams]; result: RpcListChannelsResult };
  [FIBER_RPC_METHOD.LIST_PEERS]: { params: []; result: RpcListPeersResult };
  [FIBER_RPC_METHOD.OPEN_CHANNEL]: { params: [RpcOpenChannelParams]; result: RpcOpenChannelResult };
  [FIBER_RPC_METHOD.ABANDON_CHANNEL]: { params: [RpcAbandonChannelParams]; result: unknown };
  [FIBER_RPC_METHOD.SHUTDOWN_CHANNEL]: { params: [RpcShutdownChannelParams]; result: unknown };
}

export type FiberRpcParams<M extends keyof FiberRpcCalls> = FiberRpcCalls[M]["params"];
export type FiberRpcResult<M extends keyof FiberRpcCalls> = FiberRpcCalls[M]["result"];

export const FIBER_RPC_RESULT_SCHEMAS: { [M in keyof FiberRpcCalls]: z.ZodType<FiberRpcResult<M>, z.ZodTypeDef, unknown> } = {
  [FIBER_RPC_METHOD.NODE_INFO]: nodeInfoResultSchema,
  [FIBER_RPC_METHOD.NEW_INVOICE]: invoiceResultSchema,
  [FIBER_RPC_METHOD.PARSE_INVOICE]: parseInvoiceResultSchema,
  [FIBER_RPC_METHOD.GET_INVOICE]: getInvoiceResultSchema,
  [FIBER_RPC_METHOD.SETTLE_INVOICE]: ignoredResultSchema,
  [FIBER_RPC_METHOD.CANCEL_INVOICE]: ignoredResultSchema,
  [FIBER_RPC_METHOD.SEND_PAYMENT]: paymentResultSchema,
  [FIBER_RPC_METHOD.GET_PAYMENT]: paymentResultSchema,
  [FIBER_RPC_METHOD.LIST_CHANNELS]: listChannelsResultSchema,
  [FIBER_RPC_METHOD.LIST_PEERS]: listPeersResultSchema,
  [FIBER_RPC_METHOD.OPEN_CHANNEL]: openChannelResultSchema,
  [FIBER_RPC_METHOD.ABANDON_CHANNEL]: ignoredResultSchema,
  [FIBER_RPC_METHOD.SHUTDOWN_CHANNEL]: ignoredResultSchema,
};

/* ---------------------------------------------------------------------------------------- Store changes */

/**
 * A `store_changes` push: `params.result` is an externally tagged StoreChange (PutCkbInvoiceStatus, PutPreimage,
 * PutPaymentSession, PutAttempt); every variant carries `payment_hash`.
 */
export const storeChangeNotificationSchema = z.object({
  method: z.literal(FIBER_PUBSUB.NOTIFICATION_METHOD),
  params: z.object({
    result: z.record(z.string(), z.object({ payment_hash: hexString })),
  }),
});

/** Anything the adapter calls over JSON-RPC: the HTTP client, or a recording in tests. */
export interface FiberRpc {
  request<M extends keyof FiberRpcCalls>(method: M, ...params: FiberRpcParams<M>): Promise<FiberRpcResult<M>>;
}
