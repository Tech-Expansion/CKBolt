import type { FiberInvoiceRequest } from "@/components/app/swap/contracts";
import { BridgeError, type BridgeClient } from "@/lib/wallets/fiber-browser/bridge-client";
import { BRIDGE_ERROR } from "@/lib/wallets/fiber-browser/bridge-protocol";
import { checkNodeInvoice } from "./invoice-check";

/** The part of the bridge client (lib/wallets/fiber-browser/bridge-client.ts) the wallet drives; tests pass a fake. */
export type BrowserNodePort = Pick<BridgeClient, "makeInvoice" | "payInvoice">;

export interface FiberPayRequest {
  swapId: string;
  invoice: string;
}

/** The node did not answer in time: the payment may be on its way, so it must not be sent again. */
const mayHaveSent = (e: unknown): boolean => e instanceof BridgeError && e.code === BRIDGE_ERROR.TIMEOUT;

/** The node answered that it did not pay (refused, not running, short of liquidity, send failed). */
const sentNothing = (e: unknown): boolean => e instanceof BridgeError && e.code !== BRIDGE_ERROR.TIMEOUT;

/**
 * The visitor's browser node (fiber-js on /app/fiber) as the swap card's Fiber wallet, over the same-origin bridge.
 * The node checks every request itself (network, amount, liquidity, and with the hub that a hold invoice is the swap's);
 * this side checks the invoice it gets back and never pays a swap twice. The hub's swap state stays the truth.
 */
export class BrowserNodeWallet {
  /** One payment per swap id, for the page's life. */
  private readonly payments = new Map<string, Promise<void>>();

  constructor(private readonly port: BrowserNodePort) {}

  /** ln_to_fiber: the payout invoice, made by the node and checked against the request. Throws with a sentence. */
  async makeInvoice(request: FiberInvoiceRequest): Promise<string> {
    const { invoice } = await this.port.makeInvoice({
      asset: request.asset,
      amount: request.amount,
      quoteExpiresAt: request.quoteExpiresAt,
      network: request.network,
      ...(request.request ? { request: request.request } : {}),
    });
    const check = checkNodeInvoice(invoice, request);
    if (!check.ok) throw new Error(check.error);
    return invoice;
  }

  /**
   * fiber_to_ln: asks the node to pay the hub's hold invoice, once per swap. A second call while the first runs, or
   * after it, gets the first one's answer and sends nothing.
   * - The node answered that it paid: resolves.
   * - The node did not answer in time: resolves too, as "sent; the hub's swap state tells". Paying again could pay twice.
   * - The node answered that it sent nothing: rejects, and a later call may try again.
   * - Anything else: rejects, and later calls get the same rejection.
   */
  payInvoice(request: FiberPayRequest): Promise<void> {
    const known = this.paymentFor(request.swapId);
    if (known) return known;
    const attempt = this.port.payInvoice({ swapId: request.swapId, invoice: request.invoice }).then(
      () => undefined,
      (e: unknown) => {
        if (mayHaveSent(e)) return undefined;
        if (sentNothing(e)) this.payments.delete(request.swapId);
        throw e;
      },
    );
    this.payments.set(request.swapId, attempt);
    return attempt;
  }

  /** The payment already asked for this swap (running, sent, or failed for good), if any. */
  paymentFor(swapId: string): Promise<void> | undefined {
    return this.payments.get(swapId);
  }
}
