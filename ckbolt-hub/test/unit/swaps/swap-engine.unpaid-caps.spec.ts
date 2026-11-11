import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { RateLimitedError } from "../../../src/common/errors/hub.error";
import {
  callCount,
  craftLnInvoice,
  expectHubError,
  makeSwapHarness,
  payHoldInvoice,
  processPasses,
  QUOTE_TTL_MS,
  saveQuote,
  seconds,
  silenceLogs,
  startSwap,
  defaultPayoutInvoice,
  newPreimage,
  type ConfigPatch,
  type SwapHarness,
} from "./swaps.fixtures";

/**
 * Security review, wave 2: a swap waiting for its payment reserves its payout and leaves a hold invoice on the hub's
 * nodes until its quote expires, and costs nothing to make. The engine caps them per client (the HTTP layer's client
 * key) and in total, refusing with 429 rate_limited before any node is called.
 */
describe("swap engine: caps on swaps waiting for their payment", () => {
  const ALICE = "198.51.100.1";
  const BOB = "198.51.100.2";
  const TOO_MANY = 429;
  let h: SwapHarness;

  const harness = (swaps: ConfigPatch["swaps"]): SwapHarness => {
    h = makeSwapHarness({ swaps });
    return h;
  };

  /** A swap `clientKey` asks for, on a fresh quote. */
  const swapFor = (clientKey: string, direction: "ln_to_fiber" | "fiber_to_ln" = "fiber_to_ln") => startSwap(h, direction, { clientKey });

  const holdInvoicesCreated = (): number => callCount(h.hubFiber, "createHoldInvoice") + callCount(h.hubLn, "createHoldInvoice");

  beforeEach(() => silenceLogs());
  afterEach(() => jest.restoreAllMocks());

  describe("per client (SWAP_MAX_UNPAID_PER_CLIENT)", () => {
    beforeEach(() => harness({ maxUnpaidSwapsPerClient: 2, maxUnpaidSwaps: 10 }));

    it("refuses a client's next swap with 429 once it has the cap unpaid, before any hold invoice is made", async () => {
      await swapFor(ALICE);
      await swapFor(ALICE, "ln_to_fiber");
      expect(holdInvoicesCreated()).toBe(2);

      const error = await expectHubError(() => swapFor(ALICE), TOO_MANY, API_ERROR_CODE.RATE_LIMITED);
      expect(error.message).toContain("2 swaps waiting for their payment");
      expect(holdInvoicesCreated()).toBe(2);
    });

    it("counts each client on its own", async () => {
      await swapFor(ALICE);
      await swapFor(ALICE);
      await expect(swapFor(BOB)).resolves.toMatchObject({ swap: { state: "pending" } });
    });

    it("says when to retry: when the client's first unpaid swap expires with its quote", async () => {
      await swapFor(ALICE);
      h.clock.advance(seconds(60));
      await swapFor(ALICE);
      h.clock.advance(seconds(1.5));

      const error = (await expectHubError(() => swapFor(ALICE), TOO_MANY, API_ERROR_CODE.RATE_LIMITED)) as RateLimitedError;
      // The first quote expires 180 s after it was made, 61.5 s ago: 118.5 s, rounded up.
      expect(error).toBeInstanceOf(RateLimitedError);
      expect(error.retryAfterSeconds).toBe(QUOTE_TTL_MS / 1_000 - 61);
    });

    it("frees a slot once a swap is paid", async () => {
      const first = await swapFor(ALICE);
      await swapFor(ALICE);
      await payHoldInvoice(h, first.swap);
      expect((await processPasses(h, first.swap.id, 1)).state).toBe("incoming_accepted");

      await expect(swapFor(ALICE)).resolves.toMatchObject({ swap: { state: "pending" } });
    });

    it("frees a slot once a swap expires unpaid", async () => {
      const first = await swapFor(ALICE);
      h.clock.advance(seconds(10));
      await swapFor(ALICE);
      h.clock.advance(QUOTE_TTL_MS - seconds(10));
      expect((await processPasses(h, first.swap.id, 1)).state).toBe("failed");

      await expect(swapFor(ALICE)).resolves.toMatchObject({ swap: { state: "pending" } });
    });

    it("a creation that fails gives its slot back", async () => {
      await swapFor(ALICE);
      const quote = saveQuote(h, "fiber_to_ln");
      const wrongNetwork = craftLnInvoice(h, { network: "mainnet" });
      await expectHubError(() => h.engine.createSwap({ quoteId: quote.id, payoutInvoice: wrongNetwork, demo: false, clientKey: ALICE }), 422, API_ERROR_CODE.INVOICE_INVALID);

      await expect(swapFor(ALICE)).resolves.toMatchObject({ swap: { state: "pending" } });
    });
  });

  it("concurrent requests of one client cannot get past the cap (a slot is taken before any node call)", async () => {
    harness({ maxUnpaidSwapsPerClient: 1, maxUnpaidSwaps: 10 });
    const attempts = await Promise.allSettled([swapFor(ALICE), swapFor(ALICE), swapFor(ALICE)]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const refusals = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    expect(refusals.map((refusal) => (refusal.reason as RateLimitedError).status)).toEqual([TOO_MANY, TOO_MANY]);
    expect(holdInvoicesCreated()).toBe(1);
  });

  describe("in total (SWAP_MAX_UNPAID)", () => {
    beforeEach(() => harness({ maxUnpaidSwapsPerClient: 5, maxUnpaidSwaps: 3 }));

    it("refuses any client once the hub has the cap unpaid, with a sentence about the hub", async () => {
      await swapFor(ALICE);
      await swapFor(ALICE);
      await swapFor(BOB);

      const error = await expectHubError(() => swapFor("198.51.100.3"), TOO_MANY, API_ERROR_CODE.RATE_LIMITED);
      expect(error.message).toBe("The hub has too many swaps waiting for their payment right now. Try again in a few minutes.");
    });

    it("still counts the unpaid swaps of before a restart", async () => {
      for (const client of [ALICE, BOB, ALICE]) await swapFor(client);
      h.restart();
      await expectHubError(() => swapFor("198.51.100.3"), TOO_MANY, API_ERROR_CODE.RATE_LIMITED);
    });
  });

  it("caps swaps made through the engine whichever direction they take", async () => {
    harness({ maxUnpaidSwapsPerClient: 1, maxUnpaidSwaps: 10 });
    await swapFor(ALICE, "ln_to_fiber");
    const quote = saveQuote(h, "fiber_to_ln");
    const payoutInvoice = defaultPayoutInvoice(h, newPreimage(), quote);
    await expectHubError(() => h.engine.createSwap({ quoteId: quote.id, payoutInvoice, demo: false, clientKey: ALICE }), TOO_MANY, API_ERROR_CODE.RATE_LIMITED);
  });
});
