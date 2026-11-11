import { Controller, Get, HttpCode, HttpStatus, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { API_ROUTES } from "../../../common/constants/api.constants";
import { PUBKEY_PATH_SEGMENT } from "../../../common/constants/http.constants";
import { LN_INBOUND_CHANNELS, type LnInboundChannels } from "../../../application/lightning-node/ln-inbound-channels.contract";
import { HUB_CONFIG } from "../../../application/ports/tokens";
import type { HubConfig } from "../../../config/hub.config";
import { createLightningInboundChannelBodySchema, type CreateLightningInboundChannelBody } from "../contract/requests";
import {
  resourcePath,
  toLightningInboundChannelDto,
  toLightningInboundChannelOpeningDto,
  type LightningInboundChannelDto,
  type LightningInboundChannelOpeningDto,
  type ListBody,
} from "../contract/responses";
import { LnPubkeyParam, ValidBody } from "../decorators/request.decorators";
import { LnInboundEnabledGuard } from "../guards/ln-inbound-enabled.guard";
import { SwapsPausedGuard } from "../guards/swaps-paused.guard";
import { setLocation } from "../http-headers";
import { toOpenLnInboundChannelInput } from "../mappers/request.mappers";
import { listOf } from "../presenters/api.presenter";
import { requestClientKey, type ClientRequest } from "../rate-limit/client-key";

/**
 * Inbound Lightning channels: the hub's LND opens a channel to a wallet connected to it, so the wallet can pay the hub
 * directly. 404 inbound_disabled when the hub opens none.
 */
@Controller(resourcePath(API_ROUTES.LIGHTNING_INBOUND_CHANNELS))
@UseGuards(LnInboundEnabledGuard)
export class LightningInboundChannelsController {
  constructor(
    @Inject(LN_INBOUND_CHANNELS) private readonly inbound: LnInboundChannels,
    @Inject(HUB_CONFIG) private readonly config: HubConfig,
  ) {}

  /**
   * POST /v1/lightning/inbound-channels: starts opening the channel. 202, since it opens on chain, with Location:
   * /v1/lightning/inbound-channels/:pubkey, where the channel shows. The per-client daily cap counts the client the way
   * the rate limiter does. 503 maintenance while SWAPS_PAUSED.
   */
  @Post()
  @UseGuards(SwapsPausedGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @ValidBody(createLightningInboundChannelBodySchema) body: CreateLightningInboundChannelBody,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LightningInboundChannelOpeningDto> {
    const clientKey = requestClientKey(request, this.config.server);
    const opening = await this.inbound.open(toOpenLnInboundChannelInput(body, clientKey));
    setLocation(response, resourcePath(API_ROUTES.LIGHTNING_INBOUND_CHANNELS, opening.pubkey));
    return toLightningInboundChannelOpeningDto(opening);
  }

  /** GET /v1/lightning/inbound-channels/:pubkey: the channels the hub's LND has with that wallet that are not closed. */
  @Get(PUBKEY_PATH_SEGMENT)
  async list(@LnPubkeyParam() pubkey: string): Promise<ListBody<LightningInboundChannelDto>> {
    const channels = await this.inbound.list(pubkey);
    return listOf(channels.map(toLightningInboundChannelDto));
  }
}
