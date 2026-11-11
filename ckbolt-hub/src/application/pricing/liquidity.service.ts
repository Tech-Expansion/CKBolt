import { Inject, Injectable, Logger } from "@nestjs/common";
import type { LiquiditySnapshot } from "../../domain/pricing";
import type { FiberPort } from "../ports/fiber.port";
import type { LightningPort } from "../ports/lightning.port";
import { FIBER, LIGHTNING } from "../ports/tokens";
import { describeError } from "../../common/utils/error.util";
import { PRICING_ERROR } from "./pricing.errors";

/**
 * The hub's payout balances: Lightning channel local balance (fiber_to_ln pays out there) and Fiber channels
 * (ln_to_fiber pays out there; the domain keeps only ready channels in the quoted asset).
 */
@Injectable()
export class LiquidityService {
  private readonly logger = new Logger(LiquidityService.name);

  constructor(
    @Inject(LIGHTNING) private readonly lightning: LightningPort,
    @Inject(FIBER) private readonly fiber: FiberPort,
  ) {}

  /** Both nodes' balances, read together. Throws UPSTREAM_UNAVAILABLE (503) when either node cannot be read. */
  async snapshot(): Promise<LiquiditySnapshot> {
    try {
      const [balances, fiberChannels] = await Promise.all([this.lightning.getBalances(), this.fiber.listChannels()]);
      return { lightningSats: balances.channelLocalSats, fiberChannels };
    } catch (error) {
      this.logger.warn(`Reading node balances failed: ${describeError(error)}`);
      throw PRICING_ERROR.balancesUnavailable(error);
    }
  }
}
