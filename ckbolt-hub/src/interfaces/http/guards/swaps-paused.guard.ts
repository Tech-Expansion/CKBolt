import { Inject, Injectable, type CanActivate } from "@nestjs/common";
import { HUB_CONFIG } from "../../../application/ports/tokens";
import type { HubConfig } from "../../../config/hub.config";
import { MaintenanceError } from "../errors/http.errors";

/**
 * The maintenance switch (SWAPS_PAUSED): routes that start something new (a quote, a swap, an inbound Fiber or Lightning
 * channel) answer 503 maintenance before the request is read. Reads and the swap engine are left alone, so the swaps
 * already running finish.
 */
@Injectable()
export class SwapsPausedGuard implements CanActivate {
  constructor(@Inject(HUB_CONFIG) private readonly config: HubConfig) {}

  canActivate(): boolean {
    if (this.config.swaps.paused) throw new MaintenanceError();
    return true;
  }
}
