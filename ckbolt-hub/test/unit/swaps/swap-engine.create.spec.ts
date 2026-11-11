import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { FIBER_MIN_FINAL_EXPIRY_DELTA_MS, MSAT_PER_SAT } from "../../../src/common/constants/protocol.constants";
import { SWAP_EVENT } from "../../../src/common/constants/swap.constants";
import { DuplicateHashError, HubError, QuoteAlreadyUsedError } from "../../../src/common/errors/hub.error";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import type { CreatedSwap } from "../../../src/application/swaps/swap-engine.contract";
import type { Direction, Swap } from "../../../src/domain/types";
import {
  callCount,
  craftFiberInvoice,
  craftLnInvoice,
  defaultPayoutInvoice,
  eventTypes,
  expectHubError,
  expectPlainSentence,
  FIBER_TO_LN,
  hours,
  LN_TO_FIBER,
  makeSwapHarness,
  minutes,
  newPreimage,
  QUOTE_AMOUNTS,
  QUOTE_TTL_MS,
  RUSD_SCRIPT,
  RUSD_SCRIPT_UPPER_CASE,
  saveQuote,
  seconds,
  silenceLogs,
  startSwap,
  udtOf,
  UNKNOWN_UDT_SCRIPT,
  userFiberInvoice,
  userLnInvoice,
  TEST_CLIENT_KEY,
  withoutCancelToken,
  type SwapHarness,
} from "./swaps.fixtures";

/**
 * SwapEngine.createSwap: the quote must exist, verify and be open; the payout invoice is checked for the direction;
 * the hold invoice is issued on the same payment hash with the planned timing; the swap is saved as pending with a
 * "created" event. Every rejection is a HubError with a plain sentence and the right code, and leaves nothing behind.
 */

const UNPROCESSABLE = HttpStatus.UNPROCESSABLE_ENTITY;

/** No hold invoice was issued on either hub node, and no swap was saved. */
function expectNothingCreated(h: SwapHarness): void {
  expect(callCount(h.hubLn, "createHoldInvoice")).toBe(0);
  expect(callCount(h.hubFiber, "createHoldInvoice")).toBe(0);
  expect(h.store.listOpenSwaps()).toHaveLength(0);
}

