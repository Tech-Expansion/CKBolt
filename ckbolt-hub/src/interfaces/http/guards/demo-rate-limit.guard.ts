import { Inject, Injectable } from "@nestjs/common";
import { DEMO_RATE_LIMIT_WINDOW_MS, HTTP_ERROR_MESSAGE } from "../../../common/constants/http.constants";
import type { Clock } from "../../../application/ports/clock.port";
import { CLOCK, HUB_CONFIG } from "../../../application/ports/tokens";
import type { HubConfig } from "../../../config/hub.config";
import { ClientRateLimitGuard } from "./client-rate-limit.guard";

/**
 * Demo-wallet actions (invoices and payments together): HubConfig.demo.maxActionsPerHour per client per hour, and
 * HubConfig.demo.maxTotalActionsPerHour for every client together, since client keys can be shared or made up.
 */
@Injectable()
export class DemoRateLimitGuard extends ClientRateLimitGuard {
  constructor(@Inject(HUB_CONFIG) config: HubConfig, @Inject(CLOCK) clock: Clock) {
    super(config, clock, {
      limit: config.demo.maxActionsPerHour,
      windowMs: DEMO_RATE_LIMIT_WINDOW_MS,
      message: HTTP_ERROR_MESSAGE.DEMO_RATE_LIMITED,
      total: { limit: config.demo.maxTotalActionsPerHour, message: HTTP_ERROR_MESSAGE.DEMO_TOTAL_RATE_LIMITED },
    });
  }
}
