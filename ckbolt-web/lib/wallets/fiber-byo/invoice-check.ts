import { formatUnits } from "@/lib/hub/format";
import { decodeFiberInvoice, type FiberNetwork } from "@/lib/payment-request";
import { MAX_PAYOUT_INVOICE_LENGTH } from "./constants";
import { invoicePrefix } from "./network";

/** What the payout invoice of a quote must ask for: the hub's CKB network and the quote's exact receive amount. */
export interface ByoInvoiceExpectation {
  network: FiberNetwork;
  /** The quote's receive amount, in the asset's base units. */
  amount: string;
  decimals: number;
  symbol: string;
}

/**
 * The browser's verdict on a pasted invoice. It reads the prefix (network), the amount and the checksum; the hash
 * algorithm, asset, expiry and final expiry delta sit in the compressed payload, so the hub checks those.
 */
export type ByoInvoiceCheck =
  | { status: "empty" }
  | { status: "invalid"; error: string }
  | { status: "ok"; invoice: string; summary: string };

const LIGHTNING_PREFIX = "ln";
const CKB_ADDRESS_PREFIXES = ["ckb1", "ckt1"];
const FIBER_PREFIX = "fib";

/** "123.45 CKB": an amount in base units with the asset's symbol. */
export const formatAssetAmount = (amount: bigint | string, decimals: number, symbol: string): string =>
  `${formatUnits(amount.toString(), decimals)} ${symbol}`;

/** Checks a pasted Fiber invoice against the quote before it goes into the destination field. */
export function checkByoInvoice(text: string, expected: ByoInvoiceExpectation): ByoInvoiceCheck {
  const invoice = text.trim();
  if (!invoice) return { status: "empty" };
  if (invoice.length > MAX_PAYOUT_INVOICE_LENGTH) {
    return { status: "invalid", error: "This is longer than any invoice the hub accepts. Check what was copied." };
  }
  const prefix = invoicePrefix(expected.network);
  const lower = invoice.toLowerCase();
  if (!lower.startsWith(FIBER_PREFIX)) {
    if (lower.startsWith(LIGHTNING_PREFIX)) {
      return { status: "invalid", error: `This is a Lightning invoice. Paste the Fiber invoice (${prefix}…) your Fiber node made.` };
    }
    if (CKB_ADDRESS_PREFIXES.some((p) => lower.startsWith(p))) {
      return { status: "invalid", error: `This is a CKB address. The payout goes over Fiber, so paste a Fiber invoice (${prefix}…) from your node.` };
    }
    return { status: "invalid", error: `This is not a Fiber invoice. Paste the ${prefix}… invoice your Fiber node made.` };
  }

  let decoded: ReturnType<typeof decodeFiberInvoice>;
  try {
    decoded = decodeFiberInvoice(invoice);
  } catch (e) {
    return { status: "invalid", error: e instanceof Error ? e.message : "This invoice could not be read." };
  }

  const wanted = formatAssetAmount(expected.amount, expected.decimals, expected.symbol);
  if (decoded.network !== expected.network) {
    return {
      status: "invalid",
      error: `This invoice is for CKB ${decoded.network}. The hub runs on CKB ${expected.network}: make a ${prefix}… invoice on a ${expected.network} node.`,
    };
  }
  if (decoded.amount === null) {
    return { status: "invalid", error: `This invoice has no amount. Make one for exactly ${wanted}: the hub only pays the quoted amount.` };
  }
  if (decoded.amount !== BigInt(expected.amount)) {
    const asked = formatAssetAmount(decoded.amount, expected.decimals, expected.symbol);
    return { status: "invalid", error: `This invoice asks for ${asked}. Make one for exactly ${wanted}, the amount of this quote.` };
  }
  return { status: "ok", invoice, summary: `Fiber invoice for ${wanted} on CKB ${expected.network}.` };
}
