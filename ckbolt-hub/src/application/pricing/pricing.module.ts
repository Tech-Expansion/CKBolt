import { Module } from "@nestjs/common";
import { Ed25519QuoteSigner } from "./ed25519-quote-signer";
import { LiquidityService } from "./liquidity.service";
import { MarketPriceService } from "./market-price.service";
import { PRICING_SERVICE } from "./pricing.contract";
import { PricingServiceImpl } from "./pricing.service";
import { QUOTE_SIGNER } from "./quote-signer";

/**
 * Firm quotes. Needs the global HUB_CONFIG, ASSETS and CLOCK (HubConfigModule), PRICE_SOURCES (PricesModule),
 * LIGHTNING and FIBER (node modules) and SWAP_STORE (PersistenceModule).
 */
@Module({
  providers: [
    { provide: QUOTE_SIGNER, useClass: Ed25519QuoteSigner },
    MarketPriceService,
    LiquidityService,
    { provide: PRICING_SERVICE, useClass: PricingServiceImpl },
  ],
  exports: [PRICING_SERVICE],
})
export class PricingModule {}
