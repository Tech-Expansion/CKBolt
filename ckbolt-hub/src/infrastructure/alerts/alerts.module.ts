import { Global, Module } from "@nestjs/common";
import type { AlertSink } from "../../application/ports/alert-sink.port";
import { ALERT_SINK, HUB_CONFIG } from "../../application/ports/tokens";
import type { HubConfig } from "../../config/hub.config";
import { LogAlertSink, WebhookAlertSink } from "./webhook-alert-sink";

/** Provides ALERT_SINK: the webhook in config.monitoring.webhook when it is set, else the log. */
@Global()
@Module({
  providers: [
    {
      provide: ALERT_SINK,
      useFactory: (config: HubConfig): AlertSink => {
        const webhook = config.monitoring.webhook;
        return webhook ? new WebhookAlertSink(webhook) : new LogAlertSink();
      },
      inject: [HUB_CONFIG],
    },
  ],
  exports: [ALERT_SINK],
})
export class AlertsModule {}
