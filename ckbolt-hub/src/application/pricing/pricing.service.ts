import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { QUOTE_PURPOSE, REQUEST_QUOTE_DIRECTIONS, SWAP_DIRECTION, SWAP_DIRECTIONS } from "../../common/constants/swap.constants";
import { secondsToMs } from "../../common/utils/time.util";
import type { HubConfig } from "../../config/hub.config";
import type { AssetRegistry } from "../../domain/assets";
import {
  assertFeeBps,
  assetLiquidity,
  assetPriceFor,
  availablePayout,
  canonicalQuoteMessage,
  exchangeTermsFor,
  fixesLightningLeg,
  hasEmptyLeg,
  payoutAmount,
  payoutMaxFeeBps,
  quoteAmounts,
  resolveAssetTerms,
  type AssetLiquidity,
  type AssetPrice,
  type AssetTerms,
  type ExchangeTerms,
  type PayoutReservation,
  type QuoteAmounts,
  type UnsignedQuote,
} from "../../domain/pricing";
import type { Direction, FiberAsset, FiberAssetId, Quote, QuotePurpose, QuoteRequest } from "../../domain/types";
import type { Clock } from "../ports/clock.port";
import type { SwapStore } from "../ports/swap-store.port";
import { ASSETS, CLOCK, HUB_CONFIG, SWAP_STORE } from "../ports/tokens";
import { LiquidityService } from "./liquidity.service";
import { MarketPriceService } from "./market-price.service";
import type { AssetAvailability, PricingService } from "./pricing.contract";
import { PRICING_ERROR } from "./pricing.errors";
import { QUOTE_SIGNER, type QuoteSigner } from "./quote-signer";

/** Everything a quote is drafted from. */
interface QuoteDraft {
  direction: Direction;
  asset: FiberAsset;
  purpose: QuotePurpose;
  amounts: QuoteAmounts;
  terms: ExchangeTerms;
  price: AssetPrice;
}

/** What a quote's purpose sets: the premium on top of the asset's fee and option premium, and how long the quote lives. */
interface PurposeTerms {
  premiumBps: number;
  ttlMs: number;
}

/**
 * Firm quotes: a median market price of the coins the asset's USD rule needs, the asset's hub fee plus option premium,
 * its Lightning caps and the hub's payout liquidity, signed with the hub's key and stored for the swap that redeems it.
 * The fee, premium and caps are the asset's own terms (FIBER_ASSETS), the global ones where it sets none. Liquidity is
 * what the payout side holds less the payouts open swaps have not sent yet, each with its routing fee budget
 * (config.swaps fee limits). A request quote (Get paid) lives REQUEST_QUOTE_TTL_SECONDS instead of QUOTE_TTL_SECONDS
 * and adds REQUEST_PREMIUM_BPS.
 */
@Injectable()
export class PricingServiceImpl implements PricingService {
  /** Per purpose: the premium added to the asset's fee and option premium, and the quote's lifetime. */
  private readonly termsByPurpose: Readonly<Record<QuotePurpose, PurposeTerms>>;

