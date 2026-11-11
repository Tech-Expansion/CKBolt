import { Logger } from "@nestjs/common";
import { PAYOUT_SEND_EVENTS, SWAP_EVENT, UNKNOWN_PAYMENT_FAILURE, type SwapEventType } from "../../common/constants/swap.constants";
import { describeError } from "../../common/utils/error.util";
import { preimageMatches } from "../../common/utils/hex.util";
import {
  canCancelIncoming,
  expectedIncomingAmount,
  heldPaymentProblem,
  hasNoPayment,
  holdsFunds,
  INCOMING_LEG_STATE,
  isAwaitingPayment,
  isCancelledOnRequest,
  isHoldInvoiceExpiryDue,
  isIncomingReleased,
  isPayoutFailed,
  isQuoteExpired,
  LEG_NETWORK_NAME,
  needsRefund,
  PAYOUT_LEG_STATE,
  provesPayment,
  SWAP_REASON,
  SWAP_STATE,
  type IncomingLegView,
} from "../../domain/swap";
import { timingFail } from "../../domain/timing/timing.result";
import type { HubConfig } from "../../config/hub.config";
import type { Hex32, Swap, SwapState } from "../../domain/types";
import type { Clock } from "../ports/clock.port";
import { callNode } from "./payout-invoice.checks";
import { SWAP_ERROR } from "./swap.errors";
import type { PayoutWindow, SwapFlow, SwapFlows } from "./swap-flow";
import type { SwapJournal } from "./swap-journal";

type StepHandler = (swap: Swap, flow: SwapFlow) => Promise<void>;
/** What the hub does when the held payment no longer allows a payout: a plain sentence says why. */
type RefuseHold = (reason: string) => Promise<void>;
type ProcessorSettings = Pick<HubConfig["swaps"], "holdInvoiceExpiryToleranceMs" | "payoutMaxResends" | "payoutMissingConfirmMs">;

/**
 * One step of the state machine per call, for the swap's current state (the CCH pattern, docs/research/cch.md 1.3):
 * read the nodes, save the transition, then act on it. Safety rules (docs/phase-3-plan.md section 3):
 * - the incoming leg is cancelled only before a payout exists or after it definitely failed, never while in flight:
 *   a payout the paying node has no record of counts as failed only once it has stayed unknown long enough after the
 *   last send that no send can still be starting inside the node;
 * - a preimage is trusted only if it hashes to the payment hash, and is saved before the incoming leg is settled;
 * - once the payout succeeded the swap never fails: settling is retried until the node reports it final.
 */
export class SwapProcessor {
  private readonly logger = new Logger(SwapProcessor.name);
  private readonly steps: Readonly<Record<SwapState, StepHandler>>;

  constructor(
    private readonly flows: SwapFlows,
    private readonly journal: SwapJournal,
    private readonly clock: Clock,
    private readonly settings: ProcessorSettings,
  ) {
    this.steps = {
      [SWAP_STATE.PENDING]: (swap, flow) => this.checkForPayment(swap, flow),
      [SWAP_STATE.INCOMING_ACCEPTED]: (swap, flow) => this.startPayout(swap, flow),
      [SWAP_STATE.OUTGOING_IN_FLIGHT]: (swap, flow) => this.followPayout(swap, flow),
      [SWAP_STATE.OUTGOING_SUCCEEDED]: (swap, flow) => this.collectIncoming(swap, flow),
      [SWAP_STATE.SUCCEEDED]: async () => undefined,
      [SWAP_STATE.FAILED]: (swap, flow) => this.refundIfNeeded(swap, flow),
    };
  }

  /** Runs the step for the swap's state. A failure is recorded on the swap and the next pass tries again. */
  async step(swap: Swap): Promise<void> {
    try {
      await this.steps[swap.state](swap, this.flows[swap.direction]);
    } catch (error) {
      this.reportFailure(swap, error);
    }
  }

  /* ---------------------------------------------------------------------------------- cancelled on request */

