import {
  FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS,
  FIBER_DEFAULT_FINAL_EXPIRY_DELTA_MS,
  FIBER_HASH_ALGORITHM_SHA256,
  MSAT_PER_SAT,
} from "../../common/constants/protocol.constants";
import { holdInvoiceDescription, SWAP_DIRECTION } from "../../common/constants/swap.constants";
import { basisPointsOfCeil } from "../../common/utils/basis-points.util";
import { formatBaseUnits } from "../../common/utils/pricing.util";
import { earliestOf, requirePresent } from "../../common/utils/swaps.util";
import {
  expectedPayoutAmount,
  heldIncomingLeg,
  INCOMING_LEG_STATE,
  incomingLeg,
  LEG_NETWORK,
  legNetworks,
  PAYOUT_LEG_STATE,
  PAYOUT_NOT_SENT,
  SWAP_REASON,
  type IncomingLegState,
  type IncomingLegView,
  type PayoutLegState,
  type PayoutLegView,
} from "../../domain/swap";
import { fiberPayoutForceCloseAt } from "../../domain/timing/timing.budget";
import { checkLnToFiberPayout, planLnToFiber } from "../../domain/timing/timing.policy";
import { timingFail, timingOk } from "../../domain/timing/timing.result";
import type { FiberAsset, Hex32, Swap } from "../../domain/types";
import type { FiberOfferedTlc, FiberPaymentState, FiberPaymentStatus, ParsedFiberInvoice } from "../ports/fiber.port";
import type { LnInvoiceState } from "../ports/lightning.port";
import { assertInvoiceAmount, assertInvoiceNetwork, assertInvoiceOutlivesQuote, callNode, readPayoutInvoice } from "./payout-invoice.checks";
import { SWAP_ERROR } from "./swap.errors";
import type { HoldInvoiceRequest, PayoutWindow, SwapFlow, SwapFlowDeps, SwapPlan, SwapPlanInput } from "./swap-flow";

const LN_INVOICE_LEG_STATE: Readonly<Record<LnInvoiceState, IncomingLegState>> = {
  OPEN: INCOMING_LEG_STATE.OPEN,
  ACCEPTED: INCOMING_LEG_STATE.HELD,
  SETTLED: INCOMING_LEG_STATE.SETTLED,
  CANCELED: INCOMING_LEG_STATE.CANCELLED,
};

const FIBER_PAYMENT_LEG_STATE: Readonly<Record<FiberPaymentState, PayoutLegState>> = {
  Created: PAYOUT_LEG_STATE.IN_FLIGHT,
  Inflight: PAYOUT_LEG_STATE.IN_FLIGHT,
  Success: PAYOUT_LEG_STATE.SUCCEEDED,
  Failed: PAYOUT_LEG_STATE.FAILED,
};

/**
 * ln_to_fiber (docs/phase-3-plan.md section 3, direction A): the user pays a Lightning hold invoice on the hub's LND,
 * the hub pays the user's Fiber invoice, capped by `tlc_expiry_limit` so the Fiber lock ends before LND auto-cancels
 * the held HTLC.
 */
export class LnToFiberFlow implements SwapFlow {
  readonly direction = SWAP_DIRECTION.LN_TO_FIBER;
  readonly legs = legNetworks(SWAP_DIRECTION.LN_TO_FIBER);

  constructor(private readonly deps: SwapFlowDeps) {}

  async planSwap({ quote, asset, payoutInvoice, now }: SwapPlanInput): Promise<SwapPlan> {
    const invoice = await readPayoutInvoice(LEG_NETWORK.FIBER, () => this.deps.fiber.parseInvoice(payoutInvoice));
    this.assertPayableInvoice(invoice, asset, quote.fiberAmount);
    assertInvoiceOutlivesQuote(invoice.expiresAt, quote.expiresAt, now);

    const plan = planLnToFiber(this.deps.profile, {
      payoutFinalExpiryDeltaMs: invoice.finalExpiryDeltaMs ?? FIBER_DEFAULT_FINAL_EXPIRY_DELTA_MS,
    });
    if (!plan.ok) throw SWAP_ERROR.timingOutOfRange(plan.reason);

    return {
      paymentHash: invoice.paymentHash,
      holdCltvExpiry: plan.holdCltvExpiry,
      holdFinalExpiryDeltaMs: null,
      payoutLockLimit: plan.payoutTlcExpiryLimitMs,
    };
  }

  async isHashInUse(paymentHash: Hex32): Promise<boolean> {
    const [invoice, payment] = await Promise.all([
      callNode(LEG_NETWORK.LIGHTNING, () => this.deps.lightning.lookupInvoice(paymentHash)),
      callNode(LEG_NETWORK.FIBER, () => this.deps.fiber.getPayment(paymentHash)),
    ]);
    return invoice !== null || payment !== null;
  }

  async createHoldInvoice({ swapId, quote, plan, expirySeconds }: HoldInvoiceRequest): Promise<string> {
    const { paymentRequest } = await callNode(LEG_NETWORK.LIGHTNING, () =>
      this.deps.lightning.createHoldInvoice({
        paymentHash: plan.paymentHash,
        amountSats: quote.sats,
        expirySeconds,
        cltvExpiry: requirePresent(plan.holdCltvExpiry, "holdCltvExpiry"),
        memo: holdInvoiceDescription(swapId),
      }),
    );
    return paymentRequest;
  }