describe("swap engine: createSwap, ln_to_fiber (user pays BTC on Lightning, receives a Fiber asset)", () => {
  let h: SwapHarness;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness();
  });

  afterEach(() => jest.restoreAllMocks());

  it("issues a Lightning hold invoice on the payout invoice's hash for the quoted sats, expiring with the quote", async () => {
    const { swap, quote, preimage, payoutInvoice } = await startSwap(h, "ln_to_fiber");
    const hash = sha256Hex(preimage);

    const hold = await h.hubLn.decodeInvoice(swap.holdInvoice);
    expect(hold.paymentHash).toBe(hash);
    expect(hold.amountMsat).toBe(quote.sats * MSAT_PER_SAT);
    expect(hold.cltvExpiry).toBe(LN_TO_FIBER.HOLD_CLTV);
    expect(hold.network).toBe("regtest");
    expect(hold.expiresAt).toBe(quote.expiresAt);
    expect((await h.hubLn.lookupInvoice(hash))?.state).toBe("OPEN");

    expect(swap).toMatchObject({
      quoteId: quote.id,
      direction: "ln_to_fiber",
      asset: "CKB",
      paymentHash: hash,
      sats: quote.sats,
      fiberAmount: quote.fiberAmount,
      payoutInvoice,
      state: "pending",
      preimage: null,
      failureReason: null,
      refunded: false,
      holdCltvExpiry: LN_TO_FIBER.HOLD_CLTV,
      holdFinalExpiryDeltaMs: null,
      payoutLockLimit: LN_TO_FIBER.PAYOUT_LIMIT_MS,
      quoteExpiresAt: quote.expiresAt,
      demo: false,
      createdAt: h.clock.now(),
    });
  });

  it("saves the swap (readable through getSwap) and records a single created event", async () => {
    const { swap } = await startSwap(h, "ln_to_fiber", { demo: true });

    expect(h.engine.getSwap(swap.id)).toEqual(swap);
    expect(h.store.getSwapByHash(swap.paymentHash)?.id).toBe(swap.id);
    expect(swap.demo).toBe(true);
    expect(swap.id).toMatch(/^[0-9a-f-]{36}$/);

    const events = h.engine.listEvents(swap.id);
    expect(events.map((e) => e.type)).toEqual([SWAP_EVENT.CREATED]);
    expect(events[0]).toMatchObject({ swapId: swap.id, at: h.clock.now() });
    expectPlainSentence(events[0]?.detail);
  });

  it("gives every swap its own id", async () => {
    const first = await startSwap(h, "ln_to_fiber");
    const second = await startSwap(h, "ln_to_fiber");
    expect(first.swap.id).not.toBe(second.swap.id);
  });

  it("accepts a payout invoice that never expires", async () => {
    const { swap } = await startSwap(h, "ln_to_fiber", { payoutInvoice: (p, q) => userFiberInvoice(h, p, q, { expirySeconds: null }) });
    expect(swap.state).toBe("pending");
  });

  it("serves RUSD: the payout invoice must carry the RUSD type script (compared without regard to hex case)", async () => {
    const lower = await startSwap(h, "ln_to_fiber", { asset: "RUSD", payoutInvoice: (p, q) => userFiberInvoice(h, p, q, { udt: RUSD_SCRIPT }) });
    const upper = await startSwap(h, "ln_to_fiber", {
      asset: "RUSD",
      payoutInvoice: (p, q) => userFiberInvoice(h, p, q, { udt: RUSD_SCRIPT_UPPER_CASE }),
    });
    expect(lower.swap.asset).toBe("RUSD");
    expect(upper.swap.state).toBe("pending");
  });

  it("plans the hold invoice from the payout invoice's final expiry delta: 200 minutes still fits LDK's 1008 blocks", async () => {
    // F = 200 + 240 + 10 = 450 min; C = ceil(450 min / 30 s) + 27 = 900 + 27 = 927 blocks; 927 + LDK's 80 = 1007 <= 1008.
    const { swap } = await startSwap(h, "ln_to_fiber", { payoutInvoice: (p, q) => userFiberInvoice(h, p, q, { finalExpiryDeltaMs: minutes(200) }) });
    expect(swap.holdCltvExpiry).toBe(927);
    expect(swap.payoutLockLimit).toBe(minutes(450));
    expect((await h.hubLn.decodeInvoice(swap.holdInvoice)).cltvExpiry).toBe(927);
  });

  it("refuses a payout delta whose hold invoice leaves an LDK payer no room: 4 h needs 1007 + 80 blocks", async () => {
    // F = 240 + 240 + 10 = 490 min; C = 980 + 27 = 1007; with LDK's 80-block shadow-route reserve 1087 > 1008.
    await expect(
      startSwap(h, "ln_to_fiber", { payoutInvoice: (p, q) => userFiberInvoice(h, p, q, { finalExpiryDeltaMs: hours(4) }) }),
    ).rejects.toMatchObject({ code: "invoice_invalid", message: expect.stringContaining("1087") });
  });

  it("uses the profile from TIMING_PROFILE: a faster profile gives a different hold CLTV", async () => {
    const custom = makeSwapHarness({ timing: { btcFastBlockSeconds: 60 } });
    // C = ceil(410 min / 60 s) + 27 = 410 + 27 = 437 blocks.
    const { swap } = await startSwap(custom, "ln_to_fiber");
    expect(swap.holdCltvExpiry).toBe(437);
  });

  it("issues the hold invoice for whole seconds of quote validity left, never outliving the quote", async () => {
    const quote = saveQuote(h, "ln_to_fiber");
    h.clock.advance(seconds(89) + 500);
    const swap = await h.engine.createSwap({ quoteId: quote.id, payoutInvoice: userFiberInvoice(h, newPreimage(), quote), demo: false, clientKey: TEST_CLIENT_KEY });

    const hold = await h.hubLn.decodeInvoice(swap.holdInvoice);
    expect(hold.expiresAt).toBeLessThanOrEqual(quote.expiresAt);
    expect(hold.expiresAt).toBeGreaterThan(quote.expiresAt - seconds(1));
    expect((hold.expiresAt - h.clock.now()) % seconds(1)).toBe(0);
  });

  describe("rejects the payout invoice with 422 invoice_invalid", () => {
    const rejects = async (invoice: (preimage: string, q: ReturnType<typeof saveQuote>) => string, asset: "CKB" | "RUSD" = "CKB") => {
      const quote = saveQuote(h, "ln_to_fiber", { asset });
      const error = await expectHubError(
        () => h.engine.createSwap({ quoteId: quote.id, payoutInvoice: invoice(newPreimage(), quote), demo: false, clientKey: TEST_CLIENT_KEY }),
        UNPROCESSABLE,
        API_ERROR_CODE.INVOICE_INVALID,
      );
      expectNothingCreated(h);
      return error;
    };

    it("when it is for another CKB network", async () => {
      await rejects(() => craftFiberInvoice(h, { network: "testnet" }));
    });

    it("when it uses the ckb_hash hash algorithm (both legs must share one SHA-256 hash)", async () => {
      const error = await rejects((p, q) => userFiberInvoice(h, p, q, { hashAlgorithm: "ckb_hash" }));
      expect(error.message).toContain("sha256");
    });

    it("when a CKB quote meets a RUSD invoice", async () => {
      await rejects((p, q) => userFiberInvoice(h, p, q, { udt: RUSD_SCRIPT }));
    });

    it("when a RUSD quote meets a CKB invoice", async () => {
      await rejects((p, q) => userFiberInvoice(h, p, q, { udt: null }), "RUSD");
    });

    it("when a RUSD quote meets an invoice for a UDT the hub does not serve", async () => {
      await rejects((p, q) => userFiberInvoice(h, p, q, { udt: UNKNOWN_UDT_SCRIPT }), "RUSD");
    });

    it.each([
      ["one base unit more", 1n],
      ["one base unit less", -1n],
    ])("when it asks for %s than the quote pays out", async (_label, delta) => {
      await rejects((p, q) => userFiberInvoice(h, p, q, { amount: q.fiberAmount + delta }));
    });

    it("when it has no amount: the nodes pay only invoices that carry the quoted amount", async () => {
      const error = await rejects((p, q) => userFiberInvoice(h, p, q, { amount: null }));
      expect(error.message).toBe("This invoice has no amount. Make an invoice for exactly 3960 CKB, the amount the quote pays out.");
    });

    it("when it has already expired", async () => {
      await rejects(() => craftFiberInvoice(h, { expiresAt: h.clock.now() - 1 }));
    });

    it("when it expires before the quote does (the payout could not be paid in time)", async () => {
      await rejects(() => craftFiberInvoice(h, { expiresAt: h.clock.now() + QUOTE_TTL_MS - seconds(1) }));
    });

    it("when its final expiry delta is below Fiber's 160-minute minimum", async () => {
      await rejects(() => craftFiberInvoice(h, { finalExpiryDeltaMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS - minutes(1) }));
    });

    it("when it expires before the quote does: the message names the quote's expiry", async () => {
      const error = await rejects(() => craftFiberInvoice(h, { expiresAt: h.clock.now() + QUOTE_TTL_MS - seconds(1) }));
      expect(error.message).toContain("expires before the quote");
    });

    it("when its final expiry delta needs a hold CLTV above what payers accept (241 min -> 1009 blocks > 1008)", async () => {
      // F = 241 + 240 + 10 = 491 min; C = ceil(491 min / 30 s) + 27 = 982 + 27 = 1009 blocks.
      const error = await rejects((p, q) => userFiberInvoice(h, p, q, { finalExpiryDeltaMs: minutes(241) }));
      expect(error.message).toContain("1009");
    });

    it("when it carries no final expiry delta: fnn then uses 24 hours, too long for the 1008-block cap", async () => {
      // F = 1440 + 240 + 10 = 1690 min; C = 3380 + 27 = 3407 blocks.
      await rejects(() => craftFiberInvoice(h, { finalExpiryDeltaMs: null }));
    });

  });

  describe("rejects an unreadable payout invoice with 400 invoice_invalid (bad input, as the node adapters say)", () => {
    const rejectsUnreadable = async (invoice: string) => {
      const quote = saveQuote(h, "ln_to_fiber");
      await expectHubError(() => h.engine.createSwap({ quoteId: quote.id, payoutInvoice: invoice, demo: false, clientKey: TEST_CLIENT_KEY }), HttpStatus.BAD_REQUEST, API_ERROR_CODE.INVOICE_INVALID);
      expectNothingCreated(h);
    };

    it("when it is not a Fiber invoice at all", async () => {
      await rejectsUnreadable("not an invoice");
    });

    it("when it is a Lightning invoice", async () => {
      await rejectsUnreadable(craftLnInvoice(h));
    });

    it("when the node fails in an unexpected way while reading it, keeping that error as the cause", async () => {
      const quote = saveQuote(h, "ln_to_fiber");
      const nodeError = new Error("fnn parse_invoice failed (-32000): unexpected");
      jest.spyOn(h.hubFiber, "parseInvoice").mockRejectedValueOnce(nodeError);
      const error = await expectHubError(
        () => h.engine.createSwap({ quoteId: quote.id, payoutInvoice: userFiberInvoice(h, newPreimage(), quote), demo: false, clientKey: TEST_CLIENT_KEY }),
        HttpStatus.BAD_REQUEST,
        API_ERROR_CODE.INVOICE_INVALID,
      );
      expect(error.cause).toBe(nodeError);
      expect(error.message).not.toContain("-32000");
    });
  });

  it("an invoice without a final expiry delta is planned with fnn's 24-hour default when the profile allows it", async () => {
    const roomy = makeSwapHarness({ timing: { payerMaxCltv: 5_000 } });
    const quote = saveQuote(roomy, "ln_to_fiber");
    expect(quote.fiberAmount).toBe(QUOTE_AMOUNTS.ln_to_fiber.fiberAmount);
    const swap = await roomy.engine.createSwap({ quoteId: quote.id, payoutInvoice: craftFiberInvoice(roomy, { finalExpiryDeltaMs: null }), demo: false, clientKey: TEST_CLIENT_KEY });
    expect(swap.holdCltvExpiry).toBe(3_407);
    expect(swap.payoutLockLimit).toBe(minutes(1_690));
  });

  it("keeps a HubError raised by the Fiber adapter while reading the invoice (e.g. node unavailable, 503)", async () => {
    const quote = saveQuote(h, "ln_to_fiber");
    const adapterError = new HubError("The Fiber node is unavailable. Try again in a moment.", HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
    jest.spyOn(h.hubFiber, "parseInvoice").mockRejectedValueOnce(adapterError);

    await expect(h.engine.createSwap({ quoteId: quote.id, payoutInvoice: userFiberInvoice(h, newPreimage(), quote), demo: false, clientKey: TEST_CLIENT_KEY })).rejects.toBe(adapterError);
    expectNothingCreated(h);
  });
});

