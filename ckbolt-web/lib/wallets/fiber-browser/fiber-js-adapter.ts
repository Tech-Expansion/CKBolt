import type { Script } from "@/lib/hub/contract";
import { fromHexQuantity, normalizeNodeId, toHexQuantity, with0x } from "./hex";
import { readParsedInvoice } from "./invoice-parse";
import type {
  AcceptChannelArgs,
  BrowserFiberNode,
  BrowserNodeInfo,
  CreatedInvoice,
  NewInvoiceArgs,
  NodeChannel,
  NodeDiagnosticsRaw,
  NodeInvoiceStatus,
  NodePayment,
  OpenChannelArgs,
  ParsedInvoice,
  SendPaymentOptions,
} from "./node-port";
import {
  FIBER_RPC,
  type FiberRpcName,
  type RpcAcceptChannelParams,
  type RpcAcceptChannelResult,
  type RpcChannel,
  type RpcGetInvoiceResult,
  type RpcInvoiceResult,
  type RpcNewInvoiceParams,
  type RpcNodeInfo,
  type RpcOpenChannelParams,
  type RpcParseInvoiceResult,
  type RpcPaymentResult,
  type RpcSendPaymentParams,
  type RpcShutdownChannelParams,
} from "./rpc-types";
import { scriptFromRpc, scriptToRpc } from "./scripts";
import { FIBER_HASH_ALGORITHM } from "./constants";

export type FiberLogLevel = "trace" | "debug" | "info" | "error";

/**
 * The shape of a fiber-js 0.9.1 `Fiber` instance that the app uses. The real one comes from a lazy
 * `import("@nervosnetwork/fiber-js")`; tests install a fake with the same shape (see ./fiber-loader.ts).
 */
export interface FiberLike {
  /** The bundled config for `network`, as YAML, with `ckb.rpc_url` set. Optional for fakes. */
  getDefaultConfig?(network: "mainnet" | "testnet", ckbRpcUrl: string): string;
  start(
    config: string,
    fiberKeyPair: Uint8Array,
    ckbSecretKey?: Uint8Array,
    chainSpec?: string,
    logLevel?: FiberLogLevel,
    databasePrefix?: string,
  ): Promise<void>;
  /** Any exported RPC by name, with its params object as the one array element. */
  invokeCommand(name: string, args?: unknown[]): Promise<unknown>;
  stop(): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The answer as T after a minimal shape check; a malformed answer is a node error, not a crash later on. */
function expectRecord<T>(value: unknown, command: string): T {
  if (!isRecord(value)) throw new Error(`The Fiber node sent an unreadable answer to ${command}.`);
  return value as T;
}

const toChannel = (c: RpcChannel): NodeChannel => ({
  channelId: c.channel_id,
  peerId: normalizeNodeId(c.pubkey),
  udtTypeScript: c.funding_udt_type_script ? scriptFromRpc(c.funding_udt_type_script) : null,
  state: c.state?.state_name ?? "",
  isPublic: c.is_public === true,
  enabled: c.enabled !== false,
  localBalance: fromHexQuantity(c.local_balance),
  remoteBalance: fromHexQuantity(c.remote_balance),
});

const toPayment = (p: RpcPaymentResult): NodePayment => ({
  paymentHash: p.payment_hash,
  status: p.status,
  failedError: p.failed_error ?? null,
  fee: fromHexQuantity(p.fee),
});

/** BrowserFiberNode over fiber-js's raw RPC (`invokeCommand`), so a fake needs to answer only the commands below. */
export class FiberJsNode implements BrowserFiberNode {
  constructor(private readonly fiber: FiberLike) {}

  private call(name: FiberRpcName, params?: object): Promise<unknown> {
    return this.fiber.invokeCommand(name, params === undefined ? [] : [params]);
  }

  async info(): Promise<BrowserNodeInfo> {
    const info = expectRecord<RpcNodeInfo>(await this.call(FIBER_RPC.NODE_INFO), FIBER_RPC.NODE_INFO);
    if (!isRecord(info.default_funding_lock_script)) throw new Error(`The Fiber node did not report its funding lock in ${FIBER_RPC.NODE_INFO}.`);
    return {
      nodeId: normalizeNodeId(String(info.pubkey ?? "")),
      version: String(info.version ?? ""),
      fundingLockScript: scriptFromRpc(info.default_funding_lock_script),
    };
  }

  async connectPeer(address: string): Promise<void> {
    await this.call(FIBER_RPC.CONNECT_PEER, { address });
  }

  async listPeers(): Promise<string[]> {
    const result = expectRecord<{ peers?: { pubkey: string }[] }>(await this.call(FIBER_RPC.LIST_PEERS), FIBER_RPC.LIST_PEERS);
    return (result.peers ?? []).map((p) => normalizeNodeId(String(p.pubkey)));
  }

  async openChannel(args: OpenChannelArgs): Promise<{ temporaryChannelId: string }> {
    const params: RpcOpenChannelParams = {
      pubkey: args.peerId,
      funding_amount: toHexQuantity(args.fundingAmount),
      public: args.isPublic,
      ...(args.udtTypeScript ? { funding_udt_type_script: scriptToRpc(args.udtTypeScript) } : {}),
    };
    const result = expectRecord<{ temporary_channel_id: string }>(await this.call(FIBER_RPC.OPEN_CHANNEL, params), FIBER_RPC.OPEN_CHANNEL);
    return { temporaryChannelId: result.temporary_channel_id };
  }

