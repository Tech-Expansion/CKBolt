"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ConfirmationQueue, type ConfirmOutcome, type PendingConfirmation } from "@/lib/wallets/fiber-browser/confirmations";

/** What the node's pages read and do of Pay's requests (lib/wallets/fiber-browser/confirmations.ts). */
export interface Confirmations {
  /** The bridge handlers put requests up here. */
  queue: ConfirmationQueue;
  /** The request waiting for the visitor, or null. */
  pending: PendingConfirmation | null;
  /** How the last one ended, or null. */
  last: ConfirmOutcome | null;
  /** Confirm: the password is the node's, typed in the node, for an on-chain send; null for a Fiber payment. */
  confirm: (id: number, password: string | null) => Promise<void>;
  decline: (id: number) => void;
}

const SERVER_SNAPSHOT = { pending: null, last: null };

/**
 * One queue per node document: the bridge asks it, the node's page (the popup's `confirm` page, its window, or
 * /app/fiber) shows what waits. A request still waiting when the node stops is refused.
 */
export function useConfirmations(running: boolean): Confirmations {
  const [queue] = useState(() => new ConfirmationQueue());
  const snap = useSyncExternalStore(queue.subscribe, queue.snapshot, () => SERVER_SNAPSHOT);
  useEffect(() => {
    if (!running) queue.cancel();
  }, [running, queue]);
  return useMemo(
    () => ({
      queue,
      pending: snap.pending,
      last: snap.last,
      confirm: (id, password) => queue.confirm(id, password),
      decline: (id) => queue.decline(id),
    }),
    [queue, snap],
  );
}