describe("swap engine: createSwap, fiber_to_ln (user pays a Fiber asset, receives BTC on Lightning)", () => {
  let h: SwapHarness;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness();
  });

  afterEach(() => jest.restoreAllMocks());

  it("issues a Fiber hold invoice (sha256) on the payout invoice's hash for the quoted amount, expiring with the quote", async () => {
    const { swap, quote, preimage, payoutInvoice } = await startSwap(h, "fiber_to_ln");
    const hash = sha256Hex(preimage);

    const hold = await h.hubFiber.parseInvoice(swap.holdInvoice);
    expect(hold.paymentHash).toBe(hash);
    expect(hold.amount).toBe(quote.fiberAmount);
    expect(hold.hashAlgorithm).toBe("sha256");
    expect(hold.udtTypeScript).toBeNull();
    expect(hold.network).toBe("devnet");
    expect(hold.finalExpiryDeltaMs).toBe(FIBER_TO_LN.HOLD_DELTA_MS);
    expect(hold.expiresAt).toBe(quote.expiresAt);
    expect((await h.hubFiber.getInvoice(hash))?.state).toBe("Open");

    expect(swap).toMatchObject({
      direction: "fiber_to_ln",
      paymentHash: hash,
      sats: quote.sats,
      fiberAmount: quote.fiberAmount,
      payoutInvoice,
      state: "pending",
      holdCltvExpiry: null,
      holdFinalExpiryDeltaMs: FIBER_TO_LN.HOLD_DELTA_MS,
      quoteExpiresAt: quote.expiresAt,
    });
    expect(eventTypes(h, swap.id)).toEqual([SWAP_EVENT.CREATED]);
  });

  it("a RUSD hold invoice carries the RUSD type script", async () => {
    const { swap } = await startSwap(h, "fiber_to_ln", { asset: "RUSD", quote: { fiberAmount: 8_000_000_000n } });
    const hold = await h.hubFiber.parseInvoice(swap.holdInvoice);
    expect(hold.udtTypeScript).toEqual(udtOf(h, "RUSD"));
    expect(hold.amount).toBe(8_000_000_000n);
  });

  it("uses the configured hold final expiry delta when it is longer than the payout needs", async () => {
    const custom = makeSwapHarness({ swaps: { fiberHoldFinalExpiryDeltaMs: hours(40) } });
    const { swap } = await startSwap(custom, "fiber_to_ln");
    expect(swap.holdFinalExpiryDeltaMs).toBe(hours(40));
    expect((await custom.hubFiber.parseInvoice(swap.holdInvoice)).finalExpiryDeltaMs).toBe(hours(40));
  });

  it("raises the hold delta for a payout invoice with a longer CLTV", async () => {
    // cltv 80: max(360, (80 + 3 + 1 + 80) x 15 + 171, 160) = max(360, 2631, 160) = 2631 minutes.
    const { swap } = await startSwap(h, "fiber_to_ln", { payoutInvoice: (p, q) => userLnInvoice(h, p, q, { cltvExpiry: 80 }) });
    expect(swap.holdFinalExpiryDeltaMs).toBe(minutes(2_631));
  });

  it("plans the Lightning route with the profile's route budget (LN_ROUTE_BUDGET_BLOCKS), not its settle margin", async () => {
    // (40 + 3 + 1 + 10) x 15 + 171 = 981 minutes.
    const custom = makeSwapHarness({ timing: { lnRouteBudgetBlocks: 10, lnMarginBlocks: 500 } });
    const { swap } = await startSwap(custom, "fiber_to_ln");
    expect(swap.holdFinalExpiryDeltaMs).toBe(minutes(981));
  });

  describe("rejects the payout invoice with 422 invoice_invalid", () => {
    const rejects = async (invoice: (preimage: string, q: ReturnType<typeof saveQuote>) => string) => {
      const quote = saveQuote(h, "fiber_to_ln");
      const error = await expectHubError(
        () => h.engine.createSwap({ quoteId: quote.id, payoutInvoice: invoice(newPreimage(), quote), demo: false, clientKey: TEST_CLIENT_KEY }),
        UNPROCESSABLE,
        API_ERROR_CODE.INVOICE_INVALID,
      );
      expectNothingCreated(h);
      return error;
    };

    it.each(["testnet", "signet", "mainnet"] as const)("when it is for %s while the hub runs on regtest", async (network) => {
      await rejects(() => craftLnInvoice(h, { network }));
    });

    it("when it has no amount: the nodes pay only invoices that carry the quoted amount", async () => {
      const error = await rejects((p, q) => userLnInvoice(h, p, q, { amountSats: null }));
      expect(error.message).toBe("This invoice has no amount. Make an invoice for exactly 10000 sats, the amount the quote pays out.");
    });

    it("when it asks for one millisatoshi more than the quoted sats", async () => {
      await rejects((_p, q) => craftLnInvoice(h, { amountMsat: q.sats * MSAT_PER_SAT + 1n }));
    });

    it("when it asks for one sat less than the quoted sats", async () => {
      await rejects((p, q) => userLnInvoice(h, p, q, { amountSats: q.sats - 1n }));
    });

    it("when it has already expired", async () => {
      await rejects(() => craftLnInvoice(h, { expiresAt: h.clock.now() - 1 }));
    });

    it("when it expires before the quote does", async () => {
      await rejects(() => craftLnInvoice(h, { expiresAt: h.clock.now() + QUOTE_TTL_MS - seconds(1) }));
    });

    it("when its CLTV is above what LND will pay (2013 + 3 + 1 > 2016 blocks)", async () => {
      await rejects(() => craftLnInvoice(h, { cltvExpiry: 2_013 }));
    });

    it("when its CLTV would need a Fiber hold longer than 14 days", async () => {
      // cltv 1400: (1400 + 3 + 1 + 80) x 15 min + 171 min = 22431 min > 20160 min.
      await rejects(() => craftLnInvoice(h, { cltvExpiry: 1_400 }));
    });

  });

  describe("rejects an unreadable payout invoice with 400 invoice_invalid", () => {
    const rejectsUnreadable = async (invoice: string) => {
      const quote = saveQuote(h, "fiber_to_ln");
      await expectHubError(() => h.engine.createSwap({ quoteId: quote.id, payoutInvoice: invoice, demo: false, clientKey: TEST_CLIENT_KEY }), HttpStatus.BAD_REQUEST, API_ERROR_CODE.INVOICE_INVALID);
      expectNothingCreated(h);
    };

    it("when it is a Fiber invoice", async () => {
      await rejectsUnreadable(craftFiberInvoice(h));
    });

    it("when it is not an invoice at all", async () => {
      await rejectsUnreadable("lnbcrt-garbage");
    });
  });
});

