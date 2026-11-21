/** The webhook formats the hub's alerts can be posted in (ALERT_WEBHOOK_FORMAT). */
export const ALERT_WEBHOOK_FORMAT = {
  JSON: "json",
  DISCORD: "discord",
  SLACK: "slack",
  TELEGRAM: "telegram",
} as const;

export type AlertWebhookFormat = (typeof ALERT_WEBHOOK_FORMAT)[keyof typeof ALERT_WEBHOOK_FORMAT];

export const ALERT_WEBHOOK_FORMATS = Object.values(ALERT_WEBHOOK_FORMAT) as [AlertWebhookFormat, ...AlertWebhookFormat[]];

/** How an alert's level starts its line in chat formats. */
export const ALERT_LEVEL_MARK = {
  critical: "[CRITICAL]",
  warning: "[WARNING]",
  resolved: "[RESOLVED]",
} as const;