  async acceptChannel(args: AcceptChannelArgs): Promise<{ channelId: string }> {
    const params: RpcAcceptChannelParams = {
      temporary_channel_id: with0x(args.temporaryChannelId),
      funding_amount: toHexQuantity(args.fundingAmount),
      // Without shutdown_script fnn uses the node's default_funding_lock_script, as for the channels it opens.
      ...(args.shutdownScript ? { shutdown_script: scriptToRpc(args.shutdownScript) } : {}),
    };
    const result = expectRecord<RpcAcceptChannelResult>(await this.call(FIBER_RPC.ACCEPT_CHANNEL, params), FIBER_RPC.ACCEPT_CHANNEL);
    return { channelId: result.channel_id };
  }

  async listChannels(): Promise<NodeChannel[]> {
    const result = expectRecord<{ channels?: RpcChannel[] }>(await this.call(FIBER_RPC.LIST_CHANNELS, {}), FIBER_RPC.LIST_CHANNELS);
    return (result.channels ?? []).map(toChannel);
  }

  async shutdownChannel(channelId: string, closeScript?: Script | null): Promise<void> {
    const params: RpcShutdownChannelParams = {
      channel_id: channelId,
      // Without close_script fnn pays the node's share to its default_funding_lock_script.
      ...(closeScript ? { close_script: scriptToRpc(closeScript) } : {}),
    };
    await this.call(FIBER_RPC.SHUTDOWN_CHANNEL, params);
  }

  async newInvoice(args: NewInvoiceArgs): Promise<CreatedInvoice> {
    const params: RpcNewInvoiceParams = {
      amount: toHexQuantity(args.amount),
      currency: args.currency,
      payment_preimage: with0x(args.preimage),
      expiry: toHexQuantity(args.expirySeconds),
      description: args.description,
      hash_algorithm: FIBER_HASH_ALGORITHM,
      ...(args.udtTypeScript ? { udt_type_script: scriptToRpc(args.udtTypeScript) } : {}),
    };
    const result = expectRecord<RpcInvoiceResult>(await this.call(FIBER_RPC.NEW_INVOICE, params), FIBER_RPC.NEW_INVOICE);
    return { invoice: result.invoice_address, paymentHash: result.invoice.data.payment_hash };
  }

  async getInvoiceStatus(paymentHash: string): Promise<NodeInvoiceStatus> {
    const result = expectRecord<RpcGetInvoiceResult>(
      await this.call(FIBER_RPC.GET_INVOICE, { payment_hash: with0x(paymentHash) }),
      FIBER_RPC.GET_INVOICE,
    );
    return result.status;
  }

  async cancelInvoice(paymentHash: string): Promise<NodeInvoiceStatus> {
    // cancel_invoice answers as get_invoice does, with the status it has now.
    const result = expectRecord<RpcGetInvoiceResult>(
      await this.call(FIBER_RPC.CANCEL_INVOICE, { payment_hash: with0x(paymentHash) }),
      FIBER_RPC.CANCEL_INVOICE,
    );
    return result.status;
  }

  async parseInvoice(invoice: string): Promise<ParsedInvoice> {
    const result = expectRecord<RpcParseInvoiceResult>(await this.call(FIBER_RPC.PARSE_INVOICE, { invoice }), FIBER_RPC.PARSE_INVOICE);
    return readParsedInvoice(result.invoice);
  }

  async sendPayment(invoice: string, options: SendPaymentOptions = {}): Promise<NodePayment> {
    const params: RpcSendPaymentParams = {
      invoice,
      ...(options.maxFeeAmount === undefined ? {} : { max_fee_amount: toHexQuantity(options.maxFeeAmount) }),
      // Node ids as open_channel takes them: the hub contract's plain hex.
      ...(options.trampolineHops && options.trampolineHops.length > 0 ? { trampoline_hops: options.trampolineHops.map(normalizeNodeId) } : {}),
      ...(options.dryRun ? { dry_run: true } : {}),
    };
    return toPayment(expectRecord<RpcPaymentResult>(await this.call(FIBER_RPC.SEND_PAYMENT, params), FIBER_RPC.SEND_PAYMENT));
  }

  async getPayment(paymentHash: string): Promise<NodePayment> {
    return toPayment(
      expectRecord<RpcPaymentResult>(await this.call(FIBER_RPC.GET_PAYMENT, { payment_hash: with0x(paymentHash) }), FIBER_RPC.GET_PAYMENT),
    );
  }

  async readDiagnostics(): Promise<NodeDiagnosticsRaw> {
    const nodeInfo = expectRecord<Record<string, unknown>>(await this.call(FIBER_RPC.NODE_INFO), FIBER_RPC.NODE_INFO);
    const list = async (params: object) =>
      expectRecord<{ channels?: unknown }>(await this.call(FIBER_RPC.LIST_CHANNELS, params), FIBER_RPC.LIST_CHANNELS).channels;
    let includesClosed = true;
    let channels: unknown;
    try {
      channels = await list({ include_closed: true });
    } catch {
      // A node without `include_closed` lists its open channels only.
      includesClosed = false;
      channels = await list({});
    }
    return { nodeInfo, channels: Array.isArray(channels) ? channels.filter(isRecord) : [], includesClosed };
  }

  stop(): Promise<void> {
    return this.fiber.stop();
  }
}