  /**
   * Cancels a swap its creator gave up on. Runs on the per-swap lock, so a payment is decided one way only: either a
   * step or the read below saw it first, and the cancel is refused while the swap goes on; or `failed` is saved first,
   * and a payment that lands from then on is failed back by the node when the hold invoice is cancelled.
   *
   * A failed swap reserves nothing and counts toward no cap, so everything it held is free as soon as it is saved. When
   * the node cannot cancel the hold invoice yet, the swap stays failed with `refunded` false and the failed step tries
   * again. Throws 409 when it is too late and 503 when the node cannot say what it holds: nothing has changed then.
   */
  async cancelUnpaid(swap: Swap): Promise<void> {
    if (isCancelledOnRequest(swap)) return;
    if (!isAwaitingPayment(swap)) throw SWAP_ERROR.cancelTooLate();
    const flow = this.flows[swap.direction];
    const incoming = await callNode(flow.legs.incoming, () => flow.readIncoming(swap));
    if (!hasNoPayment(incoming)) throw SWAP_ERROR.cancelTooLate();
    // As in checkForPayment, a missing invoice is not believed before the quote expires: a node that finds it again could
    // take a payment no pass would follow once the swap is closed.
    if (incoming.state === INCOMING_LEG_STATE.MISSING && !isQuoteExpired(swap.quoteExpiresAt, this.clock.now())) {
      throw SWAP_ERROR.nodeUnavailable(LEG_NETWORK_NAME[flow.legs.incoming]);
    }

    const released = isIncomingReleased(incoming);
    const failed = this.journal.advance(swap, SWAP_STATE.FAILED, SWAP_EVENT.CANCELLED_ON_REQUEST, SWAP_REASON.cancelledOnRequest, {
      failureReason: SWAP_REASON.cancelledOnRequest,
      refunded: released,
    });
    if (!failed) throw SWAP_ERROR.cancelTooLate();
    if (!released) await this.cancelHoldInvoice(failed, flow);
  }

  /** The cancel is decided and saved: a node that does not answer now is the failed step's to retry, not the caller's. */
  private async cancelHoldInvoice(failed: Swap, flow: SwapFlow): Promise<void> {
    try {
      await this.refund(failed, flow, SWAP_REASON.holdInvoiceCancelledOnRequest);
    } catch (error) {
      this.reportFailure(failed, error);
    }
  }

  /* ----------------------------------------------------------------------------------------------- pending */

  /** Waits for the hold invoice to be paid; accepts the payment only while the quote and the timing still hold. */
  private async checkForPayment(swap: Swap, flow: SwapFlow): Promise<void> {
    const incoming = await flow.readIncoming(swap);
    const quoteExpired = isQuoteExpired(swap.quoteExpiresAt, this.clock.now());
    switch (incoming.state) {
      case INCOMING_LEG_STATE.HELD:
        if (quoteExpired) return this.failAndRefund(swap, flow, SWAP_REASON.paidAfterQuoteExpiry);
        return this.acceptIfPayable(swap, flow, incoming);
      case INCOMING_LEG_STATE.OPEN:
        if (quoteExpired) return this.failAndRefund(swap, flow, SWAP_REASON.quoteExpiredUnpaid, SWAP_EVENT.EXPIRED);
        return;
      case INCOMING_LEG_STATE.CANCELLED:
        if (this.holdInvoiceExpired(swap)) return this.failReleased(swap, SWAP_REASON.quoteExpiredUnpaid, SWAP_EVENT.EXPIRED);
        this.logger.warn(`Swap ${swap.id}: the hold invoice was cancelled without the hub asking for it.`);
        return this.failReleased(swap, SWAP_REASON.holdInvoiceCancelled);
      case INCOMING_LEG_STATE.MISSING:
        if (quoteExpired) return this.failReleased(swap, SWAP_REASON.holdInvoiceMissing);
        this.journal.recordIssue(swap.id, SWAP_EVENT.ERROR, SWAP_REASON.holdInvoiceMissing);
        return;
      case INCOMING_LEG_STATE.SETTLED:
        return this.alert(swap, SWAP_REASON.settledBeforePayout);
      case INCOMING_LEG_STATE.RESOLVING:
        // A TLC on its way out (the hub never settles a pending swap, so it is being failed back): read the outcome next pass.
        return;
    }
  }

  /** The node released the unpaid hold invoice at the end of its life, which is the quote's (see isHoldInvoiceExpiryDue). */
  private holdInvoiceExpired(swap: Swap): boolean {
    return isHoldInvoiceExpiryDue(swap.quoteExpiresAt, this.clock.now(), this.settings.holdInvoiceExpiryToleranceMs);
  }

