import { decodeBolt11, type DecodedInvoice } from "@/lib/bolt11";
import { MS_PER_SECOND } from "@/lib/hub/constants";
import { lightningNetworkLabel } from "@/lib/hub/format";
import { parsePaymentRequest } from "@/lib/payment-request";
import { BOLT11_PREFIX, LIGHTNING_URI_SCHEME, MSAT_PER_SAT } from "./constants";
import { LN_WALLET_MESSAGE } from "./messages";
import { hubNetworkLabel, toNetworkFamily } from "./network";

export type InvoiceCheck = { ok: true; invoice: string } | { ok: false; error: string };

const LIGHTNING_URI = /^lightning:/i;

/** An invoice as a wallet may give it (spaces, `lightning:` prefix), as the plain BOLT11 text. */
export const normalizeInvoice = (text: string): string => text.trim().replace(LIGHTNING_URI, "").trim();

/** Whole sats in millisatoshis, exactly. */
export const satsToMsat = (sats: string): bigint => BigInt(sats) * BigInt(MSAT_PER_SAT);

/** The `lightning:` link a Lightning wallet opens for an invoice ("Open in wallet"). */
export const lightningUri = (invoice: string): string => `${LIGHTNING_URI_SCHEME}${invoice}`;

/** What a BOLT11 invoice on the hub's network starts with ("lntbs" on signet), for a placeholder; "ln" when unknown. */
export const bolt11Prefix = (hubNetwork: string | null): string => {
  const family = toNetworkFamily(hubNetwork);
  return family ? BOLT11_PREFIX[family] : "ln";
};

/** Refuses an invoice for another network than the hub's (or for mainnet when the hub did not say). */
function networkError(decoded: DecodedInvoice, hubNetwork: string | null): string | null {
  const hubLabel = hubNetworkLabel(hubNetwork);
  if (decoded.network === "mainnet") return LN_WALLET_MESSAGE.INVOICE_MAINNET(hubLabel);
  const hubFamily = toNetworkFamily(hubNetwork);
  if (hubFamily && decoded.network !== hubFamily) return LN_WALLET_MESSAGE.INVOICE_WRONG_NETWORK(lightningNetworkLabel(decoded.network), hubLabel);
  return null;
}

/** The visitor's own Lightning invoice (fiber_to_ln), read in the page: what the hub pays out to. */
export interface PayoutInvoice {
  /** The plain BOLT11 text, lower case, as the hub takes it. */
  invoice: string;
  /** Its exact amount, whole sats: it fixes the swap's receive side. */
  sats: string;
  paymentHash: string;
  /** Epoch ms from which it can no longer be paid. */
  expiresAtMs: number;
}

/** A refusal in one short line, with the decoder's own sentence behind a "?" when it says more. */
export type PayoutInvoiceCheck = { ok: true; value: PayoutInvoice } | { ok: false; line: string; detail: string | null };

const refuse = (line: string, detail: string | null = null): PayoutInvoiceCheck => ({ ok: false, line, detail });

/**
 * Reads the invoice the visitor pasted or scanned for a CKB or a token to BTC swap, before any quote: a BOLT11 invoice (a
 * `lightning:` link or a BIP21 QR code with one is read too) on the hub's network, for a whole number of sats, with a
 * payment hash, and not expired at `nowMs`. The hub refuses each of these (`assertInvoiceNetwork`, `assertInvoiceAmount`
 * in ../ckbolt-hub/src/application/swaps/payout-invoice.checks.ts); this says why first, in one line.
 */
export function checkPayoutInvoice(text: string, expected: { hubNetwork: string | null; nowMs: number }): PayoutInvoiceCheck {
  let decoded: DecodedInvoice;
  let invoice: string;
  try {
    const request = parsePaymentRequest(text);
    if (request.kind !== "lightning") return refuse(LN_WALLET_MESSAGE.INVOICE_NOT_LIGHTNING);
    decoded = request.invoice;
    invoice = request.raw.toLowerCase();
  } catch (e) {
    return refuse(LN_WALLET_MESSAGE.INVOICE_NOT_LIGHTNING, e instanceof Error ? e.message : null);
  }
  const wrongNetwork = networkError(decoded, expected.hubNetwork);
  if (wrongNetwork) return refuse(wrongNetwork);
  if (decoded.amountMsat === null) return refuse(LN_WALLET_MESSAGE.INVOICE_NO_AMOUNT);
  if (decoded.amountMsat % BigInt(MSAT_PER_SAT) !== BigInt(0)) return refuse(LN_WALLET_MESSAGE.INVOICE_PART_SAT);
  if (!decoded.paymentHash) return refuse(LN_WALLET_MESSAGE.INVOICE_NO_HASH);
  const expiresAtMs = (decoded.timestamp + decoded.expirySeconds) * MS_PER_SECOND;
  if (expiresAtMs <= expected.nowMs) return refuse(LN_WALLET_MESSAGE.INVOICE_EXPIRED);
  const sats = (decoded.amountMsat / BigInt(MSAT_PER_SAT)).toString();
  return { ok: true, value: { invoice, sats, paymentHash: decoded.paymentHash, expiresAtMs } };
}

/**
 * The invoice stays payable until the quote expires, as the hub requires (`assertInvoiceOutlivesQuote`): the visitor
 * may pay the hold invoice up to that instant, and the payout follows right after.
 */
export const outlivesQuote = (invoice: Pick<PayoutInvoice, "expiresAtMs">, quoteExpiresAt: string): boolean =>
  invoice.expiresAtMs >= Date.parse(quoteExpiresAt);

/** What the hub's hold invoice (ln_to_fiber) must be: the swap's own amount and payment hash, on the hub's network. */
export interface HoldInvoiceExpectation {
  amountSats: string;
  paymentHash: string;
  hubNetwork: string | null;
}

/**
 * Checks the hub's hold invoice against the swap before the page shows it or a browser wallet pays it, so a mix-up
 * (another swap's invoice, a changed amount) is never paid from here. Any mismatch gets one sentence: the hub, not the
 * visitor, would have to fix it.
 */
export function checkHoldInvoice(text: string, expected: HoldInvoiceExpectation): InvoiceCheck {
  const invoice = normalizeInvoice(text);
  let decoded: DecodedInvoice;
  try {
    decoded = decodeBolt11(invoice);
  } catch {
    return { ok: false, error: LN_WALLET_MESSAGE.HOLD_INVOICE_MISMATCH };
  }
  const matches =
    networkError(decoded, expected.hubNetwork) === null &&
    decoded.amountMsat === satsToMsat(expected.amountSats) &&
    decoded.paymentHash?.toLowerCase() === expected.paymentHash.toLowerCase();
  return matches ? { ok: true, invoice } : { ok: false, error: LN_WALLET_MESSAGE.HOLD_INVOICE_MISMATCH };
}