describe.each(["ln_to_fiber", "fiber_to_ln"] as const)("swap engine: createSwap, quote checks (%s)", (direction: Direction) => {
  let h: SwapHarness;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness();
  });

  afterEach(() => jest.restoreAllMocks());

  const payoutFor = (quote: ReturnType<typeof saveQuote>): string =>
    direction === "ln_to_fiber" ? userFiberInvoice(h, newPreimage(), quote) : userLnInvoice(h, newPreimage(), quote);

  it("404 not_found for an unknown quote", async () => {
    const quote = saveQuote(h, direction);
    await expectHubError(
      () => h.engine.createSwap({ quoteId: "00000000-0000-4000-8000-000000000000", payoutInvoice: payoutFor(quote), demo: false, clientKey: TEST_CLIENT_KEY }),
      HttpStatus.NOT_FOUND,
      API_ERROR_CODE.NOT_FOUND,
    );
    expectNothingCreated(h);
  });

  it("422 when the quote does not verify (changed after signing)", async () => {
    const quote = saveQuote(h, direction);
    h.store.saveQuote({ ...quote, sats: quote.sats + 1n });
    await expectHubError(
      () => h.engine.createSwap({ quoteId: quote.id, payoutInvoice: payoutFor(quote), demo: false, clientKey: TEST_CLIENT_KEY }),
      UNPROCESSABLE,
      API_ERROR_CODE.QUOTE_UNAVAILABLE,
    );
    expectNothingCreated(h);
  });

  it("asks the pricing service to verify the quote it read", async () => {
    const verify = jest.spyOn(h.pricing, "verifyQuote");
    const quote = saveQuote(h, direction);
    await h.engine.createSwap({ quoteId: quote.id, payoutInvoice: payoutFor(quote), demo: false, clientKey: TEST_CLIENT_KEY });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ id: quote.id }));
  });

  it.each([
    ["exactly at its expiry", 0],
    ["a minute after its expiry", minutes(1)],
  ])("422 quote_expired %s", async (_label, after) => {
    const quote = saveQuote(h, direction);
    const payoutInvoice = payoutFor(quote);
    h.clock.set(quote.expiresAt + after);
    await expectHubError(() => h.engine.createSwap({ quoteId: quote.id, payoutInvoice, demo: false, clientKey: TEST_CLIENT_KEY }), UNPROCESSABLE, API_ERROR_CODE.QUOTE_EXPIRED);
    expectNothingCreated(h);
  });

  it("accepts a quote with a few seconds left", async () => {
    const quote = saveQuote(h, direction);
    const payoutInvoice = payoutFor(quote);
    h.clock.set(quote.expiresAt - seconds(5));
    const swap = await h.engine.createSwap({ quoteId: quote.id, payoutInvoice, demo: false, clientKey: TEST_CLIENT_KEY });
    expect(swap.state).toBe("pending");
  });

  it("422 when the quote's asset is not served on this deployment", async () => {
    const quote = saveQuote(h, direction, { asset: "CWBTC" });
    const error = await expectHubError(
      () => h.engine.createSwap({ quoteId: quote.id, payoutInvoice: payoutFor({ ...quote, asset: "CKB" }), demo: false, clientKey: TEST_CLIENT_KEY }),
      UNPROCESSABLE,
      API_ERROR_CODE.ASSET_UNAVAILABLE,
    );
    expect(error.message).toContain("CWBTC");
    expectNothingCreated(h);
  });
});

