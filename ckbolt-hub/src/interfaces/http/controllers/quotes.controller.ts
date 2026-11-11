import { Controller, Get, HttpCode, HttpStatus, Inject, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { API_ROUTES, RESOURCE_NAME } from "../../../common/constants/api.constants";
import { ID_PATH_SEGMENT } from "../../../common/constants/http.constants";
import { NotFoundError } from "../../../common/errors/hub.error";
import { PRICING_SERVICE, type PricingService } from "../../../application/pricing/pricing.contract";
import { createQuoteBodySchema, type CreateQuoteBody } from "../contract/requests";
import { resourcePath, type QuoteDto } from "../contract/responses";
import { IdParam, ValidBody } from "../decorators/request.decorators";
import { SwapsPausedGuard } from "../guards/swaps-paused.guard";
import { setLocation } from "../http-headers";
import { toQuoteRequest } from "../mappers/request.mappers";
import { ApiPresenter } from "../presenters/api.presenter";

@Controller(resourcePath(API_ROUTES.QUOTES))
export class QuotesController {
  constructor(
    @Inject(PRICING_SERVICE) private readonly pricing: PricingService,
    private readonly presenter: ApiPresenter,
  ) {}

  /** POST /v1/quotes: a firm, signed quote. 201 with Location: /v1/quotes/:id; 503 maintenance while the hub is paused. */
  @Post()
  @UseGuards(SwapsPausedGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(@ValidBody(createQuoteBodySchema) body: CreateQuoteBody, @Res({ passthrough: true }) response: Response): Promise<QuoteDto> {
    const quote = await this.pricing.createQuote(toQuoteRequest(body));
    setLocation(response, resourcePath(API_ROUTES.QUOTES, quote.id));
    return this.presenter.quote(quote);
  }

  /** GET /v1/quotes/:id */
  @Get(ID_PATH_SEGMENT)
  get(@IdParam() id: string): QuoteDto {
    const quote = this.pricing.getQuote(id);
    if (!quote) throw new NotFoundError(RESOURCE_NAME.QUOTE);
    return this.presenter.quote(quote);
  }
}
