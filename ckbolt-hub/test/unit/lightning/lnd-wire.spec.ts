import { HttpStatus } from "@nestjs/common";
import { systemClock } from "../../../src/application/ports/clock.port";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { LN_PAYMENT_REFUSAL_REASON, LND_PAYMENT_FAILURE_REASON } from "../../../src/common/constants/lnd.constants";
import { LND_BLOCK_PADDING_BLOCKS } from "../../../src/common/constants/protocol.constants";
import { DuplicateHashError } from "../../../src/common/errors/hub.error";
import { LndLightningAdapter } from "../../../src/infrastructure/lightning/lnd-lightning.adapter";
import { LndUnavailableError, LnInvoiceInvalidError, LnInvoiceWrongNetworkError } from "../../../src/infrastructure/lightning/lnd.errors";
import { GRPC_CODE, HUB_PUBKEY, LND_DETAILS, LND_VERSION, PAYEE_PUBKEY, PAYMENT_HASH, PREIMAGE, REGTEST_SETTINGS, START_HEIGHT, makeBolt11 } from "./lightning.fixtures";
import { answer, createGrpcStub, fail, rawGetInfo, rawHtlc, rawInvoice, rawPayReq, rawPayment, type LndGrpcStub } from "./lnd-grpc.stub";

/**
 * The adapter with the real `lightning` 13.1.7 functions (the default LndRpc) over a stubbed LND gRPC connection. These
 * tests pin how the adapter reads the package's real results and errors, which the package-level tests can only imitate.
 * The package computes hold-invoice expiries from the wall clock, so these tests give the adapter the system clock.
 */

const INVOICE_CLTV = 40;
const INVOICE_MSAT = 250_000n;