  private async acceptIfPayable(swap: Swap, flow: SwapFlow, incoming: IncomingLegView): Promise<void> {
    const window = await this.payoutWindow(swap, flow, incoming);
    if (!window.ok) return this.failAndRefund(swap, flow, window.reason);
    this.journal.advance(swap, SWAP_STATE.INCOMING_ACCEPTED, SWAP_EVENT.INCOMING_ACCEPTED, SWAP_REASON.incomingAccepted);
  }

  /** The held payment must cover the quote, and there must be time to pay out and settle before the hold ends. */
  private async payoutWindow(swap: Swap, flow: SwapFlow, incoming: IncomingLegView): Promise<PayoutWindow> {
    const problem = heldPaymentProblem(incoming.heldAmount, expectedIncomingAmount(swap));
    return problem ? timingFail(problem) : flow.payoutWindow(swap, incoming);
  }

  /* ------------------------------------------------------------------------------------- incoming_accepted */

  /** Confirms the hold right before paying, saves outgoing_in_flight with the lock limit, then sends the payout. */
  private async startPayout(swap: Swap, flow: SwapFlow): Promise<void> {
    const lockLimit = await this.confirmHoldForPayout(swap, flow, (reason) => this.failAndRefund(swap, flow, reason));
    if (lockLimit === null) return;
    const inFlight = this.journal.advance(swap, SWAP_STATE.OUTGOING_IN_FLIGHT, SWAP_EVENT.PAYOUT_STARTED, SWAP_REASON.payoutStarted, {
      payoutLockLimit: lockLimit,
    });
    if (inFlight) await this.sendPayout(inFlight, flow);
  }

  /**
   * Re-reads the incoming leg and sizes the payout lock from what is held now: the deadline only gets closer. Returns
   * the lock limit, or null when no payout may be sent: the hold was released (the swap fails, nothing to cancel), it is
   * settled (needs a person), or there is no time left to pay out, which `refuse` handles.
   */
  private async confirmHoldForPayout(swap: Swap, flow: SwapFlow, refuse: RefuseHold): Promise<number | null> {
    const incoming = await flow.readIncoming(swap);
    if (incoming.state === INCOMING_LEG_STATE.SETTLED) {
      this.alert(swap, SWAP_REASON.settledBeforePayout);
      return null;
    }
    if (isIncomingReleased(incoming)) {
      this.failReleased(swap, SWAP_REASON.incomingReleased);
      return null;
    }
    const window =
      incoming.state === INCOMING_LEG_STATE.HELD ? await this.payoutWindow(swap, flow, incoming) : timingFail(SWAP_REASON.nothingHeld);
    if (window.ok) return window.lockLimit;
    await refuse(window.reason);
    return null;
  }

  /* ------------------------------------------------------------------------------------ outgoing_in_flight */

  /**
   * Sends the payout. When the node answers that it failed with nothing out (it refused to send it), the hub refunds at
   * once: the next read would find no record of the payout and send it again, until the hold ran out. Any other answer
   * is followed on the next pass.
   */
  private async sendPayout(swap: Swap, flow: SwapFlow): Promise<void> {
    const sent = await flow.sendPayout(swap);
    if (isPayoutFailed(sent, swap.paymentHash)) await this.refundFailedPayout(swap, flow, sent.failureReason);
  }

  /**
   * Waits for a final payout result. While the payout is in flight the incoming leg is never touched. A preimage that
   * matches the hash proves the payee was paid, whatever state the node reports (a part can succeed in a session that
   * reads Failed), so it is saved and collected with, never refunded.
   */
  private async followPayout(swap: Swap, flow: SwapFlow): Promise<void> {
    const payout = await flow.readPayout(swap.paymentHash);
    if (provesPayment(payout, swap.paymentHash)) return this.savePreimage(swap, payout.preimage);
    switch (payout.state) {
      case PAYOUT_LEG_STATE.IN_FLIGHT:
        return this.guardPayout(swap, flow);
      case PAYOUT_LEG_STATE.NOT_SENT:
        return this.recoverMissingPayout(swap, flow);
      case PAYOUT_LEG_STATE.SUCCEEDED:
        return this.savePreimage(swap, payout.preimage);
      case PAYOUT_LEG_STATE.FAILED:
        return this.refundFailedPayout(swap, flow, payout.failureReason);
    }
  }

