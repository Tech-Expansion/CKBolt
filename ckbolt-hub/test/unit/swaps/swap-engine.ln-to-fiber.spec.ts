import { SWAP_EVENT } from "../../../src/common/constants/swap.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import {
  callCount,
  eventTypes,
  expectPlainSentence,
  LN_TO_FIBER,
  makeSwapHarness,
  minutes,
  newPreimage,
  payHoldInvoice,
  processPasses,
  processToRest,
  requireSwap,
  RUSD_SCRIPT,
  silenceLogs,
  START_HEIGHT,
  startSwap,
  swapsSeenAtCall,
  userFiberInvoice,
  type SwapHarness,
} from "./swaps.fixtures";

/**
 * processSwap for ln_to_fiber (docs/phase-3-plan.md section 3, direction A): the user's HTLC is held by the hub's LND,
 * the hub pays the user's Fiber invoice with a capped tlc_expiry_limit, learns the preimage from the payout and only
 * then settles the Lightning hold invoice. One step per pass; transitions are saved before the engine acts on them.
 */

/** ceil(amount x bps / 10,000), worked by hand for the specs' amounts. */
const feeLimit = (amount: bigint, bps: number): bigint => (amount * BigInt(bps) + 9_999n) / 10_000n;

/** The Fiber payout lock left n blocks after the HTLC was held: (847 - 18 - 6 - n) x 30 s, capped at the plan. */
const lockAfterBlocks = (blocks: number): number =>
  Math.min(LN_TO_FIBER.PAYOUT_LIMIT_MS, (LN_TO_FIBER.HOLD_CLTV - LN_TO_FIBER.RESERVED_BLOCKS - blocks) * LN_TO_FIBER.FAST_BLOCK_MS);

