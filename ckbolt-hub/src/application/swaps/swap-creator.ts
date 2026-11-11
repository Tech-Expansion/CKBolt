import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { MIN_INVOICE_EXPIRY_SECONDS } from "../../common/constants/protocol.constants";
import { CANCEL_TOKEN_BYTES, SWAP_EVENT } from "../../common/constants/swap.constants";
import { DuplicateHashError } from "../../common/errors/hub.error";
import { describeError } from "../../common/utils/error.util";
import { newSecret, secretDigest } from "../../common/utils/secret.util";
import { secondsUntil } from "../../common/utils/time.util";
import type { AssetRegistry } from "../../domain/assets";
import { createPendingSwap, LEG_NETWORK_NAME, SWAP_REASON } from "../../domain/swap";
import type { FiberAsset, Hex32, Quote, Swap } from "../../domain/types";
import type { Clock } from "../ports/clock.port";
import type { SwapStore } from "../ports/swap-store.port";
import type { PricingService } from "../pricing/pricing.contract";
import type { CreatedSwap, CreateSwapInput } from "./swap-engine.contract";
import { SWAP_ERROR } from "./swap.errors";
import type { SwapFlow, SwapFlows } from "./swap-flow";
import type { SwapJournal } from "./swap-journal";
import type { UnpaidSwapLimits } from "./unpaid-swap-limits";

export interface SwapCreatorDeps {
  pricing: PricingService;
  assets: AssetRegistry;
  store: SwapStore;
  clock: Clock;
  flows: SwapFlows;
  journal: SwapJournal;
  unpaidSwaps: UnpaidSwapLimits;
}

/**
 * Creates swaps: checks the quote and the user's payout invoice, issues the hold invoice on the same payment hash, and
 * saves the swap as pending. Everything is checked before the hold invoice exists, so a refused request leaves nothing
 * behind on the nodes. A client may have only so many swaps waiting for their payment, and those swaps together only a
 * share of the liquidity that pays them out (UnpaidSwapLimits).
 */
export class SwapCreator {
  private readonly logger = new Logger(SwapCreator.name);

  constructor(private readonly deps: SwapCreatorDeps) {}

  async create(input: CreateSwapInput): Promise<CreatedSwap> {
    const quote = this.usableQuote(input.quoteId);
    this.assertQuoteUnused(quote);
    const asset = this.servedAsset(quote);
    const liquidity = await this.deps.pricing.liquidityFor(asset);
    const slot = this.deps.unpaidSwaps.reserve(input.clientKey, quote, liquidity);
    try {
      const swap = await this.createPending(input, quote, asset);
      slot.bind(swap.id);
      return swap;
    } catch (error) {
      slot.release();
      throw error;
    }
  }

  private async createPending(input: CreateSwapInput, quote: Quote, asset: FiberAsset): Promise<CreatedSwap> {
    const flow = this.deps.flows[quote.direction];
    const plan = await flow.planSwap({ quote, asset, payoutInvoice: input.payoutInvoice, now: this.deps.clock.now() });
    await this.assertHashUnused(plan.paymentHash, flow);

    const id = randomUUID();
    const holdInvoice = await flow.createHoldInvoice({ swapId: id, quote, asset, plan, expirySeconds: this.holdInvoiceExpirySeconds(quote) });
    const cancelToken = newSecret(CANCEL_TOKEN_BYTES);
    const swap = createPendingSwap({
      id,
      quote,
      paymentHash: plan.paymentHash,
      payoutInvoice: input.payoutInvoice,
      holdInvoice,
      timing: plan,
      cancelTokenHash: secretDigest(cancelToken),
      demo: input.demo,
      now: this.deps.clock.now(),
    });
    await this.save(swap, flow);
    this.deps.journal.record(swap.id, SWAP_EVENT.CREATED, SWAP_REASON.created(LEG_NETWORK_NAME[flow.legs.incoming]));
    return { ...swap, cancelToken };
  }

  /** The quote must exist, carry an intact signature and still be open. */
  private usableQuote(quoteId: string): Quote {
    const quote = this.deps.pricing.getQuote(quoteId);
    if (!quote) throw SWAP_ERROR.quoteNotFound();
    if (!this.deps.pricing.verifyQuote(quote)) throw SWAP_ERROR.quoteInvalid();
    this.assertQuoteOpen(quote);
    return quote;
  }

  /** One swap per quote: the quote's amounts and liquidity check cover a single payout. */
  private assertQuoteUnused(quote: Quote): void {
    if (this.deps.store.getSwapByQuoteId(quote.id)) throw SWAP_ERROR.quoteAlreadyUsed();
  }

  private servedAsset(quote: Quote): FiberAsset {
    const asset = this.deps.assets.get(quote.asset);
    if (!asset) throw SWAP_ERROR.assetNotServed(quote.asset);
    return asset;
  }

  private assertQuoteOpen(quote: Quote): void {
    if (this.secondsLeft(quote) < MIN_INVOICE_EXPIRY_SECONDS) throw SWAP_ERROR.quoteExpired();
  }

  /**
   * An unpaid hold invoice expires with the quote, whatever its purpose (a request quote lives REQUEST_QUOTE_TTL_SECONDS):
   * the whole seconds it has left, so the node never takes a payment the quote no longer covers. Checked again here:
   * the node calls before it take time.
   */
  private holdInvoiceExpirySeconds(quote: Quote): number {
    this.assertQuoteOpen(quote);
    return this.secondsLeft(quote);
  }

  private secondsLeft(quote: Quote): number {
    return secondsUntil(quote.expiresAt, this.deps.clock.now());
  }

  /** One hash per swap, never reused: not by another swap, and not by an invoice or payment already on the nodes. */
  private async assertHashUnused(paymentHash: Hex32, flow: SwapFlow): Promise<void> {
    if (this.deps.store.getSwapByHash(paymentHash)) throw new DuplicateHashError();
    if (await flow.isHashInUse(paymentHash)) throw new DuplicateHashError();
  }

  /**
   * If the swap cannot be saved (e.g. a concurrent request took the quote or the hash first), nobody can track its hold
   * invoice: cancel it so it can never be paid.
   */
  private async save(swap: Swap, flow: SwapFlow): Promise<void> {
    try {
      this.deps.store.createSwap(swap);
    } catch (error) {
      await this.discardHoldInvoice(swap, flow);
      throw error;
    }
  }

  private async discardHoldInvoice(swap: Swap, flow: SwapFlow): Promise<void> {
    try {
      await flow.cancelIncoming(swap.paymentHash);
    } catch (error) {
      this.logger.error(`Could not cancel the unsaved hold invoice for hash ${swap.paymentHash}: ${describeError(error)}`);
    }
  }
}
