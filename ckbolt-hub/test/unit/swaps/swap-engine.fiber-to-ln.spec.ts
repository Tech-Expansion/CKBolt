import { SWAP_EVENT } from "../../../src/common/constants/swap.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import { SWAP_REASON } from "../../../src/domain/swap";
import {
  callCount,
  eventTypes,
  expectPlainSentence,
  FIBER_TO_LN,
  hours,
  makeSwapHarness,
  minutes,
  newPreimage,
  payHoldInvoice,
  processPasses,
  processToRest,
  requireSwap,
  silenceLogs,
  startSwap,
  swapsSeenAtCall,
  type SwapHarness,
} from "./swaps.fixtures";

/**
 * processSwap for fiber_to_ln (docs/phase-3-plan.md section 3, direction B): the user's TLC is held by the hub's fnn,
 * the hub pays the user's BOLT11 invoice with cltv_limit = floor((held TLC expiry - now - reserve) / slow block), learns
 * the preimage from the payout and only then settles the Fiber hold invoice. A Fiber invoice can say Received after its
 * TLC timed out, so what is held comes from heldTlcs().
 */

const feeLimit = (amount: bigint, bps: number): bigint => (amount * BigInt(bps) + 9_999n) / 10_000n;

/** cltv_limit when `elapsedMs` passed since a TLC with `lifetimeMs` was held: floor((lifetime - elapsed - 171 min) / 15 min). */
const cltvLimitAfter = (elapsedMs: number, lifetimeMs = FIBER_TO_LN.HELD_TLC_LIFETIME_MS): number =>
  Math.floor((lifetimeMs - elapsedMs - FIBER_TO_LN.HOLD_RESERVE_MS) / FIBER_TO_LN.SLOW_BLOCK_MS);

/** A quote valid for two days, so the clock can move far without expiring it (the hold invoice expires with it). */
const LONG_QUOTE = (h: SwapHarness) => ({ expiresAt: h.clock.now() + hours(48) });

