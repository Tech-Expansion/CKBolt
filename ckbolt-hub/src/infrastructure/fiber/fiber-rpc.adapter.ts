import type { OnModuleDestroy } from "@nestjs/common";
import type {
  FiberChannel,
  FiberChannelBalance,
  FiberHeldTlc,
  FiberOfferedTlc,
  FiberInvoiceState,
  FiberInvoiceStatus,
  FiberNodeInfo,
  FiberPaymentStatus,
  FiberPort,
  OpenChannelArgs,
  ParsedFiberInvoice,
} from "../../application/ports/fiber.port";
import { FIBER_RPC_ERROR_PATTERN, FIBER_RPC_METHOD } from "../../common/constants/fiber-rpc.constants";
import { DuplicateHashError } from "../../common/errors/hub.error";
import { ckbNetworkOfChainHash } from "../../common/utils/chain.util";
import type { CkbNetwork, Hex32, Script } from "../../domain/types";
import { ChannelOpenRequests } from "./channel-open-requests";
import { FiberInvoiceInvalidError, FiberRpcError, FiberRpcResponseError, isFiberRpcErrorMatching } from "./fiber-rpc.errors";
import {
  PORT_STATE,
  fromRpcHash,
  hasOfferedTlcs,
  hasRemovingTlcs,
  refusedPaymentStatus,
  toChannelBalance,
  toChannelDetails,
  toHeldTlcs,
  toOfferedTlcs,
  toHoldInvoiceParams,
  toInvoiceStatus,
  toNodeInfo,
  toOpenChannelParams,
  toParsedInvoice,
  toPaymentStatus,
  toPubkey,
  toRegularInvoiceParams,
  toRpcHash,
  toSendPaymentParams,
  withPendingChannels,
  type HoldInvoiceArgs,
  type InvoiceArgs,
  type PayInvoiceArgs,
} from "./fiber-rpc.mappers";
import type { FiberRpc, RpcInvoiceResult, RpcNewInvoiceParams } from "./fiber-rpc.schemas";
import type { FiberUpdateSource } from "./fiber-store-changes.subscriber";

/** Resolves to null instead of failing when fnn answers with `notFound`: the invoice or payment does not exist. */
async function nullWhenNotFound<T>(call: Promise<T>, notFound: RegExp): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (isFiberRpcErrorMatching(error, notFound)) return null;
    throw error;
  }
}

/** A user invoice fnn refuses to parse, or one whose contents the hub cannot read, is the user's input error. */
function asInvoiceError(error: unknown): unknown {
  if (error instanceof FiberRpcError) return new FiberInvoiceInvalidError(error.rpcMessage);
  if (error instanceof FiberRpcResponseError) return new FiberInvoiceInvalidError(error.detail);
  return error;
}

/** A payment that is not known or has failed may be (re)started; anything else is live or done. */
const isActivePayment = (payment: FiberPaymentStatus | null): payment is FiberPaymentStatus =>
  payment !== null && payment.state !== PORT_STATE.PAYMENT_FAILED;

/**
 * FiberPort over the fnn v0.9.1 JSON-RPC (docs/research/fiber-node.md). Every invoice it creates uses sha256 so the
 * Lightning leg can share the hash. Settle, cancel and pay are idempotent, so the engine can retry them after a crash.
 */
export class FiberRpcAdapter implements FiberPort, OnModuleDestroy {
  /** Present only when the node's store-changes WebSocket is configured; otherwise the engine polls. */
  declare readonly onUpdate?: FiberPort["onUpdate"];
  private readonly openRequests = new ChannelOpenRequests();

  /** `network` is the hub's configured CKB network: the currency of the invoices this adapter creates. */
  constructor(
    private readonly rpc: FiberRpc,
    private readonly network: CkbNetwork,
    private readonly updates: FiberUpdateSource | null = null,
  ) {
    if (updates) this.onUpdate = (listener) => updates.subscribe(listener);
  }

  onModuleDestroy(): void {
    this.updates?.close();
  }

  /** The network comes from the node's own chain hash, so the health check can tell a node on the wrong chain. */
  async getInfo(): Promise<FiberNodeInfo> {
    const info = await this.rpc.request(FIBER_RPC_METHOD.NODE_INFO);
    return toNodeInfo(info, ckbNetworkOfChainHash(info.chain_hash));
  }

