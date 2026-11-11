import { Inject, Injectable, Logger } from "@nestjs/common";
import { HEALTH_REASON_SEPARATOR, HEALTH_STATUS } from "../../common/constants/health.constants";
import { describeError } from "../../common/utils/error.util";
import { withTimeout } from "../../common/utils/promise-timeout.util";
import type { HubConfig } from "../../config/hub.config";
import type { FiberPort } from "../ports/fiber.port";
import type { LightningPort } from "../ports/lightning.port";
import { FIBER, HUB_CONFIG, LIGHTNING } from "../ports/tokens";
import type { HealthReport, HealthService } from "./health.contract";
import { HEALTH_REASON } from "./health.reasons";
import { HUB_VERSION } from "./health.tokens";

type LightningHealth = HealthReport["lightning"];
type FiberHealth = HealthReport["fiber"];

const LIGHTNING_LABEL = "Lightning node";
const FIBER_LABEL = "Fiber node";

const unreachableLightning = (): LightningHealth => ({ reachable: false, network: null, synced: false, blockHeight: null });
const unreachableFiber = (): FiberHealth => ({ reachable: false, network: null, version: null });

/**
 * Asks the hub's own Lightning and Fiber nodes for their info, each within `config.health.timeoutMs`. The hub is `ok`
 * only when both answer, each runs on the network the hub is configured for (as the node itself reports it), and
 * Lightning is synced to the chain (its block height drives every swap's timing). Otherwise it is `degraded`, with a
 * plain reason per problem.
 */
@Injectable()
export class HealthServiceImpl implements HealthService {
  private readonly logger = new Logger(HealthServiceImpl.name);

  constructor(
    @Inject(LIGHTNING) private readonly lightning: LightningPort,
    @Inject(FIBER) private readonly fiber: FiberPort,
    @Inject(HUB_CONFIG) private readonly config: HubConfig,
    @Inject(HUB_VERSION) private readonly version: string,
  ) {}

  async check(): Promise<HealthReport> {
    const [lightning, fiber] = await Promise.all([this.checkLightning(), this.checkFiber()]);
    const reasons = [...this.lightningProblems(lightning), ...this.fiberProblems(fiber)];
    return {
      status: reasons.length === 0 ? HEALTH_STATUS.OK : HEALTH_STATUS.DEGRADED,
      ...(reasons.length === 0 ? {} : { reason: reasons.join(HEALTH_REASON_SEPARATOR) }),
      version: this.version,
      lightning,
      fiber,
      demo: { enabled: this.config.demo.enabled },
      swaps: { paused: this.config.swaps.paused },
    };
  }

  private lightningProblems(health: LightningHealth): string[] {
    if (!health.reachable) return [HEALTH_REASON.lightningUnreachable()];
    const configured = this.config.bitcoin.network;
    return [
      ...(health.network === configured ? [] : [HEALTH_REASON.lightningWrongNetwork(health.network, configured)]),
      ...(health.synced ? [] : [HEALTH_REASON.lightningNotSynced()]),
    ];
  }

  private fiberProblems(health: FiberHealth): string[] {
    if (!health.reachable) return [HEALTH_REASON.fiberUnreachable()];
    const configured = this.config.ckb.network;
    return health.network === configured ? [] : [HEALTH_REASON.fiberWrongNetwork(health.network, configured)];
  }

  private async checkLightning(): Promise<LightningHealth> {
    try {
      const info = await withTimeout(this.lightning.getInfo(), this.config.health.timeoutMs, LIGHTNING_LABEL);
      return { reachable: true, network: info.network, synced: info.synced, blockHeight: info.blockHeight };
    } catch (error) {
      this.logUnreachable(LIGHTNING_LABEL, error);
      return unreachableLightning();
    }
  }

  private async checkFiber(): Promise<FiberHealth> {
    try {
      const info = await withTimeout(this.fiber.getInfo(), this.config.health.timeoutMs, FIBER_LABEL);
      return { reachable: true, network: info.network, version: info.version };
    } catch (error) {
      this.logUnreachable(FIBER_LABEL, error);
      return unreachableFiber();
    }
  }

  private logUnreachable(node: string, error: unknown): void {
    this.logger.warn(`${node} is unreachable: ${describeError(error)}`);
  }
}