  /**
   * Lets the flow protect the incoming leg from a payee that holds the payout (SwapFlow.guardPayout), counting from the
   * last send. A failure here is logged and tried again on the next pass: the swap itself stays as it is.
   */
  private async guardPayout(swap: Swap, flow: SwapFlow): Promise<void> {
    const sentAt = this.journal.eventsOf(swap.id, PAYOUT_SEND_EVENTS).at(-1)?.at ?? swap.updatedAt;
    try {
      const closed = await flow.guardPayout(swap, sentAt);
      for (const channelId of closed) {
        this.logger.warn(`Swap ${swap.id}: the payee still holds the payout; force-closed channel ${channelId} so it settles on chain in time`);
      }
    } catch (error) {
      this.logger.warn(`Swap ${swap.id}: could not check the payout's channels: ${describeError(error)}`);
    }
  }

  /** The node's failure reason goes to the log only: users read the swap's events, which never carry node details. */
  private async refundFailedPayout(swap: Swap, flow: SwapFlow, nodeReason: string | null): Promise<void> {
    this.logger.warn(`Swap ${swap.id}: the payout failed on the ${flow.legs.outgoing} node: ${nodeReason ?? UNKNOWN_PAYMENT_FAILURE}`);
    await this.failAndRefund(swap, flow, SWAP_REASON.payoutFailed, SWAP_EVENT.PAYOUT_FAILED);
  }

  /**
   * The paying node has no record of the payout: the hub crashed right after saving outgoing_in_flight, or a send's
   * answer was lost. While the hold allows it, the payout is sent again, at most payoutMaxResends times. Otherwise the
   * hub refunds, but only once no send can still be starting inside the node (refundMissingPayout).
   */
  private async recoverMissingPayout(swap: Swap, flow: SwapFlow): Promise<void> {
    const sends = this.journal.eventsOf(swap.id, PAYOUT_SEND_EVENTS);
    const sinceLastSendMs = this.clock.now() - (sends.at(-1)?.at ?? swap.updatedAt);
    const refuse: RefuseHold = (reason) => this.refundMissingPayout(swap, flow, reason, sinceLastSendMs);
    const lockLimit = await this.confirmHoldForPayout(swap, flow, refuse);
    if (lockLimit === null) return;
    const resends = sends.filter((event) => event.type === SWAP_EVENT.PAYOUT_RETRIED).length;
    if (resends >= this.settings.payoutMaxResends) return refuse(SWAP_REASON.payoutNotSent);

    const refreshed = this.journal.update(swap, { payoutLockLimit: lockLimit });
    // Saved before the send: if its answer is lost too, the event still counts it and dates it.
    this.journal.record(swap.id, SWAP_EVENT.PAYOUT_RETRIED, SWAP_REASON.payoutRetried);
    await this.sendPayout(refreshed, flow);
  }

  /**
   * Fails and refunds a swap whose payout the paying node has no record of, once its last send is payoutMissingConfirmMs
   * old: a send whose call timed out can still be starting inside the node until then. Before that, it waits.
   */
  private async refundMissingPayout(swap: Swap, flow: SwapFlow, reason: string, sinceLastSendMs: number): Promise<void> {
    if (sinceLastSendMs < this.settings.payoutMissingConfirmMs) return;
    await this.failAndRefund(swap, flow, reason);
  }

  /** Trusts the preimage only if it hashes to the payment hash, and saves it before anything settles with it. */
  private savePreimage(swap: Swap, preimage: Hex32 | null): void {
    if (preimage === null || !preimageMatches(preimage, swap.paymentHash)) return this.alert(swap, SWAP_REASON.payoutPreimageInvalid);
    this.journal.advance(swap, SWAP_STATE.OUTGOING_SUCCEEDED, SWAP_EVENT.PAYOUT_SUCCEEDED, SWAP_REASON.payoutSucceeded, { preimage });
  }

  /* ------------------------------------------------------------------------------------ outgoing_succeeded */

