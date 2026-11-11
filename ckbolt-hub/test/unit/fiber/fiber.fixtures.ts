import { FIBER_RPC_RESULT_SCHEMAS, type FiberRpc, type FiberRpcCalls, type FiberRpcParams, type FiberRpcResult } from "../../../src/infrastructure/fiber/fiber-rpc.schemas";
import { FiberRpcError } from "../../../src/infrastructure/fiber/fiber-rpc.errors";
import { MS_PER_HOUR, MS_PER_MINUTE } from "../../../src/common/constants/protocol.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import type { Hex32, Script } from "../../../src/domain/types";

/**
 * Shared values for the fiber tests. Wire objects are shaped like fnn v0.9.1 answers (docs/research/fiber-node.md
 * section 2): snake_case fields, u64/u128 as 0x hex, Hash256 as 0x hex, enums as fnn prints them.
 */

/* ------------------------------------------------------------------------------------------------ Values */

export const PREIMAGE: Hex32 = "5f1d6b3c0a9e8d7c6b5a493827161504f3e2d1c0b9a8978675645342312f1e0d";
export const PAYMENT_HASH: Hex32 = sha256Hex(PREIMAGE);
export const OTHER_PREIMAGE: Hex32 = "a0".repeat(32);
export const OTHER_HASH: Hex32 = sha256Hex(OTHER_PREIMAGE);

/** Testnet RUSD (research 3.2). */
export const RUSD_SCRIPT: Script = {
  codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hashType: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};

/** The RUSD script as molecule bytes, worked out by hand: total 85 (0x55), offsets 16, 48, 49, then the fields. */
export const RUSD_SCRIPT_MOLECULE =
  "0x55000000" +
  "10000000" +
  "30000000" +
  "31000000" +
  "1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a" +
  "01" +
  "20000000" +
  "878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b";

/** A 33-byte compressed public key as fnn prints it (no 0x). */
export const NODE_PUBKEY = `02${"ab".repeat(32)}`;
export const PEER_PUBKEY = `03${"cd".repeat(32)}`;
export const CHANNEL_ID = `0x${"c1".repeat(32)}`;
export const UDT_CHANNEL_ID = `0x${"c2".repeat(32)}`;
/** Same instant as FakeClock's default start. */
export const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);
export const ONE_CKB = 100_000_000n;
/** 2^64 + 1: a u128 amount no JS number can hold. */
export const BEYOND_U64 = 2n ** 64n + 1n;
export const MAX_U128 = 2n ** 128n - 1n;

export const HOLD_FINAL_EXPIRY_DELTA_MS = 6 * MS_PER_HOUR;
export const QUOTE_TTL_SECONDS = 180;
export const TLC_EXPIRY_LIMIT_MS = 90 * MS_PER_MINUTE;

export const hex = (value: bigint | number): string => `0x${BigInt(value).toString(16)}`;
export const with0x = (value: string): string => `0x${value}`;

/* ------------------------------------------------------------------------------------- Molecule encoder */

/** An independent molecule encoder (the hub only decodes), so decode is checked against a separate implementation. */
const u32le = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};

export function encodeMoleculeTable(fields: readonly Buffer[]): Buffer {
  const headerSize = 4 * (fields.length + 1);
  const offsets: number[] = [];
  let offset = headerSize;
  for (const field of fields) {
    offsets.push(offset);
    offset += field.length;
  }
  return Buffer.concat([u32le(offset), ...offsets.map(u32le), ...fields]);
}

export const encodeMoleculeBytes = (data: Buffer): Buffer => Buffer.concat([u32le(data.length), data]);

const HASH_TYPE_BYTE: Record<Script["hashType"], number> = { data: 0, type: 1, data1: 2, data2: 4 };

/** Script table fields: code_hash (Byte32), hash_type (byte), args (Bytes). */
export function scriptFields(script: Script): Buffer[] {
  return [
    Buffer.from(script.codeHash.replace(/^0x/, ""), "hex"),
    Buffer.from([HASH_TYPE_BYTE[script.hashType]]),
    encodeMoleculeBytes(Buffer.from(script.args.replace(/^0x/, ""), "hex")),
  ];
}

export const encodeMoleculeScript = (script: Script, extraFields: readonly Buffer[] = []): string =>
  `0x${encodeMoleculeTable([...scriptFields(script), ...extraFields]).toString("hex")}`;

/* ---------------------------------------------------------------------------------- Recorded wire answers */

export type WireAttr = Record<string, unknown>;

export interface WireInvoiceOptions {
  currency?: string;
  amount?: string | null;
  timestamp?: string;
  paymentHash?: string;
  attrs?: WireAttr[];
}

