# Monitoring and alerts

The hub watches itself (`src/application/monitoring`), so the operator learns when money or service is at risk without
reading logs. It runs every `MONITOR_INTERVAL_SECONDS` (default 60) unless `MONITOR_ENABLED=false`.

## What it alerts

| Condition | Level | When |
|---|---|---|
| Hub degraded | critical | The health check fails or reports `degraded` (a node unreachable, LND not synced, wrong network) |
| Payout sent, incoming payment not collected | critical | A swap stays in `outgoing_succeeded` longer than `MONITOR_SETTLE_MINUTES` (3). The hub keeps trying to settle; if the incoming hold expires first, it loses the payout |
| Payout still in flight | warning | `outgoing_in_flight` longer than `MONITOR_PAYOUT_IN_FLIGHT_MINUTES` (15) |
| Payment held, payout not started | warning | `incoming_accepted` longer than `MONITOR_PAYOUT_START_MINUTES` (5) |
| Refund not done | warning | A failed swap's incoming payment is not given back after `MONITOR_REFUND_MINUTES` (10) |
| No Lightning payout liquidity / low | critical / warning | What Lightning can pay out is below the smallest swap, or below the largest |
| No payout liquidity for an asset | critical | The asset's Fiber channels can pay out nothing |
| Swap processing failing | critical | `MONITOR_FAILED_PASSES` (3) passes over open swaps fail in a row |
| Payout guard force-closed a channel | warning | Sent once, as it happens (a payee held a payout) |
| Payout guard could not check a payout | warning | Sent once per failure; it retries on the next pass |

A condition is alerted when it starts, sent again every `ALERT_REPEAT_MINUTES` (60) while it lasts ("Still: …"), sent
at once when it changes level or kind (low liquidity becoming none, a failed health check becoming degraded), and
followed by a `resolved` alert when it clears ("[RESOLVED] Hub degraded: cleared. It was: …").

Alerts carry swap ids, amounts and plain reasons. They never carry secrets, preimages or whole invoices.

## Where alerts go

Without `ALERT_WEBHOOK_URL`, alerts are written to the hub's log: critical ones as errors, the rest as warnings. With
it, each alert is POSTed there within `ALERT_WEBHOOK_TIMEOUT_MS`. A failed delivery is logged and never affects swaps.

| `ALERT_WEBHOOK_FORMAT` | `ALERT_WEBHOOK_URL` | Body |
|---|---|---|
| `json` (default) | Any endpoint | The alert: `{ key, level, title, detail }` |
| `discord` | A channel webhook URL | `{ content }` |
| `slack` | An incoming webhook URL | `{ text }` |
| `telegram` | `https://api.telegram.org/bot<token>/sendMessage` | `{ chat_id, text }`. Needs `ALERT_TELEGRAM_CHAT_ID` |

The webhook URL holds a secret (the token in it): keep it in `hub.env`, never in the repository.

## Settings

```
MONITOR_ENABLED=true
MONITOR_INTERVAL_SECONDS=60
MONITOR_SETTLE_MINUTES=3
MONITOR_PAYOUT_IN_FLIGHT_MINUTES=15
MONITOR_PAYOUT_START_MINUTES=5
MONITOR_REFUND_MINUTES=10
MONITOR_FAILED_PASSES=3
ALERT_REPEAT_MINUTES=60
ALERT_WEBHOOK_URL=
ALERT_WEBHOOK_FORMAT=json
ALERT_TELEGRAM_CHAT_ID=
ALERT_WEBHOOK_TIMEOUT_MS=5000
```

## Not covered here

- **Whether the hub is up at all.** A hub that is down cannot alert. Watch the public health endpoint from outside, for
  example with an uptime service on `https://<web app>/api/hub/v1/health`.
- **The server.** Disk, memory and the other containers on the host are outside the hub's view.