describe("LndLightningAdapter over the real `lightning` package", () => {
  let stub: LndGrpcStub;
  let adapter: LndLightningAdapter;

  beforeEach(() => {
    stub = createGrpcStub();
    adapter = new LndLightningAdapter(stub.lnd, REGTEST_SETTINGS, systemClock);
  });

  afterEach(() => adapter.close());

  /** A real BOLT11 invoice that the stubbed DecodePayReq also knows. */
  function payableInvoice(options: { cltv?: number; msat?: bigint } = {}): string {
    const createdAtMs = Date.now();
    const cltv = options.cltv ?? INVOICE_CLTV;
    const msat = options.msat ?? INVOICE_MSAT;
    const request = makeBolt11({ hash: PAYMENT_HASH, mtokens: msat.toString(), cltvDelta: cltv, createdAtMs, expirySeconds: 3_600 });
    answer(stub.default.decodePayReq, () =>
      rawPayReq({ hash: PAYMENT_HASH, msat, cltv, timestamp: Math.floor(createdAtMs / 1_000), expiry: 3_600, description: "ckbolt payout" }),
    );
    return request;
  }

  describe("GetInfo", () => {
    it("maps LND's GetInfo response", async () => {
      await expect(adapter.getInfo()).resolves.toEqual({ pubkey: HUB_PUBKEY, network: "regtest", blockHeight: START_HEIGHT, synced: true, version: LND_VERSION, uris: [] });
    });

    it("reports a node it cannot connect to as LndUnavailableError (503), like every other call does", async () => {
      fail(stub.default.getInfo, GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED);
      const error = await adapter.getInfo().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(LndUnavailableError);
      expect(error).toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE, code: API_ERROR_CODE.UPSTREAM_UNAVAILABLE });
    });
  });

  describe("DecodePayReq", () => {
    it("decodes a real BOLT11 invoice through LND's answer", async () => {
      const createdAtSeconds = Math.floor(Date.now() / 1_000);
      const request = makeBolt11({ hash: PAYMENT_HASH, mtokens: "250000", cltvDelta: 40 });
      answer(stub.default.decodePayReq, () => rawPayReq({ hash: PAYMENT_HASH, msat: 250_000n, cltv: 40, timestamp: createdAtSeconds, expiry: 600, description: "BTC" }));

      await expect(adapter.decodeInvoice(request)).resolves.toEqual({
        paymentHash: PAYMENT_HASH,
        amountMsat: 250_000n,
        network: "regtest",
        createdAt: createdAtSeconds * 1_000,
        expiresAt: (createdAtSeconds + 600) * 1_000,
        cltvExpiry: 40,
        destination: PAYEE_PUBKEY,
        description: "BTC",
      });
      expect(stub.default.decodePayReq.mock.calls[0]?.[0]).toEqual({ pay_req: request });
    });

    it("decodes an invoice without an amount (LND sends int64 zero as the string \"0\") to a null amount", async () => {
      const request = makeBolt11({ hash: PAYMENT_HASH, cltvDelta: 40 });
      answer(stub.default.decodePayReq, () => rawPayReq({ hash: PAYMENT_HASH, msat: 0n, cltv: 40, timestamp: Math.floor(Date.now() / 1_000), expiry: 600, description: "any" }));
      await expect(adapter.decodeInvoice(request)).resolves.toMatchObject({ amountMsat: null });
    });

    it("maps LND's wrong-network answer to LnInvoiceWrongNetworkError (422)", async () => {
      const request = makeBolt11({ network: "testnet", mtokens: "1000" });
      fail(stub.default.decodePayReq, GRPC_CODE.UNKNOWN, LND_DETAILS.WRONG_NETWORK);
      await expect(adapter.decodeInvoice(request)).rejects.toBeInstanceOf(LnInvoiceWrongNetworkError);
    });

    it("maps LND's parse error to LnInvoiceInvalidError (400)", async () => {
      fail(stub.default.decodePayReq, GRPC_CODE.UNKNOWN, "checksum failed");
      await expect(adapter.decodeInvoice("lnbcrt1pbroken")).rejects.toBeInstanceOf(LnInvoiceInvalidError);
    });

    it("maps a lost connection to LndUnavailableError (503)", async () => {
      fail(stub.default.decodePayReq, GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED);
      await expect(adapter.decodeInvoice(makeBolt11())).rejects.toBeInstanceOf(LndUnavailableError);
    });
  });

  describe("AddHoldInvoice", () => {
    const holdArgs = { paymentHash: PAYMENT_HASH, amountSats: 25_000n, expirySeconds: 180, cltvExpiry: 144, memo: "CKBolt swap" };

    it("asks LND for a hold invoice on the swap hash with value, expiry seconds, cltv_expiry and memo", async () => {
      const request = makeBolt11({ hash: PAYMENT_HASH, mtokens: "25000000", cltvDelta: 144 });
      answer(stub.invoices.addHoldInvoice, () => ({ payment_request: request, add_index: "1", payment_addr: Buffer.alloc(32) }));

      await expect(adapter.createHoldInvoice(holdArgs)).resolves.toEqual({ paymentRequest: request });

      const sent = stub.invoices.addHoldInvoice.mock.calls[0]?.[0] as Record<string, unknown>;
      expect((sent.hash as Buffer).toString("hex")).toBe(PAYMENT_HASH);
      expect(sent.value).toBe(25_000);
      expect(sent.cltv_expiry).toBe(144);
      expect(sent.memo).toBe("CKBolt swap");
      expect(Math.abs(Number(sent.expiry) - 180)).toBeLessThanOrEqual(1);
    });

    it("maps LND's duplicate-hash error to DuplicateHashError (409)", async () => {
      fail(stub.invoices.addHoldInvoice, GRPC_CODE.UNKNOWN, LND_DETAILS.DUPLICATE);
      await expect(adapter.createHoldInvoice(holdArgs)).rejects.toBeInstanceOf(DuplicateHashError);
    });

    it("never creates a hold invoice with LND's 24-hour default expiry when the remaining validity is 0 seconds", async () => {
      answer(stub.invoices.addHoldInvoice, () => ({ payment_request: makeBolt11({ mtokens: "25000000" }), add_index: "1", payment_addr: Buffer.alloc(32) }));
      await adapter.createHoldInvoice({ ...holdArgs, expirySeconds: 0 }).catch(() => undefined);

      for (const [request] of stub.invoices.addHoldInvoice.mock.calls as [Record<string, unknown>][]) {
        const expiry = Number(request.expiry ?? 0);
        expect(expiry).toBeGreaterThan(0);
      }
    });
  });

  describe("LookupInvoice", () => {
    it("reads an ACCEPTED invoice: paid amount and the expiry height of each held HTLC", async () => {
      answer(stub.default.lookupInvoice, () =>
        rawInvoice({
          hash: PAYMENT_HASH,
          state: "ACCEPTED",
          valueMsat: "25000000",
          amtPaidMsat: "25000000",
          htlcs: [rawHtlc("ACCEPTED", 652, "20000000"), rawHtlc("ACCEPTED", 648, "5000000"), rawHtlc("CANCELED", 630, "5000000")],
        }),
      );

      await expect(adapter.lookupInvoice(PAYMENT_HASH)).resolves.toEqual({
        paymentHash: PAYMENT_HASH,
        state: "ACCEPTED",
        amountMsat: 25_000_000n,
        amountPaidMsat: 25_000_000n,
        htlcExpiryHeights: [652, 648],
      });
      expect((stub.default.lookupInvoice.mock.calls[0]?.[0] as { r_hash: Buffer }).r_hash.toString("hex")).toBe(PAYMENT_HASH);
    });

    it.each([
      ["OPEN", "OPEN"],
      ["SETTLED", "SETTLED"],
      ["CANCELED", "CANCELED"],
    ] as const)("maps LND state %s to %s", async (lndState, state) => {
      answer(stub.default.lookupInvoice, () => rawInvoice({ hash: PAYMENT_HASH, state: lndState, valueMsat: "25000000", amtPaidMsat: "0" }));
      await expect(adapter.lookupInvoice(PAYMENT_HASH)).resolves.toMatchObject({ state, htlcExpiryHeights: [] });
    });

    it("returns null when LND answers NOT_FOUND", async () => {
      fail(stub.default.lookupInvoice, GRPC_CODE.NOT_FOUND, LND_DETAILS.INVOICE_NOT_FOUND);
      await expect(adapter.lookupInvoice(PAYMENT_HASH)).resolves.toBeNull();
    });
  });

  describe("SettleInvoice and CancelInvoice", () => {
    it("settles with the preimage bytes", async () => {
      await adapter.settleInvoice(PREIMAGE);
      expect((stub.invoices.settleInvoice.mock.calls[0]?.[0] as { preimage: Buffer }).preimage.toString("hex")).toBe(PREIMAGE);
    });

    it("treats 'invoice already settled' as success and 'invoice already canceled' as failure when settling", async () => {
      fail(stub.invoices.settleInvoice, GRPC_CODE.UNKNOWN, LND_DETAILS.ALREADY_SETTLED);
      await expect(adapter.settleInvoice(PREIMAGE)).resolves.toBeUndefined();
      fail(stub.invoices.settleInvoice, GRPC_CODE.UNKNOWN, LND_DETAILS.ALREADY_CANCELED);
      await expect(adapter.settleInvoice(PREIMAGE)).rejects.toThrow();
    });

    it("cancels with the payment hash bytes", async () => {
      await adapter.cancelInvoice(PAYMENT_HASH);
      expect((stub.invoices.cancelInvoice.mock.calls[0]?.[0] as { payment_hash: Buffer }).payment_hash.toString("hex")).toBe(PAYMENT_HASH);
    });

    it("treats 'invoice already canceled' as success and 'invoice already settled' as failure when cancelling", async () => {
      fail(stub.invoices.cancelInvoice, GRPC_CODE.UNKNOWN, LND_DETAILS.ALREADY_CANCELED);
      await expect(adapter.cancelInvoice(PAYMENT_HASH)).resolves.toBeUndefined();
      fail(stub.invoices.cancelInvoice, GRPC_CODE.UNKNOWN, LND_DETAILS.ALREADY_SETTLED);
      await expect(adapter.cancelInvoice(PAYMENT_HASH)).rejects.toThrow();
    });

    it("reports a lost connection while settling as LndUnavailableError", async () => {
      fail(stub.invoices.settleInvoice, GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED);
      await expect(adapter.settleInvoice(PREIMAGE)).rejects.toBeInstanceOf(LndUnavailableError);
    });
  });

  describe("TrackPaymentV2 (getPayment)", () => {
    it("returns null when LND says the payment isn't initiated", async () => {
      await expect(adapter.getPayment(PAYMENT_HASH)).resolves.toBeNull();
      expect((stub.router.trackPaymentV2.mock.calls[0]?.[0] as { payment_hash: Buffer }).payment_hash.toString("hex")).toBe(PAYMENT_HASH);
    });

    it("reads a SUCCEEDED payment's preimage and fee", async () => {
      stub.onTrack = (stream) => stream.emit("data", rawPayment(PAYMENT_HASH, "SUCCEEDED", { preimage: PREIMAGE, feeMsat: "1500" }));
      await expect(adapter.getPayment(PAYMENT_HASH)).resolves.toEqual({ paymentHash: PAYMENT_HASH, state: "SUCCEEDED", preimage: PREIMAGE, feeMsat: 1_500n, failureReason: null });
    });

    it("reads an IN_FLIGHT payment", async () => {
      stub.onTrack = (stream) => stream.emit("data", rawPayment(PAYMENT_HASH, "IN_FLIGHT"));
      await expect(adapter.getPayment(PAYMENT_HASH)).resolves.toMatchObject({ state: "IN_FLIGHT", preimage: null });
    });

    it.each([
      ["FAILURE_REASON_NO_ROUTE", LND_PAYMENT_FAILURE_REASON.NO_ROUTE],
      ["FAILURE_REASON_INCORRECT_PAYMENT_DETAILS", LND_PAYMENT_FAILURE_REASON.INCORRECT_PAYMENT_DETAILS],
      ["FAILURE_REASON_TIMEOUT", LND_PAYMENT_FAILURE_REASON.TIMEOUT],
      ["FAILURE_REASON_INSUFFICIENT_BALANCE", LND_PAYMENT_FAILURE_REASON.INSUFFICIENT_BALANCE],
      ["FAILURE_REASON_CANCELED", LND_PAYMENT_FAILURE_REASON.CANCELED],
      ["FAILURE_REASON_ERROR", LND_PAYMENT_FAILURE_REASON.ERROR],
    ])("reads a FAILED payment with %s", async (lndReason, reason) => {
      stub.onTrack = (stream) => stream.emit("data", rawPayment(PAYMENT_HASH, "FAILED", { failureReason: lndReason }));
      await expect(adapter.getPayment(PAYMENT_HASH)).resolves.toMatchObject({ state: "FAILED", failureReason: reason });
    });

    it("reports a lost connection as LndUnavailableError, never as 'no payment'", async () => {
      stub.onTrack = (stream) => stream.emit("error", Object.assign(new Error("14 UNAVAILABLE"), { code: GRPC_CODE.UNAVAILABLE, details: LND_DETAILS.CONNECT_FAILED }));
      await expect(adapter.getPayment(PAYMENT_HASH)).rejects.toBeInstanceOf(LndUnavailableError);
    });
  });

  describe("SendPaymentV2 (payInvoice)", () => {
    const payArgs = (request: string) => ({ paymentRequest: request, maxFeeSats: 250n, cltvLimit: 200, timeoutSeconds: 60 });

    it("sends with fee_limit_sat, cltv_limit and timeout_seconds as LND receives them, and resolves IN_FLIGHT", async () => {
      const request = payableInvoice();
      stub.onSend = (stream) => stream.emit("data", rawPayment(PAYMENT_HASH, "IN_FLIGHT"));

      await expect(adapter.payInvoice(payArgs(request))).resolves.toMatchObject({ paymentHash: PAYMENT_HASH, state: "IN_FLIGHT" });

      const sent = stub.router.sendPaymentV2.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sent.payment_request).toBe(request);
      expect(sent.fee_limit_sat).toBe(250);
      expect(sent.fee_limit_msat).toBeUndefined();
      expect(sent.cltv_limit).toBe(200);
      expect(sent.timeout_seconds).toBe(60);
    });

    it("sends a zero fee budget as fee_limit_sat 0, never as the package's unlimited default", async () => {
      const request = payableInvoice();
      stub.onSend = (stream) => stream.emit("data", rawPayment(PAYMENT_HASH, "IN_FLIGHT"));
      await adapter.payInvoice({ ...payArgs(request), maxFeeSats: 0n });
      expect((stub.router.sendPaymentV2.mock.calls[0]?.[0] as Record<string, unknown>).fee_limit_sat).toBe(0);
    });

    it("reports the settlement to onUpdate after resolving IN_FLIGHT", async () => {
      const listener = jest.fn();
      adapter.onUpdate(listener);
      const request = payableInvoice();
      stub.onSend = (stream) => stream.emit("data", rawPayment(PAYMENT_HASH, "IN_FLIGHT"));
      await adapter.payInvoice(payArgs(request));

      stub.sendStreams[0]!.emit("data", rawPayment(PAYMENT_HASH, "SUCCEEDED", { preimage: PREIMAGE }));
      expect(listener).toHaveBeenCalledWith(PAYMENT_HASH);
    });

    it("resolves FAILED with LND's reason when LND fails the payment", async () => {
      const request = payableInvoice();
      stub.onSend = (stream) => stream.emit("data", rawPayment(PAYMENT_HASH, "FAILED", { failureReason: "FAILURE_REASON_NO_ROUTE" }));
      await expect(adapter.payInvoice(payArgs(request))).resolves.toMatchObject({ state: "FAILED", failureReason: LND_PAYMENT_FAILURE_REASON.NO_ROUTE });
    });

    it("returns LND's existing payment and sends nothing", async () => {
      const request = payableInvoice();
      stub.onTrack = (stream) => stream.emit("data", rawPayment(PAYMENT_HASH, "SUCCEEDED", { preimage: PREIMAGE }));
      await expect(adapter.payInvoice(payArgs(request))).resolves.toMatchObject({ state: "SUCCEEDED", preimage: PREIMAGE });
      expect(stub.router.sendPaymentV2).not.toHaveBeenCalled();
    });

    it("reports FAILED CLTV_LIMIT_TOO_LOW, with nothing sent, when a block arrives between the checks and the package refuses", async () => {
      const request = payableInvoice();
      const cltvLimit = INVOICE_CLTV + LND_BLOCK_PADDING_BLOCKS + 1;
      answer(stub.default.getInfo, () => {
        const info = rawGetInfo(stub.height);
        stub.height += 2;
        return info;
      });

      await expect(adapter.payInvoice({ ...payArgs(request), cltvLimit })).resolves.toMatchObject({
        state: "FAILED",
        failureReason: LN_PAYMENT_REFUSAL_REASON.CLTV_LIMIT_TOO_LOW,
      });
      expect(stub.router.sendPaymentV2).not.toHaveBeenCalled();
    });

    it("reads LND's record instead of guessing when the send stream breaks before any status", async () => {
      const request = payableInvoice();
      let tracked = 0;
      stub.onTrack = (stream) => {
        tracked += 1;
        if (tracked === 1) stream.emit("error", Object.assign(new Error("5 NOT_FOUND"), { code: GRPC_CODE.NOT_FOUND, details: LND_DETAILS.PAYMENT_NOT_INITIATED }));
        else stream.emit("data", rawPayment(PAYMENT_HASH, "IN_FLIGHT"));
      };
      stub.onSend = (stream) => stream.emit("error", Object.assign(new Error("14 UNAVAILABLE"), { code: GRPC_CODE.UNAVAILABLE, details: "connection dropped" }));

      await expect(adapter.payInvoice(payArgs(request))).resolves.toMatchObject({ state: "IN_FLIGHT" });
    });

    it("throws, never FAILED, when the send stream breaks and LND has no record", async () => {
      const request = payableInvoice();
      stub.onSend = (stream) => stream.emit("error", Object.assign(new Error("14 UNAVAILABLE"), { code: GRPC_CODE.UNAVAILABLE, details: "connection dropped" }));
      await expect(adapter.payInvoice(payArgs(request))).rejects.toBeInstanceOf(LndUnavailableError);
    });
  });
});
