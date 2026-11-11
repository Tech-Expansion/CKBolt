import { WEBLN_DECLINED_CODE, WEBLN_DECLINED_MESSAGES } from "./constants";
import { WalletAnswerError, WalletNoAnswerError } from "./errors";
import { LN_WALLET_MESSAGE } from "./messages";
import type { PayAnswer } from "./pay-attempt";

/**
 * The part of a WebLN provider (`window.webln`, webln.guide) the app uses: `enable()`, then `sendPayment()`. Kept here
 * rather than imported from `@webbtc/webln-types`, which is not a dependency of this app. WebLN has no error codes.
 */
export interface WebLnProvider {
  enable(): Promise<unknown>;
  sendPayment(paymentRequest: string): Promise<{ preimage?: string }>;
}

const isFunction = (value: unknown): boolean => typeof value === "function";

/** `win.webln` when it looks like a WebLN provider (a browser extension injects it), else null. */
export function findWebLn(win: unknown): WebLnProvider | null {
  if (typeof win !== "object" || win === null) return null;
  const provider = (win as { webln?: unknown }).webln;
  if (typeof provider !== "object" || provider === null) return null;
  const p = provider as Record<string, unknown>;
  return isFunction(p.enable) && isFunction(p.sendPayment) ? (provider as WebLnProvider) : null;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error ?? ""));

/** Whether a WebLN rejection says nothing was sent ("User rejected", not enabled). */
export const isWeblnDeclined = (error: unknown): boolean => {
  const text = messageOf(error).toLowerCase();
  return WEBLN_DECLINED_MESSAGES.some((m) => text.includes(m));
};

/** A payment rejection: a refusal means nothing was sent; anything else ("Prompt was closed", a timeout) may have been. */
export const toWeblnPayError = (error: unknown): WalletAnswerError | WalletNoAnswerError =>
  isWeblnDeclined(error) ? new WalletAnswerError(messageOf(error), WEBLN_DECLINED_CODE) : new WalletNoAnswerError(messageOf(error));

/**
 * Pays `invoice` with the browser's WebLN wallet: `enable()` (the extension asks the visitor to allow the site), then
 * `sendPayment()`, which a hold invoice keeps waiting until the hub settles. Rejects with `WalletAnswerError` when the
 * visitor or the extension refused (nothing was sent) and with `WalletNoAnswerError` when the payment may be on its way.
 */
export async function payWithWebln(provider: WebLnProvider, invoice: string): Promise<PayAnswer> {
  try {
    await provider.enable();
  } catch {
    throw new WalletAnswerError(LN_WALLET_MESSAGE.WEBLN_REFUSED, WEBLN_DECLINED_CODE);
  }
  try {
    const paid = await provider.sendPayment(invoice);
    return { status: "paid", preimage: typeof paid?.preimage === "string" && paid.preimage ? paid.preimage : null };
  } catch (e) {
    throw toWeblnPayError(e);
  }
}
