import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { FIBER_MIN_FINAL_EXPIRY_DELTA_MS } from "../../../src/common/constants/protocol.constants";
import { SWAP_EVENT } from "../../../src/common/constants/swap.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import {
  callCount,
  eventTypes,
  expectHubError,
  FIBER_TO_LN,
  hours,
  LN_TO_FIBER,
  makeSwapHarness,
  minutes,
  newPreimage,
  PAYOUT_INVOICE_EXPIRY_SECONDS,
  payHoldInvoice,
  processPasses,
  processToRest,
  silenceLogs,
  startSwap,
  userLnInvoice,
  type SwapHarness,
} from "./swaps.fixtures";

/**
 * The engine against the attacks of the security review: a payout session that reads Failed while a part is still
 * out (or that carries the preimage), MPP payout invoices, a lagging LND, a held Fiber TLC on a channel whose opener
 * chose the commitment delay, and payout invoices that would lock the hub's funds for days.
 */
describe("swap engine: security rules", () => {
  let h: SwapHarness;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness();
  });

  afterEach(() => jest.restoreAllMocks());

  const lnHoldState = async (hash: string) => (await h.hubLn.lookupInvoice(hash))?.state;
  const fiberHoldState = async (hash: string) => (await h.hubFiber.getInvoice(hash))?.state;

  describe("ln_to_fiber: a Fiber payout that reads Failed while a part of it is still out", () => {
    /** A swap whose payout the hub sent and that then read Failed while the payee still holds a part. */
    const strandedPayout = async () => {
      const started = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(started.preimage);
      h.fiberNet.setPayoutBehavior(hash, "hang");
      await payHoldInvoice(h, started.swap);
      expect((await processPasses(h, started.swap.id, 2)).state).toBe("outgoing_in_flight");
      h.hubFiber.failLeavingPartOut(hash);
      return { ...started, hash };
    };

    it("stays outgoing_in_flight and never cancels the held payment while the part is out", async () => {
      const { swap, hash } = await strandedPayout();
      expect((await h.hubFiber.getPayment(hash))?.state).toBe("Failed");

      const after = await processPasses(h, swap.id, 4);
      expect(after).toMatchObject({ state: "outgoing_in_flight", refunded: false });
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
      expect(await lnHoldState(hash)).toBe("ACCEPTED");
    });

    it("collects the held payment when the payee then settles the part, though the session still reads Failed", async () => {
      const { swap, hash, preimage } = await strandedPayout();
      await processPasses(h, swap.id, 2);
      h.hubFiber.resolveStrandedPart(hash, "settle");
      expect(await h.hubFiber.getPayment(hash)).toMatchObject({ state: "Failed", preimage });

      const done = await processToRest(h, swap.id);
      expect(done).toMatchObject({ state: "succeeded", preimage, refunded: false });
      expect(await lnHoldState(hash)).toBe("SETTLED");
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
    });

    it("refunds once the part has failed too and nothing is out any more", async () => {
      const { swap, hash } = await strandedPayout();
      await processPasses(h, swap.id, 2);
      h.hubFiber.resolveStrandedPart(hash, "fail");

      const done = await processToRest(h, swap.id);
      expect(done).toMatchObject({ state: "failed", refunded: true });
      expect(await lnHoldState(hash)).toBe("CANCELED");
    });
  });

  describe("a preimage that matches the hash is a successful payout, whatever state the node reports", () => {
    it("ln_to_fiber: a Failed session carrying the preimage is collected, never refunded", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      h.fiberNet.setPayoutBehavior(hash, "hang");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);
      jest.spyOn(h.hubFiber, "getPayment").mockResolvedValue({ paymentHash: hash, state: "Failed", preimage, fee: 0n, failedError: "a part failed" });
      jest.spyOn(h.hubFiber, "hasOfferedTlcs").mockResolvedValue(false);

      const done = await processToRest(h, swap.id);
      expect(done).toMatchObject({ state: "succeeded", preimage, refunded: false });
      expect(await lnHoldState(hash)).toBe("SETTLED");
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
    });

    it("fiber_to_ln: a FAILED Lightning payment carrying the preimage is collected, never refunded", async () => {
      const { swap, preimage } = await startSwap(h, "fiber_to_ln");
      const hash = sha256Hex(preimage);
      h.lnNet.setPayoutBehavior(hash, "hang");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);
      jest.spyOn(h.hubLn, "getPayment").mockResolvedValue({ paymentHash: hash, state: "FAILED", preimage, feeMsat: 0n, failureReason: "FAILURE_REASON_TIMEOUT" });

      const done = await processToRest(h, swap.id);
      expect(done).toMatchObject({ state: "succeeded", preimage, refunded: false });
      expect(await fiberHoldState(hash)).toBe("Paid");
      expect(callCount(h.hubFiber, "cancelInvoice")).toBe(0);
    });

    it("a Failed session whose preimage does not match the hash is still a failed payout", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      const hash = sha256Hex(preimage);
      h.fiberNet.setPayoutBehavior(hash, "hang");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);
      jest.spyOn(h.hubFiber, "getPayment").mockResolvedValue({ paymentHash: hash, state: "Failed", preimage: newPreimage(), fee: 0n, failedError: "x" });
      jest.spyOn(h.hubFiber, "hasOfferedTlcs").mockResolvedValue(false);

      const done = await processToRest(h, swap.id);
      expect(done).toMatchObject({ state: "failed", refunded: true, preimage: null });
    });
  });

  describe("ln_to_fiber: the hub pays out in a single part", () => {
    it("refuses (422 invoice_invalid) a Fiber payout invoice that allows MPP, before any hold invoice exists", async () => {
      const mppInvoice = (preimage: string, quote: { fiberAmount: bigint }) =>
        h.userFiber.createInvoiceWithOptions(preimage, {
          amount: quote.fiberAmount,
          expirySeconds: PAYOUT_INVOICE_EXPIRY_SECONDS,
          finalExpiryDeltaMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
          allowMpp: true,
        });
      const error = await expectHubError(() => startSwap(h, "ln_to_fiber", { payoutInvoice: mppInvoice }), 422, API_ERROR_CODE.INVOICE_INVALID);
      expect(error.message).toMatch(/multi-part/);
      expect(callCount(h.hubLn, "createHoldInvoice")).toBe(0);
    });
  });

  describe("ln_to_fiber: LND's block height sizes the Fiber lock only once LND is synced", () => {
    it("keeps a held payment pending while LND lags the chain, without paying out or refunding, then goes on", async () => {
      const { swap, preimage } = await startSwap(h, "ln_to_fiber");
      await payHoldInvoice(h, swap);
      h.hubLn.synced = false;

      const waiting = await processPasses(h, swap.id, 3);
      expect(waiting.state).toBe("pending");
      expect(callCount(h.hubFiber, "payInvoice")).toBe(0);
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
      expect(eventTypes(h, swap.id)).toContain(SWAP_EVENT.ERROR);

      h.hubLn.synced = true;
      expect(await processToRest(h, swap.id)).toMatchObject({ state: "succeeded", preimage });
    });

    it("does not start the payout from incoming_accepted while LND lags the chain", async () => {
      const { swap } = await startSwap(h, "ln_to_fiber");
      await payHoldInvoice(h, swap);
      expect((await processPasses(h, swap.id, 1)).state).toBe("incoming_accepted");
      h.hubLn.synced = false;

      const waiting = await processPasses(h, swap.id, 3);
      expect(waiting).toMatchObject({ state: "incoming_accepted", refunded: false });
      expect(callCount(h.hubFiber, "payInvoice")).toBe(0);
      expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
    });
  });

  describe("fiber_to_ln: the Lightning payout fits before fnn fails the held TLC on its own channel", () => {
    it("refunds, without paying out, a payment over a channel the payer opened (it chose the commitment delay)", async () => {
      h.userFiber.opensPaymentChannel = { commitmentDelayEpochs: 2 };
      const { swap, preimage } = await startSwap(h, "fiber_to_ln");
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);

      const done = await processToRest(h, swap.id);
      expect(done).toMatchObject({ state: "failed", refunded: true });
      expect(callCount(h.hubLn, "payInvoice")).toBe(0);
      expect(await fiberHoldState(hash)).toBe("Cancelled");
      expect((await h.userFiber.getPayment(hash))?.state).toBe("Failed");
    });

    it("pays out over such a channel when the operator vouches for its delay, with a cltv_limit cut by its longer early fail", async () => {
      h = makeSwapHarness({ swaps: { fiberPeerChannelCommitmentDelayEpochs: 2 } });
      h.userFiber.opensPaymentChannel = { commitmentDelayEpochs: 2 };
      const pay = jest.spyOn(h.hubLn, "payInvoice");
      const { swap } = await startSwap(h, "fiber_to_ln");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);

      // fnn fails the TLC 2 x 4 h x 2/3 + 1 min = 321 min before expiry: floor((2271 - 321 - 10) / 15) = 129, not 140.
      expect(pay.mock.calls[0]?.[0].cltvLimit).toBe(129);
      expect(FIBER_TO_LN.CLTV_LIMIT).toBe(140);
    });

    it("a channel the hub opened keeps the default margin (cltv_limit 140)", async () => {
      const pay = jest.spyOn(h.hubLn, "payInvoice");
      const { swap } = await startSwap(h, "fiber_to_ln");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);
      expect(pay.mock.calls[0]?.[0].cltvLimit).toBe(FIBER_TO_LN.CLTV_LIMIT);
    });
  });

  describe("the payout lock cap (MAX_PAYOUT_LOCK_MINUTES)", () => {
    it("fiber_to_ln: refuses (422) a Lightning invoice whose CLTV would let the payee hold the payout past the cap", async () => {
      // regtest: 48 h / 15 min = 192 blocks; CLTV 109 + 3 padding + 1 + 80 route budget = 193.
      const longCltv = (preimage: string, quote: Parameters<typeof userLnInvoice>[2]) => userLnInvoice(h, preimage, quote, { cltvExpiry: 109 });
      await expectHubError(() => startSwap(h, "fiber_to_ln", { payoutInvoice: longCltv }), 422, API_ERROR_CODE.INVOICE_INVALID);
      expect(callCount(h.hubFiber, "createHoldInvoice")).toBe(0);
    });

    it("ln_to_fiber: refuses (422) a Fiber invoice whose payout lock would exceed the cap", async () => {
      h = makeSwapHarness({ timing: { maxPayoutLockMs: hours(6) } });
      // 160 min final delta + 4 h hop + 10 min margin = 410 min > 360 min.
      await expectHubError(() => startSwap(h, "ln_to_fiber"), 422, API_ERROR_CODE.INVOICE_INVALID);
      expect(callCount(h.hubLn, "createHoldInvoice")).toBe(0);
    });

    it("ln_to_fiber: caps tlc_expiry_limit at the cap when paying out, even for a swap planned under a looser one", async () => {
      const pay = jest.spyOn(h.hubFiber, "payInvoice");
      const { swap } = await startSwap(h, "ln_to_fiber");
      expect(swap.payoutLockLimit).toBe(LN_TO_FIBER.PAYOUT_LIMIT_MS);
      h.config.timing.maxPayoutLockMs = minutes(405);
      await payHoldInvoice(h, swap);

      const inFlight = await processPasses(h, swap.id, 2);
      expect(inFlight).toMatchObject({ state: "outgoing_in_flight", payoutLockLimit: minutes(405) });
      expect(pay.mock.calls[0]?.[0].tlcExpiryLimitMs).toBe(minutes(405));
    });

    it("fiber_to_ln: caps cltv_limit at the cap in slow blocks when paying out", async () => {
      const pay = jest.spyOn(h.hubLn, "payInvoice");
      const { swap } = await startSwap(h, "fiber_to_ln");
      h.config.timing.maxPayoutLockMs = hours(12);
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);

      // 12 h / 15 min = 48 blocks, instead of the 140 the held TLC would allow.
      expect(pay.mock.calls[0]?.[0].cltvLimit).toBe(48);
    });
  });
});
