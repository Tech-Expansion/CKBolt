import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { describeError } from "../../common/utils/error.util";
import type { HubConfig } from "../../config/hub.config";
import { HEALTH_SERVICE, type HealthReport, type HealthService } from "../health/health.contract";
import { PRICING_SERVICE, type AssetAvailability, type PricingService } from "../pricing/pricing.contract";
import type { Alert, AlertSink } from "../ports/alert-sink.port";
import type { Clock } from "../ports/clock.port";
import type { SwapStore } from "../ports/swap-store.port";
import { ALERT_SINK, CLOCK, HUB_CONFIG, SWAP_STORE } from "../ports/tokens";
import { healthConditions, liquidityConditions, passConditions, swapConditions, type Condition } from "./monitor.checks";
import { OPERATOR_EVENTS, type OperatorEvent, type OperatorEvents } from "./operator-events";

/** A condition the operator was told about, and when they were last told. */
interface Alerted {
  condition: Condition;
  lastSentAt: number;
}

/** A resolved alert keeps the condition's title (its level says it cleared) and says what it was. */
const RESOLVED_DETAIL_PREFIX = "cleared. It was: ";
const REMINDER_PREFIX = "Still: ";

/** One key can change level (low liquidity becoming none) or kind (health failing becoming degraded): tell at once. */
const changedSince = (before: Condition, now: Condition): boolean => before.level !== now.level || before.title !== now.title;

/**
 * Watches the hub so the operator learns, without reading logs, when money or service is at risk (docs/monitoring.md):
 * every `config.monitoring.intervalMs` it reads the health check, the open swaps and the payout liquidity, and it hears
 * the payout guard and the swap scheduler as they act (OperatorEvents). A condition is alerted when it starts, reminded
 * every `repeatMs` while it lasts, and resolved when it clears. Off with MONITOR_ENABLED=false. Never throws into the
 * hub: a failed read becomes a condition, a failed delivery is the sink's to log.
 */
@Injectable()
export class HubMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HubMonitorService.name);
  private readonly alerted = new Map<string, Alerted>();
  private readonly oneShots: Condition[] = [];
  private failedPasses = 0;
  private lastPassError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private running = false;

  constructor(
    @Inject(HEALTH_SERVICE) private readonly health: HealthService,
    @Inject(PRICING_SERVICE) private readonly pricing: PricingService,
    @Inject(SWAP_STORE) private readonly store: SwapStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(HUB_CONFIG) private readonly config: HubConfig,
    @Inject(ALERT_SINK) private readonly sink: AlertSink,
    @Inject(OPERATOR_EVENTS) private readonly events: OperatorEvents,
  ) {}

  onModuleInit(): void {
    if (!this.config.monitoring.enabled) return;
    this.unsubscribe = this.events.on((event) => this.onEvent(event));
    this.timer = setInterval(() => void this.check(), this.config.monitoring.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** One round: what holds now is alerted, reminded or resolved; then what happened since the last round, once each. */
  async check(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const conditions = [
        ...(await this.healthNow()),
        ...swapConditions(this.store.listOpenSwaps(), this.clock.now(), this.config.monitoring.swapLimits),
        ...(await this.liquidityNow()),
        ...passConditions(this.failedPasses, this.config.monitoring.failedPassesAlert, this.lastPassError),
      ];
      await this.publish(conditions);
      for (const happened of this.oneShots.splice(0)) await this.send({ ...happened });
    } catch (error) {
      this.logger.error(`Monitor round failed: ${describeError(error)}`);
    } finally {
      this.running = false;
    }
  }

  private onEvent(event: OperatorEvent): void {
    switch (event.kind) {
      case "payout-guard-closed":
        this.oneShots.push({
          key: `guard:${event.swapId}:${event.channelId}`,
          level: "warning",
          title: "Payout guard force-closed a channel",
          detail: `Swap ${event.swapId}: the payee held the payout, so the hub force-closed channel ${event.channelId} to settle on chain in time.`,
        });
        return;
      case "payout-guard-failed":
        this.oneShots.push({
          key: `guard-failed:${event.swapId}`,
          level: "warning",
          title: "Payout guard could not check a payout",
          detail: `Swap ${event.swapId}: ${event.detail}. It retries on the next pass.`,
        });
        return;
      case "swap-pass-failed":
        this.failedPasses += 1;
        this.lastPassError = event.detail;
        return;
      case "swap-pass-ok":
        this.failedPasses = 0;
        this.lastPassError = null;
        return;
    }
  }

  private async healthNow(): Promise<Condition[]> {
    let report: HealthReport | null = null;
    let error: string | null = null;
    try {
      report = await this.health.check();
    } catch (e) {
      error = describeError(e);
    }
    return healthConditions(report, error);
  }

  private async liquidityNow(): Promise<Condition[]> {
    let assets: AssetAvailability[];
    try {
      assets = await this.pricing.listAssets();
    } catch {
      // The nodes are unreadable: the health condition says so.
      return [];
    }
    return liquidityConditions(assets);
  }

  private async publish(conditions: readonly Condition[]): Promise<void> {
    const now = this.clock.now();
    const holding = new Set<string>();
    for (const condition of conditions) {
      holding.add(condition.key);
      const before = this.alerted.get(condition.key);
      if (!before || changedSince(before.condition, condition)) {
        await this.send(condition);
        this.alerted.set(condition.key, { condition, lastSentAt: now });
      } else if (now - before.lastSentAt >= this.config.monitoring.repeatMs) {
        await this.send({ ...condition, title: `${REMINDER_PREFIX}${condition.title}` });
        this.alerted.set(condition.key, { condition, lastSentAt: now });
      }
    }
    for (const [key, { condition }] of this.alerted) {
      if (holding.has(key)) continue;
      this.alerted.delete(key);
      await this.send({ key, level: "resolved", title: condition.title, detail: `${RESOLVED_DETAIL_PREFIX}${condition.detail}` });
    }
  }

  private send(alert: Alert): Promise<void> {
    return this.sink.send(alert);
  }
}
