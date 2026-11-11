import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { PRICING_ERROR } from "../../../src/application/pricing/pricing.errors";
import { DuplicateHashError, HubError } from "../../../src/common/errors/hub.error";
import type { HubConfig } from "../../../src/config/hub.config";
import type { AssetRegistry } from "../../../src/domain/assets";
import type { SwapEvent } from "../../../src/domain/types";
import { FakeClock } from "../../fakes";
import {
  createApiApp,
  makeAvailability,
  makeQuote,
  makeStubs,
  makeSwap,
  okHealthReport,
  PAYMENT_HASH,
  PREIMAGE,
  QUOTE_ID,
  requireAsset,
  spyOnLogger,
  stubServicesModule,
  SWAP_ID,
  testAssets,
  testConfig,
  UNKNOWN_ID,
  type Stubs,
} from "./api.fixtures";

/**
 * REST API v1 end to end over HTTP: a real Nest app (ApiModule + HubConfigModule) with stub application services.
 * Checks paths, status codes, Location headers, the DTO shapes and the `{ error: { code, message } }` body.
 */

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("REST API v1 (HTTP)", () => {
  let app: INestApplication;
  let stubs: Stubs;
  let config: HubConfig;
  let assets: AssetRegistry;
  let logs: ReturnType<typeof spyOnLogger>;

  const http = () => request(app.getHttpServer());

  const expectErrorBody = (body: unknown, code: string): string => {
    expect(body).toEqual({ error: { code, message: expect.any(String) } });
    const message = (body as { error: { message: string } }).error.message;
    expect(message.length).toBeGreaterThan(0);
    return message;
  };

  beforeEach(async () => {
    logs = spyOnLogger();
    stubs = makeStubs();
    config = testConfig({ server: { rateLimitPerMinute: 1_000 } });
    assets = testAssets(config);
    app = await createApiApp({ config, clock: new FakeClock(), apiImports: [stubServicesModule(stubs)] });
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  describe("routing", () => {
    it.each([
      ["GET", "/health"],
      ["GET", "/assets"],
      ["GET", "/v2/health"],
      ["GET", "/v1/nothing-here"],
      ["POST", "/quotes"],
      ["GET", `/swaps/${SWAP_ID}`],
    ])("%s %s outside /v1 answers 404 not_found with the error body", async (method, path) => {
      const res = method === "GET" ? await http().get(path) : await http().post(path).send({});
      expect(res.status).toBe(404);
      expectErrorBody(res.body, API_ERROR_CODE.NOT_FOUND);
    });

    it("answers JSON for errors", async () => {
      const res = await http().get("/nope");
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    });

    it("a method the resource does not support answers 404 not_found (no route)", async () => {
      const res = await http().delete(`/v1/swaps/${SWAP_ID}`);
      expect(res.status).toBe(404);
      expectErrorBody(res.body, API_ERROR_CODE.NOT_FOUND);
    });
  });

  describe("GET /v1/health", () => {
    it("200 with the HealthDto when the hub is ok", async () => {
      stubs.health.report = okHealthReport({ demo: { enabled: true } });
      const res = await http().get("/v1/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: "ok",
        version: "9.9.9-test",
        lightning: { reachable: true, network: "regtest", synced: true, blockHeight: 321 },
        fiber: { reachable: true, network: "devnet", version: "0.9.1" },
        demo: { enabled: true },
        swaps: { paused: false },
      });
    });

    it("says when swaps are paused (SWAPS_PAUSED), still 200 while the hub is ok", async () => {
      stubs.health.report = okHealthReport({ swaps: { paused: true } });
      const res = await http().get("/v1/health");
      expect(res.status).toBe(200);
      expect(res.body.swaps).toEqual({ paused: true });
    });

    it("503 with the same HealthDto body (not an error body) when degraded", async () => {
      stubs.health.report = okHealthReport({
        status: "degraded",
        fiber: { reachable: false, network: null, version: null },
      });
      const res = await http().get("/v1/health");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("degraded");
      expect(res.body.fiber).toEqual({ reachable: false, network: null, version: null });
      expect(res.body.error).toBeUndefined();
    });

    it("a health service that throws gives a bare 500 internal_error", async () => {
      stubs.health.check.mockRejectedValueOnce(new Error("boom at /srv/secret"));
      const res = await http().get("/v1/health");
      expect(res.status).toBe(500);
      const message = expectErrorBody(res.body, API_ERROR_CODE.INTERNAL);
      expect(message).not.toContain("secret");
    });
  });

  describe("GET /v1/assets", () => {
    it("200 { data: AssetDto[] } with amounts as decimal strings", async () => {
      const ckb = requireAsset(assets, "CKB");
      const rusd = requireAsset(assets, "RUSD");
      stubs.pricing.availability = [makeAvailability(ckb), makeAvailability(rusd, { directions: ["ln_to_fiber"] })];
      const res = await http().get("/v1/assets");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: [
          {
            id: "CKB",
            symbol: "CKB",
            name: ckb.name,
            decimals: 8,
            directions: ["ln_to_fiber", "fiber_to_ln"],
            displayName: null,
            iconUrl: null,
            minSats: "1000",
            maxSats: "100000",
            liquidity: { lightningSats: "900000", fiberAmount: "12345678901234567890" },
          },
          expect.objectContaining({ id: "RUSD", directions: ["ln_to_fiber"] }),
        ],
      });
    });

    it("an empty list is still { data: [] }", async () => {
      const res = await http().get("/v1/assets");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [] });
    });

    it("a HubError from pricing keeps its status and code (503 upstream_unavailable)", async () => {
      stubs.pricing.listAssets.mockRejectedValueOnce(new HubError("Prices are unavailable. Try again shortly.", 503, API_ERROR_CODE.UPSTREAM_UNAVAILABLE));
      const res = await http().get("/v1/assets");
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: { code: "upstream_unavailable", message: "Prices are unavailable. Try again shortly." } });
    });
  });

  describe("POST /v1/quotes", () => {
    const body = { direction: "ln_to_fiber", asset: "CKB", side: "pay", amount: "50000" };

    it("201 with Location: /v1/quotes/:id and the QuoteDto", async () => {
      const res = await http().post("/v1/quotes").send(body);
      expect(res.status).toBe(201);
      expect(res.headers.location).toBe(`/v1/quotes/${QUOTE_ID}`);
      expect(res.body).toMatchObject({
        id: QUOTE_ID,
        direction: "ln_to_fiber",
        asset: "CKB",
        pay: { network: "lightning", asset: "BTC", amount: "50000", decimals: 8 },
        receive: { network: "fiber", asset: "CKB", amount: "2000000000000", decimals: 8 },
        prices: { btcUsd: 80_000, assetUsd: 0.002, source: "median:fake-a,fake-b" },
        feeBps: 100,
        signature: "ee".repeat(64),
        hubPubkey: "ff".repeat(32),
      });
      for (const field of [res.body.createdAt, res.body.expiresAt, res.body.prices.at]) expect(field).toMatch(ISO_8601);
    });

    it("passes the request to pricing with the amount as a bigint", async () => {
      await http().post("/v1/quotes").send({ direction: "fiber_to_ln", asset: "RUSD", side: "receive", amount: "123456789012345678901234567890" });
      expect(stubs.pricing.createQuote).toHaveBeenCalledWith({
        direction: "fiber_to_ln",
        asset: "RUSD",
        side: "receive",
        amount: 123_456_789_012_345_678_901_234_567_890n,
      });
    });

    it("fiber_to_ln quotes show the Fiber leg as what the user pays", async () => {
      stubs.pricing.nextQuote = makeQuote({ direction: "fiber_to_ln" });
      const res = await http().post("/v1/quotes").send({ ...body, direction: "fiber_to_ln" });
      expect(res.status).toBe(201);
      expect(res.body.pay).toEqual({ network: "fiber", asset: "CKB", amount: "2000000000000", decimals: 8 });
      expect(res.body.receive).toEqual({ network: "lightning", asset: "BTC", amount: "50000", decimals: 8 });
    });

    it.each([
      ["amount zero", { ...body, amount: "0" }, "amount"],
      ["amount with a decimal point", { ...body, amount: "1.5" }, "amount"],
      ["negative amount", { ...body, amount: "-1" }, "amount"],
      ["amount as a JSON number", { ...body, amount: 50_000 }, "amount"],
      ["amount with a leading zero", { ...body, amount: "0100" }, "amount"],
      ["amount over 30 digits", { ...body, amount: "1".repeat(31) }, "amount"],
      ["missing amount", { direction: "ln_to_fiber", asset: "CKB", side: "pay" }, "amount"],
      ["unknown direction", { ...body, direction: "btc_to_eth" }, "direction"],
      ["a malformed asset id (lower case)", { ...body, asset: "ckb" }, "asset"],
      ["a malformed asset id (a symbol in it)", { ...body, asset: "C-KB" }, "asset"],
      ["unknown side", { ...body, side: "both" }, "side"],
    ])("400 validation_failed for %s, naming the field, without calling pricing", async (_label, payload, field) => {
      const res = await http().post("/v1/quotes").send(payload);
      expect(res.status).toBe(400);
      const message = expectErrorBody(res.body, API_ERROR_CODE.VALIDATION);
      expect(message).toContain(field);
      expect(stubs.pricing.createQuote).not.toHaveBeenCalled();
    });

    it("passes a well-formed asset id the hub does not serve to pricing, and answers its 422 asset_unavailable", async () => {
      stubs.pricing.createQuote.mockRejectedValueOnce(PRICING_ERROR.assetNotServed("USDI"));
      const res = await http().post("/v1/quotes").send({ ...body, asset: "USDI" });
      expect(res.status).toBe(422);
      expect(expectErrorBody(res.body, API_ERROR_CODE.ASSET_UNAVAILABLE)).toContain("USDI");
      expect(stubs.pricing.createQuote).toHaveBeenCalledWith(expect.objectContaining({ asset: "USDI" }));
    });

    it("400 validation_failed for an empty body", async () => {
      const res = await http().post("/v1/quotes");
      expect(res.status).toBe(400);
      expectErrorBody(res.body, API_ERROR_CODE.VALIDATION);
    });

    it("400 validation_failed for a JSON array body", async () => {
      const res = await http().post("/v1/quotes").send([body]);
      expect(res.status).toBe(400);
      expectErrorBody(res.body, API_ERROR_CODE.VALIDATION);
    });

    it("a validation message lists every bad field in one plain sentence", async () => {
      const res = await http().post("/v1/quotes").send({ direction: "x", asset: "CKB", side: "pay" });
      const message = expectErrorBody(res.body, API_ERROR_CODE.VALIDATION);
      expect(message).toMatch(/^Invalid request\. /);
      expect(message).toContain("direction");
      expect(message).toContain("amount");
      expect(message).not.toMatch(/[{}[\]]/);
    });

    it("400 bad_request for a malformed JSON body, without echoing parser internals", async () => {
      const res = await http().post("/v1/quotes").set("Content-Type", "application/json").send('{"direction": "ln_to_fiber",');
      expect(res.status).toBe(400);
      const message = expectErrorBody(res.body, API_ERROR_CODE.BAD_REQUEST);
      expect(message).not.toMatch(/Unexpected|JSON\.parse|position/);
      expect(stubs.pricing.createQuote).not.toHaveBeenCalled();
    });

    it("413 with the error body for an oversized JSON body", async () => {
      const res = await http().post("/v1/quotes").send({ ...body, padding: "x".repeat(2 * 1024 * 1024) });
      expect(res.status).toBe(413);
      expectErrorBody(res.body, API_ERROR_CODE.BAD_REQUEST);
      expect(stubs.pricing.createQuote).not.toHaveBeenCalled();
    });

    it("a non-JSON body is not read as the request: 400 validation_failed", async () => {
      const res = await http().post("/v1/quotes").set("Content-Type", "text/plain").send(JSON.stringify(body));
      expect(res.status).toBe(400);
      expectErrorBody(res.body, API_ERROR_CODE.VALIDATION);
      expect(stubs.pricing.createQuote).not.toHaveBeenCalled();
    });

    it("a HubError from pricing keeps its status, code and message (422 quote_unavailable)", async () => {
      stubs.pricing.createQuote.mockRejectedValueOnce(new HubError("The hub cannot pay out this much CKB right now.", 422, API_ERROR_CODE.INSUFFICIENT_LIQUIDITY));
      const res = await http().post("/v1/quotes").send(body);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: { code: "insufficient_liquidity", message: "The hub cannot pay out this much CKB right now." } });
      expect(res.headers.location).toBeUndefined();
    });

    it("an unexpected error is a bare 500 internal_error: no message, stack or detail leaks, and it is logged", async () => {
      const secret = new Error("SQLITE_CORRUPT at /var/lib/hub/hub.sqlite (macaroon=0201abc)");
      stubs.pricing.createQuote.mockRejectedValueOnce(secret);
      const res = await http().post("/v1/quotes").send(body);
      expect(res.status).toBe(500);
      const message = expectErrorBody(res.body, API_ERROR_CODE.INTERNAL);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain("SQLITE");
      expect(raw).not.toContain("macaroon");
      expect(raw).not.toContain("at ");
      expect(message).not.toContain(secret.message);
      expect(logs.error).toHaveBeenCalled();
      expect(logs.error.mock.calls.flat().join(" ")).toContain("SQLITE_CORRUPT");
    });

    it("a thrown non-Error value is also a bare 500 internal_error", async () => {
      stubs.pricing.createQuote.mockRejectedValueOnce("just a string");
      const res = await http().post("/v1/quotes").send(body);
      expect(res.status).toBe(500);
      expectErrorBody(res.body, API_ERROR_CODE.INTERNAL);
      expect(JSON.stringify(res.body)).not.toContain("just a string");
    });

    it("4xx HubErrors are not logged as errors", async () => {
      stubs.pricing.createQuote.mockRejectedValueOnce(new HubError("This quote has expired.", 422, API_ERROR_CODE.QUOTE_EXPIRED));
      await http().post("/v1/quotes").send(body);
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  describe("GET /v1/quotes/:id", () => {
    it("200 with the QuoteDto", async () => {
      stubs.pricing.quotes.set(QUOTE_ID, makeQuote());
      const res = await http().get(`/v1/quotes/${QUOTE_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(QUOTE_ID);
      expect(res.body.pay.amount).toBe("50000");
      expect(stubs.pricing.getQuote).toHaveBeenCalledWith(QUOTE_ID);
    });

    it("404 not_found for an unknown quote", async () => {
      const res = await http().get(`/v1/quotes/${UNKNOWN_ID}`);
      expect(res.status).toBe(404);
      const message = expectErrorBody(res.body, API_ERROR_CODE.NOT_FOUND);
      expect(message).toMatch(/quote/i);
    });

    it.each(["not-a-uuid", "123", `${QUOTE_ID}x`, "' OR 1=1 --"])("400 validation_failed for the id %p, without reading the store", async (id) => {
      const res = await http().get(`/v1/quotes/${encodeURIComponent(id)}`);
      expect(res.status).toBe(400);
      const message = expectErrorBody(res.body, API_ERROR_CODE.VALIDATION);
      expect(message).toContain("id");
      expect(stubs.pricing.getQuote).not.toHaveBeenCalled();
    });

    it("a stored quote for an asset the hub no longer serves is a 500 internal_error", async () => {
      stubs.pricing.quotes.set(QUOTE_ID, makeQuote({ asset: "CWBTC" }));
      const res = await http().get(`/v1/quotes/${QUOTE_ID}`);
      expect(res.status).toBe(500);
      expectErrorBody(res.body, API_ERROR_CODE.INTERNAL);
    });
  });

  describe("POST /v1/swaps", () => {
    const body = { quoteId: QUOTE_ID, payoutInvoice: "fibd1userinvoice" };

    it("201 with Location: /v1/swaps/:id and the SwapDto whose pay.invoice is the hold invoice", async () => {
      const res = await http().post("/v1/swaps").send(body);
      expect(res.status).toBe(201);
      expect(res.headers.location).toBe(`/v1/swaps/${SWAP_ID}`);
      expect(res.body).toMatchObject({
        id: SWAP_ID,
        quoteId: QUOTE_ID,
        direction: "ln_to_fiber",
        asset: "CKB",
        state: "pending",
        paymentHash: PAYMENT_HASH,
        pay: { network: "lightning", asset: "BTC", amount: "50000", decimals: 8, invoice: "lnbcrt-hub-hold-invoice" },
        receive: { network: "fiber", asset: "CKB", amount: "2000000000000", decimals: 8, invoice: "fibd1userinvoice" },
        refunded: false,
        failureReason: null,
        preimage: null,
        demo: false,
        links: { self: `/v1/swaps/${SWAP_ID}`, events: `/v1/swaps/${SWAP_ID}/events` },
      });
      for (const field of [res.body.createdAt, res.body.updatedAt, res.body.quoteExpiresAt]) expect(field).toMatch(ISO_8601);
    });

    it("demo is what the demo wallet says about the payout invoice, never what the request says", async () => {
      await http().post("/v1/swaps").send({ ...body, demo: true });
      expect(stubs.demo.receivesPayout).toHaveBeenLastCalledWith("fibd1userinvoice");
      const input = { quoteId: QUOTE_ID, payoutInvoice: "fibd1userinvoice", clientKey: expect.any(String) };
      expect(stubs.engine.createSwap).toHaveBeenLastCalledWith({ ...input, demo: false });

      stubs.demo.receivesPayout.mockResolvedValueOnce(true);
      await http().post("/v1/swaps").send(body);
      expect(stubs.engine.createSwap).toHaveBeenLastCalledWith({ ...input, demo: true });
    });

    it("trims the payout invoice", async () => {
      await http().post("/v1/swaps").send({ ...body, payoutInvoice: "  fibd1userinvoice\n" });
      expect(stubs.engine.createSwap).toHaveBeenCalledWith(expect.objectContaining({ payoutInvoice: "fibd1userinvoice" }));
    });

    it.each([
      ["a quoteId that is not a uuid", { ...body, quoteId: "q-1" }, "quoteId"],
      ["a missing quoteId", { payoutInvoice: "fibd1userinvoice" }, "quoteId"],
      ["an empty payout invoice", { ...body, payoutInvoice: "" }, "payoutInvoice"],
      ["a blank payout invoice", { ...body, payoutInvoice: "   " }, "payoutInvoice"],
      ["a payout invoice over 4096 characters", { ...body, payoutInvoice: "f".repeat(4_097) }, "payoutInvoice"],
      ["demo as a string", { ...body, demo: "yes" }, "demo"],
    ])("400 validation_failed for %s, without calling the engine", async (_label, payload, field) => {
      const res = await http().post("/v1/swaps").send(payload);
      expect(res.status).toBe(400);
      const message = expectErrorBody(res.body, API_ERROR_CODE.VALIDATION);
      expect(message).toContain(field);
      expect(stubs.engine.createSwap).not.toHaveBeenCalled();
    });

    it("409 duplicate_hash when the engine reports a reused payment hash", async () => {
      stubs.engine.createSwap.mockRejectedValueOnce(new DuplicateHashError());
      const res = await http().post("/v1/swaps").send(body);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("duplicate_hash");
      expect(res.headers.location).toBeUndefined();
    });

    it.each([
      [422, API_ERROR_CODE.QUOTE_EXPIRED],
      [422, API_ERROR_CODE.INVOICE_INVALID],
      [404, API_ERROR_CODE.NOT_FOUND],
      [503, API_ERROR_CODE.UPSTREAM_UNAVAILABLE],
    ])("a HubError %i %s from the engine is answered as is", async (status, code) => {
      stubs.engine.createSwap.mockRejectedValueOnce(new HubError("A plain sentence for the user.", status, code));
      const res = await http().post("/v1/swaps").send(body);
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: { code, message: "A plain sentence for the user." } });
    });
  });

  describe("GET /v1/swaps/:id", () => {
    it("200 with the SwapDto", async () => {
      stubs.engine.add(makeSwap({ state: "outgoing_in_flight", demo: true }));
      const res = await http().get(`/v1/swaps/${SWAP_ID}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: SWAP_ID, state: "outgoing_in_flight", demo: true, preimage: null });
    });

    it("hides a known preimage until the swap has succeeded", async () => {
      stubs.engine.add(makeSwap({ state: "outgoing_succeeded", preimage: PREIMAGE }));
      const before = await http().get(`/v1/swaps/${SWAP_ID}`);
      expect(before.body.preimage).toBeNull();
      expect(JSON.stringify(before.body)).not.toContain(PREIMAGE);

      stubs.engine.add(makeSwap({ state: "succeeded", preimage: PREIMAGE }));
      const after = await http().get(`/v1/swaps/${SWAP_ID}`);
      expect(after.body.preimage).toBe(PREIMAGE);
    });

    it("shows a refunded failure with its reason", async () => {
      stubs.engine.add(makeSwap({ state: "failed", refunded: true, failureReason: "The payout failed." }));
      const res = await http().get(`/v1/swaps/${SWAP_ID}`);
      expect(res.body).toMatchObject({ state: "failed", refunded: true, failureReason: "The payout failed." });
    });

    it("404 not_found for an unknown swap", async () => {
      const res = await http().get(`/v1/swaps/${UNKNOWN_ID}`);
      expect(res.status).toBe(404);
      const message = expectErrorBody(res.body, API_ERROR_CODE.NOT_FOUND);
      expect(message).toMatch(/swap/i);
    });

    it("400 validation_failed for an id that is not a uuid", async () => {
      const res = await http().get("/v1/swaps/abc");
      expect(res.status).toBe(400);
      expectErrorBody(res.body, API_ERROR_CODE.VALIDATION);
      expect(stubs.engine.getSwap).not.toHaveBeenCalled();
    });
  });

  describe("GET /v1/swaps/:id/events", () => {
    const event = (at: number, type: string, swapId = SWAP_ID): SwapEvent => ({ swapId, at, type, detail: `${type} detail` });

    it("200 { data: SwapEventDto[] } in the engine's order, times as ISO 8601, without the swap id", async () => {
      stubs.engine.add(makeSwap());
      const t0 = Date.UTC(2026, 9, 23, 12, 0, 0);
      stubs.engine.events.push(event(t0, "created"), event(t0 + 1_000, "incoming_accepted"), event(t0, "created", UNKNOWN_ID));
      const res = await http().get(`/v1/swaps/${SWAP_ID}/events`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: [
          { at: "2026-10-23T12:00:00.000Z", type: "created", detail: "created detail" },
          { at: "2026-10-23T12:00:01.000Z", type: "incoming_accepted", detail: "incoming_accepted detail" },
        ],
      });
    });

    it("an existing swap without events is { data: [] }", async () => {
      stubs.engine.add(makeSwap());
      const res = await http().get(`/v1/swaps/${SWAP_ID}/events`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [] });
    });

    it("404 not_found for an unknown swap (not an empty list)", async () => {
      const res = await http().get(`/v1/swaps/${UNKNOWN_ID}/events`);
      expect(res.status).toBe(404);
      expectErrorBody(res.body, API_ERROR_CODE.NOT_FOUND);
    });

    it("400 validation_failed for an id that is not a uuid", async () => {
      const res = await http().get("/v1/swaps/xyz/events");
      expect(res.status).toBe(400);
      expectErrorBody(res.body, API_ERROR_CODE.VALIDATION);
    });
  });

  describe("demo routes (wallet stubbed)", () => {
    it("POST /v1/demo/invoices: 201 with the DemoInvoiceDto and the mapped input", async () => {
      const res = await http().post("/v1/demo/invoices").send({ direction: "ln_to_fiber", asset: "RUSD", amount: "250000000" });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ invoice: "fibd-demo-invoice", paymentHash: PAYMENT_HASH });
      expect(stubs.demo.createPayoutInvoice).toHaveBeenCalledWith({ direction: "ln_to_fiber", asset: "RUSD", amount: 250_000_000n });
    });

    it("POST /v1/demo/payments: 202 { swapId, status: submitted }", async () => {
      const res = await http().post("/v1/demo/payments").send({ swapId: SWAP_ID });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ swapId: SWAP_ID, status: "submitted" });
      expect(stubs.demo.payHoldInvoice).toHaveBeenCalledWith(SWAP_ID);
    });

    it.each([
      ["/v1/demo/invoices", { direction: "ln_to_fiber", asset: "CKB", amount: "0" }, "amount"],
      ["/v1/demo/invoices", { direction: "sideways", asset: "CKB", amount: "10" }, "direction"],
      ["/v1/demo/payments", { swapId: "swap-1" }, "swapId"],
      ["/v1/demo/payments", {}, "swapId"],
    ])("POST %s answers 400 validation_failed for a bad body", async (path, payload, field) => {
      const res = await http().post(path).send(payload);
      expect(res.status).toBe(400);
      const message = expectErrorBody(res.body, API_ERROR_CODE.VALIDATION);
      expect(message).toContain(field);
    });

    it.each(["/v1/demo/invoices", "/v1/demo/payments"])("POST %s answers 404 demo_disabled when the demo is off", async (path) => {
      stubs.demo.enabled = false;
      const res = await http().post(path).send({ direction: "ln_to_fiber", asset: "CKB", amount: "10", swapId: SWAP_ID });
      expect(res.status).toBe(404);
      expectErrorBody(res.body, API_ERROR_CODE.DEMO_DISABLED);
      expect(stubs.demo.createPayoutInvoice).not.toHaveBeenCalled();
      expect(stubs.demo.payHoldInvoice).not.toHaveBeenCalled();
    });

    it("demo_disabled is answered before body validation (a disabled demo does not describe its inputs)", async () => {
      stubs.demo.enabled = false;
      const res = await http().post("/v1/demo/payments").send({ swapId: "nope" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(API_ERROR_CODE.DEMO_DISABLED);
    });

    it("GET on a demo route is not a route (404 not_found)", async () => {
      const res = await http().get("/v1/demo/invoices");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(API_ERROR_CODE.NOT_FOUND);
    });
  });
});