/** Attributes fnn writes for a sha256 hold invoice on RUSD (new_invoice with every option the hub sets). */
export const holdInvoiceAttrs = (overrides: { udtScript?: string | null } = {}): WireAttr[] => [
  { description: "ckbolt swap" },
  { expiry_time: hex(QUOTE_TTL_SECONDS) },
  { final_htlc_minimum_expiry_delta: hex(HOLD_FINAL_EXPIRY_DELTA_MS) },
  { hash_algorithm: "sha256" },
  ...(overrides.udtScript === null ? [] : [{ udt_script: overrides.udtScript ?? RUSD_SCRIPT_MOLECULE }]),
  { payee_public_key: NODE_PUBKEY },
];

/** A CkbInvoice as parse_invoice / new_invoice / get_invoice return it. */
export function wireInvoice(options: WireInvoiceOptions = {}): Record<string, unknown> {
  return {
    currency: options.currency ?? "Fibt",
    amount: options.amount === undefined ? hex(ONE_CKB) : options.amount,
    signature: "0e1f2a3b4c5d6e7f",
    data: {
      timestamp: options.timestamp ?? hex(T0),
      payment_hash: options.paymentHash ?? with0x(PAYMENT_HASH),
      attrs: options.attrs ?? holdInvoiceAttrs(),
    },
  };
}

export const INVOICE_ADDRESS = "fibt1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f38yyc4";

export const wireInvoiceResult = (options: WireInvoiceOptions = {}, address = INVOICE_ADDRESS): Record<string, unknown> => ({
  invoice_address: address,
  invoice: wireInvoice(options),
});

export const wireGetInvoiceResult = (status: string, options: WireInvoiceOptions = {}): Record<string, unknown> => ({
  ...wireInvoiceResult(options),
  status,
});

export interface WirePaymentOptions {
  paymentHash?: string;
  status?: string;
  preimage?: string | null;
  fee?: string | null;
  failedError?: string | null;
}

export function wirePayment(options: WirePaymentOptions = {}): Record<string, unknown> {
  return {
    payment_hash: options.paymentHash ?? with0x(PAYMENT_HASH),
    status: options.status ?? "Created",
    created_at: hex(T0),
    last_updated_at: hex(T0 + 1_000),
    failed_error: options.failedError === undefined ? null : options.failedError,
    fee: options.fee === undefined ? "0x0" : options.fee,
    custom_records: null,
    ...(options.preimage === undefined ? {} : { payment_preimage: options.preimage }),
  };
}

export interface WireTlcOptions {
  id?: number;
  amount?: bigint;
  paymentHash?: string;
  expiry?: number;
  forwardingChannelId?: string | null;
  status?: unknown;
}

export function wireTlc(options: WireTlcOptions = {}): Record<string, unknown> {
  return {
    id: hex(options.id ?? 0),
    amount: hex(options.amount ?? ONE_CKB),
    payment_hash: options.paymentHash ?? with0x(PAYMENT_HASH),
    expiry: hex(options.expiry ?? T0 + 10 * MS_PER_HOUR),
    forwarding_channel_id: options.forwardingChannelId === undefined ? null : options.forwardingChannelId,
    forwarding_tlc_id: null,
    status: options.status === undefined ? { Inbound: "Committed" } : options.status,
  };
}

export interface WireChannelOptions {
  channelId?: string;
  pubkey?: string;
  udtScript?: Record<string, string> | null;
  stateName?: string;
  enabled?: boolean;
  localBalance?: bigint;
  remoteBalance?: bigint;
  pendingTlcs?: Record<string, unknown>[];
  /** list_channels `is_acceptor`: true when the peer opened the channel; null leaves the field out. Default false. */
  isAcceptor?: boolean | null;
  /** list_channels `is_public`. Default true. */
  isPublic?: boolean;
}

export function wireChannel(options: WireChannelOptions = {}): Record<string, unknown> {
  return {
    channel_id: options.channelId ?? CHANNEL_ID,
    is_public: options.isPublic ?? true,
    ...(options.isAcceptor === null ? {} : { is_acceptor: options.isAcceptor ?? false }),
    is_one_way: false,
    channel_outpoint: `0x${"0f".repeat(36)}`,
    pubkey: options.pubkey ?? PEER_PUBKEY,
    funding_udt_type_script: options.udtScript === undefined ? null : options.udtScript,
    state: { state_name: options.stateName ?? "ChannelReady", state_flags: [] },
    local_balance: hex(options.localBalance ?? 400n * ONE_CKB),
    offered_tlc_balance: "0x0",
    remote_balance: hex(options.remoteBalance ?? 151n * ONE_CKB),
    received_tlc_balance: "0x0",
    pending_tlcs: options.pendingTlcs ?? [],
    latest_commitment_transaction_hash: `0x${"e0".repeat(32)}`,
    created_at: hex(T0 - MS_PER_HOUR),
    enabled: options.enabled ?? true,
    tlc_expiry_delta: hex(4 * MS_PER_HOUR),
    tlc_fee_proportional_millionths: "0x3e8",
    shutdown_transaction_hash: null,
    failure_detail: null,
  };
}