describe("swap engine: createSwap, Bitcoin networks that share an invoice prefix", () => {
  beforeEach(() => silenceLogs());
  afterEach(() => jest.restoreAllMocks());

  it("a testnet4 hub pays out to an lntb invoice: testnet3 and testnet4 share the prefix", async () => {
    const h = makeSwapHarness({ btcNetwork: "testnet4" });
    const { swap } = await startSwap(h, "fiber_to_ln", { payoutInvoice: () => craftLnInvoice(h, { network: "testnet" }) });
    expect(swap.state).toBe("pending");
  });

  it("a testnet4 hub refuses a signet (lntbs, Mutinynet) invoice with 422 invoice_invalid naming both networks", async () => {
    const h = makeSwapHarness({ btcNetwork: "testnet4" });
    const quote = saveQuote(h, "fiber_to_ln");
    const error = await expectHubError(
      () => h.engine.createSwap({ quoteId: quote.id, payoutInvoice: craftLnInvoice(h, { network: "signet" }), demo: false, clientKey: TEST_CLIENT_KEY }),
      UNPROCESSABLE,
      API_ERROR_CODE.INVOICE_INVALID,
    );
    expect(error.message).toContain("signet");
    expect(error.message).toContain("testnet4");
    expectNothingCreated(h);
  });
});