  async parseInvoice(invoice: string): Promise<ParsedFiberInvoice> {
    try {
      const result = await this.rpc.request(FIBER_RPC_METHOD.PARSE_INVOICE, { invoice });
      return toParsedInvoice(result.invoice);
    } catch (error) {
      throw asInvoiceError(error);
    }
  }

  async createHoldInvoice(args: HoldInvoiceArgs): Promise<{ invoice: string }> {
    const result = await this.newInvoice(toHoldInvoiceParams(args, this.network));
    return { invoice: result.invoice_address };
  }

  async createInvoice(args: InvoiceArgs): Promise<{ invoice: string; paymentHash: Hex32 }> {
    const result = await this.newInvoice(toRegularInvoiceParams(args, this.network));
    return { invoice: result.invoice_address, paymentHash: fromRpcHash(result.invoice.data.payment_hash, "payment_hash") };
  }

  async getInvoice(paymentHash: Hex32): Promise<FiberInvoiceStatus | null> {
    const lookup = this.rpc.request(FIBER_RPC_METHOD.GET_INVOICE, { payment_hash: toRpcHash(paymentHash) });
    const result = await nullWhenNotFound(lookup, FIBER_RPC_ERROR_PATTERN.INVOICE_NOT_FOUND);
    return result && toInvoiceStatus(result);
  }

  async settleInvoice(paymentHash: Hex32, preimage: Hex32): Promise<void> {
    const params = { payment_hash: toRpcHash(paymentHash), payment_preimage: toRpcHash(preimage) };
    await this.idempotent(paymentHash, PORT_STATE.INVOICE_PAID, () => this.rpc.request(FIBER_RPC_METHOD.SETTLE_INVOICE, params));
  }

  async cancelInvoice(paymentHash: Hex32): Promise<void> {
    const params = { payment_hash: toRpcHash(paymentHash) };
    await this.idempotent(paymentHash, PORT_STATE.INVOICE_CANCELLED, () => this.rpc.request(FIBER_RPC_METHOD.CANCEL_INVOICE, params));
  }

  async heldTlcs(paymentHash: Hex32, udtTypeScript: Script | null): Promise<FiberHeldTlc[]> {
    const { channels } = await this.rpc.request(FIBER_RPC_METHOD.LIST_CHANNELS, {});
    return toHeldTlcs(channels, paymentHash, udtTypeScript);
  }

  async hasRemovingTlcs(paymentHash: Hex32): Promise<boolean> {
    const { channels } = await this.rpc.request(FIBER_RPC_METHOD.LIST_CHANNELS, {});
    return hasRemovingTlcs(channels, paymentHash);
  }

  async hasOfferedTlcs(paymentHash: Hex32): Promise<boolean> {
    const { channels } = await this.rpc.request(FIBER_RPC_METHOD.LIST_CHANNELS, {});
    return hasOfferedTlcs(channels, paymentHash);
  }

  async offeredTlcs(paymentHash: Hex32): Promise<FiberOfferedTlc[]> {
    const { channels } = await this.rpc.request(FIBER_RPC_METHOD.LIST_CHANNELS, {});
    return toOfferedTlcs(channels, paymentHash);
  }

  /** get_payment first: fnn refuses a second send_payment for a hash unless the earlier one Failed. */
  async payInvoice(args: PayInvoiceArgs): Promise<FiberPaymentStatus> {
    const invoice = await this.parseInvoice(args.invoice);
    const existing = await this.getPayment(invoice.paymentHash);
    if (isActivePayment(existing)) return existing;
    return this.sendPayment(args, invoice);
  }

  async getPayment(paymentHash: Hex32): Promise<FiberPaymentStatus | null> {
    const lookup = this.rpc.request(FIBER_RPC_METHOD.GET_PAYMENT, { payment_hash: toRpcHash(paymentHash) });
    const result = await nullWhenNotFound(lookup, FIBER_RPC_ERROR_PATTERN.PAYMENT_NOT_FOUND);
    return result && toPaymentStatus(result);
  }

