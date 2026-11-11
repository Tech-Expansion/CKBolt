import { Controller, Get, Inject } from "@nestjs/common";
import { API_ROUTES } from "../../../common/constants/api.constants";
import { FIBER_NODE_SERVICE, type FiberNodeService } from "../../../application/fiber-node/fiber-node.contract";
import { resourcePath, toFiberNodeDto, type FiberNodeDto } from "../contract/responses";

@Controller(resourcePath(API_ROUTES.FIBER_NODE))
export class FiberNodeController {
  constructor(@Inject(FIBER_NODE_SERVICE) private readonly node: FiberNodeService) {}

  /** GET /v1/fiber/node: the hub's Fiber node id, network and addresses, the assets and the inbound channels it offers. */
  @Get()
  async get(): Promise<FiberNodeDto> {
    return toFiberNodeDto(await this.node.describe());
  }
}