describe.each(["ln_to_fiber", "fiber_to_ln"] as const)("swap engine: createSwap, one swap per quote (%s)", (direction: Direction) => {
  let h: SwapHarness;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness();
  });

  afterEach(() => jest.restoreAllMocks());

  it("409 conflict when the quote already has a swap, and no second hold invoice is issued", async () => {
    const first = await startSwap(h, direction);
    const holdCalls = callCount(h.hubLn, "createHoldInvoice") + callCount(h.hubFiber, "createHoldInvoice");

    const error = await expectHubError(
      () => h.engine.createSwap({ quoteId: first.quote.id, payoutInvoice: defaultPayoutInvoice(h, newPreimage(), first.quote), demo: false, clientKey: TEST_CLIENT_KEY }),
      HttpStatus.CONFLICT,
      API_ERROR_CODE.CONFLICT,
    );
    expect(error).toBeInstanceOf(QuoteAlreadyUsedError);
    expectPlainSentence(error.message);
    expect(callCount(h.hubLn, "createHoldInvoice") + callCount(h.hubFiber, "createHoldInvoice")).toBe(holdCalls);
    expect(h.store.listOpenSwaps()).toEqual([first.swap]);
  });

  it("two concurrent requests for one quote: one swap is created, the other gets 409 and its hold invoice is cancelled", async () => {
    const quote = saveQuote(h, direction);
    const preimages = [newPreimage(), newPreimage()];
    const results = await Promise.allSettled(
      preimages.map((preimage) => h.engine.createSwap({ quoteId: quote.id, payoutInvoice: defaultPayoutInvoice(h, preimage, quote), demo: false, clientKey: TEST_CLIENT_KEY })),
    );

    const created = results.filter((r): r is PromiseFulfilledResult<CreatedSwap> => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toBeInstanceOf(QuoteAlreadyUsedError);
    expect(h.store.listOpenSwaps()).toEqual([withoutCancelToken(created[0]?.value)]);

    const loserHash = preimages.map(sha256Hex).find((hash) => hash !== created[0]?.value.paymentHash);
    if (!loserHash) throw new Error("expected a refused hash");
    const loserHold = direction === "ln_to_fiber" ? (await h.hubLn.lookupInvoice(loserHash))?.state : (await h.hubFiber.getInvoice(loserHash))?.state;
    expect(loserHold).toBe(direction === "ln_to_fiber" ? "CANCELED" : "Cancelled");
  });
});