  async listChannels(): Promise<FiberChannelBalance[]> {
    const { channels } = await this.rpc.request(FIBER_RPC_METHOD.LIST_CHANNELS, {});
    return channels.map(toChannelBalance);
  }

  /**
   * Two list_channels calls: the plain one leaves out a channel the node asked a peer to open that the peer has not
   * accepted yet, which only `only_pending` lists (without its UDT, filled in from what this adapter opened). The plain
   * one goes first, so a channel the peer accepts in between is listed once, under its final id.
   */
  async listChannelDetails(peer?: string): Promise<FiberChannel[]> {
    const pubkey = peer === undefined ? undefined : toPubkey(peer);
    const filter = pubkey === undefined ? {} : { pubkey };
    const droppable = this.openRequests.idsTo(pubkey);
    const { channels: listed } = await this.rpc.request(FIBER_RPC_METHOD.LIST_CHANNELS, filter);
    const { channels: pending } = await this.rpc.request(FIBER_RPC_METHOD.LIST_CHANNELS, { ...filter, only_pending: true });
    const channels = withPendingChannels(listed, pending).map(toChannelDetails);
    this.openRequests.dropUnlisted(droppable, channels);
    return channels.map((channel) => this.openRequests.withAsset(channel));
  }

  async isConnected(nodeId: string): Promise<boolean> {
    const { peers } = await this.rpc.request(FIBER_RPC_METHOD.LIST_PEERS);
    return peers.some((peer) => toPubkey(peer.pubkey) === toPubkey(nodeId));
  }

  async openChannel(args: OpenChannelArgs): Promise<{ temporaryChannelId: string }> {
    const { temporary_channel_id: temporaryChannelId } = await this.rpc.request(FIBER_RPC_METHOD.OPEN_CHANNEL, toOpenChannelParams(args));
    this.openRequests.remember(temporaryChannelId, { peer: toPubkey(args.peer), udtTypeScript: args.udtTypeScript });
    return { temporaryChannelId };
  }

  async abandonChannel(channelId: string): Promise<void> {
    await this.rpc.request(FIBER_RPC_METHOD.ABANDON_CHANNEL, { channel_id: channelId });
  }

  async forceCloseChannel(channelId: string): Promise<void> {
    await this.rpc.request(FIBER_RPC_METHOD.SHUTDOWN_CHANNEL, { channel_id: channelId, force: true });
  }

  /** fnn keeps one invoice per payment hash per node: a second one means the hash is already in use. */
  private async newInvoice(params: RpcNewInvoiceParams): Promise<RpcInvoiceResult> {
    try {
      return await this.rpc.request(FIBER_RPC_METHOD.NEW_INVOICE, params);
    } catch (error) {
      if (isFiberRpcErrorMatching(error, FIBER_RPC_ERROR_PATTERN.INVOICE_ALREADY_EXISTS)) throw new DuplicateHashError();
      throw error;
    }
  }

  /**
   * A refused send_payment started nothing, unless a session for the hash is live after all (a concurrent send).
   * A transport error is left to the caller: the payment may have started, so it must be re-read with getPayment.
   */
  private async sendPayment(args: PayInvoiceArgs, invoice: ParsedFiberInvoice): Promise<FiberPaymentStatus> {
    try {
      return toPaymentStatus(await this.rpc.request(FIBER_RPC_METHOD.SEND_PAYMENT, toSendPaymentParams(args, invoice.amount)));
    } catch (error) {
      if (!(error instanceof FiberRpcError)) throw error;
      const current = await this.getPayment(invoice.paymentHash);
      return isActivePayment(current) ? current : refusedPaymentStatus(invoice.paymentHash, error.rpcMessage);
    }
  }

  /** Runs a settle or cancel; when fnn refuses it, succeeds anyway if the invoice is already in the target state. */
  private async idempotent(paymentHash: Hex32, doneState: FiberInvoiceState, call: () => Promise<unknown>): Promise<void> {
    try {
      await call();
    } catch (error) {
      if (!(error instanceof FiberRpcError)) throw error;
      const invoice = await this.getInvoice(paymentHash);
      if (invoice?.state !== doneState) throw error;
    }
  }
}
