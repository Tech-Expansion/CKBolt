"use client";

import { useSyncExternalStore } from "react";
import { WEBLN_READY_EVENT } from "@/lib/wallets/lightning/constants";
import { NO_ATTEMPTS, weblnPayStore, type PayAttempts, type WeblnPayStore } from "@/lib/wallets/lightning/pay-store";

export interface Webln {
  /** A WebLN wallet (a browser extension such as Alby) is on the page. */
  available: boolean;
  /** What it answered so far, by lower-case payment hash. */
  attempts: PayAttempts;
  /** Asks it to pay a checked hold invoice: once per payment hash, again only after it refused. */
  pay: (paymentHash: string, invoice: string) => Promise<void>;
}

function subscribeWebln(onChange: () => void): () => void {
  window.addEventListener(WEBLN_READY_EVENT, onChange);
  return () => window.removeEventListener(WEBLN_READY_EVENT, onChange);
}

const notAvailable = () => false;

/** The browser's WebLN wallet and the page's record of what it paid (lib/wallets/lightning/pay-store.ts) as React state. */
export function useWebln(store: WeblnPayStore = weblnPayStore()): Webln {
  const available = useSyncExternalStore(subscribeWebln, store.available, notAvailable);
  const attempts = useSyncExternalStore(store.subscribe, store.getSnapshot, () => NO_ATTEMPTS);
  return { available, attempts, pay: store.pay };
}
