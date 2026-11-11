import { Controller, Get, Inject } from "@nestjs/common";
import { API_ROUTES } from "../../../common/constants/api.constants";
import { PRICING_SERVICE, type PricingService } from "../../../application/pricing/pricing.contract";
import { resourcePath, toAssetDto, type AssetDto, type ListBody } from "../contract/responses";
import { listOf } from "../presenters/api.presenter";

@Controller(resourcePath(API_ROUTES.ASSETS))
export class AssetsController {
  constructor(@Inject(PRICING_SERVICE) private readonly pricing: PricingService) {}

  /** GET /v1/assets: what the hub serves now, with directions, size caps and payout liquidity. */
  @Get()
  async list(): Promise<ListBody<AssetDto>> {
    const assets = await this.pricing.listAssets();
    return listOf(assets.map(toAssetDto));
  }
}
