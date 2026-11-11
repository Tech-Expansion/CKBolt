import { Controller, Get, HttpCode, HttpStatus, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { API_ROUTES } from "../../../common/constants/api.constants";
import { NODE_ID_PATH_SEGMENT } from "../../../common/constants/http.constants";
import { INBOUND_CHANNELS, type InboundChannels } from "../../../application/fiber-node/inbound-channels.contract";
import { HUB_CONFIG } from "../../../application/ports/tokens";
import type { HubConfig } from "../../../config/hub.config";
import { createInboundChannelBodySchema, type CreateInboundChannelBody } from "../contract/requests";
import {
  resourcePath,
  toInboundChannelDto,
  toInboundChannelOpeningDto,
  type InboundChannelDto,
  type InboundChannelOpeningDto,
  type ListBody,
} from "../contract/responses";
import { NodeIdParam, ValidBody } from "../decorators/request.decorators";
import { InboundEnabledGuard } from "../guards/inbound-enabled.guard";
import { SwapsPausedGuard } from "../guards/swaps-paused.guard";
import { setLocation } from "../http-headers";
import { toOpenInboundChannelInput } from "../mappers/request.mappers";
import { listOf } from "../presenters/api.presenter";
import { requestClientKey, type ClientRequest } from "../rate-limit/client-key";

/**
 * Inbound channels: the hub's Fiber node opens a channel to a node connected to it, so that node can receive. 404
 * inbound_disabled when the hub opens none.
 */
@Controller(resourcePath(API_ROUTES.FIBER_INBOUND_CHANNELS))
@UseGuards(InboundEnabledGuard)
export class InboundChannelsController {
  constructor(
    @Inject(INBOUND_CHANNELS) private readonly inbound: InboundChannels,
    @Inject(HUB_CONFIG) private readonly config: HubConfig,
  ) {}

  /**
   * POST /v1/fiber/inbound-channels: starts opening the channel. 202, since it opens on chain, with Location:
   * /v1/fiber/inbound-channels/:nodeId, where the channel shows. The per-client daily cap counts the client the way the
   * rate limiter does. 503 maintenance while SWAPS_PAUSED.
   */
  @Post()
  @UseGuards(SwapsPausedGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @ValidBody(createInboundChannelBodySchema) body: CreateInboundChannelBody,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InboundChannelOpeningDto> {
    const clientKey = requestClientKey(request, this.config.server);
    const opening = await this.inbound.open(toOpenInboundChannelInput(body, clientKey));
    setLocation(response, resourcePath(API_ROUTES.FIBER_INBOUND_CHANNELS, opening.nodeId));
    return toInboundChannelOpeningDto(opening);
  }

  /** GET /v1/fiber/inbound-channels/:nodeId: the channels the hub's node opened to that node that are not closed. */
  @Get(NODE_ID_PATH_SEGMENT)
  async list(@NodeIdParam() nodeId: string): Promise<ListBody<InboundChannelDto>> {
    const channels = await this.inbound.list(nodeId);
    return listOf(channels.map(toInboundChannelDto));
  }
}
