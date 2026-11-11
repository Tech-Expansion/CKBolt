import {
  BTC_INVOICE_NETWORKS,
  FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS,
  MSAT_DECIMALS,
  MSAT_PER_SAT,
} from "../../common/constants/protocol.constants";
import { holdInvoiceDescription, SATS_UNIT_LABEL, SWAP_DIRECTION } from "../../common/constants/swap.constants";
import { sumOf } from "../../common/utils/amount.util";
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
import { fiberHeldTlcFailsAt } from "../../domain/timing/timing.budget";
import { lnPayoutCltvLimit, planFiberToLn } from "../../domain/timing/timing.policy";
import { timingFail, timingOk } from "../../domain/timing/timing.result";
import type { FiberAsset, Hex32, Script, Swap } from "../../domain/types";
import type { FiberHeldTlc, FiberInvoiceState } from "../ports/fiber.port";
import type { LnPaymentState, LnPaymentStatus } from "../ports/lightning.port";
import { assertInvoiceAmount, assertInvoiceNetwork, assertInvoiceOutlivesQuote, callNode, readPayoutInvoice } from "./payout-invoice.checks";
import { SWAP_ERROR } from "./swap.errors";
import type { HoldInvoiceRequest, PayoutWindow, SwapFlow, SwapFlowDeps, SwapPlan, SwapPlanInput } from "./swap-flow";

/** `Expired` is an Open invoice past its expiry: nothing was paid and nothing can be any more. */
const FIBER_INVOICE_LEG_STATE: Readonly<Record<FiberInvoiceState, IncomingLegState>> = {
  Open: INCOMING_LEG_STATE.OPEN,
  Received: INCOMING_LEG_STATE.HELD,
  Paid: INCOMING_LEG_STATE.SETTLED,
  Cancelled: INCOMING_LEG_STATE.CANCELLED,
  Expired: INCOMING_LEG_STATE.CANCELLED,
};

const LN_PAYMENT_LEG_STATE: Readonly<Record<LnPaymentState, PayoutLegState>> = {
  IN_FLIGHT: PAYOUT_LEG_STATE.IN_FLIGHT,
  SUCCEEDED: PAYOUT_LEG_STATE.SUCCEEDED,
  FAILED: PAYOUT_LEG_STATE.FAILED,
};

/** An LND payment as the payout leg: LND reports FAILED only once nothing of the payment is out, so it maps as is. */
const toPayoutView = (payment: LnPaymentStatus): PayoutLegView => ({
  state: LN_PAYMENT_LEG_STATE[payment.state],
  preimage: payment.preimage,
  failureReason: payment.failureReason,
});

/** A millisatoshi amount in sats, for messages: 1500500 -> "1500.5 sats". */
const describeMsat = (amountMsat: bigint): string => `${formatBaseUnits(amountMsat, MSAT_DECIMALS)} ${SATS_UNIT_LABEL}`;

/**
 * fiber_to_ln (docs/phase-3-plan.md section 3, direction B): the user pays a Fiber hold invoice on the hub's fnn, the
 * hub pays the user's BOLT11 invoice, capped by `cltv_limit` so the Lightning lock resolves before fnn fails the held
 * TLC.
 */
export class FiberToLnFlow implements SwapFlow {
  readonly direction = SWAP_DIRECTION.FIBER_TO_LN;
  readonly legs = legNetworks(SWAP_DIRECTION.FIBER_TO_LN);

  constructor(private readonly deps: SwapFlowDeps) {}

