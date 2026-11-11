import { randomUUID } from "node:crypto";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { LND_MAX_CLTV_LIMIT } from "../../../src/common/constants/protocol.constants";
import { SWAP_STATE } from "../../../src/common/constants/swap.constants";
import {
  API_PATH,
  CKB_SHANNONS,
  createSwap,
  expectApiError,
  lightningQuote,
  postDemoInvoice,
  postDemoPayment,
  postQuote,
  postSwap,
  processUntil,
  RUSD_SCRIPT,
  startFakeHub,
  SWAP_SATS,
  userFiberInvoice,
  userLnInvoice,
  useHubLifecycle,
  type FakeHub,
} from "./integration.fixtures";

/**
 * The error contract of the REST API on the real app (docs/architecture.md, REST API v1): every error is exactly
 * `{ "error": { "code", "message" } }` with the documented status. 400 bad input, 404 unknown resource or route,
 * 409 conflict with existing state, 422 valid input the hub cannot serve.
 */

describe("API error shapes on the real AppModule", () => {
  const lifecycle = useHubLifecycle();
  let hub: FakeHub;

  beforeEach(async () => {
    hub = lifecycle.track(await startFakeHub());
  });

  describe("400", () => {
    it("validation_failed: a quote body that breaks the schema names the fields", async () => {
      const res = await hub.http().post(API_PATH.QUOTES).send({ direction: "sideways", asset: "CKB", side: "pay", amount: "-5" });
      const message = expectApiError(res, 400, API_ERROR_CODE.VALIDATION);
      expect(message).toContain("direction");
      expect(message).toContain("amount");
    });

    it("validation_failed: a swap body without a UUID quote id or an invoice", async () => {
      const res = await hub.http().post(API_PATH.SWAPS).send({ quoteId: "not-a-uuid" });
      const message = expectApiError(res, 400, API_ERROR_CODE.VALIDATION);
      expect(message).toContain("quoteId");
      expect(message).toContain("payoutInvoice");
    });

    it.each([
      ["a swap", (id: string) => API_PATH.swap(id)],
      ["a swap's events", (id: string) => API_PATH.swapEvents(id)],
      ["a quote", (id: string) => API_PATH.quote(id)],
    ])("validation_failed: %s with an id that is not a UUID", async (_what, path) => {
      expectApiError(await hub.http().get(path("12345")), 400, API_ERROR_CODE.VALIDATION);
    });

    it("bad_request: a body that is not JSON", async () => {
      const res = await hub.http().post(API_PATH.QUOTES).set("Content-Type", "application/json").send("{ not json");
      expectApiError(res, 400, API_ERROR_CODE.BAD_REQUEST);
    });

    it("invoice_invalid: a payout invoice that cannot be read at all", async () => {
      for (const direction of ["ln_to_fiber", "fiber_to_ln"] as const) {
        const quote = await postQuote(hub, lightningQuote(direction, "CKB"));
        expectApiError(await postSwap(hub, quote.id, "this is not an invoice"), 400, API_ERROR_CODE.INVOICE_INVALID);
      }
      expect(hub.hubLn.calls).not.toContain("createHoldInvoice");
      expect(hub.hubFiber.calls).not.toContain("createHoldInvoice");
    });

    it("validation_failed: a demo payment without a UUID swap id", async () => {
      expectApiError(await hub.http().post(API_PATH.DEMO_PAYMENTS).send({ swapId: 42 }), 400, API_ERROR_CODE.VALIDATION);
    });
  });

  describe("404", () => {
    it.each([
      ["swap", (id: string) => API_PATH.swap(id)],
      ["swap events", (id: string) => API_PATH.swapEvents(id)],
      ["quote", (id: string) => API_PATH.quote(id)],
    ])("not_found: an unknown %s", async (_what, path) => {
      expectApiError(await hub.http().get(path(randomUUID())), 404, API_ERROR_CODE.NOT_FOUND);
    });

    it("not_found: a swap on a quote the hub never issued", async () => {
      const payout = userFiberInvoice(hub, 1n);
      expectApiError(await postSwap(hub, randomUUID(), payout.invoice), 404, API_ERROR_CODE.NOT_FOUND);
    });

    it("not_found: a demo payment for an unknown swap", async () => {
      expectApiError(await hub.http().post(API_PATH.DEMO_PAYMENTS).send({ swapId: randomUUID() }), 404, API_ERROR_CODE.NOT_FOUND);
    });

    it("not_found: a route that does not exist, or a version the hub does not serve", async () => {
      expectApiError(await hub.http().get("/v1/nothing-here"), 404, API_ERROR_CODE.NOT_FOUND);
      expectApiError(await hub.http().get("/v2/swaps"), 404, API_ERROR_CODE.NOT_FOUND);
    });

    it("demo_disabled: the demo routes on a hub without demo nodes", async () => {
      const plain = lifecycle.track(await startFakeHub({ env: { DEMO_ENABLED: "false" } }));
      const invoice = await plain.http().post(API_PATH.DEMO_INVOICES).send({ direction: "fiber_to_ln", asset: "CKB", amount: "10000" });
      expectApiError(invoice, 404, API_ERROR_CODE.DEMO_DISABLED);
      const payment = await plain.http().post(API_PATH.DEMO_PAYMENTS).send({ swapId: randomUUID() });
      expectApiError(payment, 404, API_ERROR_CODE.DEMO_DISABLED);
      expect((await plain.http().get(API_PATH.HEALTH).expect(200)).body.demo).toEqual({ enabled: false });
    });
  });

  describe("409", () => {
    it("conflict: a second swap on a quote that already has one", async () => {
      const quote = await postQuote(hub, lightningQuote("fiber_to_ln", "CKB"));
      await createSwap(hub, quote.id, userLnInvoice(hub, SWAP_SATS).invoice);
      const message = expectApiError(await postSwap(hub, quote.id, userLnInvoice(hub, SWAP_SATS).invoice), 409, API_ERROR_CODE.CONFLICT);
      expect(message).toMatch(/quote/i);
    });

    it("duplicate_hash: a new quote paid out to an invoice whose hash another swap already uses", async () => {
      const payout = userLnInvoice(hub, SWAP_SATS);
      const first = await postQuote(hub, lightningQuote("fiber_to_ln", "CKB"));
      await createSwap(hub, first.id, payout.invoice);
      const second = await postQuote(hub, lightningQuote("fiber_to_ln", "CKB"));
      expectApiError(await postSwap(hub, second.id, payout.invoice), 409, API_ERROR_CODE.DUPLICATE_HASH);
    });

    it("duplicate_hash: a payment hash the hub's nodes already know, even without a swap", async () => {
      const quote = await postQuote(hub, lightningQuote("ln_to_fiber", "CKB"));
      const payout = userFiberInvoice(hub, BigInt(quote.receive.amount));
      await hub.hubLn.createHoldInvoice({ paymentHash: payout.paymentHash, amountSats: 1n, expirySeconds: 60, cltvExpiry: 40, memo: "stray" });
      expectApiError(await postSwap(hub, quote.id, payout.invoice), 409, API_ERROR_CODE.DUPLICATE_HASH);
    });

    it("conflict: a demo payment for a swap that no longer waits for one", async () => {
      const quote = await postQuote(hub, lightningQuote("ln_to_fiber", "CKB"));
      const payout = await postDemoInvoice(hub, quote);
      const swap = await createSwap(hub, quote.id, payout.invoice, true);
      await postDemoPayment(hub, swap.id);
      await processUntil(hub, swap.id, (s) => s.state !== SWAP_STATE.PENDING);

      expectApiError(await hub.http().post(API_PATH.DEMO_PAYMENTS).send({ swapId: swap.id }), 409, API_ERROR_CODE.CONFLICT);
    });
  });

  describe("422", () => {
    it("quote_expired: a swap on a quote whose validity has run out", async () => {
      const quote = await postQuote(hub, lightningQuote("fiber_to_ln", "CKB"));
      hub.clock.set(Date.parse(quote.expiresAt));
      expectApiError(await postSwap(hub, quote.id, userLnInvoice(hub, SWAP_SATS).invoice), 422, API_ERROR_CODE.QUOTE_EXPIRED);
    });

    it("validation_failed: a quote whose Lightning side is outside the per-swap caps", async () => {
      const { minSats, maxSats } = hub.config.pricing;
      for (const sats of [minSats - 1n, maxSats + 1n]) {
        const res = await hub.http().post(API_PATH.QUOTES).send(lightningQuote("ln_to_fiber", "CKB", sats));
        const message = expectApiError(res, 422, API_ERROR_CODE.VALIDATION);
        expect(message).toContain(`${minSats}`);
        expect(message).toContain(`${maxSats}`);
      }
    });

    it("asset_unavailable: an asset the hub does not serve on its network (no cWBTC script configured)", async () => {
      const quote = await hub.http().post(API_PATH.QUOTES).send(lightningQuote("ln_to_fiber", "CWBTC"));
      expectApiError(quote, 422, API_ERROR_CODE.ASSET_UNAVAILABLE);
      const demo = await hub.http().post(API_PATH.DEMO_INVOICES).send({ direction: "ln_to_fiber", asset: "CWBTC", amount: "1000" });
      expectApiError(demo, 422, API_ERROR_CODE.ASSET_UNAVAILABLE);
    });

    it("insufficient_liquidity: a payout larger than the hub's payout balance", async () => {
      hub.hubLn.setBalances({ channelLocalSats: 2_000n });
      const res = await hub.http().post(API_PATH.QUOTES).send(lightningQuote("fiber_to_ln", "CKB", SWAP_SATS));
      expectApiError(res, 422, API_ERROR_CODE.INSUFFICIENT_LIQUIDITY);
    });

    it.each([
      ["the wrong amount", () => userLnInvoice(hub, SWAP_SATS + 1n).invoice, /asks for/],
      ["an expiry before the quote's", () => userLnInvoice(hub, SWAP_SATS, { expirySeconds: 10 }).invoice, /expires before the quote/],
      ["a CLTV above what LND will pay", () => userLnInvoice(hub, SWAP_SATS, { cltvExpiry: LND_MAX_CLTV_LIMIT }).invoice, /CLTV/],
    ])("invoice_invalid: a Lightning payout invoice with %s", async (_what, makeInvoice, pattern) => {
      const quote = await postQuote(hub, lightningQuote("fiber_to_ln", "CKB"));
      expect(expectApiError(await postSwap(hub, quote.id, makeInvoice()), 422, API_ERROR_CODE.INVOICE_INVALID)).toMatch(pattern);
      expect(hub.hubFiber.calls).not.toContain("createHoldInvoice");
    });

    it("invoice_invalid: a Fiber payout invoice for another asset, or with the ckb_hash algorithm", async () => {
      const quote = await postQuote(hub, lightningQuote("ln_to_fiber", "RUSD"));
      const amount = BigInt(quote.receive.amount);
      const ckbInvoice = userFiberInvoice(hub, amount, null).invoice;
      expect(expectApiError(await postSwap(hub, quote.id, ckbInvoice), 422, API_ERROR_CODE.INVOICE_INVALID)).toContain("RUSD");

      const ckbHash = hub.userFiber.createInvoiceWithOptions("ab".repeat(32), { amount, udt: RUSD_SCRIPT, hashAlgorithm: "ckb_hash" });
      expect(expectApiError(await postSwap(hub, quote.id, ckbHash), 422, API_ERROR_CODE.INVOICE_INVALID)).toContain("sha256");
      expect(hub.hubLn.calls).not.toContain("createHoldInvoice");
    });

  });

  describe("503", () => {
    it("quote_unavailable: no price source answers", async () => {
      for (const source of hub.prices) source.failing = true;
      expectApiError(await hub.http().post(API_PATH.QUOTES).send(lightningQuote("ln_to_fiber", "CKB")), 503, API_ERROR_CODE.QUOTE_UNAVAILABLE);
    });

    it("upstream_unavailable: the hub's Lightning node fails while a swap is created", async () => {
      const quote = await postQuote(hub, lightningQuote("ln_to_fiber", "CKB"));
      const payout = userFiberInvoice(hub, BigInt(quote.receive.amount));
      hub.hubLn.failNext = "createHoldInvoice";
      expectApiError(await postSwap(hub, quote.id, payout.invoice), 503, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
    });
  });

  it("a refused swap request leaves the quote usable: the next valid request on it succeeds", async () => {
    const quote = await postQuote(hub, lightningQuote("ln_to_fiber", "CKB"));
    const amount = BigInt(quote.receive.amount);
    expectApiError(await postSwap(hub, quote.id, userFiberInvoice(hub, amount + CKB_SHANNONS).invoice), 422, API_ERROR_CODE.INVOICE_INVALID);
    expect((await postSwap(hub, quote.id, userFiberInvoice(hub, amount).invoice)).status).toBe(201);
  });
});
