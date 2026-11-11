import "reflect-metadata";
import { createDemoInvoiceBodySchema, createQuoteBodySchema, createSwapBodySchema } from "../../../src/interfaces/http/contract/requests";
import { toCreateSwapInput, toDemoInvoiceInput, toQuoteRequest } from "../../../src/interfaces/http/mappers/request.mappers";
import { ApiPresenter, listOf, toDemoInvoiceDto, toDemoPaymentDto, toHealthDto } from "../../../src/interfaces/http/presenters/api.presenter";
import { makeQuote, makeSwap, okHealthReport, PREIMAGE, QUOTE_ID, SWAP_ID, testAssets, testConfig } from "./api.fixtures";

/** Request mappers (validated body -> application input) and the presenter (domain -> response DTO). */

describe("request mappers", () => {
  it("toQuoteRequest keeps the fields and turns the amount into an exact bigint", () => {
    const body = createQuoteBodySchema.parse({ direction: "fiber_to_ln", asset: "RUSD", side: "receive", amount: "999999999999999999999999999999" });
    expect(toQuoteRequest(body)).toEqual({ direction: "fiber_to_ln", asset: "RUSD", side: "receive", amount: 999_999_999_999_999_999_999_999_999_999n });
  });

  it("toCreateSwapInput passes quoteId and payout invoice, with the demo flag and client key the hub worked out", () => {
    const body = createSwapBodySchema.parse({ quoteId: QUOTE_ID, payoutInvoice: "lnbcrt1abc" });
    expect(toCreateSwapInput(body, true, "203.0.113.5")).toEqual({ quoteId: QUOTE_ID, payoutInvoice: "lnbcrt1abc", demo: true, clientKey: "203.0.113.5" });
    expect(toCreateSwapInput(body, false, "::1")).toEqual({ quoteId: QUOTE_ID, payoutInvoice: "lnbcrt1abc", demo: false, clientKey: "::1" });
  });

  it("toCreateSwapInput never takes the demo flag from the request body", () => {
    const body = createSwapBodySchema.parse({ quoteId: QUOTE_ID, payoutInvoice: "lnbcrt1abc", demo: true });
    expect(toCreateSwapInput(body, false, "::1").demo).toBe(false);
  });

  it("toDemoInvoiceInput turns the amount into a bigint", () => {
    const body = createDemoInvoiceBodySchema.parse({ direction: "ln_to_fiber", asset: "CKB", amount: "100000000" });
    expect(toDemoInvoiceInput(body)).toEqual({ direction: "ln_to_fiber", asset: "CKB", amount: 100_000_000n });
  });
});

describe("presenter helpers", () => {
  it("listOf wraps a collection as { data }", () => {
    expect(listOf([1, 2])).toEqual({ data: [1, 2] });
    expect(listOf([])).toEqual({ data: [] });
  });

  it("toHealthDto copies the report without sharing nested objects", () => {
    const report = okHealthReport({ status: "degraded" });
    const dto = toHealthDto(report);
    expect(dto).toEqual(report);
    expect(dto.lightning).not.toBe(report.lightning);
    expect(dto.fiber).not.toBe(report.fiber);
    expect(dto.demo).not.toBe(report.demo);
  });

  it("toDemoInvoiceDto keeps only invoice and paymentHash (never a preimage)", () => {
    const withExtras = { invoice: "fibd1x", paymentHash: "ab".repeat(32), preimage: PREIMAGE } as { invoice: string; paymentHash: string };
    expect(toDemoInvoiceDto(withExtras)).toEqual({ invoice: "fibd1x", paymentHash: "ab".repeat(32) });
  });

  it("toDemoPaymentDto says the payment was submitted", () => {
    expect(toDemoPaymentDto(SWAP_ID)).toEqual({ swapId: SWAP_ID, status: "submitted" });
  });
});

describe("ApiPresenter", () => {
  const presenter = new ApiPresenter(testAssets(testConfig()));

  it("quote(): legs follow the direction, amounts as strings, times as ISO 8601", () => {
    const dto = presenter.quote(makeQuote({ direction: "ln_to_fiber", asset: "RUSD", sats: 1_234n, fiberAmount: 99_000_000n }));
    expect(dto.pay).toEqual({ network: "lightning", asset: "BTC", amount: "1234", decimals: 8 });
    expect(dto.receive).toEqual({ network: "fiber", asset: "RUSD", amount: "99000000", decimals: 8 });
    expect(dto.createdAt).toBe("2026-10-23T12:00:00.000Z");
    expect(dto.expiresAt).toBe("2026-10-23T12:03:00.000Z");
    expect(dto.prices.at).toBe("2026-10-23T11:59:55.000Z");
  });

  it("swap(): pay.invoice is the hold invoice, receive.invoice the payout invoice, links point at the resource", () => {
    const dto = presenter.swap(makeSwap({ direction: "fiber_to_ln", holdInvoice: "fibd-hold", payoutInvoice: "lnbcrt-payout" }));
    expect(dto.pay).toEqual({ network: "fiber", asset: "CKB", amount: "2000000000000", decimals: 8, invoice: "fibd-hold" });
    expect(dto.receive).toEqual({ network: "lightning", asset: "BTC", amount: "50000", decimals: 8, invoice: "lnbcrt-payout" });
    expect(dto.links).toEqual({ self: `/v1/swaps/${SWAP_ID}`, events: `/v1/swaps/${SWAP_ID}/events` });
  });

  it.each(["pending", "incoming_accepted", "outgoing_in_flight", "outgoing_succeeded", "failed"] as const)(
    "swap(): hides the preimage while the swap is %s",
    (state) => {
      expect(presenter.swap(makeSwap({ state, preimage: PREIMAGE })).preimage).toBeNull();
    },
  );

  it("swap(): shows the preimage once the swap has succeeded", () => {
    expect(presenter.swap(makeSwap({ state: "succeeded", preimage: PREIMAGE })).preimage).toBe(PREIMAGE);
  });

  it("does not expose internal swap fields", () => {
    const dto = presenter.swap(makeSwap()) as unknown as Record<string, unknown>;
    for (const internal of ["holdCltvExpiry", "holdFinalExpiryDeltaMs", "payoutLockLimit", "sats", "fiberAmount", "holdInvoice", "payoutInvoice"]) {
      expect(dto).not.toHaveProperty(internal);
    }
  });

  it("throws for an asset missing from the registry (a server-side inconsistency)", () => {
    expect(() => presenter.quote(makeQuote({ asset: "CWBTC" }))).toThrow();
    expect(() => presenter.swap(makeSwap({ asset: "CWBTC" }))).toThrow();
  });
});