  async planSwap({ quote, asset, payoutInvoice, now }: SwapPlanInput): Promise<SwapPlan> {
    const invoice = await readPayoutInvoice(LEG_NETWORK.LIGHTNING, () => this.deps.lightning.decodeInvoice(payoutInvoice));
    const hubNetwork = this.deps.config.bitcoin.network;
    assertInvoiceNetwork(LEG_NETWORK.LIGHTNING, invoice.network, hubNetwork, BTC_INVOICE_NETWORKS[hubNetwork]);
    assertInvoiceAmount(invoice.amountMsat, quote.sats * MSAT_PER_SAT, describeMsat);
    assertInvoiceOutlivesQuote(invoice.expiresAt, quote.expiresAt, now);

    const plan = planFiberToLn(this.deps.profile, {
      payoutCltvExpiry: invoice.cltvExpiry,
      configuredHoldFinalExpiryDeltaMs: this.deps.config.swaps.fiberHoldFinalExpiryDeltaMs,
      inboundCommitmentDelayEpochs: this.holdCommitmentDelayEpochs(asset),
    });
    if (!plan.ok) throw SWAP_ERROR.timingOutOfRange(plan.reason);

    return {
      paymentHash: invoice.paymentHash,
      holdCltvExpiry: null,
      holdFinalExpiryDeltaMs: plan.holdFinalExpiryDeltaMs,
      payoutLockLimit: null,
    };
  }

  async isHashInUse(paymentHash: Hex32): Promise<boolean> {
    const [invoice, payment] = await Promise.all([
      callNode(LEG_NETWORK.FIBER, () => this.deps.fiber.getInvoice(paymentHash)),
      callNode(LEG_NETWORK.LIGHTNING, () => this.deps.lightning.getPayment(paymentHash)),
    ]);
    return invoice !== null || payment !== null;
  }

  async createHoldInvoice({ swapId, quote, asset, plan, expirySeconds }: HoldInvoiceRequest): Promise<string> {
    const { invoice } = await callNode(LEG_NETWORK.FIBER, () =>
      this.deps.fiber.createHoldInvoice({
        paymentHash: plan.paymentHash,
        amount: quote.fiberAmount,
        udtTypeScript: asset.udtTypeScript,
        expirySeconds,
        finalExpiryDeltaMs: requirePresent(plan.holdFinalExpiryDeltaMs, "holdFinalExpiryDeltaMs"),
        description: holdInvoiceDescription(swapId),
      }),
    );
    return invoice;
  }

  /**
   * A Received invoice whose TLC timed out still reads Received, so what is held comes from the TLCs themselves, and
   * only from TLCs in the swap's asset. A Received invoice holding nothing while a TLC is being removed is resolving:
   * right after settle_invoice it turns Paid, after a failed-back TLC it keeps holding nothing. The hold's deadline is
   * when fnn fails the first held TLC.
   */
  async readIncoming(swap: Swap): Promise<IncomingLegView> {
    const { paymentHash } = swap;
    const invoice = await this.deps.fiber.getInvoice(paymentHash);
    if (!invoice) return incomingLeg(INCOMING_LEG_STATE.MISSING);
    const state = FIBER_INVOICE_LEG_STATE[invoice.state];
    if (state !== INCOMING_LEG_STATE.HELD) return incomingLeg(state);
    const tlcs = await this.deps.fiber.heldTlcs(paymentHash, this.udtTypeScriptOf(swap));
    if (tlcs.length === 0 && (await this.deps.fiber.hasRemovingTlcs(paymentHash))) return incomingLeg(INCOMING_LEG_STATE.RESOLVING);
    return heldIncomingLeg(
      sumOf(tlcs.map((tlc) => tlc.amount)),
      earliestOf(tlcs.map((tlc) => fiberHeldTlcFailsAt(tlc.expiresAt, this.commitmentDelayEpochsOf(tlc)))),
    );
  }

