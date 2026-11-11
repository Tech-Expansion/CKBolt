import type { Script } from "@/lib/hub/contract";
import { decodeFiberInvoice, type FiberNetwork } from "@/lib/payment-request";
import { MAX_PAYOUT_INVOICE_LENGTH } from "@/lib/wallets/fiber-byo/constants";
import type { ParsedInvoice } from "./node-port";
import { sameScript } from "./scripts";
import { formatTokenAmount, type WalletToken } from "./tokens";
import { FIBER_CURRENCY, PAY_MAX_FEE_PER_THOUSAND, PER_THOUSAND } from "./constants";

/**
 * Pay with a Fiber invoice (docs/pay-get-paid.md, part B): what the page checks before it asks the node, and what the
 * node checks once it read the invoice (parse_invoice), before it asks the visitor to confirm. Pure checks; sentences
 * say what is wrong, then what to do.
 */

export const PAYMENT_MESSAGE = {
  NOT_FIBER: (prefix: string) => `This is not a Fiber invoice. Paste one that starts with ${prefix}.`,
  LIGHTNING: (prefix: string) => `This is a Lightning invoice. Paste a Fiber invoice (${prefix}…).`,
  TOO_LONG: "This is longer than any Fiber invoice. Check what was copied.",
  WRONG_NETWORK: (invoiceNetwork: string, network: string, prefix: string) =>
    `This invoice is for CKB ${invoiceNetwork}. Use a CKB ${network} invoice (${prefix}…).`,
  UNREADABLE: (reason: string) => `Your node could not read this invoice: ${reason}`,
  EXPIRED: "This invoice has expired. Ask for a new one.",
  NO_AMOUNT: "This invoice has no amount. Ask for one with an amount.",
  UNKNOWN_TOKEN: "This invoice asks for a token your node does not hold.",
  OWN_INVOICE: "This invoice is your own node's. Pay it from another wallet.",
  HUB_INVOICE: "This is the CKBolt hub's invoice. Pay it from Swap.",
  CANNOT_SEND: (can: string) => `Your channels can send ${can} now. Not enough for this and its fee.`,
} as const;

/* ------------------------------------------------------------------------------- in the page, before asking */

export type InvoiceTextCheck = { status: "empty" } | { status: "invalid"; error: string } | { status: "ok"; invoice: string };

const LIGHTNING_PREFIX = "ln";
const FIBER_PREFIX = "fib";

/** What the browser can check before the node reads a pasted invoice: a Fiber invoice of `network`, well formed. */
export function checkInvoiceText(text: string, network: FiberNetwork): InvoiceTextCheck {
  const invoice = text.trim();
  if (!invoice) return { status: "empty" };
  const prefix = FIBER_CURRENCY[network].toLowerCase();
  if (invoice.length > MAX_PAYOUT_INVOICE_LENGTH) return { status: "invalid", error: PAYMENT_MESSAGE.TOO_LONG };
  const lower = invoice.toLowerCase();
  if (!lower.startsWith(FIBER_PREFIX)) {
    return { status: "invalid", error: lower.startsWith(LIGHTNING_PREFIX) ? PAYMENT_MESSAGE.LIGHTNING(prefix) : PAYMENT_MESSAGE.NOT_FIBER(prefix) };
  }
  let decoded;
  try {
    decoded = decodeFiberInvoice(invoice);
  } catch (e) {
    return { status: "invalid", error: e instanceof Error ? e.message : PAYMENT_MESSAGE.NOT_FIBER(prefix) };
  }
  if (decoded.network !== network) return { status: "invalid", error: PAYMENT_MESSAGE.WRONG_NETWORK(decoded.network, network, prefix) };
  return { status: "ok", invoice };
}

/* --------------------------------------------------------------------------------- in the node, once read */

/** The token with this script (null: CKB), or null when the node does not know it. */
export const tokenOfScript = (script: Script | null, tokens: readonly WalletToken[]): WalletToken | null =>
  tokens.find((t) => (script === null ? t.udtTypeScript === null : t.udtTypeScript !== null && sameScript(t.udtTypeScript, script))) ?? null;

/**
 * The most a payment of `amount` may spend on routing fees: fnn's default rate (0.5 %), rounded down, as fnn clamps it
 * (`max_fee_amount` and `amount × max_fee_rate / 1000`, the smaller).
 */
export const maxFeeOf = (amount: bigint): bigint => (amount * BigInt(PAY_MAX_FEE_PER_THOUSAND)) / BigInt(PER_THOUSAND);

export interface InvoicePreview {
  token: WalletToken;
  amount: bigint;
  maxFee: bigint;
  paymentHash: string;
  expiresAtMs: number | null;
  payee: string | null;
  description: string | null;
}

export type InvoiceVerdict = { ok: true; preview: InvoicePreview } | { ok: false; error: string; cannotSend: boolean };

export interface InvoiceCheckContext {
  network: FiberNetwork;
  tokens: readonly WalletToken[];
  ownNodeId: string | null;
  /** Every id the hub is known by: its invoices are a swap's, paid from Swap only. */
  hubNodeIds: readonly string[];
  nowMs: number;
  /** What the node's ready channels can send in a token now. */
  sendable: (token: WalletToken) => bigint;
}

/**
 * Whether the node may pay an invoice it read: on its network, not expired, with an amount, in a token it knows, not
 * its own nor the hub's, and within what its channels can send in that token, with the most the fee may be.
 */
export function checkParsedInvoice(parsed: ParsedInvoice, ctx: InvoiceCheckContext): InvoiceVerdict {
  const fail = (error: string, cannotSend = false): InvoiceVerdict => ({ ok: false, error, cannotSend });
  const prefix = FIBER_CURRENCY[ctx.network].toLowerCase();
  if (parsed.network !== ctx.network) return fail(PAYMENT_MESSAGE.WRONG_NETWORK(parsed.network ?? "another network", ctx.network, prefix));
  if (parsed.expiresAtMs !== null && parsed.expiresAtMs <= ctx.nowMs) return fail(PAYMENT_MESSAGE.EXPIRED);
  if (parsed.amount === null || parsed.amount <= BigInt(0)) return fail(PAYMENT_MESSAGE.NO_AMOUNT);
  const token = tokenOfScript(parsed.udtTypeScript, ctx.tokens);
  if (!token) return fail(PAYMENT_MESSAGE.UNKNOWN_TOKEN);
  if (ctx.ownNodeId && parsed.payee === ctx.ownNodeId) return fail(PAYMENT_MESSAGE.OWN_INVOICE);
  if (parsed.payee && ctx.hubNodeIds.includes(parsed.payee)) return fail(PAYMENT_MESSAGE.HUB_INVOICE);
  const maxFee = maxFeeOf(parsed.amount);
  const can = ctx.sendable(token);
  if (can < parsed.amount + maxFee) return fail(PAYMENT_MESSAGE.CANNOT_SEND(formatTokenAmount(can, token)), true);
  return {
    ok: true,
    preview: {
      token,
      amount: parsed.amount,
      maxFee,
      paymentHash: parsed.paymentHash.toLowerCase(),
      expiresAtMs: parsed.expiresAtMs,
      payee: parsed.payee,
      description: parsed.description,
    },
  };
}
