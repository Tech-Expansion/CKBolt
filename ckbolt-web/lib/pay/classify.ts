import { parsePaymentRequest, type FiberNetwork } from "@/lib/payment-request";
import type { ShortError } from "@/lib/swap/errors";
import { checkInvoiceText } from "@/lib/wallets/fiber-browser/payments";
import { checkPayoutInvoice, type PayoutInvoice } from "@/lib/wallets/lightning/invoice-check";
import { PAY_ERROR } from "./copy";

/**
 * What the visitor pasted or scanned in Pay (docs/pay-get-paid.md, part B), read in the page before anything is asked
 * of the hub or the node: a Lightning invoice the hub can pay (on its network, with a whole amount, not expired), a Fiber
 * invoice of the node's network, or a CKB address of the node's network. Anything else is refused in one line, with the
 * reader's own sentence behind a "?".
 */
export type PayTarget =
  | { kind: "empty" }
  | { kind: "invalid"; error: ShortError }
  | { kind: "lightning"; invoice: PayoutInvoice }
  | { kind: "fiber"; invoice: string }
  | { kind: "ckb-address"; address: string };

export interface PayContext {
  /** The hub's Lightning network (GET /v1/health), or null. */
  lightningNetwork: string | null;
  /** The browser node's CKB network: Fiber invoices and CKB addresses must be on it. */
  fiberNetwork: FiberNetwork;
  nowMs: number;
}

const refuse = (line: string, detail: string | null = null): PayTarget => ({
  kind: "invalid",
  error: { line, detail: detail && detail !== line ? detail : null },
});

export function classifyPayInput(text: string, ctx: PayContext): PayTarget {
  if (!text.trim()) return { kind: "empty" };
  let request;
  try {
    request = parsePaymentRequest(text);
  } catch (e) {
    return refuse(PAY_ERROR.NOT_PAYABLE, e instanceof Error ? e.message : null);
  }
  switch (request.kind) {
    case "lightning": {
      // The checks the hub makes of a payout invoice: network, amount, whole sats, hash, expiry (part A).
      const read = checkPayoutInvoice(request.raw, { hubNetwork: ctx.lightningNetwork, nowMs: ctx.nowMs });
      return read.ok ? { kind: "lightning", invoice: read.value } : refuse(read.line, read.detail);
    }
    case "fiber": {
      // The dev log's client-side network check, before the node reads it.
      const check = checkInvoiceText(request.raw, ctx.fiberNetwork);
      if (check.status === "ok") return { kind: "fiber", invoice: check.invoice };
      return check.status === "invalid" ? refuse(check.error) : { kind: "empty" };
    }
    case "ckb-address":
      return request.network === ctx.fiberNetwork ? { kind: "ckb-address", address: request.raw } : refuse(PAY_ERROR.CKB_WRONG_NETWORK(ctx.fiberNetwork));
  }
}