  /**
   * Settles the incoming leg with the saved preimage until the node reports it final. This state never fails. When the
   * node holds nothing left to collect (released, or a timed-out fnn TLC behind an invoice that still reads Received),
   * the hub has paid out and cannot be paid: it alerts and keeps trying until a person resolves the swap. While the
   * node is still resolving what it held (fnn right after settle_invoice), the outcome is not known: it waits for it.
   */
  private async collectIncoming(swap: Swap, flow: SwapFlow): Promise<void> {
    const preimage = swap.preimage;
    if (preimage === null) return this.alert(swap, SWAP_REASON.preimageMissing);

    const before = await flow.readIncoming(swap);
    if (before.state === INCOMING_LEG_STATE.SETTLED) return this.complete(swap);
    if (before.state === INCOMING_LEG_STATE.RESOLVING) return;
    if (isIncomingReleased(before)) return this.alert(swap, SWAP_REASON.incomingLostAfterPayout);

    await flow.settleIncoming(swap.paymentHash, preimage);
    const after = await flow.readIncoming(swap);
    if (after.state === INCOMING_LEG_STATE.SETTLED) return this.complete(swap);
    if (after.state !== INCOMING_LEG_STATE.RESOLVING && !holdsFunds(after)) this.alert(swap, SWAP_REASON.incomingLostAfterPayout);
  }

  private complete(swap: Swap): void {
    this.journal.advance(swap, SWAP_STATE.SUCCEEDED, SWAP_EVENT.SETTLED, SWAP_REASON.settled);
  }

  /* ------------------------------------------------------------------------------------------------ failed */

  private async refundIfNeeded(swap: Swap, flow: SwapFlow): Promise<void> {
    if (!needsRefund(swap)) return;
    await this.refund(swap, flow, isCancelledOnRequest(swap) ? SWAP_REASON.holdInvoiceCancelledOnRequest : SWAP_REASON.refunded);
  }

  /** Saves `failed` first, then cancels the incoming leg; if the cancel fails, the failed step retries it. */
  private async failAndRefund(swap: Swap, flow: SwapFlow, reason: string, event: SwapEventType = SWAP_EVENT.FAILED): Promise<void> {
    const failed = this.journal.advance(swap, SWAP_STATE.FAILED, event, reason, { failureReason: reason, refunded: false });
    if (failed) await this.refund(failed, flow);
  }

  /** Fails a swap whose incoming leg the node already released: there is nothing left to cancel. */
  private failReleased(swap: Swap, reason: string, event: SwapEventType = SWAP_EVENT.FAILED): void {
    this.journal.advance(swap, SWAP_STATE.FAILED, event, reason, { failureReason: reason, refunded: true });
  }

  private async refund(swap: Swap, flow: SwapFlow, detail: string = SWAP_REASON.refunded): Promise<void> {
    if (!canCancelIncoming(swap)) return this.alert(swap, SWAP_REASON.refundBlocked);
    await flow.cancelIncoming(swap.paymentHash);
    this.journal.update(swap, { refunded: true });
    this.journal.record(swap.id, SWAP_EVENT.CANCELLED, detail);
  }

  /* -------------------------------------------------------------------------------------------- reporting */

  /** Something only a person can resolve: logged loudly, recorded once on the swap. */
  private alert(swap: Swap, reason: string): void {
    if (this.journal.recordIssue(swap.id, SWAP_EVENT.ALERT, reason)) this.logger.error(`Swap ${swap.id} needs attention: ${reason}`);
  }

  /**
   * Records a failed step without node details (users read events) and logs the details. A failure after the payout
   * succeeded is always logged as an error: until the incoming leg settles, the hub has paid and not been paid.
   */
  private reportFailure(swap: Swap, error: unknown): void {
    const message = `Swap ${swap.id} (${swap.state}): ${describeError(error)}`;
    let isNew = true;
    try {
      isNew = this.journal.recordIssue(swap.id, SWAP_EVENT.ERROR, SWAP_REASON.retrying(swap.state));
    } catch (recordError) {
      this.logger.error(`Swap ${swap.id}: could not record a failure: ${describeError(recordError)}`);
    }
    if (swap.state === SWAP_STATE.OUTGOING_SUCCEEDED) this.logger.error(message);
    else if (isNew) this.logger.warn(message);
    else this.logger.debug(message);
  }
}