describe("swap engine: processSwap, fiber_to_ln", () => {
  let h: SwapHarness;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness();
  });

  afterEach(() => jest.restoreAllMocks());

  const holdState = async (hash: string) => (await h.hubFiber.getInvoice(hash))?.state;

  describe("the normal path", () => {
    it("waits in pending while the hold invoice is unpaid, writing nothing", async () => {
      const { swap } = await startSwap(h, "fiber_to_ln");
      const after = await processPasses(h, swap.id, 3);

      expect(after.state).toBe("pending");
      expect(eventTypes(h, swap.id)).toEqual([SWAP_EVENT.CREATED]);
      for (const write of ["settleInvoice", "cancelInvoice", "payInvoice"]) {
        expect(callCount(h.hubLn, write)).toBe(0);
        expect(callCount(h.hubFiber, write)).toBe(0);
      }
    });

    it("moves one state per pass to succeeded: accept, pay out on Lightning, save the preimage, settle on Fiber", async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln");
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);
      expect(await holdState(hash)).toBe("Received");

      expect((await processPasses(h, swap.id, 1)).state).toBe("incoming_accepted");
      expect(callCount(h.hubLn, "payInvoice")).toBe(0);

      const inFlight = await processPasses(h, swap.id, 1);
      expect(inFlight).toMatchObject({ state: "outgoing_in_flight", payoutLockLimit: FIBER_TO_LN.CLTV_LIMIT });

      const paidOut = await processPasses(h, swap.id, 1);
      expect(paidOut).toMatchObject({ state: "outgoing_succeeded", preimage });
      expect(await holdState(hash)).toBe("Received");

      const done = await processPasses(h, swap.id, 1);
      expect(done).toMatchObject({ state: "succeeded", preimage, refunded: false, failureReason: null });
      expect(await holdState(hash)).toBe("Paid");
      expect((await h.userFiber.getPayment(hash))).toMatchObject({ state: "Success", preimage });
      expect(h.lnNet.invoices.get(hash)?.state).toBe("SETTLED");
      expect(eventTypes(h, swap.id)).toEqual([
        SWAP_EVENT.CREATED,
        SWAP_EVENT.INCOMING_ACCEPTED,
        SWAP_EVENT.PAYOUT_STARTED,
        SWAP_EVENT.PAYOUT_SUCCEEDED,
        SWAP_EVENT.SETTLED,
      ]);
    });

    it("pays the user's Lightning invoice with the fee limit, cltv_limit and timeout from config and the live hold", async () => {
      const pay = jest.spyOn(h.hubLn, "payInvoice");
      const { swap, quote, payoutInvoice } = await startSwap(h, "fiber_to_ln");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);

      expect(cltvLimitAfter(0)).toBe(FIBER_TO_LN.CLTV_LIMIT);
      expect(pay).toHaveBeenCalledTimes(1);
      expect(pay).toHaveBeenCalledWith({
        paymentRequest: payoutInvoice,
        maxFeeSats: feeLimit(quote.sats, h.config.swaps.lnMaxFeeBps),
        cltvLimit: FIBER_TO_LN.CLTV_LIMIT,
        timeoutSeconds: h.config.swaps.lnPayTimeoutSeconds,
      });
      expect(feeLimit(quote.sats, h.config.swaps.lnMaxFeeBps)).toBe(100n);
    });

    it("takes the fee limit and the payment timeout from config, not fixed values", async () => {
      const custom = makeSwapHarness({ swaps: { lnMaxFeeBps: 250, lnPayTimeoutSeconds: 90 } });
      const pay = jest.spyOn(custom.hubLn, "payInvoice");
      const { swap } = await startSwap(custom, "fiber_to_ln");
      await payHoldInvoice(custom, swap);
      await processPasses(custom, swap.id, 2);
      expect(pay.mock.calls[0]?.[0]).toMatchObject({ maxFeeSats: 250n, timeoutSeconds: 90 });
    });

    it("settles a RUSD hold invoice too", async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln", { asset: "RUSD", quote: { fiberAmount: 8_000_000_000n } });
      await payHoldInvoice(h, swap);
      expect((await processToRest(h, swap.id)).state).toBe("succeeded");
      expect(await holdState(sha256Hex(preimage))).toBe("Paid");
    });
  });

  describe("saves every transition before acting on it", () => {
    it("outgoing_in_flight with cltv_limit is saved before the Lightning payout is sent", async () => {
      const { swap } = await startSwap(h, "fiber_to_ln");
      const seen = swapsSeenAtCall(h.hubLn, "payInvoice", h, swap.id);
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);
      expect(seen[0]).toMatchObject({ state: "outgoing_in_flight", payoutLockLimit: FIBER_TO_LN.CLTV_LIMIT });
    });

    it("the preimage is saved before the Fiber hold invoice is settled", async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln");
      const seen = swapsSeenAtCall(h.hubFiber, "settleInvoice", h, swap.id);
      await payHoldInvoice(h, swap);
      await processToRest(h, swap.id);
      expect(seen[0]).toMatchObject({ state: "outgoing_succeeded", preimage });
    });
  });

  describe("the payout lock follows the live hold", () => {
    it("shrinks with time: an hour after the TLC was held, cltv_limit = floor((2271 - 60 - 171) / 15) = 136", async () => {
      const pay = jest.spyOn(h.hubLn, "payInvoice");
      const { swap } = await startSwap(h, "fiber_to_ln", { quote: LONG_QUOTE(h) });
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 1);
      h.clock.advance(minutes(60));
      const inFlight = await processPasses(h, swap.id, 1);

      expect(cltvLimitAfter(minutes(60))).toBe(136);
      expect(pay.mock.calls[0]?.[0].cltvLimit).toBe(136);
      expect(inFlight.payoutLockLimit).toBe(136);
    });

    it("uses the earliest of several held TLCs and their total amount", async () => {
      const pay = jest.spyOn(h.hubLn, "payInvoice");
      const { swap } = await startSwap(h, "fiber_to_ln");
      await payHoldInvoice(h, swap);
      const heldAt = h.clock.now();
      jest.spyOn(h.hubFiber, "heldTlcs").mockImplementation(async (paymentHash) => [
        { paymentHash, amount: swap.fiberAmount - 1_000n, expiresAt: heldAt + FIBER_TO_LN.HELD_TLC_LIFETIME_MS, channelId: "0x01", channelOpenedByPeer: false },
        { paymentHash, amount: 1_000n, expiresAt: heldAt + minutes(1_000), channelId: "0x02", channelOpenedByPeer: false },
      ]);
      await processPasses(h, swap.id, 2);

      // floor((1000 - 171) / 15) = 55.
      expect(pay.mock.calls[0]?.[0].cltvLimit).toBe(55);
    });

    it(`accepts a TLC still held ${FIBER_TO_LN.MAX_MINUTES_BEFORE_PAYOUT} minutes later (cltv_limit 44 = 40 + 3 + 1)`, async () => {
      const { swap } = await startSwap(h, "fiber_to_ln", { quote: LONG_QUOTE(h) });
      await payHoldInvoice(h, swap);
      h.clock.advance(minutes(FIBER_TO_LN.MAX_MINUTES_BEFORE_PAYOUT));
      expect(cltvLimitAfter(minutes(FIBER_TO_LN.MAX_MINUTES_BEFORE_PAYOUT))).toBe(44);
      expect((await processPasses(h, swap.id, 1)).state).toBe("incoming_accepted");
    });

    it(`refunds a TLC found ${FIBER_TO_LN.MAX_MINUTES_BEFORE_PAYOUT + 1} minutes later: too little time to pay out on Lightning`, async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln", { quote: LONG_QUOTE(h) });
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);
      h.clock.advance(minutes(FIBER_TO_LN.MAX_MINUTES_BEFORE_PAYOUT + 1));
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true, preimage: null });
      expectPlainSentence(after.failureReason);
      expect(await holdState(hash)).toBe("Cancelled");
      expect((await h.userFiber.getPayment(hash))?.state).toBe("Failed");
      expect(callCount(h.hubLn, "payInvoice")).toBe(0);
    });

    it("refunds instead of paying when time ran out between acceptance and the payout", async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln", { quote: LONG_QUOTE(h) });
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 1);
      h.clock.advance(minutes(FIBER_TO_LN.MAX_MINUTES_BEFORE_PAYOUT + 1));
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true });
      expect(await holdState(sha256Hex(preimage))).toBe("Cancelled");
      expect(callCount(h.hubLn, "payInvoice")).toBe(0);
    });

    it("does not trust a Received invoice whose TLC already timed out: no payout, the swap fails and is refunded", async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln", { quote: LONG_QUOTE(h) });
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap, { tlcExpiryLimitMs: FIBER_TO_LN.HOLD_DELTA_MS });
      h.clock.advance(FIBER_TO_LN.HOLD_DELTA_MS - minutes(160));
      h.fiberNet.tick();
      expect(await holdState(hash)).toBe("Received");
      expect(await h.hubFiber.heldTlcs(hash, null)).toHaveLength(0);

      const after = await processToRest(h, swap.id);
      expect(after).toMatchObject({ state: "failed", refunded: true });
      expect(callCount(h.hubLn, "payInvoice")).toBe(0);
    });

    it("refunds a hold whose TLCs pay less than the quoted amount", async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln");
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);
      const heldTlcs = h.hubFiber.heldTlcs.bind(h.hubFiber);
      jest.spyOn(h.hubFiber, "heldTlcs").mockImplementation(async (paymentHash, udtTypeScript) =>
        (await heldTlcs(paymentHash, udtTypeScript)).map((tlc) => ({ ...tlc, amount: swap.fiberAmount - 1n })),
      );
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true });
      expect(h.fiberNet.invoices.get(hash)?.state).toBe("Cancelled");
      expect(callCount(h.hubLn, "payInvoice")).toBe(0);
    });
  });

  describe("quote expiry and the incoming leg", () => {
    it("refunds a payment that is found only after the quote expired", async () => {
      const { swap, quote, preimage } = await startSwap(h, "fiber_to_ln");
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);
      h.clock.set(quote.expiresAt + 1);
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true });
      expect(await holdState(hash)).toBe("Cancelled");
      expect((await h.userFiber.getPayment(hash))?.state).toBe("Failed");
      expect(callCount(h.hubLn, "payInvoice")).toBe(0);
    });

    it("fails an unpaid swap once the quote expired; the hold invoice can no longer be paid", async () => {
      const { swap, quote } = await startSwap(h, "fiber_to_ln");
      h.clock.set(quote.expiresAt + minutes(1));
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true });
      expectPlainSentence(after.failureReason);
      expect(eventTypes(h, swap.id)).toContain(SWAP_EVENT.EXPIRED);
      expect((await payHoldInvoice(h, swap)).state).toBe("Failed");
    });

    it("a hold invoice cancelled outside the hub fails the swap as already refunded, with no payout", async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln");
      await h.hubFiber.cancelInvoice(sha256Hex(preimage));
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true });
      expect(callCount(h.hubLn, "payInvoice")).toBe(0);
    });

    it("an unpaid hold invoice the node releases within the tolerance before the quote expires counts as expired", async () => {
      // The node expires the hold invoice in whole seconds by its own clock: a little before the hub's clock gets there.
      const logs = silenceLogs();
      const { swap, quote, preimage } = await startSwap(h, "fiber_to_ln");
      h.clock.set(quote.expiresAt - h.config.swaps.holdInvoiceExpiryToleranceMs);
      await h.hubFiber.cancelInvoice(sha256Hex(preimage));
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true, failureReason: SWAP_REASON.quoteExpiredUnpaid });
      expect(eventTypes(h, swap.id)).toEqual([SWAP_EVENT.CREATED, SWAP_EVENT.EXPIRED]);
      expect(logs.warn).not.toHaveBeenCalled();
    });

    it("an unpaid hold invoice released earlier than the tolerance is a cancellation behind the hub's back (warned)", async () => {
      const logs = silenceLogs();
      const { swap, quote, preimage } = await startSwap(h, "fiber_to_ln");
      h.clock.set(quote.expiresAt - h.config.swaps.holdInvoiceExpiryToleranceMs - 1);
      await h.hubFiber.cancelInvoice(sha256Hex(preimage));
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true, failureReason: SWAP_REASON.holdInvoiceCancelled });
      expect(eventTypes(h, swap.id)).toEqual([SWAP_EVENT.CREATED, SWAP_EVENT.FAILED]);
      expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining("cancelled without the hub asking"));
    });
  });

  describe("the payout's outcome", () => {
    it("a failed Lightning payout cancels the Fiber hold invoice (refund) and fails the swap", async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln");
      const hash = sha256Hex(preimage);
      h.lnNet.setPayoutBehavior(hash, "fail");
      await payHoldInvoice(h, swap);
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true, preimage: null });
      expectPlainSentence(after.failureReason);
      expect(await holdState(hash)).toBe("Cancelled");
      expect((await h.userFiber.getPayment(hash))?.state).toBe("Failed");
      expect(eventTypes(h, swap.id)).toEqual(expect.arrayContaining([SWAP_EVENT.PAYOUT_FAILED, SWAP_EVENT.CANCELLED]));
    });

    it("a payout still in flight is never cancelled, even after the quote expired, and then succeeds", async () => {
      const { swap, quote, preimage } = await startSwap(h, "fiber_to_ln");
      const hash = sha256Hex(preimage);
      h.lnNet.setPayoutBehavior(hash, "hang");
      await payHoldInvoice(h, swap);
      expect((await processPasses(h, swap.id, 2)).state).toBe("outgoing_in_flight");

      h.clock.set(quote.expiresAt + minutes(30));
      const waiting = await processPasses(h, swap.id, 5);
      expect(waiting.state).toBe("outgoing_in_flight");
      expect(callCount(h.hubFiber, "cancelInvoice")).toBe(0);
      expect(await holdState(hash)).toBe("Received");

      h.lnNet.resolveHanging(hash, "succeed");
      const done = await processToRest(h, swap.id);
      expect(done).toMatchObject({ state: "succeeded", preimage });
      expect(await holdState(hash)).toBe("Paid");
      expect(callCount(h.hubFiber, "cancelInvoice")).toBe(0);
    });

    it("a payout in flight that finally fails is refunded", async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln");
      const hash = sha256Hex(preimage);
      h.lnNet.setPayoutBehavior(hash, "hang");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 4);
      h.lnNet.resolveHanging(hash, "fail");
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true });
      expect(await holdState(hash)).toBe("Cancelled");
    });

    it("does not trust a payout success whose preimage does not match", async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln");
      const hash = sha256Hex(preimage);
      h.lnNet.setPayoutBehavior(hash, "hang");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);
      jest.spyOn(h.hubLn, "getPayment").mockResolvedValue({ paymentHash: hash, state: "SUCCEEDED", preimage: newPreimage(), feeMsat: 0n, failureReason: null });

      const after = await processPasses(h, swap.id, 3);
      expect(after).toMatchObject({ state: "outgoing_in_flight", preimage: null });
      expect(callCount(h.hubFiber, "settleInvoice")).toBe(0);
      expect(callCount(h.hubFiber, "cancelInvoice")).toBe(0);
      expect(eventTypes(h, swap.id)).toContain(SWAP_EVENT.ALERT);
    });
  });

  describe("recovery from failed calls", () => {
    it("sends the Lightning payout on the next pass when it never reached LND", async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln");
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 1);
      h.hubLn.failNext = "payInvoice";

      expect((await processPasses(h, swap.id, 1)).state).toBe("outgoing_in_flight");
      expect(await h.hubLn.getPayment(hash)).toBeNull();

      await processPasses(h, swap.id, 1);
      expect((await h.hubLn.getPayment(hash))?.state).toBe("SUCCEEDED");
      const done = await processPasses(h, swap.id, 2);
      expect(done).toMatchObject({ state: "succeeded", preimage });
      expect(eventTypes(h, swap.id)).toContain(SWAP_EVENT.PAYOUT_RETRIED);
      expect(callCount(h.hubFiber, "cancelInvoice")).toBe(0);
    });

    it("retries settling on Fiber until Paid; the swap never fails from outgoing_succeeded", async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln");
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 3);
      h.hubFiber.failNext = "settleInvoice";

      const retrying = await processPasses(h, swap.id, 1);
      expect(retrying.state).toBe("outgoing_succeeded");
      expect(eventTypes(h, swap.id)).toContain(SWAP_EVENT.ERROR);

      const done = await processPasses(h, swap.id, 1);
      expect(done.state).toBe("succeeded");
      expect(await holdState(hash)).toBe("Paid");
      expect(callCount(h.hubFiber, "cancelInvoice")).toBe(0);
    });

    it("waits without an alert while fnn is still removing the settled TLC (invoice Received, nothing held), then succeeds", async () => {
      // fnn v0.9.1 keeps the invoice Received for a moment after settle_invoice while the TLC is LocalRemoved.
      const { swap, preimage } = await startSwap(h, "fiber_to_ln");
      const hash = sha256Hex(preimage);
      h.fiberNet.settleInSteps = true;
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 3);

      const settling = await processPasses(h, swap.id, 2);
      expect(settling).toMatchObject({ state: "outgoing_succeeded", preimage });
      expect(await holdState(hash)).toBe("Received");
      expect(callCount(h.hubFiber, "settleInvoice")).toBe(1);
      expect(eventTypes(h, swap.id)).not.toContain(SWAP_EVENT.ALERT);

      h.fiberNet.completeRemovals();
      const done = await processPasses(h, swap.id, 1);
      expect(done).toMatchObject({ state: "succeeded", preimage, refunded: false });
      expect(await holdState(hash)).toBe("Paid");
      expect(eventTypes(h, swap.id)).toEqual([
        SWAP_EVENT.CREATED,
        SWAP_EVENT.INCOMING_ACCEPTED,
        SWAP_EVENT.PAYOUT_STARTED,
        SWAP_EVENT.PAYOUT_SUCCEEDED,
        SWAP_EVENT.SETTLED,
      ]);
    });

    it("keeps trying, never fails or cancels, and alerts when the payout succeeded but the Fiber TLC timed out", async () => {
      // plan section 3: "OutgoingSuccess that cannot settle is a loss in the making: alert loudly, retry until the hard deadline."
      const { swap, preimage } = await startSwap(h, "fiber_to_ln", { quote: LONG_QUOTE(h) });
      const hash = sha256Hex(preimage);
      h.lnNet.setPayoutBehavior(hash, "hang");
      await payHoldInvoice(h, swap, { tlcExpiryLimitMs: FIBER_TO_LN.HOLD_DELTA_MS });
      await processPasses(h, swap.id, 2);
      h.clock.advance(FIBER_TO_LN.HOLD_DELTA_MS - minutes(160));
      h.fiberNet.tick();
      h.lnNet.resolveHanging(hash, "succeed");

      expect((await processPasses(h, swap.id, 1))).toMatchObject({ state: "outgoing_succeeded", preimage });
      const after = await processPasses(h, swap.id, 4);
      expect(after.state).toBe("outgoing_succeeded");
      expect(callCount(h.hubFiber, "settleInvoice")).toBeGreaterThanOrEqual(1);
      expect(callCount(h.hubFiber, "cancelInvoice")).toBe(0);
      expect(requireSwap(h, swap.id).failureReason).toBeNull();
      expect(eventTypes(h, swap.id)).toContain(SWAP_EVENT.ALERT);
    });

    it("a refund whose cancel failed is retried on the next pass over open swaps", async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln");
      const hash = sha256Hex(preimage);
      h.lnNet.setPayoutBehavior(hash, "fail");
      await payHoldInvoice(h, swap);
      // Accepted; the next pass sends the payout, which fails at once, and refunds in the same pass.
      await processPasses(h, swap.id, 1);
      h.hubFiber.failNext = "cancelInvoice";

      expect(await processPasses(h, swap.id, 1)).toMatchObject({ state: "failed", refunded: false });
      expect(await holdState(hash)).toBe("Received");

      await h.engine.processOpenSwaps();
      expect(requireSwap(h, swap.id)).toMatchObject({ state: "failed", refunded: true });
      expect(await holdState(hash)).toBe("Cancelled");
    });
  });
});