describe.each(["ln_to_fiber", "fiber_to_ln"] as const)("swap engine: createSwap, one hash per swap (%s)", (direction: Direction) => {
  let h: SwapHarness;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness();
  });

  afterEach(() => jest.restoreAllMocks());

  it("409 duplicate_hash when another swap already uses the hash, and no second hold invoice is issued", async () => {
    const first = await startSwap(h, direction);
    const quote = saveQuote(h, direction);
    const holdCalls = callCount(h.hubLn, "createHoldInvoice") + callCount(h.hubFiber, "createHoldInvoice");

    const error = await expectHubError(
      () => h.engine.createSwap({ quoteId: quote.id, payoutInvoice: first.payoutInvoice, demo: false, clientKey: TEST_CLIENT_KEY }),
      HttpStatus.CONFLICT,
      API_ERROR_CODE.DUPLICATE_HASH,
    );
    expect(error).toBeInstanceOf(DuplicateHashError);
    expect(callCount(h.hubLn, "createHoldInvoice") + callCount(h.hubFiber, "createHoldInvoice")).toBe(holdCalls);
    expect(h.store.listOpenSwaps()).toHaveLength(1);
  });

  it("409 when the hub's incoming node already has an invoice for the hash", async () => {
    const quote = saveQuote(h, direction);
    const preimage = newPreimage();
    if (direction === "ln_to_fiber") h.hubLn.createInvoiceWithPreimage(preimage, 1_000n);
    else h.hubFiber.createInvoiceWithOptions(preimage);
    const payoutInvoice = direction === "ln_to_fiber" ? userFiberInvoice(h, preimage, quote) : userLnInvoice(h, preimage, quote);

    await expectHubError(() => h.engine.createSwap({ quoteId: quote.id, payoutInvoice, demo: false, clientKey: TEST_CLIENT_KEY }), HttpStatus.CONFLICT, API_ERROR_CODE.DUPLICATE_HASH);
    expectNothingCreated(h);
  });

  it("409 when the hub's paying node already has a payment for the hash", async () => {
    const quote = saveQuote(h, direction);
    const preimage = newPreimage();
    const payoutInvoice = direction === "ln_to_fiber" ? userFiberInvoice(h, preimage, quote) : userLnInvoice(h, preimage, quote);
    if (direction === "ln_to_fiber") await h.hubFiber.payInvoice({ invoice: payoutInvoice, maxFeeAmount: 0n, tlcExpiryLimitMs: hours(24) });
    else await h.hubLn.payInvoice({ paymentRequest: payoutInvoice, maxFeeSats: 10n, cltvLimit: 500, timeoutSeconds: 60 });

    await expectHubError(() => h.engine.createSwap({ quoteId: quote.id, payoutInvoice, demo: false, clientKey: TEST_CLIENT_KEY }), HttpStatus.CONFLICT, API_ERROR_CODE.DUPLICATE_HASH);
    expect(callCount(h.hubLn, "createHoldInvoice") + callCount(h.hubFiber, "createHoldInvoice")).toBe(0);
  });
});

