/** How bad an alert is; `resolved` says a condition that was alerted has cleared. */
export type AlertLevel = "critical" | "warning" | "resolved";

/**
 * One message to the operator. `key` names the condition, so it is alerted once, reminded, then resolved. Alerts never
 * carry secrets, preimages or whole invoices: swap ids, amounts and plain reasons only.
 */
export interface Alert {
  key: string;
  level: AlertLevel;
  title: string;
  detail: string;
}

/** Where alerts go (a webhook, or the log). Never throws: a failed delivery is the adapter's to log. */
export interface AlertSink {
  send(alert: Alert): Promise<void>;
}
