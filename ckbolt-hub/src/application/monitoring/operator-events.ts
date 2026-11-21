/**
 * What the swap machinery tells the monitor as it happens, beyond what the stores and nodes show: the payout guard
 * closing a channel or failing a pass, and the scheduler's passes. In-process only; nothing is persisted.
 */
export type OperatorEvent =
  | { kind: "payout-guard-closed"; swapId: string; channelId: string }
  | { kind: "payout-guard-failed"; swapId: string; detail: string }
  | { kind: "swap-pass-failed"; detail: string }
  | { kind: "swap-pass-ok" };

export type OperatorEventListener = (event: OperatorEvent) => void;

/** A tiny in-process bus. A listener that throws is skipped: reporting must never break a swap step. */
export class OperatorEvents {
  private readonly listeners = new Set<OperatorEventListener>();

  on(listener: OperatorEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: OperatorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A monitor bug must not stop the swap that reported it.
      }
    }
  }
}

export const OPERATOR_EVENTS = Symbol("OPERATOR_EVENTS");
