import { MIN_RETRY_AFTER_SECONDS } from "../../common/constants/http.constants";
import { QUOTE_PURPOSE, SWAP_STATE } from "../../common/constants/swap.constants";
import { earliestOf } from "../../common/utils/swaps.util";
import { secondsToWait } from "../../common/utils/time.util";
import {
  payoutAmount,
  payoutMaxFeeBps,
  payoutWithFeeBudget,
  unpaidPayoutRoom,
  type AssetLiquidity,
  type PayoutFeeBudgets,
  type PayoutReservation,
} from "../../domain/pricing";
import { isAwaitingPayment } from "../../domain/swap";
import type { Quote, QuotePurpose, Swap } from "../../domain/types";
import type { Clock } from "../ports/clock.port";
import type { SwapStore } from "../ports/swap-store.port";
import { SWAP_ERROR } from "./swap.errors";

/** One swap a client is creating: `bind` it to the saved swap, or `release` it when the creation failed. */
export interface UnpaidSwapSlot {
  bind(swapId: string): void;
  release(): void;
}

export interface UnpaidSwapCaps {
  /** Most swaps on swap quotes one client may have waiting for their payment. */
  perClient: number;
  /** Most swaps on request quotes (open payment requests) one client may have waiting for their payment. */
  requestsPerClient: number;
  /** Most swaps waiting for their payment from every client together, whatever their quotes' purpose. */
  total: number;
  /** Most of a direction's payout liquidity (less what paid swaps need) that unpaid swaps may reserve, percent. */
  maxSharePercent: number;
  /** The routing fee budgets payouts reserve on top of their amount. */
  feeBudgets: PayoutFeeBudgets;
}

/** Who made a pending swap, and on a quote for what: each purpose has its own cap per client. */
interface SwapOwner {
  clientKey: string;
  purpose: QuotePurpose;
}

/** A creation under way: a slot taken, no swap saved yet. Its payout counts as reserved like a pending swap's. */
interface Creation extends SwapOwner {
  reservation: PayoutReservation;
}

/** Same client, same quote purpose: the swap counts toward that client's cap for the purpose. */
const isOwnedBy = (candidate: SwapOwner | undefined, owner: SwapOwner): boolean =>
  candidate?.clientKey === owner.clientKey && candidate.purpose === owner.purpose;

/** What a swap on `quote` will reserve while it waits for its payment. */
const reservationOf = (quote: Quote): PayoutReservation => ({
  direction: quote.direction,
  asset: quote.asset,
  state: SWAP_STATE.PENDING,
  sats: quote.sats,
  fiberAmount: quote.fiberAmount,
});

/**
 * Caps the swaps that wait for their payment (pending): their number per client and in total, and the payout they
 * reserve together on each side (a share of that side's liquidity). Each one reserves its payout and its routing fee
 * budget and leaves a hold invoice on the hub's nodes until its quote expires, yet costs nothing to make, so without
 * the caps a few clients could lock all of the hub's payout liquidity. Clients are the HTTP layer's client keys, the
 * ones the rate limiter counts.
 *
 * Per client, swaps on request quotes (open payment requests, which wait REQUEST_QUOTE_TTL_SECONDS for a payer) have a
 * cap of their own, so a merchant's open requests never stop it from swapping, nor its swaps from asking to be paid.
 * The total and the share count every pending swap, whatever its quote's purpose. A pending swap stops counting once
 * the engine moves it on: paid, or failed when its quote expires (the scheduler's next pass after that instant).
 *
 * A slot is taken before the first node call that creates anything, and reserve() itself is synchronous, so concurrent
 * requests cannot overshoot a cap. The totals count the store's pending swaps and survive a restart; which client made
 * which swap is kept in memory only, so after a restart a client's earlier swaps count toward the totals alone until
 * they expire with their quotes.
 */
export class UnpaidSwapLimits {
  /** The client and quote purpose of each pending swap made since start-up. */
  private readonly ownerBySwapId = new Map<string, SwapOwner>();
  private readonly creations = new Set<Creation>();