export const wireRusdScript = (): Record<string, string> => ({
  code_hash: RUSD_SCRIPT.codeHash,
  hash_type: RUSD_SCRIPT.hashType,
  args: RUSD_SCRIPT.args,
});

/**
 * node_info `chain_hash` (the genesis hash of the node's chain) of a node whose invoices use each currency: CKB mainnet
 * (Lina), CKB testnet (Pudge, docs/research/fiber-node.md 4.1), and a devnet, which has a genesis of its own.
 */
export const CHAIN_HASH_BY_CURRENCY = {
  Fibb: "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5",
  Fibt: "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606",
  Fibd: `0x${"10".repeat(32)}`,
} as const;

export const wireNodeInfo = (pubkey = NODE_PUBKEY, chainHash: string = CHAIN_HASH_BY_CURRENCY.Fibd): Record<string, unknown> => ({
  version: "0.9.1",
  commit_hash: "9a561b3e7b786001488b61303a0663d9f4f22259",
  pubkey,
  features: ["GOSSIP_QUERIES_OPTIONAL", "BASIC_MPP_OPTIONAL"],
  node_name: "ckbolt-hub",
  addresses: ["/ip4/127.0.0.1/tcp/8228"],
  chain_hash: chainHash,
  open_channel_auto_accept_min_ckb_funding_amount: hex(100n * ONE_CKB),
  auto_accept_channel_ckb_funding_amount: hex(99n * ONE_CKB),
  default_funding_lock_script: { code_hash: `0x${"9b".repeat(32)}`, hash_type: "type", args: `0x${"aa".repeat(20)}` },
  tlc_expiry_delta: hex(4 * MS_PER_HOUR),
  tlc_min_value: "0x0",
  tlc_fee_proportional_millionths: "0x3e8",
  channel_count: "0x1",
  pending_channel_count: "0x0",
  peers_count: "0x1",
  udt_cfg_infos: [],
});

/* ------------------------------------------------------------------------------------------- Scripted RPC */

export type RpcHandler = (params: Record<string, unknown> | undefined) => unknown;

/**
 * A FiberRpc whose answers the test scripts per method. Raw answers go through the real result schemas, as the HTTP
 * client does, so the adapter sees exactly what it would see from a node. Throw from a handler to fail the call.
 */
export class ScriptedFiberRpc implements FiberRpc {
  readonly calls: { method: string; params: unknown[] }[] = [];
  private readonly persistent = new Map<string, RpcHandler>();
  private readonly queued = new Map<string, RpcHandler[]>();

  on(method: keyof FiberRpcCalls, handler: RpcHandler): this {
    this.persistent.set(method, handler);
    return this;
  }

  once(method: keyof FiberRpcCalls, handler: RpcHandler): this {
    this.queued.set(method, [...(this.queued.get(method) ?? []), handler]);
    return this;
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  paramsOf(method: string, index = 0): Record<string, unknown> | undefined {
    const call = this.calls.filter((c) => c.method === method)[index];
    return call?.params[0] as Record<string, unknown> | undefined;
  }

  async request<M extends keyof FiberRpcCalls>(method: M, ...params: FiberRpcParams<M>): Promise<FiberRpcResult<M>> {
    this.calls.push({ method, params: [...params] });
    const handler = this.queued.get(method)?.shift() ?? this.persistent.get(method);
    if (!handler) throw new Error(`unexpected fnn call ${method}`);
    const raw = await handler(params[0] as Record<string, unknown> | undefined);
    return FIBER_RPC_RESULT_SCHEMAS[method].parse(raw) as FiberRpcResult<M>;
  }
}

/** fnn's JSON-RPC error for a failed call: code -32000 (call execution failed) and the params as data. */
export const fnnError = (method: string, message: string, code = -32000): FiberRpcError => new FiberRpcError(method, code, message);

export const failWith = (method: string, message: string, code = -32000): RpcHandler => () => {
  throw fnnError(method, message, code);
};
