import type { Direction, FiberAssetId } from "../../domain/types";

/**
 * The hub-run demo wallet: a visitor without nodes uses it to try a real swap on testnet. It runs its own Lightning
 * and Fiber nodes (DEMO_LIGHTNING, DEMO_FIBER), separate from the hub's. Test money, custodial, rate limited.
 */
export interface DemoWallet {
  readonly enabled: boolean;
  /**
   * An invoice the demo wallet will receive the payout on: a Fiber sha256 invoice for ln_to_fiber, a BOLT11 invoice
   * for fiber_to_ln. `amount` is in the payout leg's base units.
   */
  createPayoutInvoice(input: { direction: Direction; asset: FiberAssetId; amount: bigint }): Promise<{ invoice: string; paymentHash: string }>;
  /**
   * Pays the swap's hold invoice from the demo wallet, only when the swap pays out to an invoice of the demo wallet's
   * own node (409 conflict otherwise). Resolves once the payment is submitted.
   */
  payHoldInvoice(swapId: string): Promise<void>;
  /**
   * True when `payoutInvoice` is an invoice of the demo wallet's own node (one POST /v1/demo/invoices made), so a swap
   * paying out to it is a demo swap. False when the demo is off, for any other invoice, or when the demo node cannot
   * tell.
   */
  receivesPayout(payoutInvoice: string): Promise<boolean>;
}

export const DEMO_WALLET = Symbol("DEMO_WALLET");