  constructor(
    private readonly store: SwapStore,
    private readonly clock: Clock,
    private readonly caps: UnpaidSwapCaps,
  ) {}

  /**
   * Takes a slot for a swap `clientKey` is creating on `quote`, given the balances that pay it out (`liquidity`). Throws
   * a 429 when the client (on quotes of that purpose) or the hub has too many unpaid swaps, and a 503
   * insufficient_liquidity when the unpaid swaps on the quote's side would reserve more than their share of its
   * liquidity.
   */
  reserve(clientKey: string, quote: Quote, liquidity: AssetLiquidity): UnpaidSwapSlot {
    const open = this.store.listOpenSwaps();
    const unpaid = open.filter(isAwaitingPayment);
    this.forgetAllBut(unpaid);
    if (unpaid.length + this.creations.size >= this.caps.total) {
      throw SWAP_ERROR.tooManyUnpaidSwaps(this.retryAfterSeconds(unpaid));
    }
    const owner: SwapOwner = { clientKey, purpose: quote.purpose };
    this.assertClientCapLeft(owner, unpaid);
    const creation: Creation = { ...owner, reservation: reservationOf(quote) };
    this.assertShareLeft(creation.reservation, liquidity, open);
    return this.takeSlot(creation);
  }

  /** The client's unpaid swaps on quotes of this purpose, with its creations under way, must stay below that cap. */
  private assertClientCapLeft(owner: SwapOwner, unpaid: readonly Swap[]): void {
    const ofOwner = unpaid.filter((swap) => isOwnedBy(this.ownerBySwapId.get(swap.id), owner));
    const creations = [...this.creations].filter((creation) => isOwnedBy(creation, owner)).length;
    const isRequest = owner.purpose === QUOTE_PURPOSE.REQUEST;
    const cap = isRequest ? this.caps.requestsPerClient : this.caps.perClient;
    if (ofOwner.length + creations < cap) return;
    const retryAfter = this.retryAfterSeconds(ofOwner);
    throw isRequest ? SWAP_ERROR.tooManyOpenRequestsFromClient(cap, retryAfter) : SWAP_ERROR.tooManyUnpaidSwapsFromClient(cap, retryAfter);
  }

  /** The new swap's payout and fee budget must fit in what unpaid swaps (and creations under way) leave of their share. */
  private assertShareLeft(reservation: PayoutReservation, liquidity: AssetLiquidity, open: readonly Swap[]): void {
    const maxFeeBps = payoutMaxFeeBps(reservation.direction, this.caps.feeBudgets);
    const reserved = [...open, ...[...this.creations].map((creation) => creation.reservation)];
    const room = unpaidPayoutRoom(liquidity, reserved, reservation, maxFeeBps, this.caps.maxSharePercent);
    if (payoutWithFeeBudget(payoutAmount(reservation.direction, reservation), maxFeeBps) > room) {
      throw SWAP_ERROR.unpaidShareReached(reservation.direction);
    }
  }

  private takeSlot(creation: Creation): UnpaidSwapSlot {
    this.creations.add(creation);
    return {
      bind: (swapId) => {
        if (this.creations.delete(creation)) this.ownerBySwapId.set(swapId, { clientKey: creation.clientKey, purpose: creation.purpose });
      },
      release: () => void this.creations.delete(creation),
    };
  }

  /** Swaps that were paid, expired or failed no longer count: only the pending ones are remembered. */
  private forgetAllBut(unpaid: readonly Swap[]): void {
    const pendingIds = new Set(unpaid.map((swap) => swap.id));
    for (const swapId of this.ownerBySwapId.keys()) if (!pendingIds.has(swapId)) this.ownerBySwapId.delete(swapId);
  }

  /** A slot frees up at the latest when the first of these swaps expires with its quote. */
  private retryAfterSeconds(unpaid: readonly Swap[]): number {
    const firstExpiry = earliestOf(unpaid.map((swap) => swap.quoteExpiresAt));
    const wait = firstExpiry === null ? 0 : secondsToWait(firstExpiry, this.clock.now());
    return Math.max(MIN_RETRY_AFTER_SECONDS, wait);
  }
}
