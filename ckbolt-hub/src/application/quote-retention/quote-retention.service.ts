import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { describeError } from "../../common/utils/error.util";
import type { HubConfig } from "../../config/hub.config";
import type { Clock } from "../ports/clock.port";
import type { QuoteRetention } from "../ports/quote-retention.port";
import { CLOCK, HUB_CONFIG, QUOTE_RETENTION } from "../ports/tokens";

/**
 * Keeps the quotes table from growing forever (docs/security-review-2026-11.md, H9): deletes the quotes that expired more
 * than `config.pricing.quoteRetentionMs` ago and that no swap uses, once at start-up and then every
 * `quotePruneIntervalMs`. A quote a swap uses is never deleted (QuoteRetention). Never throws into the hub: a failed
 * round is logged and the next one tries again.
 */
@Injectable()
export class QuoteRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QuoteRetentionService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(QUOTE_RETENTION) private readonly quotes: QuoteRetention,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(HUB_CONFIG) private readonly config: HubConfig,
  ) {}

  onModuleInit(): void {
    this.prune();
    this.timer = setInterval(() => this.prune(), this.config.pricing.quotePruneIntervalMs);
    // Shutdown clears the timer; unref keeps a forgotten one from holding the process open.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One round. Returns how many quotes it deleted: 0 when there were none, or when the round failed. */
  prune(): number {
    const expiredBefore = this.clock.now() - this.config.pricing.quoteRetentionMs;
    try {
      const deleted = this.quotes.deleteUnusedQuotesExpiredBefore(expiredBefore);
      if (deleted > 0) this.logger.log(`Deleted ${deleted} expired quotes that no swap uses`);
      return deleted;
    } catch (error) {
      this.logger.warn(`Could not delete old quotes: ${describeError(error)}`);
      return 0;
    }
  }
}
