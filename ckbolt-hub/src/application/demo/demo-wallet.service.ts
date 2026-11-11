import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { API_ERROR_CODE, RESOURCE_NAME } from "../../common/constants/api.constants";
import { DEMO_INVOICE_DESCRIPTION } from "../../common/constants/demo.constants";
import { FIBER_MAX_TLC_EXPIRY_LIMIT_MS } from "../../common/constants/protocol.constants";
import { SWAP_DIRECTION, SWAP_DIRECTIONS, SWAP_STATE, UNKNOWN_PAYMENT_FAILURE } from "../../common/constants/swap.constants";
import { HubError, NotFoundError } from "../../common/errors/hub.error";
import { basisPointsOfCeil } from "../../common/utils/basis-points.util";
import { describeError } from "../../common/utils/error.util";
import { randomPreimage } from "../../common/utils/hex.util";
import { rethrowAsHubError } from "../../common/utils/hub-error.util";
import type { HubConfig } from "../../config/hub.config";
import type { AssetRegistry } from "../../domain/assets";
import type { Direction, FiberAssetId, Hex32, Swap } from "../../domain/types";
import type { FiberPaymentState, FiberPort } from "../ports/fiber.port";
import type { LightningPort, LnPaymentState } from "../ports/lightning.port";
import { ASSETS, DEMO_FIBER, DEMO_LIGHTNING, HUB_CONFIG } from "../ports/tokens";
import { SWAP_ENGINE, type SwapEngine } from "../swaps/swap-engine.contract";
import type { DemoWallet } from "./demo-wallet.contract";
import {
  DemoAssetUnavailableError,
  DemoDisabledError,
  DemoWalletUnavailableError,
  SwapNotAwaitingPaymentError,
  SwapNotForDemoWalletError,
} from "./demo.errors";

const FIBER_PAYMENT_FAILED: FiberPaymentState = "Failed";
const LIGHTNING_PAYMENT_FAILED: LnPaymentState = "FAILED";

/** A string the demo node could not read as an invoice: not the demo wallet's, and nothing to log. */
const isUnreadableInvoice = (error: unknown): boolean => error instanceof HubError && error.code === API_ERROR_CODE.INVOICE_INVALID;

interface DemoNodes {
  lightning: LightningPort;
  fiber: FiberPort;
}

interface PayoutInvoice {
  invoice: string;
  paymentHash: Hex32;
}

/**
 * The hub-run demo wallet. It receives payouts on its own nodes (DEMO_LIGHTNING, DEMO_FIBER) and pays hold invoices
 * from them, so a visitor without nodes can try a real swap. It pays only for swaps whose payout comes back to it: the
 * demo money never funds a payout to someone else's wallet. The infrastructure binds both tokens to null when the demo
 * is off; the wallet is enabled only when both nodes exist.
 */
@Injectable()
export class DemoWalletService implements DemoWallet {
  readonly enabled: boolean;
  private readonly nodes: DemoNodes | null;
  private readonly logger = new Logger(DemoWalletService.name);

  constructor(
    @Inject(HUB_CONFIG) private readonly config: HubConfig,
    @Inject(ASSETS) private readonly assets: AssetRegistry,
    @Inject(SWAP_ENGINE) private readonly engine: SwapEngine,
    @Optional() @Inject(DEMO_LIGHTNING) lightning: LightningPort | null = null,
    @Optional() @Inject(DEMO_FIBER) fiber: FiberPort | null = null,
  ) {
    this.nodes = lightning && fiber ? { lightning, fiber } : null;
    this.enabled = this.nodes !== null;
  }

  async createPayoutInvoice(input: { direction: Direction; asset: FiberAssetId; amount: bigint }): Promise<PayoutInvoice> {
    const nodes = this.requireNodes();
    return input.direction === SWAP_DIRECTION.LN_TO_FIBER
      ? this.createFiberInvoice(nodes.fiber, input.asset, input.amount)
      : this.createLightningInvoice(nodes.lightning, input.amount);
  }

  async payHoldInvoice(swapId: string): Promise<void> {
    const nodes = this.requireNodes();
    const swap = this.requireSwapAwaitingPayment(swapId);
    await this.requirePayoutToDemoWallet(nodes, swap);
    if (swap.direction === SWAP_DIRECTION.LN_TO_FIBER) await this.payOnLightning(nodes.lightning, swap);
    else await this.payOnFiber(nodes.fiber, swap);
  }

  /** Both demo nodes look: the one that cannot read the invoice (it is for the other network) says no. */
  async receivesPayout(payoutInvoice: string): Promise<boolean> {
    const nodes = this.nodes;
    if (!nodes) return false;
    const answers = await Promise.all(SWAP_DIRECTIONS.map((direction) => this.receivesOrNot(nodes, direction, payoutInvoice)));
    return answers.some(Boolean);
  }

  private requireNodes(): DemoNodes {
    if (!this.nodes) throw new DemoDisabledError();
    return this.nodes;
  }

  private requireSwapAwaitingPayment(swapId: string): Swap {
    const swap = this.engine.getSwap(swapId);
    if (!swap) throw new NotFoundError(RESOURCE_NAME.SWAP);
    // A pending swap's hold invoice is issued and not yet paid.
    if (swap.state !== SWAP_STATE.PENDING) throw new SwapNotAwaitingPaymentError();
    return swap;
  }

  /** The demo money pays a hold invoice only when the swap's payout goes to the demo wallet itself (409 otherwise). */
  private async requirePayoutToDemoWallet(nodes: DemoNodes, swap: Swap): Promise<void> {
    const receives = await this.callNode(() => this.demoNodeReceives(nodes, swap.direction, swap.payoutInvoice));
    if (!receives) throw new SwapNotForDemoWalletError();
  }

