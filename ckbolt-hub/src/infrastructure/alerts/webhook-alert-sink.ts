import { Logger } from "@nestjs/common";
import { ALERT_WEBHOOK_FORMAT, ALERT_LEVEL_MARK, type AlertWebhookFormat } from "../../common/constants/monitoring.constants";
import { describeError } from "../../common/utils/error.util";
import type { Alert, AlertSink } from "../../application/ports/alert-sink.port";

export interface WebhookAlertSettings {
  url: string;
  format: AlertWebhookFormat;
  /** Telegram only: the chat the bot writes to. */
  telegramChatId: string | null;
  timeoutMs: number;
}

/** One line of text for chat formats: "[CRITICAL] Hub degraded: The hub's Lightning node does not answer." */
export const alertText = (alert: Alert): string => `${ALERT_LEVEL_MARK[alert.level]} ${alert.title}: ${alert.detail}`;

/** The request body each webhook format expects. */
export function webhookBody(alert: Alert, settings: Pick<WebhookAlertSettings, "format" | "telegramChatId">): unknown {
  switch (settings.format) {
    case ALERT_WEBHOOK_FORMAT.DISCORD:
      return { content: alertText(alert) };
    case ALERT_WEBHOOK_FORMAT.SLACK:
      return { text: alertText(alert) };
    case ALERT_WEBHOOK_FORMAT.TELEGRAM:
      return { chat_id: settings.telegramChatId, text: alertText(alert) };
    case ALERT_WEBHOOK_FORMAT.JSON:
      return alert;
  }
}

/** Posts each alert to a webhook (ALERT_WEBHOOK_URL), within a timeout; a failure is logged, never thrown. */
export class WebhookAlertSink implements AlertSink {
  private readonly logger = new Logger(WebhookAlertSink.name);

  constructor(
    private readonly settings: WebhookAlertSettings,
    private readonly post: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async send(alert: Alert): Promise<void> {
    try {
      const response = await this.post(this.settings.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(webhookBody(alert, this.settings)),
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
      if (!response.ok) this.logger.warn(`Alert ${alert.key} not delivered: the webhook answered ${response.status}`);
    } catch (error) {
      this.logger.warn(`Alert ${alert.key} not delivered: ${describeError(error)}`);
    }
  }
}

/** Without a webhook: alerts go to the log, at warn level (error for critical ones). */
export class LogAlertSink implements AlertSink {
  private readonly logger = new Logger("HubAlert");

  async send(alert: Alert): Promise<void> {
    if (alert.level === "critical") this.logger.error(alertText(alert));
    else this.logger.warn(alertText(alert));
  }
}
