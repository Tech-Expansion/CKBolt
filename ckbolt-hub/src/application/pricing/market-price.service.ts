import { Inject, Injectable, Logger } from "@nestjs/common";
import { PRICED_COINS } from "../../common/constants/price-sources.constants";
import { describeError } from "../../common/utils/error.util";
import type { HubConfig } from "../../config/hub.config";
import { aggregateMarketPrice, hasAnyCoinPrice, isFreshMarketPrice, type MarketPrice } from "../../domain/pricing";
import type { Clock } from "../ports/clock.port";
import type { PriceSource, UsdPrices } from "../ports/prices.port";
import { CLOCK, HUB_CONFIG, PRICE_SOURCES } from "../ports/tokens";
import { PRICING_ERROR } from "./pricing.errors";

/** A market price and when the hub fetched it. */
interface CachedPrice {
  price: MarketPrice;
  fetchedAt: number;
}

/**
 * Reads every configured price source at once and returns, per coin, the median of the fresh prices. A fetched price is
 * reused for `config.pricing.priceCacheMs` while it stays fresh, and concurrent requests share one round of source
 * requests, so a burst of quotes does not hammer the public price APIs (and run into their rate limits).
 */
@Injectable()
export class MarketPriceService {
  private readonly logger = new Logger(MarketPriceService.name);
  private cached: CachedPrice | null = null;
  private pending: Promise<MarketPrice> | null = null;

  constructor(
    @Inject(PRICE_SOURCES) private readonly sources: readonly PriceSource[],
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(HUB_CONFIG) private readonly config: HubConfig,
  ) {}

  /**
   * The market price per coin now; a coin no source has a fresh price for is null (assetPriceFor then refuses only the
   * assets that need it). Throws QUOTE_UNAVAILABLE (503) when no coin has a fresh price at all.
   */
  async current(): Promise<MarketPrice> {
    if (this.cached && this.isReusable(this.cached)) return this.cached.price;
    this.pending ??= this.fetchMarketPrice().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Within the cache window, and every coin price still within the allowed age. */
  private isReusable({ price, fetchedAt }: CachedPrice): boolean {
    const now = this.clock.now();
    const { priceCacheMs, maxPriceAgeMs } = this.config.pricing;
    return now - fetchedAt < priceCacheMs && isFreshMarketPrice(price, { now, maxAgeMs: maxPriceAgeMs });
  }

  private async fetchMarketPrice(): Promise<MarketPrice> {
    const samples = await this.fetchAll();
    const now = this.clock.now();
    const price = aggregateMarketPrice(samples, { now, maxAgeMs: this.config.pricing.maxPriceAgeMs });
    if (!hasAnyCoinPrice(price)) throw PRICING_ERROR.noFreshPrice();
    this.cached = { price, fetchedAt: now };
    return price;
  }

  /**
   * Prices from every source that answered; a failing source (even one that throws synchronously) is logged and skipped,
   * and so is a coin a source answered without.
   */
  private async fetchAll(): Promise<UsdPrices[]> {
    const results = await Promise.allSettled(this.sources.map(async (source) => source.fetch()));
    return results.flatMap((result, index) => {
      const name = this.sources[index]?.name;
      if (result.status === "rejected") {
        this.logger.warn(`Price source ${name} failed: ${describeError(result.reason)}`);
        return [];
      }
      const missing = PRICED_COINS.filter((coin) => result.value[coin] === null);
      if (missing.length > 0) this.logger.warn(`Price source ${name} has no ${missing.join(", ")} price`);
      return [result.value];
    });
  }
}
