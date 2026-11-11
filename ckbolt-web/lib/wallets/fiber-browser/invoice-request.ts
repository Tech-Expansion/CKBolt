import type { CkbNetwork, Script } from "@/lib/hub/contract";
import { MS_PER_SECOND } from "@/lib/hub/constants";
import type { NewInvoiceArgs } from "./node-port";
import { FIBER_CURRENCY, INVOICE_DESCRIPTION, INVOICE_EXTRA_SECONDS, INVOICE_MIN_EXPIRY_SECONDS } from "./constants";
import { toHexBytes } from "./hex";

/**
 * Seconds a payout invoice stays valid: past the quote's expiry, with the same margin the hub's demo wallet uses, so
 * the hub can pay it once the Lightning payment arrives; never less than a minimum.
 */
export function invoiceExpirySeconds(quoteExpiresAt: string, nowMs: number): number {
  const untilQuoteEnds = Math.ceil((Date.parse(quoteExpiresAt) - nowMs) / MS_PER_SECOND);
  const base = Number.isFinite(untilQuoteEnds) ? Math.max(untilQuoteEnds, 0) : 0;
  return Math.max(base + INVOICE_EXTRA_SECONDS, INVOICE_MIN_EXPIRY_SECONDS);
}

/** True when a Fiber invoice is one of `network`'s: it starts with that network's currency ("fibt" on testnet). */
export function isInvoiceOfNetwork(invoice: string, network: CkbNetwork): boolean {
  return invoice.trim().toLowerCase().startsWith(FIBER_CURRENCY[network].toLowerCase());
}

/** A whole, positive number of base units from a decimal string, or null. */
export function parseBaseUnits(amount: string): bigint | null {
  return /^[1-9]\d{0,29}$/.test(amount) ? BigInt(amount) : null;
}

/**
 * new_invoice arguments for a swap payout (ln_to_fiber): exactly the quote's receive amount, the asset's UDT script,
 * sha256 (set by the adapter), a fresh preimage only this node knows, like the hub's demo wallet invoices.
 */
export function payoutInvoiceArgs(args: {
  amount: bigint;
  network: CkbNetwork;
  udtTypeScript: Script | null;
  quoteExpiresAt: string;
  nowMs: number;
  preimage: Uint8Array;
}): NewInvoiceArgs {
  return {
    amount: args.amount,
    currency: FIBER_CURRENCY[args.network],
    preimage: toHexBytes(args.preimage),
    expirySeconds: invoiceExpirySeconds(args.quoteExpiresAt, args.nowMs),
    description: INVOICE_DESCRIPTION,
    udtTypeScript: args.udtTypeScript,
  };
}
