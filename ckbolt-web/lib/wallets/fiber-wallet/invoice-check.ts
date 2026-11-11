import type { FiberInvoiceRequest } from "@/components/app/swap/contracts";
import { decodeFiberInvoice } from "@/lib/payment-request";
import { parseBaseUnits } from "@/lib/wallets/fiber-browser/invoice-request";
import { FIBER_WALLET_MESSAGE } from "./messages";

export type NodeInvoiceCheck = { ok: true } | { ok: false; error: string };

/**
 * Checks an invoice the browser node returned against what the page asked for (a swap's payout invoice, or a Get paid
 * request's Fiber invoice): a Fiber invoice of the CKB network (when known) for exactly the amount asked. The node runs its own checks before it makes
 * one, and the hub checks the rest (sha256, asset, expiry) when the swap is created.
 */
export function checkNodeInvoice(invoice: string, request: Pick<FiberInvoiceRequest, "amount" | "network">): NodeInvoiceCheck {
  let decoded: ReturnType<typeof decodeFiberInvoice>;
  try {
    decoded = decodeFiberInvoice(invoice.trim());
  } catch {
    return { ok: false, error: FIBER_WALLET_MESSAGE.INVOICE_UNREADABLE };
  }
  if (request.network && decoded.network !== request.network) {
    return { ok: false, error: FIBER_WALLET_MESSAGE.INVOICE_WRONG_NETWORK(decoded.network, request.network) };
  }
  if (decoded.amount === null) return { ok: false, error: FIBER_WALLET_MESSAGE.INVOICE_NO_AMOUNT };
  const expected = parseBaseUnits(request.amount);
  if (expected === null || decoded.amount !== expected) return { ok: false, error: FIBER_WALLET_MESSAGE.INVOICE_WRONG_AMOUNT };
  return { ok: true };
}
