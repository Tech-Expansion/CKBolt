import { isNoRouteError, WalletAnswerError, walletErrorText } from "./errors";
import { LN_WALLET_MESSAGE } from "./messages";

/** What a browser wallet answered to a payment. Never the source of truth for the swap: the hub's swap state is. */
export type PayAnswer = { status: "paid"; preimage: string | null };

/**
 * What happened when the visitor's browser wallet (WebLN) was asked to pay a swap's hold invoice, as the wallet tells
 * it. It only decides what the progress dialog shows and whether the page may ask again; the swap's progress comes
 * from the hub.
 * - `sending`: asked, no answer yet (a hold invoice keeps WebLN `sendPayment` waiting until the hub settles).
 * - `paid`: the wallet reports the payment complete.
 * - `declined`: the wallet answered that it did not pay ("User rejected"): asking again is safe.
 *   `noRoute`: it found no route to the hub, which a channel from the hub fixes.
 * - `uncertain`: no clear answer (a closed prompt, a timeout): the payment may still be on its way; never ask again.
 */
export type PayAttempt =
  | { status: "sending" }
  | { status: "paid"; preimage: string | null }
  | { status: "declined"; message: string; noRoute: boolean }
  | { status: "uncertain" };

export const PAY_SENDING: PayAttempt = { status: "sending" };

export const attemptFromAnswer = (answer: PayAnswer): PayAttempt => ({ status: "paid", preimage: answer.preimage });

/** Only a wallet's own refusal proves nothing was sent; every other failure counts as "maybe sent". */
export const attemptFromError = (error: unknown): PayAttempt =>
  error instanceof WalletAnswerError
    ? { status: "declined", message: walletErrorText(error, LN_WALLET_MESSAGE.WALLET_ERROR_FALLBACK), noRoute: isNoRouteError(error) }
    : { status: "uncertain" };

/** The wallet may be asked to pay: never asked for this swap, or it answered that it did not pay. */
export const canPayAgain = (attempt: PayAttempt | undefined): boolean => attempt === undefined || attempt.status === "declined";