describe("swap engine: processSwap, ln_to_fiber", () => {
  let h: SwapHarness;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness();
  });

  afterEach(() => jest.restoreAllMocks());

  /** The hub's Lightning hold invoice state for this hash. */
  const holdState = async (hash: string) => (await h.hubLn.lookupInvoice(hash))?.state;

  describe("the normal path", () => {
    it("waits in pending while the hold invoice is unpaid and the quote is open, writing nothing", async () => {
      const { swap } = await startSwap(h, "ln_to_fiber");
      const after = await processPasses(h, swap.id, 3);

      expect(after.state).toBe("pending");
      expect(eventTypes(h, swap.id)).toEqual([SWAP_EVENT.CREATED]);
      for (const write of ["settleInvoice", "cancelInvoice", "payInvoice"]) {
        expect(callCount(h.hubLn, write)).toBe(0);
        expect(callCount(h.hubFiber, write)).toBe(0);
      }
    });

    it("moves one state per pass to succeeded: accept, pay out, save the preimage, settle", async () => {
      const { swap, quote, preimage, payoutInvoice } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);
      expect(await holdState(hash)).toBe("ACCEPTED");

      expect((await processPasses(h, swap.id, 1)).state).toBe("incoming_accepted");
      expect(callCount(h.hubFiber, "payInvoice")).toBe(0);

      const inFlight = await processPasses(h, swap.id, 1);
      expect(inFlight.state).toBe("outgoing_in_flight");
      expect(inFlight.payoutLockLimit).toBe(LN_TO_FIBER.PAYOUT_LIMIT_MS);
      expect(callCount(h.hubFiber, "payInvoice")).toBe(1);

      const paidOut = await processPasses(h, swap.id, 1);
      expect(paidOut.state).toBe("outgoing_succeeded");
      expect(paidOut.preimage).toBe(preimage);
      expect(await holdState(hash)).toBe("ACCEPTED");

      const done = await processPasses(h, swap.id, 1);
      expect(done).toMatchObject({ state: "succeeded", preimage, refunded: false, failureReason: null });
      expect(await holdState(hash)).toBe("SETTLED");
      expect((await h.userLn.getPayment(hash))?.state).toBe("SUCCEEDED");
      expect(h.fiberNet.invoices.get(hash)?.state).toBe("Paid");
      expect(payoutInvoice).toBe(swap.payoutInvoice);
      expect(quote.id).toBe(done.quoteId);
    });

    it("records one event per transition, in order, each a plain sentence stamped with the hub clock", async () => {
      const { swap } = await startSwap(h, "ln_to_fiber");
      await payHoldInvoice(h, swap);
      for (let pass = 0; pass < 4; pass += 1) {
        h.clock.advance(1_000);
        await h.engine.processSwap(swap.id);
      }

      const events = h.engine.listEvents(swap.id);
      expect(events.map((e) => e.type)).toEqual([
        SWAP_EVENT.CREATED,
        SWAP_EVENT.INCOMING_ACCEPTED,
        SWAP_EVENT.PAYOUT_STARTED,
        SWAP_EVENT.PAYOUT_SUCCEEDED,
        SWAP_EVENT.SETTLED,
      ]);
      events.forEach((event) => {
        expect(event.swapId).toBe(swap.id);
        expectPlainSentence(event.detail);
      });
      const times = events.map((e) => e.at);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(times.at(-1)).toBe(h.clock.now());
    });

    it("is idempotent once succeeded: further passes change nothing and call no node writes", async () => {
      const { swap } = await startSwap(h, "ln_to_fiber");
      await payHoldInvoice(h, swap);
      const done = await processToRest(h, swap.id);
      expect(done.state).toBe("succeeded");
      const writes = () => ["settleInvoice", "cancelInvoice", "payInvoice"].map((m) => callCount(h.hubLn, m) + callCount(h.hubFiber, m));
      const before = writes();
      const eventsBefore = eventTypes(h, swap.id);

      const again = await processPasses(h, swap.id, 3);
      expect(again).toEqual(done);
      expect(writes()).toEqual(before);
      expect(eventTypes(h, swap.id)).toEqual(eventsBefore);
    });

    it("pays the user's Fiber invoice with the fee limit from config and the planned tlc_expiry_limit", async () => {
      const pay = jest.spyOn(h.hubFiber, "payInvoice");
      const { swap, quote, payoutInvoice } = await startSwap(h, "ln_to_fiber");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);

      expect(pay).toHaveBeenCalledTimes(1);
      expect(pay).toHaveBeenCalledWith({
        invoice: payoutInvoice,
        maxFeeAmount: feeLimit(quote.fiberAmount, h.config.swaps.fiberMaxFeeBps),
        tlcExpiryLimitMs: LN_TO_FIBER.PAYOUT_LIMIT_MS,
      });
      expect(feeLimit(quote.fiberAmount, h.config.swaps.fiberMaxFeeBps)).toBe(1_980_000_000n);
    });

    it("takes the fee limit from config.swaps.fiberMaxFeeBps, not a fixed rate", async () => {
      const custom = makeSwapHarness({ swaps: { fiberMaxFeeBps: 200 } });
      const pay = jest.spyOn(custom.hubFiber, "payInvoice");
      const { swap } = await startSwap(custom, "ln_to_fiber");
      await payHoldInvoice(custom, swap);
      await processPasses(custom, swap.id, 2);
      expect(pay.mock.calls[0]?.[0].maxFeeAmount).toBe(7_920_000_000n);
    });

    it("pays out RUSD to an invoice with the RUSD type script", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber", {
        asset: "RUSD",
        quote: { fiberAmount: 8_000_000_000n },
        payoutInvoice: (p, q) => userFiberInvoice(h, p, q, { udt: RUSD_SCRIPT }),
      });
      await payHoldInvoice(h, swap);
      expect((await processToRest(h, swap.id)).state).toBe("succeeded");
      expect(h.fiberNet.invoices.get(sha256Hex(preimage))?.state).toBe("Paid");
    });
  });

  describe("saves every transition before acting on it", () => {
    it("outgoing_in_flight with the payout lock is saved before the payout is sent", async () => {
      const { swap } = await startSwap(h, "ln_to_fiber");
      const seen = swapsSeenAtCall(h.hubFiber, "payInvoice", h, swap.id);
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ state: "outgoing_in_flight", payoutLockLimit: LN_TO_FIBER.PAYOUT_LIMIT_MS });
    });

    it("the preimage and outgoing_succeeded are saved before the hold invoice is settled", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      const seen = swapsSeenAtCall(h.hubLn, "settleInvoice", h, swap.id);
      await payHoldInvoice(h, swap);
      await processToRest(h, swap.id);

      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0]).toMatchObject({ state: "outgoing_succeeded", preimage });
      expect(h.hubLn.calls.filter((c) => c === "settleInvoice")).toHaveLength(seen.length);
    });

    it("failed is saved before the hold invoice is cancelled", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      h.fiberNet.setPayoutBehavior(sha256Hex(preimage), "fail");
      const seen = swapsSeenAtCall(h.hubLn, "cancelInvoice", h, swap.id);
      await payHoldInvoice(h, swap);
      await processToRest(h, swap.id);

      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0]?.state).toBe("failed");
    });
  });

  describe("the payout lock follows the live hold", () => {
    it("is re-computed just before paying: 10 blocks after acceptance it shrinks to (847 - 24 - 10) x 30 s", async () => {
      const pay = jest.spyOn(h.hubFiber, "payInvoice");
      const { swap } = await startSwap(h, "ln_to_fiber");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 1);
      h.lnNet.mineBlocks(10);
      const inFlight = await processPasses(h, swap.id, 1);

      expect(lockAfterBlocks(10)).toBe(24_390_000);
      expect(pay.mock.calls[0]?.[0].tlcExpiryLimitMs).toBe(24_390_000);
      expect(inFlight.payoutLockLimit).toBe(24_390_000);
    });

    it("uses the earliest of several held HTLCs", async () => {
      const pay = jest.spyOn(h.hubFiber, "payInvoice");
      const { swap } = await startSwap(h, "ln_to_fiber");
      await payHoldInvoice(h, swap);
      const lookup = h.hubLn.lookupInvoice.bind(h.hubLn);
      const earlier = START_HEIGHT + 830;
      jest.spyOn(h.hubLn, "lookupInvoice").mockImplementation(async (hash) => {
        const status = await lookup(hash);
        return status && status.state === "ACCEPTED" ? { ...status, htlcExpiryHeights: [START_HEIGHT + LN_TO_FIBER.HOLD_CLTV, earlier] } : status;
      });
      await processPasses(h, swap.id, 2);

      // (830 - 18 - 6) x 30 s = 806 x 30 s.
      expect(pay.mock.calls[0]?.[0].tlcExpiryLimitMs).toBe(806 * LN_TO_FIBER.FAST_BLOCK_MS);
    });

    it(`accepts a payment still held ${LN_TO_FIBER.MAX_BLOCKS_BEFORE_PAYOUT} blocks later`, async () => {
      const { swap } = await startSwap(h, "ln_to_fiber");
      await payHoldInvoice(h, swap);
      h.lnNet.mineBlocks(LN_TO_FIBER.MAX_BLOCKS_BEFORE_PAYOUT);
      expect((await processPasses(h, swap.id, 1)).state).toBe("incoming_accepted");
    });

    it(`refunds a payment found ${LN_TO_FIBER.MAX_BLOCKS_BEFORE_PAYOUT + 1} blocks later: too little time left to pay out`, async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);
      h.lnNet.mineBlocks(LN_TO_FIBER.MAX_BLOCKS_BEFORE_PAYOUT + 1);
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true, preimage: null });
      expectPlainSentence(after.failureReason);
      expect(await holdState(hash)).toBe("CANCELED");
      expect((await h.userLn.getPayment(hash))?.state).toBe("FAILED");
      expect(callCount(h.hubFiber, "payInvoice")).toBe(0);
      expect(eventTypes(h, swap.id)).toContain(SWAP_EVENT.CANCELLED);
    });

    it("refunds instead of paying when time ran out between acceptance and the payout", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 1);
      h.lnNet.mineBlocks(LN_TO_FIBER.MAX_BLOCKS_BEFORE_PAYOUT + 1);
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true });
      expect(await holdState(sha256Hex(preimage))).toBe("CANCELED");
      expect(callCount(h.hubFiber, "payInvoice")).toBe(0);
    });

    it("never pays out when LND auto-cancelled the held HTLC before the payout started", async () => {
      const { swap } = await startSwap(h, "ln_to_fiber");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 1);
      h.lnNet.mineBlocks(LN_TO_FIBER.HOLD_CLTV - 18);
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true });
      expect(callCount(h.hubFiber, "payInvoice")).toBe(0);
    });
  });

  describe("quote expiry and the incoming leg", () => {
    it("refunds a payment that is found only after the quote expired", async () => {
      const { swap, quote, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);
      h.clock.set(quote.expiresAt + 1);
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true });
      expectPlainSentence(after.failureReason);
      expect(await holdState(hash)).toBe("CANCELED");
      expect((await h.userLn.getPayment(hash))?.state).toBe("FAILED");
      expect(callCount(h.hubFiber, "payInvoice")).toBe(0);
    });

    it("fails an unpaid swap once the quote expired; the hold invoice can no longer be paid", async () => {
      const { swap, quote } = await startSwap(h, "ln_to_fiber");
      h.clock.set(quote.expiresAt + minutes(1));
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true });
      expectPlainSentence(after.failureReason);
      expect(eventTypes(h, swap.id)).toContain(SWAP_EVENT.EXPIRED);
      expect((await payHoldInvoice(h, swap)).state).toBe("FAILED");
      expect(h.store.listOpenSwaps()).toHaveLength(0);
    });

    it("cancels a hold invoice the node still shows open after the quote expired", async () => {
      const { swap, quote, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      h.clock.set(quote.expiresAt + 1);
      // A node whose invoice outlives the quote: it reads OPEN until the hub cancels it.
      let cancelled = false;
      const cancel = h.hubLn.cancelInvoice.bind(h.hubLn);
      jest.spyOn(h.hubLn, "cancelInvoice").mockImplementation(async (paymentHash) => {
        cancelled = true;
        await cancel(paymentHash);
      });
      jest.spyOn(h.hubLn, "lookupInvoice").mockImplementation(async (paymentHash) => ({
        paymentHash,
        state: cancelled ? "CANCELED" : "OPEN",
        amountMsat: swap.sats * 1_000n,
        amountPaidMsat: 0n,
        htlcExpiryHeights: [],
      }));

      const after = await processToRest(h, swap.id);
      expect(after).toMatchObject({ state: "failed", refunded: true });
      expect(callCount(h.hubLn, "cancelInvoice")).toBeGreaterThanOrEqual(1);
      expect(h.lnNet.invoices.get(hash)?.state).toBe("CANCELED");
    });

    it("a hold invoice cancelled outside the hub fails the swap as already refunded, with no payout", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      await h.hubLn.cancelInvoice(sha256Hex(preimage));
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true });
      expectPlainSentence(after.failureReason);
      expect(callCount(h.hubFiber, "payInvoice")).toBe(0);
    });

    it("refunds a hold that pays less than the quoted sats", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);
      const lookup = h.hubLn.lookupInvoice.bind(h.hubLn);
      jest.spyOn(h.hubLn, "lookupInvoice").mockImplementation(async (paymentHash) => {
        const status = await lookup(paymentHash);
        return status && status.state === "ACCEPTED" ? { ...status, amountPaidMsat: (swap.sats - 1n) * 1_000n } : status;
      });
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true });
      expect(h.lnNet.invoices.get(hash)?.state).toBe("CANCELED");
      expect(callCount(h.hubFiber, "payInvoice")).toBe(0);
    });

    it("never pays out when the node says the hold invoice is settled although the hub never settled it", async () => {
      const { swap } = await startSwap(h, "ln_to_fiber");
      await payHoldInvoice(h, swap);
      const lookup = h.hubLn.lookupInvoice.bind(h.hubLn);
      jest.spyOn(h.hubLn, "lookupInvoice").mockImplementation(async (paymentHash) => {
        const status = await lookup(paymentHash);
        return status ? { ...status, state: "SETTLED", htlcExpiryHeights: [] } : status;
      });
      const after = await processPasses(h, swap.id, 3);

      expect(after.state).not.toBe("outgoing_in_flight");
      expect(callCount(h.hubFiber, "payInvoice")).toBe(0);
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
      expect(eventTypes(h, swap.id)).toContain(SWAP_EVENT.ALERT);
    });
  });

  describe("the payout's outcome", () => {
    it("a failed payout cancels the hold invoice (refund) and fails the swap", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      h.fiberNet.setPayoutBehavior(hash, "fail");
      await payHoldInvoice(h, swap);
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true, preimage: null });
      expectPlainSentence(after.failureReason);
      expect(await holdState(hash)).toBe("CANCELED");
      expect((await h.userLn.getPayment(hash))?.state).toBe("FAILED");
      expect(eventTypes(h, swap.id)).toEqual(expect.arrayContaining([SWAP_EVENT.PAYOUT_FAILED, SWAP_EVENT.CANCELLED]));
      expect(h.store.listOpenSwaps()).toHaveLength(0);
    });

    it("a payout still in flight is never cancelled, even long after the quote expired, and then succeeds", async () => {
      const { swap, quote, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      h.fiberNet.setPayoutBehavior(hash, "hang");
      await payHoldInvoice(h, swap);
      expect((await processPasses(h, swap.id, 2)).state).toBe("outgoing_in_flight");

      h.clock.set(quote.expiresAt + minutes(60));
      h.lnNet.mineBlocks(5);
      const waiting = await processPasses(h, swap.id, 5);
      expect(waiting.state).toBe("outgoing_in_flight");
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
      expect(await holdState(hash)).toBe("ACCEPTED");

      h.fiberNet.resolveHanging(hash, "succeed");
      const done = await processToRest(h, swap.id);
      expect(done).toMatchObject({ state: "succeeded", preimage, refunded: false });
      expect(await holdState(hash)).toBe("SETTLED");
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
    });

    it("a payout in flight that finally fails is refunded", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      h.fiberNet.setPayoutBehavior(hash, "hang");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 4);
      h.fiberNet.resolveHanging(hash, "fail");
      const after = await processToRest(h, swap.id);

      expect(after).toMatchObject({ state: "failed", refunded: true });
      expect(await holdState(hash)).toBe("CANCELED");
    });

    it("does not trust a payout success whose preimage does not hash to the payment hash", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      h.fiberNet.setPayoutBehavior(hash, "hang");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);
      jest.spyOn(h.hubFiber, "getPayment").mockResolvedValue({ paymentHash: hash, state: "Success", preimage: newPreimage(), fee: 0n, failedError: null });

      const after = await processPasses(h, swap.id, 3);
      expect(after).toMatchObject({ state: "outgoing_in_flight", preimage: null });
      expect(callCount(h.hubLn, "settleInvoice")).toBe(0);
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
      expect(eventTypes(h, swap.id)).toContain(SWAP_EVENT.ALERT);
    });

    it("does not trust a payout success that carries no preimage", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      h.fiberNet.setPayoutBehavior(hash, "hang");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);
      jest.spyOn(h.hubFiber, "getPayment").mockResolvedValue({ paymentHash: hash, state: "Success", preimage: null, fee: 0n, failedError: null });

      const after = await processPasses(h, swap.id, 3);
      expect(after.state).toBe("outgoing_in_flight");
      expect(callCount(h.hubLn, "settleInvoice")).toBe(0);
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
    });
  });

  describe("recovery from failed calls", () => {
    it("sends the payout on the next pass when it never reached the node (crash right after saving outgoing_in_flight)", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 1);
      h.hubFiber.failNext = "payInvoice";

      const lost = await processPasses(h, swap.id, 1);
      expect(lost.state).toBe("outgoing_in_flight");
      expect(await h.hubFiber.getPayment(hash)).toBeNull();
      const errorEvent = h.store.listEvents(swap.id).find((e) => e.type === SWAP_EVENT.ERROR);
      expectPlainSentence(errorEvent?.detail);
      expect(errorEvent?.detail).not.toContain("simulated transport error");

      // Resend (state unchanged), then read the success, then settle.
      const resent = await processPasses(h, swap.id, 1);
      expect(resent.state).toBe("outgoing_in_flight");
      expect((await h.hubFiber.getPayment(hash))?.state).toBe("Success");
      const done = await processPasses(h, swap.id, 2);
      expect(done).toMatchObject({ state: "succeeded", preimage });
      expect(eventTypes(h, swap.id)).toContain(SWAP_EVENT.PAYOUT_RETRIED);
      expect(h.fiberNet.invoices.get(hash)?.state).toBe("Paid");
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
    });

    it("retries settling until the node reports it settled; the swap never fails from outgoing_succeeded", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 3);
      const settle = jest.spyOn(h.hubLn, "settleInvoice");
      settle.mockRejectedValueOnce(new Error("lnd: connection reset")).mockRejectedValueOnce(new Error("lnd: connection reset")).mockRejectedValueOnce(new Error("lnd: deadline exceeded"));

      for (let pass = 0; pass < 3; pass += 1) {
        h.clock.advance(minutes(10));
        expect((await processPasses(h, swap.id, 1)).state).toBe("outgoing_succeeded");
      }
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
      expect(h.store.listEvents(swap.id).some((e) => e.type === SWAP_EVENT.ERROR && !e.detail.includes("lnd:"))).toBe(true);

      const done = await processPasses(h, swap.id, 1);
      expect(done.state).toBe("succeeded");
      expect(await holdState(hash)).toBe("SETTLED");
    });

    it("alerts and never cancels when the held HTLC is gone after the payout succeeded", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 3);
      expect(requireSwap(h, swap.id).state).toBe("outgoing_succeeded");
      h.lnNet.mineBlocks(LN_TO_FIBER.HOLD_CLTV);
      expect(await holdState(hash)).toBe("CANCELED");

      const after = await processPasses(h, swap.id, 3);
      expect(after).toMatchObject({ state: "outgoing_succeeded", preimage });
      expect(eventTypes(h, swap.id)).toContain(SWAP_EVENT.ALERT);
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
    });

    it("a refund whose cancel failed stays open and is retried until the hold invoice is cancelled", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      h.fiberNet.setPayoutBehavior(hash, "fail");
      await payHoldInvoice(h, swap);
      // Accepted; the next pass sends the payout, which fails at once, and refunds in the same pass.
      await processPasses(h, swap.id, 1);
      h.hubLn.failNext = "cancelInvoice";

      const failed = await processPasses(h, swap.id, 1);
      expect(failed).toMatchObject({ state: "failed", refunded: false });
      expect(h.store.listOpenSwaps().map((s) => s.id)).toEqual([swap.id]);
      expect(await holdState(hash)).toBe("ACCEPTED");

      await h.engine.processOpenSwaps();
      expect(requireSwap(h, swap.id)).toMatchObject({ state: "failed", refunded: true });
      expect(await holdState(hash)).toBe("CANCELED");
      expect(h.store.listOpenSwaps()).toHaveLength(0);
    });
  });
});
