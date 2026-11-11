import { Controller, Get, Headers, HttpCode, HttpStatus, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { API_ROUTES, RESOURCE_NAME } from "../../../common/constants/api.constants";
import { HTTP_HEADER, ID_PATH_SEGMENT } from "../../../common/constants/http.constants";
import { NotFoundError } from "../../../common/errors/hub.error";
import { DEMO_WALLET, type DemoWallet } from "../../../application/demo/demo-wallet.contract";
import { HUB_CONFIG } from "../../../application/ports/tokens";
import { SWAP_ENGINE, type SwapEngine } from "../../../application/swaps/swap-engine.contract";
import type { HubConfig } from "../../../config/hub.config";
import type { Swap } from "../../../domain/types";
import { createSwapBodySchema, type CreateSwapBody } from "../contract/requests";
import { resourcePath, toSwapEventDto, type CreatedSwapDto, type ListBody, type SwapDto, type SwapEventDto } from "../contract/responses";
import { IdParam, ValidBody } from "../decorators/request.decorators";
import { setLocation } from "../http-headers";
import { toCreateSwapInput } from "../mappers/request.mappers";
import { ApiPresenter, listOf } from "../presenters/api.presenter";
import { SwapsPausedGuard } from "../guards/swaps-paused.guard";
import { requestClientKey, type ClientRequest } from "../rate-limit/client-key";

const SWAP_EVENTS_PATH = `${ID_PATH_SEGMENT}/${API_ROUTES.SWAP_EVENTS}`;
const SWAP_CANCEL_PATH = `${ID_PATH_SEGMENT}/${API_ROUTES.SWAP_CANCEL}`;

@Controller(resourcePath(API_ROUTES.SWAPS))
export class SwapsController {
  constructor(
    @Inject(SWAP_ENGINE) private readonly engine: SwapEngine,
    @Inject(DEMO_WALLET) private readonly demoWallet: DemoWallet,
    @Inject(HUB_CONFIG) private readonly config: HubConfig,
    private readonly presenter: ApiPresenter,
  ) {}

  /**
   * POST /v1/swaps: starts a swap on a quote. 201 with Location: /v1/swaps/:id; `pay.invoice` is what the user pays,
   * `cancelToken` what cancels it, here only.
   * The swap is a demo swap when the demo wallet receives its payout, whatever the request says. 429 when the client
   * (counted as the rate limiter counts it) or the hub already has too many swaps waiting for their payment; 503
   * maintenance while the hub is paused.
   */
  @Post()
  @UseGuards(SwapsPausedGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @ValidBody(createSwapBodySchema) body: CreateSwapBody,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreatedSwapDto> {
    const demo = await this.demoWallet.receivesPayout(body.payoutInvoice);
    const clientKey = requestClientKey(request, this.config.server);
    const created = await this.engine.createSwap(toCreateSwapInput(body, demo, clientKey));
    setLocation(response, resourcePath(API_ROUTES.SWAPS, created.id));
    return this.presenter.createdSwap(created);
  }

  /**
   * POST /v1/swaps/:id/cancel: cancels a swap nobody has paid, for whoever holds its cancel token (X-CKBolt-Cancel-Token),
   * and answers the swap as saved; asking again answers the same. 403 cancel_refused without the right token; 409
   * conflict once a payment arrived or the swap has moved on; 503 upstream_unavailable when the node cannot say what it
   * holds. Open while the hub is paused: it starts nothing and frees liquidity.
   */
  @Post(SWAP_CANCEL_PATH)
  @HttpCode(HttpStatus.OK)
  async cancel(@IdParam() id: string, @Headers(HTTP_HEADER.CANCEL_TOKEN) cancelToken: string | undefined): Promise<SwapDto> {
    return this.presenter.swap(await this.engine.cancelSwap(id, cancelToken));
  }

  /** GET /v1/swaps/:id */
  @Get(ID_PATH_SEGMENT)
  get(@IdParam() id: string): SwapDto {
    return this.presenter.swap(this.requireSwap(id));
  }

  /** GET /v1/swaps/:id/events: the swap's event log, oldest first. */
  @Get(SWAP_EVENTS_PATH)
  events(@IdParam() id: string): ListBody<SwapEventDto> {
    this.requireSwap(id);
    return listOf(this.engine.listEvents(id).map(toSwapEventDto));
  }

  private requireSwap(id: string): Swap {
    const swap = this.engine.getSwap(id);
    if (!swap) throw new NotFoundError(RESOURCE_NAME.SWAP);
    return swap;
  }
}
