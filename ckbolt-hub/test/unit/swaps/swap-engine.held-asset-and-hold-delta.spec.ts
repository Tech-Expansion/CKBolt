import { sha256Hex } from "../../../src/common/utils/hex.util";
import {
  callCount,
  LN_TO_FIBER,
  makeSwapHarness,
  payHoldInvoice,
  processPasses,
  processToRest,
  RUSD_SCRIPT,
  silenceLogs,
  startSwap,
  udtOf,
  type SwapHarness,
} from "./swaps.fixtures";

/**
 * Security review, wave 2 (low findings): the engine counts a held Fiber payment only in the swap's own asset, and
 * plans the Lightning hold around the hub LND's configured invoices.holdexpirydelta instead of LND's default 18.
 */
describe("swap engine: held Fiber TLCs count only in the swap's asset", () => {
  let h: SwapHarness;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness();
  });

  afterEach(() => jest.restoreAllMocks());

  it("reads what is held in the swap's asset (RUSD), not in every channel", async () => {
    const heldTlcs = jest.spyOn(h.hubFiber, "heldTlcs");
    const { swap } = await startSwap(h, "fiber_to_ln", { asset: "RUSD" });
    await payHoldInvoice(h, swap);
    await processPasses(h, swap.id, 1);

    expect(heldTlcs).toHaveBeenCalledWith(swap.paymentHash, RUSD_SCRIPT);
    expect(heldTlcs.mock.calls.every(([, udt]) => udt === udtOf(h, "RUSD"))).toBe(true);
  });

  it("refunds, without paying out, an RUSD hold whose only TLC arrived on a CKB channel (fnn has not rejected it yet)", async () => {
    const { swap, preimage } = await startSwap(h, "fiber_to_ln", { asset: "RUSD" });
    const hash = sha256Hex(preimage);
    h.userFiber.paysOverChannelOf = null;
    await payHoldInvoice(h, swap);
    expect((await h.hubFiber.getInvoice(hash))?.state).toBe("Received");

    const done = await processToRest(h, swap.id);
    expect(done).toMatchObject({ state: "failed", refunded: true, preimage: null });
    expect(callCount(h.hubLn, "payInvoice")).toBe(0);
    expect((await h.hubFiber.getInvoice(hash))?.state).toBe("Cancelled");
  });

  it("pays out an RUSD hold whose TLC arrived on an RUSD channel", async () => {
    const { swap, preimage } = await startSwap(h, "fiber_to_ln", { asset: "RUSD" });
    await payHoldInvoice(h, swap);
    expect(await processToRest(h, swap.id)).toMatchObject({ state: "succeeded", preimage });
  });
});

describe("swap engine: LND's hold-invoice auto-cancel delta comes from config (LND_HOLD_EXPIRY_DELTA_BLOCKS)", () => {
  const DELTA = 40;
  let h: SwapHarness;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness({ timing: { lndHoldExpiryDeltaBlocks: DELTA } });
    h.lnNet.holdExpiryDeltaBlocks = DELTA;
  });

  afterEach(() => jest.restoreAllMocks());

  it("asks the payer for 22 more blocks of CLTV than with LND's default 18 (869 instead of 847)", async () => {
    const createHold = jest.spyOn(h.hubLn, "createHoldInvoice");
    const { swap } = await startSwap(h, "ln_to_fiber");

    // ceil(410 min / 30 s) + 40 + 6 margin + 3 padding = 869.
    expect(swap.holdCltvExpiry).toBe(LN_TO_FIBER.HOLD_CLTV + DELTA - 18);
    expect(createHold.mock.calls[0]?.[0].cltvExpiry).toBe(869);
  });

  it("settles before an LND set to 40 blocks cancels, even when the payee holds the payout for its whole lock", async () => {
    const { swap, preimage } = await startSwap(h, "ln_to_fiber");
    const hash = sha256Hex(preimage);
    h.fiberNet.setPayoutBehavior(hash, "hang");
    await payHoldInvoice(h, swap);
    const inFlight = await processPasses(h, swap.id, 2);
    expect(inFlight.state).toBe("outgoing_in_flight");

    // Worst case: blocks come at the fast interval while the payee holds the Fiber payout to the end of its lock.
    h.lnNet.mineBlocks(Math.ceil((inFlight.payoutLockLimit ?? 0) / LN_TO_FIBER.FAST_BLOCK_MS));
    expect((await h.hubLn.lookupInvoice(hash))?.state).toBe("ACCEPTED");

    h.fiberNet.resolveHanging(hash, "succeed");
    expect(await processToRest(h, swap.id)).toMatchObject({ state: "succeeded", preimage });
    expect((await h.hubLn.lookupInvoice(hash))?.state).toBe("SETTLED");
  });
});