  async readIncoming(swap: Swap): Promise<IncomingLegView> {
    const invoice = await this.deps.lightning.lookupInvoice(swap.paymentHash);
    if (!invoice) return incomingLeg(INCOMING_LEG_STATE.MISSING);
    const state = LN_INVOICE_LEG_STATE[invoice.state];
    if (state !== INCOMING_LEG_STATE.HELD) return incomingLeg(state);
    return heldIncomingLeg(invoice.amountPaidMsat / MSAT_PER_SAT, earliestOf(invoice.htlcExpiryHeights));
  }

  /**
   * The Fiber lock must end before LND auto-cancels the earliest held HTLC, with the profile's margins to spare. LND's
   * height counts only once it is synced: a lagging node would overstate the blocks left. Until then the step throws,
   * so the swap waits (the next pass tries again) instead of paying out or failing.
   */
  async payoutWindow(swap: Swap, incoming: IncomingLegView): Promise<PayoutWindow> {
    if (incoming.holdDeadline === null) return timingFail(SWAP_REASON.nothingHeld);
    const { blockHeight, synced } = await this.deps.lightning.getInfo();
    if (!synced) throw SWAP_ERROR.lightningNotSynced();
    const check = checkLnToFiberPayout(this.deps.profile, {
      earliestHtlcExpiryHeight: incoming.holdDeadline,
      currentHeight: blockHeight,
      plannedTlcExpiryLimitMs: requirePresent(swap.payoutLockLimit, "payoutLockLimit"),
    });
    return check.ok ? timingOk({ lockLimit: check.payoutTlcExpiryLimitMs }) : check;
  }

  /** A refusal (fnn started nothing) reads Failed, but a part of an earlier attempt may still be out: see toPayoutView. */
  async sendPayout(swap: Swap): Promise<PayoutLegView> {
    const payment = await this.deps.fiber.payInvoice({
      invoice: swap.payoutInvoice,
      maxFeeAmount: basisPointsOfCeil(expectedPayoutAmount(swap), this.deps.config.swaps.fiberMaxFeeBps),
      tlcExpiryLimitMs: requirePresent(swap.payoutLockLimit, "payoutLockLimit"),
    });
    return this.toPayoutView(payment);
  }

  async readPayout(paymentHash: Hex32): Promise<PayoutLegView> {
    const payment = await this.deps.fiber.getPayment(paymentHash);
    return payment ? this.toPayoutView(payment) : PAYOUT_NOT_SENT;
  }

  /**
   * Force-closes each private channel on which the payee still holds the hub's TLC past fiberPayoutForceCloseAt
   * (FIBER_PAYOUT_GUARD): the on-chain settlement then opens before the TLC expires, so a payee that claims it with the
   * preimage on chain does so while the Lightning hold still stands, and fnn reports the preimage as the payment's. A
   * public channel's peer is a router, whose own payee answers to it first (a hop's expiry delta), so it is left open.
   */
  async guardPayout(swap: Swap, sentAt: number): Promise<string[]> {
    const now = this.deps.clock.now();
    const due = (await this.deps.fiber.offeredTlcs(swap.paymentHash)).filter(
      (tlc) => !tlc.channelPublic && now >= fiberPayoutForceCloseAt({ ...tlc, commitmentDelayEpochs: this.commitmentDelayOf(tlc), sentAt }),
    );
    const channelIds = [...new Set(due.map((tlc) => tlc.channelId))];
    for (const channelId of channelIds) await this.deps.fiber.forceCloseChannel(channelId);
    return channelIds;
  }

  settleIncoming(_paymentHash: Hex32, preimage: Hex32): Promise<void> {
    return this.deps.lightning.settleInvoice(preimage);
  }

  cancelIncoming(paymentHash: Hex32): Promise<void> {
    return this.deps.lightning.cancelInvoice(paymentHash);
  }

  /**
   * fnn can report a session Failed while a part it sent is still out (docs/research/fiber-node.md 2.2): the payout
   * counts as failed only once no channel has a TLC this node offered for the hash with its removal unacknowledged.
   */
  private async toPayoutView(payment: FiberPaymentStatus): Promise<PayoutLegView> {
    const payout = { state: FIBER_PAYMENT_LEG_STATE[payment.state], preimage: payment.preimage, failureReason: payment.failedError };
    if (payout.state !== PAYOUT_LEG_STATE.FAILED) return payout;
    return (await this.deps.fiber.hasOfferedTlcs(payment.paymentHash)) ? { ...payout, state: PAYOUT_LEG_STATE.IN_FLIGHT } : payout;
  }

  /** The hub opens its channels with fnn's default delay; a channel a peer opened is counted with the delay assumed for it. */
  private commitmentDelayOf(tlc: FiberOfferedTlc): number {
    return tlc.channelOpenedByPeer ? this.deps.config.swaps.fiberPeerChannelCommitmentDelayEpochs : FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS;
  }

  /** Network, hash algorithm, single part, asset and amount must match what the hub can pay for this quote. */
  private assertPayableInvoice(invoice: ParsedFiberInvoice, asset: FiberAsset, quotedAmount: bigint): void {
    assertInvoiceNetwork(LEG_NETWORK.FIBER, invoice.network, this.deps.config.ckb.network);
    if (invoice.hashAlgorithm !== FIBER_HASH_ALGORITHM_SHA256) throw SWAP_ERROR.fiberHashAlgorithm(invoice.hashAlgorithm);
    if (invoice.allowsMpp) throw SWAP_ERROR.fiberInvoiceAllowsMpp();
    if (this.deps.assets.byTypeScript(invoice.udtTypeScript)?.id !== asset.id) throw SWAP_ERROR.fiberAssetMismatch(asset.symbol);
    assertInvoiceAmount(invoice.amount, quotedAmount, (amount) => `${formatBaseUnits(amount, asset.decimals)} ${asset.symbol}`);
  }
}
