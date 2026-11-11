import { Inject, Injectable } from "@nestjs/common";
import { HTTP_ERROR_MESSAGE, RATE_LIMIT_WINDOW_MS } from "../../../common/constants/http.constants";
import type { Clock } from "../../../application/ports/clock.port";
import { CLOCK, HUB_CONFIG } from "../../../application/ports/tokens";
import type { HubConfig } from "../../../config/hub.config";
import { ClientRateLimitGuard } from "./client-rate-limit.guard";

/** Every API route: HubConfig.server.rateLimitPerMinute requests per client per minute. */
@Injectable()
export class RateLimitGuard extends ClientRateLimitGuard {
  constructor(@Inject(HUB_CONFIG) config: HubConfig, @Inject(CLOCK) clock: Clock) {
    super(config, clock, { limit: config.server.rateLimitPerMinute, windowMs: RATE_LIMIT_WINDOW_MS, message: HTTP_ERROR_MESSAGE.RATE_LIMITED });
  }
}
