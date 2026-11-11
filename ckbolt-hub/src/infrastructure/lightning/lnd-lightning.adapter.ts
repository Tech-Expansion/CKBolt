import type { EventEmitter } from "node:events";
import { Logger } from "@nestjs/common";
import type { AuthenticatedLnd } from "lightning";
import type { Clock } from "../../application/ports/clock.port";
import type {
  DecodedLnInvoice,
  LightningPort,
  LnBalances,
  LnInvoiceStatus,
  LnNodeInfo,
  LnPaymentStatus,
} from "../../application/ports/lightning.port";
import { LIGHTNING_LIB_PAY_REFUSALS, LN_PAYMENT_REFUSAL_REASON, LND_ERROR_DETAILS, LND_RPC } from "../../common/constants/lnd.constants";
import { BTC_INVOICE_NETWORKS, MIN_INVOICE_EXPIRY_SECONDS } from "../../common/constants/protocol.constants";
import { DuplicateHashError } from "../../common/errors/hub.error";
import { btcNetworkOfChainIds } from "../../common/utils/chain.util";
import { toHex32 } from "../../common/utils/hex.util";
import { bolt11Network, minLnCltvLimit, satsToNumber } from "../../common/utils/lightning.util";
import { secondsToMs, toIso } from "../../common/utils/time.util";
import type { BtcNetwork, Hex32 } from "../../domain/types";
import { disconnectLnd } from "./lnd-connection";
import { LndPaymentFollower } from "./lnd-payment-follower";
import { LndUpdateFeed } from "./lnd-update-feed";
import {
  hasLndDetails,
  isAccessDenied,
  isInvoiceNotFound,
  isNodeUnavailable,
  isPaymentNotFound,
  LnInvoiceInvalidError,
  LnInvoiceWrongNetworkError,
  readLndError,
  toLndError,
  type LndErrorInfo,
} from "./lnd.errors";
import { failedPayment, toBalances, toDecodedInvoice, toInvoiceStatus, toNodeInfo, toPaymentStatus } from "./lnd.mappers";
import { lndRpc, type LndRpc } from "./lnd.rpc";

export interface LndAdapterSettings {
  /** The Bitcoin network the hub is configured for (HubConfig.bitcoin.network): which invoices it decodes and pays. */
  network: BtcNetwork;
  /** Names the node in logs, e.g. its gRPC host. */
  name: string;
  /** Most parts a payment may be split into (SendPaymentV2 max_parts; HubConfig.swaps.lnMaxPaymentParts). */
  maxPaymentParts: number;
  /** Hold invoices carry route hints for the node's private channels (HubConfig.swaps.lnInvoiceRouteHints). */
  invoiceRouteHints: boolean;
}

type PayInvoiceArgs = Parameters<LightningPort["payInvoice"]>[0];
type CreateHoldInvoiceArgs = Parameters<LightningPort["createHoldInvoice"]>[0];
type CreateInvoiceArgs = Parameters<LightningPort["createInvoice"]>[0];

/** A refusal reason when `cltvLimit` is below the smallest LND takes for the invoice (its final CLTV, padding and one). */
const cltvLimitRefusal = (cltvLimit: number, invoiceCltvExpiry: number): string | null =>
  cltvLimit >= minLnCltvLimit(invoiceCltvExpiry) ? null : LN_PAYMENT_REFUSAL_REASON.CLTV_LIMIT_TOO_LOW;

function assertPayArgs(args: PayInvoiceArgs): void {
  if (args.maxFeeSats < 0n) throw new RangeError(`maxFeeSats must not be negative: ${args.maxFeeSats}`);
  if (!Number.isInteger(args.cltvLimit)) throw new RangeError(`cltvLimit must be a whole number of blocks: ${args.cltvLimit}`);
  if (!(args.timeoutSeconds > 0)) throw new RangeError(`timeoutSeconds must be positive: ${args.timeoutSeconds}`);
}

/**
 * LightningPort on LND v0.21.4 through the `lightning` package (docs/research/lnd.md sections 1-3 and 6.4).
 * Safety: every payment carries an explicit fee limit and cltv_limit; FAILED is reported only when LND says so or when
 * nothing was ever sent; settle and cancel are idempotent.
 */
export class LndLightningAdapter implements LightningPort {
  private readonly logger: Logger;
  private readonly updates: LndUpdateFeed;
  private readonly payments: LndPaymentFollower;
  /** A macaroon without onchain:read cannot read the wallet balance; after the first denial on-chain funds count as zero. */
  private chainBalanceReadable = true;

  constructor(
    private readonly lnd: AuthenticatedLnd,
    private readonly settings: LndAdapterSettings,
    private readonly clock: Clock,
    private readonly rpc: LndRpc = lndRpc,
  ) {
    this.logger = new Logger(`${LndLightningAdapter.name} ${settings.name}`);
    this.updates = new LndUpdateFeed(() => rpc.subscribeToInvoices({ lnd }), this.logger);
    this.payments = new LndPaymentFollower((paymentHash) => this.updates.notify(paymentHash));
  }

