import type { AssetLiquidity } from "../../domain/pricing";
import type { Direction, FiberAsset, Quote, QuoteRequest } from "../../domain/types";

/** Firm quotes: prices, fee and option premium, caps, liquidity, signature. Implemented in src/application/pricing. */
export interface PricingService {
  /** Prices, checks caps and liquidity, signs and stores the quote. Throws HubError with a user-facing message. */
  createQuote(request: QuoteRequest): Promise<Quote>;
  getQuote(id: string): Quote | null;
  /** True when the signature and fields are intact. Does not check expiry. */
  verifyQuote(quote: Quote): boolean;
  /** What the hub serves right now, for GET /v1/assets. */
  listAssets(): Promise<AssetAvailability[]>;
  /**
   * The balances that pay out swaps in `asset` right now, before open swaps' reservations: Lightning channel local sats
   * (fiber_to_ln) and the asset's ready Fiber channels (ln_to_fiber). Throws 503 upstream_unavailable when a node
   * cannot be read.
   */
  liquidityFor(asset: FiberAsset): Promise<AssetLiquidity>;
}

export interface AssetAvailability {
  asset: FiberAsset;
  directions: Direction[];
  minSats: bigint;
  maxSats: bigint;
  /**
   * The largest payout a new quote can get now: sats on Lightning (fiber_to_ln), asset base units on Fiber
   * (ln_to_fiber). The channel balance less the payouts open swaps have not sent yet and the routing fee budget.
   */
  liquidity: { lightningSats: bigint; fiberAmount: bigint };
}

export const PRICING_SERVICE = Symbol("PRICING_SERVICE");
