import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { FIBER_MAX_TLC_EXPIRY_LIMIT_MS } from "../../../src/common/constants/protocol.constants";
import {
  API_PATH,
  createSwap,
  expectApiError,
  lightningQuote,
  postQuote,
  startFakeHub,
  SWAP_SATS,
  userLnInvoice,
  useHubLifecycle,
  type FakeHub,
} from "./integration.fixtures";

/**
 * POST /v1/swaps over HTTP on the real AppModule: a client may leave only SWAP_MAX_UNPAID_PER_CLIENT swaps waiting for
 * their payment (429 rate_limited with Retry-After and a plain sentence), and the client is the one the rate limiter
 * counts: the last X-Forwarded-For entry from a trusted proxy, otherwise the socket address.
 */
describe("POST /v1/swaps: swaps waiting for their payment, per client", () => {
  const lifecycle = useHubLifecycle();
  const FORWARDED_FOR = "X-Forwarded-For";

  const start = async (env: Record<string, string>): Promise<FakeHub> => lifecycle.track(await startFakeHub({ env }));

  /** POST /v1/swaps for a fresh fiber_to_ln quote, as the client behind `forwardedFor` when one is given. */
  async function postSwapAs(hub: FakeHub, forwardedFor?: string) {
    const quote = await postQuote(hub, lightningQuote("fiber_to_ln", "CKB"));
    const body = { quoteId: quote.id, payoutInvoice: userLnInvoice(hub, SWAP_SATS).invoice };
    const req = hub.http().post(API_PATH.SWAPS);
    return forwardedFor === undefined ? req.send(body) : req.set(FORWARDED_FOR, forwardedFor).send(body);
  }

  it("answers 429 rate_limited with Retry-After and a plain sentence once the client has the cap unpaid", async () => {
    const hub = await start({ SWAP_MAX_UNPAID_PER_CLIENT: "2" });
    for (let i = 0; i < 2; i += 1) expect((await postSwapAs(hub)).status).toBe(201);

    const res = await postSwapAs(hub);
    const message = expectApiError(res, 429, API_ERROR_CODE.RATE_LIMITED);
    expect(message).toBe("This client already has 2 swaps waiting for their payment. Pay one of them or let it expire, then try again.");
    // The first swap's quote expires QUOTE_TTL_SECONDS after it was made; the fake clock has not moved.
    expect(res.headers["retry-after"]).toBe(String(hub.config.pricing.quoteTtlSeconds));
    expect(hub.store.listOpenSwaps()).toHaveLength(2);
  });

  it("behind a trusted proxy, counts each visitor (the last X-Forwarded-For entry) on its own", async () => {
    const hub = await start({ SWAP_MAX_UNPAID_PER_CLIENT: "1", HUB_TRUST_PROXY: "true" });
    expect((await postSwapAs(hub, "203.0.113.1")).status).toBe(201);
    expect((await postSwapAs(hub, "203.0.113.2")).status).toBe(201);
    expectApiError(await postSwapAs(hub, "198.51.100.9, 203.0.113.1"), 429, API_ERROR_CODE.RATE_LIMITED);
  });

  it("without a trusted proxy, X-Forwarded-For does not make a new client", async () => {
    const hub = await start({ SWAP_MAX_UNPAID_PER_CLIENT: "1", HUB_TRUST_PROXY: "false" });
    expect((await postSwapAs(hub, "203.0.113.1")).status).toBe(201);
    expectApiError(await postSwapAs(hub, "203.0.113.2"), 429, API_ERROR_CODE.RATE_LIMITED);
  });

  it("caps every client together at SWAP_MAX_UNPAID", async () => {
    const hub = await start({ SWAP_MAX_UNPAID_PER_CLIENT: "5", SWAP_MAX_UNPAID: "2", HUB_TRUST_PROXY: "true" });
    expect((await postSwapAs(hub, "203.0.113.1")).status).toBe(201);
    expect((await postSwapAs(hub, "203.0.113.2")).status).toBe(201);
    const message = expectApiError(await postSwapAs(hub, "203.0.113.3"), 429, API_ERROR_CODE.RATE_LIMITED);
    expect(message).toContain("The hub has too many swaps waiting for their payment");
  });

  it("a paid swap no longer counts", async () => {
    const hub = await start({ SWAP_MAX_UNPAID_PER_CLIENT: "1" });
    const quote = await postQuote(hub, lightningQuote("fiber_to_ln", "CKB"));
    const swap = await createSwap(hub, quote.id, userLnInvoice(hub, SWAP_SATS).invoice);
    await hub.userFiber.payInvoice({ invoice: swap.pay.invoice, maxFeeAmount: 0n, tlcExpiryLimitMs: FIBER_MAX_TLC_EXPIRY_LIMIT_MS });
    await hub.engine.processSwap(swap.id);

    expect((await postSwapAs(hub)).status).toBe(201);
  });
});
