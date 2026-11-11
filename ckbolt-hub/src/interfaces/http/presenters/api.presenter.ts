import { Inject, Injectable } from "@nestjs/common";
import { DEMO_PAYMENT_STATUS } from "../../../common/constants/http.constants";
import type { HealthReport } from "../../../application/health/health.contract";
import { ASSETS } from "../../../application/ports/tokens";
import type { CreatedSwap } from "../../../application/swaps/swap-engine.contract";
import type { AssetRegistry } from "../../../domain/assets";
import type { FiberAsset, FiberAssetId, Quote, Swap } from "../../../domain/types";
import {
  toCreatedSwapDto,
  toQuoteDto,
  toSwapDto,
  type CreatedSwapDto,
  type DemoInvoiceDto,
  type DemoPaymentDto,
  type HealthDto,
  type ListBody,
  type QuoteDto,
  type SwapDto,
} from "../contract/responses";

/** A collection response: `{ data: [...] }`. */
export const listOf = <T>(items: T[]): ListBody<T> => ({ data: items });

export const toHealthDto = (report: HealthReport): HealthDto => ({
  status: report.status,
  ...(report.reason === undefined ? {} : { reason: report.reason }),
  version: report.version,
  lightning: { ...report.lightning },
  fiber: { ...report.fiber },
  demo: { ...report.demo },
  swaps: { ...report.swaps },
});

export const toDemoInvoiceDto = (invoice: { invoice: string; paymentHash: string }): DemoInvoiceDto => ({
  invoice: invoice.invoice,
  paymentHash: invoice.paymentHash,
});

export const toDemoPaymentDto = (swapId: string): DemoPaymentDto => ({ swapId, status: DEMO_PAYMENT_STATUS.SUBMITTED });

/**
 * Turns quotes and swaps into their DTOs. They need the asset's metadata (decimals), which comes from the hub's asset
 * registry; a stored quote or swap for an asset the hub no longer serves is a server-side inconsistency (500).
 */
@Injectable()
export class ApiPresenter {
  constructor(@Inject(ASSETS) private readonly assets: AssetRegistry) {}

  quote(quote: Quote): QuoteDto {
    return toQuoteDto(quote, this.assetOf(quote.asset));
  }

  swap(swap: Swap): SwapDto {
    return toSwapDto(swap, this.assetOf(swap.asset));
  }

  createdSwap(created: CreatedSwap): CreatedSwapDto {
    return toCreatedSwapDto(created, this.assetOf(created.asset));
  }

  private assetOf(id: FiberAssetId): FiberAsset {
    const asset = this.assets.get(id);
    if (!asset) throw new Error(`Asset ${id} is not in the hub's asset registry`);
    return asset;
  }
}
