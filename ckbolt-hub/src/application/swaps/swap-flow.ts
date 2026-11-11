import type { HubConfig } from "../../config/hub.config";
import type { AssetRegistry } from "../../domain/assets";
import type { IncomingLegView, PayoutLegView, SwapLegNetworks, SwapTiming } from "../../domain/swap";
import type { TimingProfile, TimingResult } from "../../domain/timing/timing.types";
import type { Direction, FiberAsset, Hex32, Quote, Swap } from "../../domain/types";
import type { Clock } from "../ports/clock.port";
import type { FiberPort } from "../ports/fiber.port";
import type { LightningPort } from "../ports/lightning.port";

/**
 * Everything that differs between the two swap directions, behind one interface: which node holds the incoming leg,
 * which node pays out, how the payout invoice is checked and how the payout lock is sized. The engine decides on the
 * normalized leg views only, so a new direction or node type is a new flow, not an engine change.
 */
export interface SwapFlow {
  readonly direction: Direction;
  readonly legs: SwapLegNetworks;

  /** Reads and checks the user's payout invoice against the quote, and plans the timing. No side effects. */
  planSwap(input: SwapPlanInput): Promise<SwapPlan>;
  /** True when the incoming node already has an invoice, or the paying node a payment, for this hash. */
  isHashInUse(paymentHash: Hex32): Promise<boolean>;
  /** Issues the hold invoice the user pays; returns the encoded invoice. */
  createHoldInvoice(request: HoldInvoiceRequest): Promise<string>;

  /** The swap's hold invoice as the incoming node sees it: what is held, in the swap's asset, and until when. */
  readIncoming(swap: Swap): Promise<IncomingLegView>;
  /** How long the payout may lock funds, from what is held right now; fails when there is no longer time to pay out. */
  payoutWindow(swap: Swap, incoming: IncomingLegView): Promise<PayoutWindow>;
  /**
   * Starts the payout with the swap's saved `payoutLockLimit` and returns what the paying node reports for it at once.
   * FAILED means nothing of the payout is out: the node refused to send it, or it failed for good right away.
   * Idempotent per payment hash.
   */
  sendPayout(swap: Swap): Promise<PayoutLegView>;
  readPayout(paymentHash: Hex32): Promise<PayoutLegView>;
  /**
   * While the payout is in flight: protects the incoming leg from a payee that holds the payout without settling it.
   * `sentAt` is when the payout was last sent (ms). Returns the ids of the channels it force-closed, for the log; it
   * never touches the incoming leg.
   */
  guardPayout(swap: Swap, sentAt: number): Promise<string[]>;
  /** Collects the incoming leg. Idempotent. */
  settleIncoming(paymentHash: Hex32, preimage: Hex32): Promise<void>;
  /** Cancels the incoming leg, which refunds the payer. Idempotent. */
  cancelIncoming(paymentHash: Hex32): Promise<void>;
}

export type SwapFlows = Readonly<Record<Direction, SwapFlow>>;

export interface SwapFlowDeps {
  lightning: LightningPort;
  fiber: FiberPort;
  assets: AssetRegistry;
  profile: TimingProfile;
  clock: Clock;
  config: HubConfig;
}

export interface SwapPlanInput {
  quote: Quote;
  asset: FiberAsset;
  payoutInvoice: string;
  now: number;
}

/** The payment hash shared by both legs, and the timing values saved with the swap. */
export interface SwapPlan extends SwapTiming {
  paymentHash: Hex32;
}

export interface HoldInvoiceRequest {
  swapId: string;
  quote: Quote;
  asset: FiberAsset;
  plan: SwapPlan;
  /** Whole seconds the quote stays valid: an unpaid hold invoice expires with it. */
  expirySeconds: number;
}

/** `lockLimit` is `tlc_expiry_limit` in ms (Fiber payout) or `cltv_limit` in blocks (Lightning payout). */
export type PayoutWindow = TimingResult<{ lockLimit: number }>;
