import { NO_ROUTE_ERROR_MARKERS, WALLET_MESSAGE_MAX_CHARS } from "./constants";

/**
 * The wallet answered with a refusal (a WebLN "User rejected", an extension that did not allow the site): it says
 * nothing was paid, so paying again is safe.
 */
export class WalletAnswerError extends Error {
  readonly answered = true;
  constructor(
    message: string,
    /** Why the wallet refused, as a code (WebLN has none: see WEBLN_DECLINED_CODE). */
    readonly code: string,
  ) {
    super(message);
    this.name = "WalletAnswerError";
  }
}

/** The wallet did not answer clearly (a closed prompt, a timeout): a payment may still be on its way. */
export class WalletNoAnswerError extends Error {
  readonly answered = false;
  constructor(message: string) {
    super(message);
    this.name = "WalletNoAnswerError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const SENTENCE_END = /[.!?…]$/;

/** The message an error carries, or "". */
const rawMessage = (error: unknown): string =>
  error instanceof Error ? error.message : isRecord(error) && typeof error.message === "string" ? error.message : "";

/**
 * A wallet's error text as one short sentence for the page (shortened, ending in punctuation), or `fallback` when it
 * has none. React renders it as text, so a wallet cannot inject markup through it.
 */
export function walletErrorText(error: unknown, fallback: string): string {
  const text = rawMessage(error).replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  if (text.length > WALLET_MESSAGE_MAX_CHARS) return `${text.slice(0, WALLET_MESSAGE_MAX_CHARS)}…`;
  return SENTENCE_END.test(text) ? text : `${text}.`;
}

/** Whether a wallet's error says it found no route to the payee (NO_ROUTE_ERROR_MARKERS). */
export function isNoRouteError(error: unknown): boolean {
  const text = rawMessage(error).toLowerCase();
  return NO_ROUTE_ERROR_MARKERS.some((marker) => text.includes(marker));
}
