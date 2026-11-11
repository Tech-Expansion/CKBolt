import { attemptFromAnswer, attemptFromError, canPayAgain, PAY_SENDING, type PayAttempt } from "./pay-attempt";
import { findWebLn, payWithWebln, type WebLnProvider } from "./webln-wallet";

/** Pay attempts by lower-case payment hash, for the page's life: a swap's hold invoice is never paid twice from here. */
export type PayAttempts = Readonly<Record<string, PayAttempt>>;

export const NO_ATTEMPTS: PayAttempts = {};

/** What the store needs from the browser; tests pass a fake provider. */
export interface WeblnPayStoreDeps {
  findWebLn: () => WebLnProvider | null;
}

/**
 * The browser wallet's (WebLN) payments of swap hold invoices, outside React, so a closed dialog or a re-render cannot
 * forget that the page already asked the wallet to pay. Paying by QR code or pasted invoice happens in the visitor's
 * own wallet, outside the page: only this button's attempts are known here.
 */
export class WeblnPayStore {
  private attempts: PayAttempts = NO_ATTEMPTS;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: WeblnPayStoreDeps) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): PayAttempts => this.attempts;

  /** A WebLN wallet is on the page now (an extension may inject it after load, then fire `webln:ready`). */
  readonly available = (): boolean => this.deps.findWebLn() !== null;

  private setAttempt(key: string, attempt: PayAttempt): void {
    this.attempts = { ...this.attempts, [key]: attempt };
    this.listeners.forEach((listener) => listener());
  }

  /**
   * Asks the browser wallet to pay `invoice` (already checked against its swap), once per payment hash: again only after
   * the wallet answered that it did not pay. The attempt is recorded before the wallet is asked, so a double click
   * cannot pay twice. Does nothing without a WebLN wallet on the page.
   */
  readonly pay = async (paymentHash: string, invoice: string): Promise<void> => {
    const key = paymentHash.toLowerCase();
    if (!canPayAgain(this.attempts[key])) return;
    const provider = this.deps.findWebLn();
    if (!provider) return;
    this.setAttempt(key, PAY_SENDING);
    try {
      this.setAttempt(key, attemptFromAnswer(await payWithWebln(provider, invoice)));
    } catch (e) {
      this.setAttempt(key, attemptFromError(e));
    }
  };
}

let pageStore: WeblnPayStore | null = null;

/** The page's one store of browser wallet payments, with the page's `window.webln`. */
export function weblnPayStore(): WeblnPayStore {
  pageStore ??= new WeblnPayStore({ findWebLn: () => findWebLn(typeof window === "undefined" ? undefined : window) });
  return pageStore;
}