describe.each(["ln_to_fiber", "fiber_to_ln"] as const)("swap engine: createSwap, node failures (%s)", (direction: Direction) => {
  let h: SwapHarness;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness();
  });

  afterEach(() => jest.restoreAllMocks());

  const incomingNode = () => (direction === "ln_to_fiber" ? h.hubLn : h.hubFiber);

  it("503 upstream_unavailable when the hold invoice cannot be issued, and nothing is saved", async () => {
    incomingNode().failNext = "createHoldInvoice";
    const quote = saveQuote(h, direction);
    const payoutInvoice = direction === "ln_to_fiber" ? userFiberInvoice(h, newPreimage(), quote) : userLnInvoice(h, newPreimage(), quote);

    const error = await expectHubError(
      () => h.engine.createSwap({ quoteId: quote.id, payoutInvoice, demo: false, clientKey: TEST_CLIENT_KEY }),
      HttpStatus.SERVICE_UNAVAILABLE,
      API_ERROR_CODE.UPSTREAM_UNAVAILABLE,
    );
    expect(error.message).not.toContain("simulated transport error");
    expect((error.cause as Error).message).toContain("simulated transport error");
    expect(h.store.listOpenSwaps()).toHaveLength(0);
  });

  it("503 when the hash check cannot reach the incoming node", async () => {
    incomingNode().failNext = direction === "ln_to_fiber" ? "lookupInvoice" : "getInvoice";
    const quote = saveQuote(h, direction);
    const payoutInvoice = direction === "ln_to_fiber" ? userFiberInvoice(h, newPreimage(), quote) : userLnInvoice(h, newPreimage(), quote);

    await expectHubError(
      () => h.engine.createSwap({ quoteId: quote.id, payoutInvoice, demo: false, clientKey: TEST_CLIENT_KEY }),
      HttpStatus.SERVICE_UNAVAILABLE,
      API_ERROR_CODE.UPSTREAM_UNAVAILABLE,
    );
    expectNothingCreated(h);
  });

  it("a swap that cannot be saved does not leave a payable hold invoice behind", async () => {
    const quote = saveQuote(h, direction);
    const preimage = newPreimage();
    const payoutInvoice = direction === "ln_to_fiber" ? userFiberInvoice(h, preimage, quote) : userLnInvoice(h, preimage, quote);
    jest.spyOn(h.store, "createSwap").mockImplementationOnce(() => {
      throw new DuplicateHashError();
    });

    await expect(h.engine.createSwap({ quoteId: quote.id, payoutInvoice, demo: false, clientKey: TEST_CLIENT_KEY })).rejects.toBeInstanceOf(DuplicateHashError);
    const hash = sha256Hex(preimage);
    const state = direction === "ln_to_fiber" ? (await h.hubLn.lookupInvoice(hash))?.state : (await h.hubFiber.getInvoice(hash))?.state;
    expect(state === "CANCELED" || state === "Cancelled").toBe(true);
  });
});