  constructor(
    @Inject(HUB_CONFIG) private readonly config: HubConfig,
    @Inject(ASSETS) private readonly assets: AssetRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SWAP_STORE) private readonly store: SwapStore,
    @Inject(QUOTE_SIGNER) private readonly signer: QuoteSigner,
    private readonly marketPrices: MarketPriceService,
    private readonly liquidity: LiquidityService,
  ) {
    const { requestPremiumBps, quoteTtlSeconds, requestQuoteTtlSeconds } = config.pricing;
    this.termsByPurpose = {
      [QUOTE_PURPOSE.SWAP]: { premiumBps: 0, ttlMs: secondsToMs(quoteTtlSeconds) },
      [QUOTE_PURPOSE.REQUEST]: { premiumBps: requestPremiumBps, ttlMs: secondsToMs(requestQuoteTtlSeconds) },
    };
    for (const asset of assets.list()) {
      for (const purpose of Object.values(QUOTE_PURPOSE)) assertFeeBps(this.totalFeeBps(asset, purpose));
    }
  }

  async createQuote(request: QuoteRequest): Promise<Quote> {
    const purpose = this.servedPurpose(request);
    const asset = this.servedAsset(request.asset);
    if (request.amount <= 0n) throw PRICING_ERROR.amountNotPositive();
    if (fixesLightningLeg(request)) this.assertSatsInRange(request.amount, asset);

    const price = assetPriceFor(asset.usdRule, await this.marketPrices.current());
    if (!price) throw PRICING_ERROR.noFreshPrice();
    const terms = exchangeTermsFor(asset, price, this.totalFeeBps(asset, purpose));
    const amounts = quoteAmounts(request, terms);
    this.assertSatsInRange(amounts.sats, asset);
    if (hasEmptyLeg(amounts)) throw PRICING_ERROR.amountTooSmall();
    await this.assertPayoutCovered(request.direction, asset, amounts);

    const quote = this.sign(this.draft({ direction: request.direction, asset, purpose, amounts, terms, price }));
    this.store.saveQuote(quote);
    return quote;
  }

  getQuote(id: string): Quote | null {
    return this.store.getQuote(id);
  }

  verifyQuote(quote: Quote): boolean {
    return quote.hubPubkey === this.signer.publicKeyHex && this.signer.verify(canonicalQuoteMessage(quote), quote.signature, quote.hubPubkey);
  }

  async listAssets(): Promise<AssetAvailability[]> {
    const snapshot = await this.liquidity.snapshot();
    const openSwaps = this.store.listOpenSwaps();
    return this.assets.list().map((asset) => {
      const liquidity = assetLiquidity(snapshot, asset);
      const { minSats, maxSats } = this.termsOf(asset);
      return {
        asset,
        directions: [...SWAP_DIRECTIONS],
        minSats,
        maxSats,
        liquidity: {
          lightningSats: this.availablePayout(liquidity, openSwaps, SWAP_DIRECTION.FIBER_TO_LN, asset),
          fiberAmount: this.availablePayout(liquidity, openSwaps, SWAP_DIRECTION.LN_TO_FIBER, asset),
        },
      };
    });
  }

  async liquidityFor(asset: FiberAsset): Promise<AssetLiquidity> {
    return assetLiquidity(await this.liquidity.snapshot(), asset);
  }

  /** A swap quote unless the request asks for another purpose; a request quote only for REQUEST_QUOTE_DIRECTIONS. */
  private servedPurpose({ purpose = QUOTE_PURPOSE.SWAP, direction }: QuoteRequest): QuotePurpose {
    if (purpose === QUOTE_PURPOSE.REQUEST && !REQUEST_QUOTE_DIRECTIONS.includes(direction)) {
      throw PRICING_ERROR.purposeUnsupported(purpose, direction);
    }
    return purpose;
  }

  private servedAsset(id: FiberAssetId): FiberAsset {
    const asset = this.assets.get(id);
    if (!asset) throw PRICING_ERROR.assetNotServed(id);
    return asset;
  }

  /** The asset's own terms (FIBER_ASSETS), the global pricing values for what it does not set. */
  private termsOf(asset: FiberAsset): AssetTerms {
    return resolveAssetTerms(this.config.pricing, this.config.pricing.termsByAsset[asset.id]);
  }

  /** Hub fee plus option premium of the asset, plus the purpose's premium: the fee a quote applies once. */
  private totalFeeBps(asset: FiberAsset, purpose: QuotePurpose): number {
    const { feeBps, optionPremiumBps } = this.termsOf(asset);
    return feeBps + optionPremiumBps + this.termsByPurpose[purpose].premiumBps;
  }

  private assertSatsInRange(sats: bigint, asset: FiberAsset): void {
    const { minSats, maxSats } = this.termsOf(asset);
    if (sats < minSats || sats > maxSats) throw PRICING_ERROR.satsOutOfRange(sats, minSats, maxSats);
  }

  private async assertPayoutCovered(direction: Direction, asset: FiberAsset, amounts: QuoteAmounts): Promise<void> {
    const liquidity = await this.liquidityFor(asset);
    const available = this.availablePayout(liquidity, this.store.listOpenSwaps(), direction, asset);
    if (payoutAmount(direction, amounts) > available) throw PRICING_ERROR.insufficientLiquidity(direction, available, asset);
  }

  /** The largest payout a new quote in `direction` can get, after open swaps' payouts and its own fee budget. */
  private availablePayout(liquidity: AssetLiquidity, openSwaps: readonly PayoutReservation[], direction: Direction, asset: FiberAsset): bigint {
    return availablePayout(liquidity, openSwaps, { direction, asset: asset.id }, payoutMaxFeeBps(direction, this.config.swaps));
  }

  private draft({ direction, asset, purpose, amounts, terms, price }: QuoteDraft): UnsignedQuote {
    const createdAt = this.clock.now();
    return {
      id: randomUUID(),
      direction,
      asset: asset.id,
      sats: amounts.sats,
      fiberAmount: amounts.fiberAmount,
      btcUsd: terms.btcUsd,
      assetUsd: terms.assetUsd,
      priceSource: price.source,
      priceAt: price.at,
      feeBps: terms.feeBps,
      purpose,
      createdAt,
      expiresAt: createdAt + this.termsByPurpose[purpose].ttlMs,
    };
  }

  private sign(quote: UnsignedQuote): Quote {
    return { ...quote, signature: this.signer.sign(canonicalQuoteMessage(quote)), hubPubkey: this.signer.publicKeyHex };
  }
}