  /** The network comes from the chain the node names, so the health check can tell a node on the wrong network. */
  async getInfo(): Promise<LnNodeInfo> {
    const info = await this.call(LND_RPC.GET_INFO, () => this.rpc.getWalletInfo({ lnd: this.lnd }));
    return toNodeInfo(info, btcNetworkOfChainIds(info.chains));
  }

  /** Refuses, before asking LND, an invoice whose prefix is for a network this node cannot pay (BTC_INVOICE_NETWORKS). */
  async decodeInvoice(paymentRequest: string): Promise<DecodedLnInvoice> {
    const network = bolt11Network(paymentRequest);
    if (!network) throw LnInvoiceInvalidError.unknownPrefix();
    if (!BTC_INVOICE_NETWORKS[this.settings.network].includes(network)) {
      throw new LnInvoiceWrongNetworkError(network, this.settings.network);
    }
    const decoded = await this.call(
      LND_RPC.DECODE_PAY_REQ,
      () => this.rpc.decodePaymentRequest({ lnd: this.lnd, request: paymentRequest }),
      (error) => this.decodeError(error, network),
    );
    return toDecodedInvoice(decoded, network);
  }

  async createHoldInvoice(args: CreateHoldInvoiceArgs): Promise<{ paymentRequest: string }> {
    const expiresAt = this.expiresAt(args.expirySeconds);
    const created = await this.call(
      LND_RPC.ADD_HOLD_INVOICE,
      () =>
        this.rpc.createHodlInvoice({
          lnd: this.lnd,
          id: toHex32(args.paymentHash),
          tokens: satsToNumber(args.amountSats),
          expires_at: expiresAt,
          cltv_delta: args.cltvExpiry,
          description: args.memo,
          is_including_private_channels: this.settings.invoiceRouteHints,
        }),
      (error) => this.holdInvoiceError(error),
    );
    return { paymentRequest: created.request };
  }

  async createInvoice(args: CreateInvoiceArgs): Promise<{ paymentRequest: string; paymentHash: Hex32 }> {
    const expiresAt = this.expiresAt(args.expirySeconds);
    const created = await this.call(LND_RPC.ADD_INVOICE, () =>
      this.rpc.createInvoice({
        lnd: this.lnd,
        tokens: satsToNumber(args.amountSats),
        expires_at: expiresAt,
        description: args.memo,
      }),
    );
    return { paymentRequest: created.request, paymentHash: toHex32(created.id) };
  }

  async lookupInvoice(paymentHash: Hex32): Promise<LnInvoiceStatus | null> {
    const id = toHex32(paymentHash);
    const invoice = await this.find(LND_RPC.LOOKUP_INVOICE, () => this.rpc.getInvoice({ lnd: this.lnd, id }), isInvoiceNotFound);
    return invoice ? toInvoiceStatus(invoice) : null;
  }

  async settleInvoice(preimage: Hex32): Promise<void> {
    const secret = toHex32(preimage);
    await this.idempotent(LND_RPC.SETTLE_INVOICE, () => this.rpc.settleHodlInvoice({ lnd: this.lnd, secret }), LND_ERROR_DETAILS.INVOICE_ALREADY_SETTLED);
  }

  async cancelInvoice(paymentHash: Hex32): Promise<void> {
    const id = toHex32(paymentHash);
    await this.idempotent(LND_RPC.CANCEL_INVOICE, () => this.rpc.cancelHodlInvoice({ lnd: this.lnd, id }), LND_ERROR_DETAILS.INVOICE_ALREADY_CANCELED);
  }

  async payInvoice(args: PayInvoiceArgs): Promise<LnPaymentStatus> {
    assertPayArgs(args);
    const invoice = await this.decodeInvoice(args.paymentRequest);
    const existing = await this.getPayment(invoice.paymentHash);
    if (existing) return this.keepFollowing(existing);
    const refusal = cltvLimitRefusal(args.cltvLimit, invoice.cltvExpiry);
    if (refusal) return failedPayment(invoice.paymentHash, refusal);
    return this.startPayment(args, invoice.paymentHash);
  }

  async getPayment(paymentHash: Hex32): Promise<LnPaymentStatus | null> {
    const id = toHex32(paymentHash);
    const result = await this.find(LND_RPC.TRACK_PAYMENT, () => this.rpc.getPayment({ lnd: this.lnd, id }), isPaymentNotFound);
    return result ? toPaymentStatus(result, id) : null;
  }

  async getBalances(): Promise<LnBalances> {
    const [channels, onchainSats] = await Promise.all([
      this.call(LND_RPC.CHANNEL_BALANCE, () => this.rpc.getChannelBalance({ lnd: this.lnd })),
      this.onchainSats(),
    ]);
    return toBalances(channels, onchainSats);
  }

  onUpdate(listener: (paymentHash: Hex32) => void): () => void {
    return this.updates.subscribe(listener);
  }

  /** Stops every stream and closes the gRPC channels. */
  close(): void {
    this.payments.stopAll();
    this.updates.close();
    disconnectLnd(this.lnd);
  }

  /* ------------------------------------------------------------------------------------------------- payments */

