import type { EventEmitter } from "node:events";
import type { LnPaymentStatus } from "../../application/ports/lightning.port";
import { LIGHTNING_LIB_EVENT } from "../../common/constants/lnd.constants";
import type { Hex32 } from "../../domain/types";
import { failedPayment, failureReasonOf, inFlightPayment, succeededPayment, type PaymentFailureFlags, type SettledPayment } from "./lnd.mappers";

/**
 * Follows the payment streams of the `lightning` package (subscribeToPayViaRequest, subscribeToPastPayment).
 * `follow` resolves with the first status a stream reports, or rejects with the stream's error when it breaks before
 * that. It keeps listening until the payment is final and calls `onChange(hash)` on every final outcome, and when the
 * stream breaks after its first status (the payment then goes on inside LND; callers re-read it).
 */
export class LndPaymentFollower {
  private readonly streams = new Map<Hex32, EventEmitter>();

  constructor(private readonly onChange: (paymentHash: Hex32) => void) {}

  isFollowing(paymentHash: Hex32): boolean {
    return this.streams.has(paymentHash);
  }

  follow(paymentHash: Hex32, stream: EventEmitter): Promise<LnPaymentStatus> {
    this.streams.set(paymentHash, stream);
    return new Promise((resolve, reject) => {
      let answered = false;
      /** Runs `answer` only for the first event; returns false when the promise was already answered. */
      const answerOnce = (answer: () => void): boolean => {
        if (answered) return false;
        answered = true;
        answer();
        return true;
      };
      const finish = (status: LnPaymentStatus): void => {
        this.release(paymentHash, stream);
        answerOnce(() => resolve(status));
        this.onChange(paymentHash);
      };

      stream.on(LIGHTNING_LIB_EVENT.PAYING, () => answerOnce(() => resolve(inFlightPayment(paymentHash))));
      stream.on(LIGHTNING_LIB_EVENT.CONFIRMED, (settled: SettledPayment) => finish(succeededPayment(paymentHash, settled)));
      stream.on(LIGHTNING_LIB_EVENT.FAILED, (flags: PaymentFailureFlags) => finish(failedPayment(paymentHash, failureReasonOf(flags))));
      stream.on(LIGHTNING_LIB_EVENT.ERROR, (error: unknown) => {
        this.release(paymentHash, stream);
        if (!answerOnce(() => reject(error))) this.onChange(paymentHash);
      });
    });
  }

  /** Follows a payment nobody awaits; a stream that breaks early only triggers `onChange`. */
  followInBackground(paymentHash: Hex32, stream: EventEmitter): void {
    this.follow(paymentHash, stream).catch(() => this.onChange(paymentHash));
  }

  stopAll(): void {
    for (const [paymentHash, stream] of [...this.streams]) this.release(paymentHash, stream);
  }

  /** Removing the listeners also cancels a past-payment stream (the package cancels it once nobody listens). */
  private release(paymentHash: Hex32, stream: EventEmitter): void {
    stream.removeAllListeners();
    if (this.streams.get(paymentHash) === stream) this.streams.delete(paymentHash);
  }
}
