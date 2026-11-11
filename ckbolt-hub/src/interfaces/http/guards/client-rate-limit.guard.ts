import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { ALL_CLIENTS_KEY } from "../../../common/constants/http.constants";
import { MS_PER_SECOND } from "../../../common/constants/protocol.constants";
import { RateLimitedError } from "../../../common/errors/hub.error";
import type { Clock } from "../../../application/ports/clock.port";
import type { HubConfig } from "../../../config/hub.config";
import { requestClientKey, type ClientRequest } from "../rate-limit/client-key";
import { SlidingWindowRateLimiter, type RateLimitDecision } from "../rate-limit/sliding-window.limiter";

/** A number of requests per window, and the plain sentence of the 429 once it is used up. */
export interface RateLimitBudget {
  limit: number;
  message: string;
}

export interface RateLimitPolicy extends RateLimitBudget {
  windowMs: number;
  /**
   * A budget every client shares, on top of each client's own: however many client keys someone makes up, they cannot
   * get past it.
   */
  total?: RateLimitBudget;
}

/** A budget's limiter and its 429 sentence. */
interface Budget {
  limiter: SlidingWindowRateLimiter;
  message: string;
  keyOf: (clientKey: string) => string;
}

/**
 * Refuses a request with 429 rate_limited once its client has used up `policy.limit` in the sliding window, or every
 * client together `policy.total.limit`. A refused request counts against no budget. Each subclass is one budget; Nest
 * makes one instance per module, so the budget is shared by every route it guards.
 */
export abstract class ClientRateLimitGuard implements CanActivate {
  private readonly budgets: readonly Budget[];

  protected constructor(
    private readonly config: HubConfig,
    private readonly clock: Clock,
    policy: RateLimitPolicy,
  ) {
    const limiter = (limit: number): SlidingWindowRateLimiter =>
      new SlidingWindowRateLimiter(limit, policy.windowMs, config.server.rateLimitMaxClients);
    const perClient: Budget = { limiter: limiter(policy.limit), message: policy.message, keyOf: (clientKey) => clientKey };
    const total: Budget[] = policy.total
      ? [{ limiter: limiter(policy.total.limit), message: policy.total.message, keyOf: () => ALL_CLIENTS_KEY }]
      : [];
    this.budgets = [perClient, ...total];
  }

  canActivate(context: ExecutionContext): boolean {
    const clientKey = requestClientKey(context.switchToHttp().getRequest<ClientRequest>(), this.config.server);
    const now = this.clock.now();
    for (const budget of this.budgets) {
      const decision = budget.limiter.check(budget.keyOf(clientKey), now);
      if (!decision.allowed) throw this.refusal(budget, decision);
    }
    for (const budget of this.budgets) budget.limiter.hit(budget.keyOf(clientKey), now);
    return true;
  }

  private refusal(budget: Budget, decision: RateLimitDecision): RateLimitedError {
    return new RateLimitedError(budget.message, Math.ceil(decision.retryAfterMs / MS_PER_SECOND));
  }
}
