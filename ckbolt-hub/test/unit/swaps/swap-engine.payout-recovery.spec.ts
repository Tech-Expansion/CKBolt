import { SWAP_EVENT } from "../../../src/common/constants/swap.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import { SWAP_REASON } from "../../../src/domain/swap";
import type { Direction } from "../../../src/domain/types";
import {
  callCount,
  eventTypes,
  FIBER_TO_LN,
  hours,
  LN_TO_FIBER,
  makeSwapHarness,
  minutes,
  payHoldInvoice,
  processPasses,
  processToRest,
  seconds,
  silenceLogs,
  startSwap,
  SWAP_SETTINGS,
  type SwapHarness,
} from "./swaps.fixtures";

/**
 * Payouts the paying node refuses, and payouts it has no record of (security review, wave 2). A refusal sends nothing,
 * so the hub refunds at once instead of sending again every pass until the hold runs out. A payout the node has no
 * record of is sent again at most PAYOUT_MAX_RESENDS times, and refunded only once it has stayed unknown for
 * PAYOUT_MISSING_CONFIRM_SECONDS after its last send: a send whose answer was lost may still be starting inside the
 * node, and refunding then would let the payout go out after the held payment went back.
 */
describe("swap engine: refused and missing payouts", () => {
  let h: SwapHarness;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness();
  });

  afterEach(() => jest.restoreAllMocks());

  const DIRECTIONS: Direction[] = ["ln_to_fiber", "fiber_to_ln"];

  /** The hub's node that pays out, and the network whose payout behaviour a test sets, by direction. */
  const payoutSide = (direction: Direction) =>
    direction === "ln_to_fiber"
      ? { payer: h.hubFiber, incoming: h.hubLn, behaviours: h.fiberNet }
      : { payer: h.hubLn, incoming: h.hubFiber, behaviours: h.lnNet };

  const incomingState = async (direction: Direction, hash: string) =>
    direction === "ln_to_fiber" ? (await h.hubLn.lookupInvoice(hash))?.state : (await h.hubFiber.getInvoice(hash))?.state;

  const RELEASED = { ln_to_fiber: "CANCELED", fiber_to_ln: "Cancelled" } as const;
  const HELD = { ln_to_fiber: "ACCEPTED", fiber_to_ln: "Received" } as const;

  const countOf = (id: string, type: string) => eventTypes(h, id).filter((event) => event === type).length;

  /** A swap whose payment is held and accepted: the next pass sends the payout. */
  async function acceptedSwap(direction: Direction) {
    const started = await startSwap(h, direction);
    await payHoldInvoice(h, started.swap);
    expect((await processPasses(h, started.swap.id, 1)).state).toBe("incoming_accepted");
    return { ...started, hash: sha256Hex(started.preimage) };
  }

  describe.each(DIRECTIONS)("%s: a payout the paying node refuses to send", (direction) => {
    it("is refunded in the pass that sent it, and never sent again", async () => {
      const started = await startSwap(h, direction);
      const hash = sha256Hex(started.preimage);
      const side = payoutSide(direction);
      side.behaviours.setPayoutBehavior(hash, "refuse");
      await payHoldInvoice(h, started.swap);

      const after = await processPasses(h, started.swap.id, 2);
      expect(after).toMatchObject({ state: "failed", refunded: true, preimage: null, failureReason: SWAP_REASON.payoutFailed });
      expect(await incomingState(direction, hash)).toBe(RELEASED[direction]);
      expect(await side.payer.getPayment(hash)).toBeNull();

      await h.engine.processOpenSwaps();
      expect(callCount(side.payer, "payInvoice")).toBe(1);
      expect(eventTypes(h, started.swap.id)).toEqual([
        SWAP_EVENT.CREATED,
        SWAP_EVENT.INCOMING_ACCEPTED,
        SWAP_EVENT.PAYOUT_STARTED,
        SWAP_EVENT.PAYOUT_FAILED,
        SWAP_EVENT.CANCELLED,
      ]);
    });
  });

  describe("a Failed send is a failure only when nothing of the payout is out and no preimage proves it paid", () => {
    it("ln_to_fiber: stays outgoing_in_flight when the send reads Failed while a part of the payout is still out", async () => {
      const { swap, hash } = await acceptedSwap("ln_to_fiber");
      jest.spyOn(h.hubFiber, "payInvoice").mockResolvedValue({ paymentHash: hash, state: "Failed", preimage: null, fee: 0n, failedError: "a part failed" });
      jest.spyOn(h.hubFiber, "hasOfferedTlcs").mockResolvedValue(true);

      expect(await processPasses(h, swap.id, 1)).toMatchObject({ state: "outgoing_in_flight", refunded: false });
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
      expect(await incomingState("ln_to_fiber", hash)).toBe("ACCEPTED");
    });

    it("ln_to_fiber: a Failed send that carries the matching preimage is collected, never refunded", async () => {
      const { swap, hash, preimage } = await acceptedSwap("ln_to_fiber");
      const paid = { paymentHash: hash, state: "Failed" as const, preimage, fee: 0n, failedError: "a part failed" };
      jest.spyOn(h.hubFiber, "payInvoice").mockResolvedValue(paid);
      jest.spyOn(h.hubFiber, "getPayment").mockResolvedValue(paid);
      jest.spyOn(h.hubFiber, "hasOfferedTlcs").mockResolvedValue(false);

      expect(await processToRest(h, swap.id)).toMatchObject({ state: "succeeded", preimage, refunded: false });
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
    });
  });

  describe("fiber_to_ln: the cltv_limit the hub pays with is one LND takes", () => {
    it(`pays at the smallest limit LND takes (CLTV ${FIBER_TO_LN.PAYOUT_CLTV_EXPIRY} + 3 padding + 1) and completes`, async () => {
      const longQuote = { expiresAt: h.clock.now() + hours(48) };
      const { swap, preimage } = await startSwap(h, "fiber_to_ln", { quote: longQuote });
      const pay = jest.spyOn(h.hubLn, "payInvoice");
      await payHoldInvoice(h, swap);
      h.clock.advance(minutes(FIBER_TO_LN.MAX_MINUTES_BEFORE_PAYOUT));

      expect(await processToRest(h, swap.id)).toMatchObject({ state: "succeeded", preimage });
      expect(pay.mock.calls[0]?.[0].cltvLimit).toBe(FIBER_TO_LN.PAYOUT_CLTV_EXPIRY + 3 + 1);
    });
  });

  describe.each(DIRECTIONS)("%s: a payout the paying node keeps having no record of", (direction) => {
    it("is sent again at most PAYOUT_MAX_RESENDS times, each resend recorded once before it is sent", async () => {
      const { swap } = await acceptedSwap(direction);
      const pay = jest.spyOn(payoutSide(direction).payer, "payInvoice").mockRejectedValue(new Error("send: answer lost"));

      const after = await processPasses(h, swap.id, 12);
      expect(after).toMatchObject({ state: "outgoing_in_flight", refunded: false });
      expect(pay).toHaveBeenCalledTimes(1 + SWAP_SETTINGS.payoutMaxResends);
      expect(countOf(swap.id, SWAP_EVENT.PAYOUT_RETRIED)).toBe(SWAP_SETTINGS.payoutMaxResends);
      expect(callCount(payoutSide(direction).incoming, "cancelInvoice")).toBe(0);
    });

    it("is refunded only once it has had no record for PAYOUT_MISSING_CONFIRM_SECONDS since its last send", async () => {
      const { swap, hash } = await acceptedSwap(direction);
      jest.spyOn(payoutSide(direction).payer, "payInvoice").mockRejectedValue(new Error("send: answer lost"));
      await processPasses(h, swap.id, 1 + SWAP_SETTINGS.payoutMaxResends);

      h.clock.advance(SWAP_SETTINGS.payoutMissingConfirmMs - 1);
      expect(await processPasses(h, swap.id, 2)).toMatchObject({ state: "outgoing_in_flight", refunded: false });
      expect(await incomingState(direction, hash)).toBe(HELD[direction]);

      h.clock.advance(1);
      const refunded = await processPasses(h, swap.id, 1);
      expect(refunded).toMatchObject({ state: "failed", refunded: true, failureReason: SWAP_REASON.payoutNotSent });
      expect(await incomingState(direction, hash)).toBe(RELEASED[direction]);
    });
  });

  describe("ln_to_fiber: the hold runs out while the paying node has no record of the payout", () => {
    /** The first send's answer is lost; then blocks pass until the payout no longer fits before LND's auto-cancel. */
    async function lostSendThenWindowClosed() {
      const accepted = await acceptedSwap("ln_to_fiber");
      const pay = jest.spyOn(h.hubFiber, "payInvoice").mockRejectedValueOnce(new Error("send_payment: timeout"));
      expect((await processPasses(h, accepted.swap.id, 1)).state).toBe("outgoing_in_flight");
      expect(await h.hubFiber.getPayment(accepted.hash)).toBeNull();
      h.lnNet.mineBlocks(LN_TO_FIBER.MAX_BLOCKS_BEFORE_PAYOUT + 1);
      return { ...accepted, pay };
    }

    it("does not cancel the held payment on a 'not found' read while the lost send may still be starting", async () => {
      const { swap, hash } = await lostSendThenWindowClosed();

      const after = await processPasses(h, swap.id, 3);
      expect(after).toMatchObject({ state: "outgoing_in_flight", refunded: false });
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
      expect(await incomingState("ln_to_fiber", hash)).toBe("ACCEPTED");
    });

    it("collects the held payment when the lost send turns out to have gone through after all", async () => {
      const { swap, preimage, pay } = await lostSendThenWindowClosed();
      await processPasses(h, swap.id, 2);

      // The node starts the send it was given before the hub's call timed out.
      pay.mockRestore();
      await h.hubFiber.payInvoice({ invoice: swap.payoutInvoice, maxFeeAmount: 0n, tlcExpiryLimitMs: LN_TO_FIBER.PAYOUT_LIMIT_MS });

      expect(await processToRest(h, swap.id)).toMatchObject({ state: "succeeded", preimage, refunded: false });
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
    });

    it("refunds once the payout has had no record for the confirm window since the lost send", async () => {
      const { swap, hash } = await lostSendThenWindowClosed();
      await processPasses(h, swap.id, 1);

      h.clock.advance(seconds(30));
      const refunded = await processPasses(h, swap.id, 1);
      expect(refunded).toMatchObject({ state: "failed", refunded: true, preimage: null });
      expect(refunded.failureReason).toContain("400 minutes");
      expect(await incomingState("ln_to_fiber", hash)).toBe("CANCELED");
    });
  });

  it("ln_to_fiber: after the last resend, a hold LND has released fails the swap without a cancel call", async () => {
    const { swap, hash } = await acceptedSwap("ln_to_fiber");
    jest.spyOn(h.hubFiber, "payInvoice").mockRejectedValue(new Error("send: answer lost"));
    await processPasses(h, swap.id, 1 + SWAP_SETTINGS.payoutMaxResends);
    h.lnNet.mineBlocks(LN_TO_FIBER.HOLD_CLTV);
    expect(await incomingState("ln_to_fiber", hash)).toBe("CANCELED");

    const failed = await processPasses(h, swap.id, 1);
    expect(failed).toMatchObject({ state: "failed", refunded: true, failureReason: SWAP_REASON.incomingReleased });
    expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
  });

  it("a restarted hub still counts the resends made before the restart", async () => {
    const { swap } = await acceptedSwap("ln_to_fiber");
    const lost = () => jest.spyOn(h.hubFiber, "payInvoice").mockRejectedValue(new Error("send: answer lost"));
    let pay = lost();
    await processPasses(h, swap.id, 3);
    expect(pay).toHaveBeenCalledTimes(3);

    h.restart();
    pay.mockRestore();
    pay = lost();
    await processPasses(h, swap.id, 5);
    // One first send and two resends before the restart: one resend is left.
    expect(pay).toHaveBeenCalledTimes(1);
    expect(countOf(swap.id, SWAP_EVENT.PAYOUT_RETRIED)).toBe(SWAP_SETTINGS.payoutMaxResends);
  });
});
