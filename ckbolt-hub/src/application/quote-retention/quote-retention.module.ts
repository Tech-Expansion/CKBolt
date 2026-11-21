import { Module } from "@nestjs/common";
import { QuoteRetentionService } from "./quote-retention.service";

/**
 * Deletes old quotes no swap uses (QuoteRetentionService). Needs the global QUOTE_RETENTION (PersistenceModule) and
 * HUB_CONFIG, CLOCK (HubConfigModule). Its own module, so the pricing and swap modules start without it.
 */
@Module({
  providers: [QuoteRetentionService],
})
export class QuoteRetentionModule {}
