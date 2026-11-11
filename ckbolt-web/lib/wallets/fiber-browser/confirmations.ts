import type { FiberAssetId } from "@/lib/hub/contract";
import { BRIDGE_ERROR, type FiberPaymentRoute } from "./bridge-protocol";
import { NodeRequestError } from "./request-error";

/**
 * Pay's security rule (docs/pay-get-paid.md, part B): the node never pays a Fiber invoice or sends CKB on chain because
 * a page asked over the bridge. It puts the request up here, the node's own page shows it (the popup's `confirm` page,
 * the node window, or /app/fiber), and only the visitor's Confirm there runs it; Decline, or no answer in time, refuses
 * it. One request at a time. Pure state with listeners, so the React side reads it with useSyncExternalStore and the
 * tests drive it directly.
 */

/** What the visitor confirms: amounts are decimal strings of base units (shannons for CKB). Nothing secret. */
export type ConfirmView =
  | {
      kind: "fiber-payment";
      asset: FiberAssetId;
      amount: string;
      /** The most the routing fee may be. */
      maxFee: string;
      /** The node it pays, or null when the invoice names none. */
      payee: string | null;
      /** The invoice's note, cut to a short length, or null. */
      note: string | null;
      /** Epoch ms the invoice stops being payable, or null. */
      expiresAt: number | null;
      /** How the node will pay it: its own route, or through the CKBolt hub (a trampoline). */
      route: FiberPaymentRoute;
    }
  | {
      kind: "on-chain";
      address: string;
      /** Shannons the address receives. */
      amount: string;
      /** Shannons the transaction pays, as the node built it before asking. */
      fee: string;
    };

/** The request the node waits on. */
export interface PendingConfirmation {
  id: number;
  view: ConfirmView;
  /** Epoch ms after which the node declines by itself. */
  deadline: number;
  /** Confirm was pressed and the node is sending. */
  running: boolean;
  /** Why the last Confirm did not go through when the visitor may try again (a wrong password), or null. */
  error: string | null;
}

/** How the last request ended, for the page that showed it. */
export interface ConfirmOutcome {
  id: number;
  kind: ConfirmView["kind"];
  status: "sent" | "declined" | "expired" | "failed";
  /** The node's sentence for a failure, or null. */
  message: string | null;
}

export interface ConfirmSnapshot {
  pending: PendingConfirmation | null;
  last: ConfirmOutcome | null;
}

/** What runs on Confirm: with the password the visitor typed in the node, for an on-chain send; null otherwise. */
export type ConfirmAction<T> = (password: string | null) => Promise<T>;

export interface AskOptions {
  /** How long the visitor has to confirm. */
  timeoutMs: number;
  /** A failure the visitor can fix and confirm again (a wrong password): the request stays up. */
  retryable?: (error: unknown) => boolean;
}

export const CONFIRM_MESSAGE = {
  BUSY: "Your node waits for you to confirm another request. Answer it in your Fiber node first.",
  DECLINED: "You declined it in your Fiber node. Nothing was sent.",
  EXPIRED: "It was not confirmed in your Fiber node in time. Nothing was sent.",
  STOPPED: "Your Fiber node stopped before it was confirmed. Nothing was sent.",
} as const;

interface Entry {
  pending: PendingConfirmation;
  action: ConfirmAction<unknown>;
  options: AskOptions;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const EMPTY: ConfirmSnapshot = { pending: null, last: null };

export class ConfirmationQueue {
  private entry: Entry | null = null;
  private snap: ConfirmSnapshot = EMPTY;
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The same object until something changes (useSyncExternalStore). */
  readonly snapshot = (): ConfirmSnapshot => this.snap;

  /**
   * Puts a request up for the visitor and resolves with what `action` returns once they confirm it; rejects with a
   * NodeRequestError `declined` when they decline or do not answer in time, `busy` when another request waits.
   */
  ask<T>(view: ConfirmView, action: ConfirmAction<T>, options: AskOptions): Promise<T> {
    if (this.entry) return Promise.reject(new NodeRequestError(BRIDGE_ERROR.BUSY, CONFIRM_MESSAGE.BUSY));
    return new Promise<T>((resolve, reject) => {
      const pending: PendingConfirmation = { id: this.nextId++, view, deadline: this.now() + options.timeoutMs, running: false, error: null };
      this.entry = { pending, action, options, resolve: resolve as (value: unknown) => void, reject, timer: undefined };
      this.arm();
      this.publish({ pending, last: this.snap.last });
    });
  }

  /** The visitor confirmed request `id` in the node: runs it once at a time. Never throws. */
  async confirm(id: number, password: string | null = null): Promise<void> {
    const entry = this.entry;
    if (!entry || entry.pending.id !== id || entry.pending.running) return;
    clearTimeout(entry.timer);
    this.update({ running: true, error: null });
    try {
      const result = await entry.action(password);
      this.finish(entry, "sent", null);
      entry.resolve(result);
    } catch (e) {
      if (entry.options.retryable?.(e)) {
        this.update({ running: false, error: e instanceof Error ? e.message : String(e) });
        this.arm();
        return;
      }
      const error = e instanceof NodeRequestError ? e : new NodeRequestError(BRIDGE_ERROR.NODE_ERROR, e instanceof Error ? e.message : String(e));
      this.finish(entry, "failed", error.message);
      entry.reject(error);
    }
  }

  /** The visitor declined request `id`; ignored while it is already sending. */
  decline(id: number): void {
    const entry = this.entry;
    if (!entry || entry.pending.id !== id || entry.pending.running) return;
    this.refuse(entry, "declined", CONFIRM_MESSAGE.DECLINED);
  }

  /** The node stopped: a request still waiting is refused. */
  cancel(code: (typeof BRIDGE_ERROR)[keyof typeof BRIDGE_ERROR] = BRIDGE_ERROR.NOT_RUNNING): void {
    const entry = this.entry;
    if (!entry || entry.pending.running) return;
    clearTimeout(entry.timer);
    this.entry = null;
    this.publish({ pending: null, last: { id: entry.pending.id, kind: entry.pending.view.kind, status: "declined", message: CONFIRM_MESSAGE.STOPPED } });
    entry.reject(new NodeRequestError(code, CONFIRM_MESSAGE.STOPPED));
  }

  private arm(): void {
    const entry = this.entry;
    if (!entry) return;
    clearTimeout(entry.timer);
    const left = Math.max(0, entry.pending.deadline - this.now());
    entry.timer = setTimeout(() => {
      if (this.entry === entry && !entry.pending.running) this.refuse(entry, "expired", CONFIRM_MESSAGE.EXPIRED);
    }, left);
  }

  private refuse(entry: Entry, status: "declined" | "expired", message: string): void {
    clearTimeout(entry.timer);
    this.finish(entry, status, null);
    entry.reject(new NodeRequestError(BRIDGE_ERROR.DECLINED, message));
  }

  private finish(entry: Entry, status: ConfirmOutcome["status"], message: string | null): void {
    clearTimeout(entry.timer);
    if (this.entry === entry) this.entry = null;
    this.publish({ pending: null, last: { id: entry.pending.id, kind: entry.pending.view.kind, status, message } });
  }

  private update(change: Partial<Pick<PendingConfirmation, "running" | "error">>): void {
    if (!this.entry) return;
    this.entry.pending = { ...this.entry.pending, ...change };
    this.publish({ pending: this.entry.pending, last: this.snap.last });
  }

  private publish(next: ConfirmSnapshot): void {
    this.snap = next;
    for (const listener of this.listeners) listener();
  }
}
