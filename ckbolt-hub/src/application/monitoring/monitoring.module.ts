import { Global, Module } from "@nestjs/common";
import { HealthModule } from "../health/health.module";
import { PricingModule } from "../pricing/pricing.module";
import { HubMonitorService } from "./hub-monitor.service";
import { OPERATOR_EVENTS, OperatorEvents } from "./operator-events";

/**
 * The hub's monitor (HubMonitorService) and the in-process bus the swap machinery reports on (OPERATOR_EVENTS, global,
 * so the swaps module can emit without depending on this one). Needs ALERT_SINK (AlertsModule), the global SWAP_STORE,
 * CLOCK and HUB_CONFIG, the health check and the pricing service.
 */
@Global()
@Module({
  imports: [HealthModule, PricingModule],
  providers: [{ provide: OPERATOR_EVENTS, useFactory: () => new OperatorEvents() }, HubMonitorService],
  exports: [OPERATOR_EVENTS],
})
export class MonitoringModule {}
