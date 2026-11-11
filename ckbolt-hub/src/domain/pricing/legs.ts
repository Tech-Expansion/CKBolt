import { QUOTE_SIDE, SWAP_DIRECTION } from "../../common/constants/swap.constants";
import type { Direction, QuoteRequest } from "../types";
import type { QuoteAmounts, SwapLegs } from "./pricing.types";

/** True when the user pays on Lightning (and the hub pays out on Fiber). */
export const lightningIsIncoming = (direction: Direction): boolean => direction === SWAP_DIRECTION.LN_TO_FIBER;

/** The quote's legs as incoming (user pays) and outgoing (hub pays out). */
export const legsOf = (direction: Direction, amounts: QuoteAmounts): SwapLegs =>
  lightningIsIncoming(direction)
    ? { incoming: amounts.sats, outgoing: amounts.fiberAmount }
    : { incoming: amounts.fiberAmount, outgoing: amounts.sats };

/** The inverse of legsOf: incoming and outgoing back to sats and Fiber amount. */
export const amountsFromLegs = (direction: Direction, legs: SwapLegs): QuoteAmounts =>
  lightningIsIncoming(direction)
    ? { sats: legs.incoming, fiberAmount: legs.outgoing }
    : { sats: legs.outgoing, fiberAmount: legs.incoming };

/** The most the hub spends routing a payout, basis points of it, per paying side (HubConfig.swaps has both). */
export interface PayoutFeeBudgets {
  lnMaxFeeBps: number;
  fiberMaxFeeBps: number;
}

/** The routing fee limit a payout in `direction` is sent with: Fiber's for ln_to_fiber, Lightning's for fiber_to_ln. */
export const payoutMaxFeeBps = (direction: Direction, budgets: PayoutFeeBudgets): number =>
  lightningIsIncoming(direction) ? budgets.fiberMaxFeeBps : budgets.lnMaxFeeBps;

/** What the hub pays out: the Fiber amount for ln_to_fiber, the sats for fiber_to_ln. */
export const payoutAmount = (direction: Direction, amounts: QuoteAmounts): bigint => legsOf(direction, amounts).outgoing;

/** True when the request fixes the Lightning leg: what the user pays on ln_to_fiber, or receives on fiber_to_ln. */
export const fixesLightningLeg = (request: Pick<QuoteRequest, "direction" | "side">): boolean =>
  lightningIsIncoming(request.direction) === (request.side === QUOTE_SIDE.PAY);