  /** demoNodeReceives, answering no when the node cannot read the invoice or cannot answer (logged). */
  private async receivesOrNot(nodes: DemoNodes, direction: Direction, payoutInvoice: string): Promise<boolean> {
    try {
      return await this.demoNodeReceives(nodes, direction, payoutInvoice);
    } catch (error) {
      if (!isUnreadableInvoice(error)) this.logger.warn(`Could not check whether a payout invoice is the demo wallet's: ${describeError(error)}`);
      return false;
    }
  }

  /**
   * True when `payoutInvoice` is the demo node's own: addressed to it, and issued by it (the node knows the hash). Its
   * state does not matter: a payout to a demo invoice that was cancelled meanwhile fails and is refunded to the demo.
   */
  private demoNodeReceives(nodes: DemoNodes, direction: Direction, payoutInvoice: string): Promise<boolean> {
    return direction === SWAP_DIRECTION.LN_TO_FIBER
      ? this.fiberNodeReceives(nodes.fiber, payoutInvoice)
      : this.lightningNodeReceives(nodes.lightning, payoutInvoice);
  }

  /** The invoice names the demo fnn as payee and the demo fnn has an invoice for its hash. */
  private async fiberNodeReceives(fiber: FiberPort, invoice: string): Promise<boolean> {
    const parsed = await fiber.parseInvoice(invoice);
    const [issued, info] = await Promise.all([fiber.getInvoice(parsed.paymentHash), fiber.getInfo()]);
    return issued !== null && parsed.payee === info.nodeId;
  }

  /** The invoice names the demo LND as destination and the demo LND has an invoice for its hash. */
  private async lightningNodeReceives(lightning: LightningPort, paymentRequest: string): Promise<boolean> {
    const decoded = await lightning.decodeInvoice(paymentRequest);
    const [issued, info] = await Promise.all([lightning.lookupInvoice(decoded.paymentHash), lightning.getInfo()]);
    return issued !== null && decoded.destination === info.pubkey;
  }

  /** ln_to_fiber payout: a sha256 Fiber invoice whose preimage only the demo node knows, like a user's own wallet. */
  private createFiberInvoice(fiber: FiberPort, assetId: FiberAssetId, amount: bigint): Promise<PayoutInvoice> {
    const asset = this.assets.get(assetId);
    if (!asset) throw new DemoAssetUnavailableError(assetId);
    return this.callNode(() =>
      fiber.createInvoice({
        preimage: randomPreimage(),
        amount,
        udtTypeScript: asset.udtTypeScript,
        expirySeconds: this.invoiceExpirySeconds(),
        description: DEMO_INVOICE_DESCRIPTION,
      }),
    );
  }

  /** fiber_to_ln payout: a regular BOLT11 invoice; the demo node generates and keeps the preimage. */
  private async createLightningInvoice(lightning: LightningPort, amountSats: bigint): Promise<PayoutInvoice> {
    const created = await this.callNode(() =>
      lightning.createInvoice({ amountSats, expirySeconds: this.invoiceExpirySeconds(), memo: DEMO_INVOICE_DESCRIPTION }),
    );
    return { invoice: created.paymentRequest, paymentHash: created.paymentHash };
  }

  /** Outlives the longest quote the hub makes (a swap's or a request's), whichever quote the invoice is for. */
  private invoiceExpirySeconds(): number {
    const { quoteTtlSeconds, requestQuoteTtlSeconds } = this.config.pricing;
    return Math.max(quoteTtlSeconds, requestQuoteTtlSeconds) + this.config.demo.payoutInvoiceExtraSeconds;
  }

  /** ln_to_fiber: the user's side pays the hub's BOLT11 hold invoice, within the payer CLTV cap the hub plans for. */
  private async payOnLightning(lightning: LightningPort, swap: Swap): Promise<void> {
    const status = await this.callNode(() =>
      lightning.payInvoice({
        paymentRequest: swap.holdInvoice,
        maxFeeSats: basisPointsOfCeil(swap.sats, this.config.swaps.lnMaxFeeBps),
        cltvLimit: this.config.timing.payerMaxCltv,
        timeoutSeconds: this.config.swaps.lnPayTimeoutSeconds,
      }),
    );
    if (status.state === LIGHTNING_PAYMENT_FAILED) this.failPayment(swap.id, status.failureReason);
  }

  /**
   * fiber_to_ln: the user's side pays the hub's Fiber hold invoice. The lock limit is fnn's default, as any Fiber
   * wallet would use; the hub's own final_expiry_delta sits well inside it.
   */
  private async payOnFiber(fiber: FiberPort, swap: Swap): Promise<void> {
    const status = await this.callNode(() =>
      fiber.payInvoice({
        invoice: swap.holdInvoice,
        maxFeeAmount: basisPointsOfCeil(swap.fiberAmount, this.config.swaps.fiberMaxFeeBps),
        tlcExpiryLimitMs: FIBER_MAX_TLC_EXPIRY_LIMIT_MS,
      }),
    );
    if (status.state === FIBER_PAYMENT_FAILED) this.failPayment(swap.id, status.failedError);
  }

  private failPayment(swapId: string, reason: string | null): never {
    this.logger.warn(`Demo payment for swap ${swapId} failed: ${reason ?? UNKNOWN_PAYMENT_FAILURE}`);
    throw new DemoWalletUnavailableError();
  }

  /** Runs a demo-node call; transport errors become a 503 for the user and a log line for the operator. */
  private callNode<T>(call: () => Promise<T>): Promise<T> {
    return rethrowAsHubError(call, (cause) => {
      this.logger.warn(`Demo node call failed: ${describeError(cause)}`);
      return new DemoWalletUnavailableError({ cause });
    });
  }
}
