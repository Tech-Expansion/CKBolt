import { Controller, HttpCode, HttpStatus, Inject, Post, UseGuards } from "@nestjs/common";
import { API_ROUTES } from "../../../common/constants/api.constants";
import { DEMO_WALLET, type DemoWallet } from "../../../application/demo/demo-wallet.contract";
import {
  createDemoInvoiceBodySchema,
  createDemoPaymentBodySchema,
  type CreateDemoInvoiceBody,
  type CreateDemoPaymentBody,
} from "../contract/requests";
import { resourcePath, type DemoInvoiceDto, type DemoPaymentDto } from "../contract/responses";
import { ValidBody } from "../decorators/request.decorators";
import { DemoEnabledGuard } from "../guards/demo-enabled.guard";
import { DemoRateLimitGuard } from "../guards/demo-rate-limit.guard";
import { toDemoInvoiceInput } from "../mappers/request.mappers";
import { toDemoInvoiceDto, toDemoPaymentDto } from "../presenters/api.presenter";

/**
 * The hub-run demo wallet (custodial test money). 404 demo_disabled when the hub has no demo nodes; otherwise each
 * action counts against the client's hourly demo budget on top of the global rate limit.
 */
@Controller()
@UseGuards(DemoEnabledGuard, DemoRateLimitGuard)
export class DemoController {
  constructor(@Inject(DEMO_WALLET) private readonly demo: DemoWallet) {}

  /** POST /v1/demo/invoices: an invoice the demo wallet receives a swap's payout on. */
  @Post(resourcePath(API_ROUTES.DEMO_INVOICES))
  @HttpCode(HttpStatus.CREATED)
  async createInvoice(@ValidBody(createDemoInvoiceBodySchema) body: CreateDemoInvoiceBody): Promise<DemoInvoiceDto> {
    const invoice = await this.demo.createPayoutInvoice(toDemoInvoiceInput(body));
    return toDemoInvoiceDto(invoice);
  }

  /** POST /v1/demo/payments: the demo wallet pays a swap's hold invoice. 202: the swap then moves on its own. */
  @Post(resourcePath(API_ROUTES.DEMO_PAYMENTS))
  @HttpCode(HttpStatus.ACCEPTED)
  async createPayment(@ValidBody(createDemoPaymentBodySchema) body: CreateDemoPaymentBody): Promise<DemoPaymentDto> {
    await this.demo.payHoldInvoice(body.swapId);
    return toDemoPaymentDto(body.swapId);
  }
}