  /**
   * The Lightning payout must resolve before fnn fails the earliest held TLC, counted at the slow block interval. When it
   * cannot and the payment came over a channel the payer opened, the reason says so: the hub counted that channel's
   * longest possible commitment delay.
   */
  async payoutWindow(swap: Swap, incoming: IncomingLegView): Promise<PayoutWindow> {
    if (incoming.holdDeadline === null) return timingFail(SWAP_REASON.nothingHeld);
    const payoutInvoice = await this.deps.lightning.decodeInvoice(swap.payoutInvoice);
    const limit = lnPayoutCltvLimit(this.deps.profile, {
      heldTlcFailsAt: incoming.holdDeadline,
      now: this.deps.clock.now(),
      payoutCltvExpiry: payoutInvoice.cltvExpiry,
    });
    if (limit.ok) return timingOk({ lockLimit: limit.cltvLimit });
    if (!(await this.heldOverPeerChannel(swap))) return limit;
    return timingFail(SWAP_REASON.peerChannelHoldTooShort(this.deps.config.swaps.fiberPeerChannelCommitmentDelayEpochs));
  }

  /** LND's FAILED is final: it reports it once no HTLC of the payment is out, or when it refused to send any. */
  async sendPayout(swap: Swap): Promise<PayoutLegView> {
    const payment = await this.deps.lightning.payInvoice({
      paymentRequest: swap.payoutInvoice,
      maxFeeSats: basisPointsOfCeil(expectedPayoutAmount(swap), this.deps.config.swaps.lnMaxFeeBps),
      cltvLimit: requirePresent(swap.payoutLockLimit, "payoutLockLimit"),
      timeoutSeconds: this.deps.config.swaps.lnPayTimeoutSeconds,
    });
    return toPayoutView(payment);
  }

  /** A Lightning payout needs no guard: LND resolves its HTLC on chain within the cltv_limit the hub set. */
  async guardPayout(): Promise<string[]> {
    return [];
  }

  async readPayout(paymentHash: Hex32): Promise<PayoutLegView> {
    const payment = await this.deps.lightning.getPayment(paymentHash);
    return payment ? toPayoutView(payment) : PAYOUT_NOT_SENT;
  }

  settleIncoming(paymentHash: Hex32, preimage: Hex32): Promise<void> {
    return this.deps.fiber.settleInvoice(paymentHash, preimage);
  }

  cancelIncoming(paymentHash: Hex32): Promise<void> {
    return this.deps.fiber.cancelInvoice(paymentHash);
  }

  /** The swap's asset as a UDT type script (null for CKB). An asset the hub stopped serving cannot be read: the step fails. */
  private udtTypeScriptOf(swap: Swap): Script | null {
    return requirePresent(this.deps.assets.get(swap.asset), `asset ${swap.asset}`).udtTypeScript;
  }

  /** Some of the held payment came over a channel the payer opened (so it chose the channel's commitment delay). */
  private async heldOverPeerChannel(swap: Swap): Promise<boolean> {
    const tlcs = await this.deps.fiber.heldTlcs(swap.paymentHash, this.udtTypeScriptOf(swap));
    return tlcs.some((tlc) => tlc.channelOpenedByPeer);
  }

  /**
   * The longest commitment delay a payment in `asset` may arrive under, which the hold invoice is sized for: the delay
   * assumed for a channel a node opened when the asset takes such channels (FIBER_ASSETS peerChannels), otherwise fnn's
   * default, which the hub's own channels use.
   */
  private holdCommitmentDelayEpochs(asset: FiberAsset): number {
    const takesPeerChannels = this.deps.config.fiberPeers.peerChannels.terms[asset.id] !== undefined;
    return takesPeerChannels ? this.deps.config.swaps.fiberPeerChannelCommitmentDelayEpochs : FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS;
  }

  /**
   * The commitment delay of the channel a held TLC arrived on, which sets how early fnn fails it. The hub's own channels
   * use fnn's default; a peer that opened its channel chose the delay, and fnn does not report it, so the configured
   * assumption applies (by default the longest delay fnn accepts).
   */
  private commitmentDelayEpochsOf(tlc: FiberHeldTlc): number {
    return tlc.channelOpenedByPeer ? this.deps.config.swaps.fiberPeerChannelCommitmentDelayEpochs : FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS;
  }
}