  private async startPayment(args: PayInvoiceArgs, paymentHash: Hex32): Promise<LnPaymentStatus> {
    const { blockHeight } = await this.getInfo();
    const stream = this.openPaymentStream(args, blockHeight + args.cltvLimit);
    try {
      return await this.payments.follow(paymentHash, stream);
    } catch (error) {
      return this.statusAfterBrokenStream(paymentHash, error);
    }
  }

  /** max_fee is always set: the package would otherwise allow an unlimited fee. max_paths caps the parts of the payment. */
  private openPaymentStream(args: PayInvoiceArgs, maxTimeoutHeight: number): EventEmitter {
    try {
      return this.rpc.subscribeToPayViaRequest({
        lnd: this.lnd,
        request: args.paymentRequest,
        max_fee: satsToNumber(args.maxFeeSats),
        max_paths: this.settings.maxPaymentParts,
        max_timeout_height: maxTimeoutHeight,
        pathfinding_timeout: secondsToMs(args.timeoutSeconds),
      });
    } catch (error) {
      throw toLndError(LND_RPC.SEND_PAYMENT, error);
    }
  }

  /**
   * The payment stream broke before its first status. A refusal the package raises before calling LND means nothing
   * was sent. Otherwise LND's own record decides; without one, the outcome is reported as an error, never as FAILED.
   */
  private async statusAfterBrokenStream(paymentHash: Hex32, error: unknown): Promise<LnPaymentStatus> {
    const refusal = LIGHTNING_LIB_PAY_REFUSALS[readLndError(error).name];
    if (refusal) return failedPayment(paymentHash, refusal);
    const recorded = await this.getPayment(paymentHash);
    if (recorded) return this.keepFollowing(recorded);
    throw toLndError(LND_RPC.SEND_PAYMENT, error);
  }

  /** Follows a payment found in flight (for example after a restart) so its outcome reaches onUpdate listeners. */
  private keepFollowing(status: LnPaymentStatus): LnPaymentStatus {
    const { paymentHash } = status;
    if (status.state === "IN_FLIGHT" && !this.payments.isFollowing(paymentHash)) {
      this.payments.followInBackground(paymentHash, this.rpc.subscribeToPastPayment({ lnd: this.lnd, id: paymentHash }));
    }
    return status;
  }

  /* -------------------------------------------------------------------------------------------------- helpers */

  /** Refuses an expiry LND would replace with its 24-hour default (see MIN_INVOICE_EXPIRY_SECONDS). */
  private expiresAt(expirySeconds: number): string {
    if (!(expirySeconds >= MIN_INVOICE_EXPIRY_SECONDS)) {
      throw new RangeError(`expirySeconds must be at least ${MIN_INVOICE_EXPIRY_SECONDS}: ${expirySeconds}`);
    }
    return toIso(this.clock.now() + secondsToMs(expirySeconds));
  }

  private async onchainSats(): Promise<bigint> {
    if (!this.chainBalanceReadable) return 0n;
    try {
      const { chain_balance: sats } = await this.rpc.getChainBalance({ lnd: this.lnd });
      return BigInt(sats);
    } catch (error) {
      if (!isAccessDenied(readLndError(error))) throw toLndError(LND_RPC.WALLET_BALANCE, error);
      this.chainBalanceReadable = false;
      this.logger.warn("The LND macaroon cannot read the on-chain balance (onchain:read); on-chain funds are reported as 0.");
      return 0n;
    }
  }

  /** LND rejecting the invoice is the user's problem; an unreachable node or a refused macaroon is not. */
  private decodeError(error: unknown, invoiceNetwork: BtcNetwork): Error {
    const info = readLndError(error);
    if (isNodeUnavailable(info) || isAccessDenied(info)) return toLndError(LND_RPC.DECODE_PAY_REQ, error);
    if (hasLndDetails(info, LND_ERROR_DETAILS.WRONG_NETWORK_INVOICE)) return new LnInvoiceWrongNetworkError(invoiceNetwork, this.settings.network);
    return new LnInvoiceInvalidError(info.details || info.name);
  }

  private holdInvoiceError(error: unknown): Error {
    return hasLndDetails(readLndError(error), LND_ERROR_DETAILS.DUPLICATE_INVOICE) ? new DuplicateHashError() : toLndError(LND_RPC.ADD_HOLD_INVOICE, error);
  }

  private async call<T>(rpc: string, run: () => Promise<T>, mapError: (error: unknown) => Error = (error) => toLndError(rpc, error)): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw mapError(error);
    }
  }

  /** Like `call`, but resolves null when LND says the thing does not exist. */
  private async find<T>(rpc: string, run: () => Promise<T>, isMissing: (info: LndErrorInfo) => boolean): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      if (isMissing(readLndError(error))) return null;
      throw toLndError(rpc, error);
    }
  }

  /** Like `call`, but an error saying the work is already done counts as success. */
  private async idempotent(rpc: string, run: () => Promise<void>, alreadyDone: string): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (!hasLndDetails(readLndError(error), alreadyDone)) throw toLndError(rpc, error);
    }
  }
}
