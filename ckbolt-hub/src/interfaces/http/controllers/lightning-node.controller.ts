import { Controller, Get, Inject } from "@nestjs/common";
import { API_ROUTES } from "../../../common/constants/api.constants";
import { LIGHTNING_NODE_SERVICE, type LightningNodeService } from "../../../application/lightning-node/lightning-node.contract";
import { resourcePath, toLightningNodeDto, type LightningNodeDto } from "../contract/responses";

@Controller(resourcePath(API_ROUTES.LIGHTNING_NODE))
export class LightningNodeController {
  constructor(@Inject(LIGHTNING_NODE_SERVICE) private readonly node: LightningNodeService) {}

  /** GET /v1/lightning/node: the hub's Lightning node key, network and URIs, and the inbound channels it opens. */
  @Get()
  async get(): Promise<LightningNodeDto> {
    return toLightningNodeDto(await this.node.describe());
  }
}
