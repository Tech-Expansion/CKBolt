import { LIGHTNING_LIB_ERROR, LN_PAYMENT_REFUSAL_REASON, LND_PAYMENT_FAILURE_REASON } from "../../../src/common/constants/lnd.constants";
import { LND_BLOCK_PADDING_BLOCKS } from "../../../src/common/constants/protocol.constants";
import {
  LndRpcError,
  LndUnavailableError,
  LnInvoiceInvalidError,
  LnInvoiceWrongNetworkError,
} from "../../../src/infrastructure/lightning/lnd.errors";
import type { LndLightningAdapter } from "../../../src/infrastructure/lightning/lnd-lightning.adapter";
import { FakeClock } from "../../fakes";
import { GRPC_CODE, LND_DETAILS, PAYMENT_HASH, PREIMAGE, REGTEST_SETTINGS, START_HEIGHT, flushPromises, libError, libOnlyError } from "./lightning.fixtures";
import {
  LndPackageSimulator,
  confirmedEvent,
  confirmedPaymentResult,
  createAdapter,
  failedEvent,
  failedPaymentResult,
  payingEvent,
  pendingPaymentResult,
} from "./lnd-package.simulator";

const INVOICE_CLTV = 40;

const inFlight = { paymentHash: PAYMENT_HASH, state: "IN_FLIGHT", preimage: null, feeMsat: 0n, failureReason: null };

describe("LndLightningAdapter.payInvoice", () => {
  let sim: LndPackageSimulator;
  let adapter: LndLightningAdapter;
  let request: string;
  let args: { paymentRequest: string; maxFeeSats: bigint; cltvLimit: number; timeoutSeconds: number };

  const emitPaying = (): void => {
    sim.onPay = (stream) => stream.emit("paying", payingEvent(PAYMENT_HASH));
  };

  beforeEach(() => {
    sim = new LndPackageSimulator();
    adapter = createAdapter(sim, { clock: new FakeClock() });
    request = sim.addPayable({ hash: PAYMENT_HASH, mtokens: "250000", cltvDelta: INVOICE_CLTV });
    args = { paymentRequest: request, maxFeeSats: 250n, cltvLimit: 200, timeoutSeconds: 60 };
  });

  afterEach(() => adapter.close());

  /* ------------------------------------------------------------------------------------- what LND is asked */

  describe("a new payment", () => {
    it("sends with an explicit fee limit, the configured part count, max_timeout_height = height + cltvLimit and the timeout in ms", async () => {
      emitPaying();
      await expect(adapter.payInvoice(args)).resolves.toEqual(inFlight);

      expect(sim.rpc.subscribeToPayViaRequest).toHaveBeenCalledTimes(1);
      expect(sim.rpc.subscribeToPayViaRequest).toHaveBeenCalledWith({
        lnd: sim.lnd,
        request,
        max_fee: 250,
        max_paths: REGTEST_SETTINGS.maxPaymentParts,
        max_timeout_height: START_HEIGHT + 200,
        pathfinding_timeout: 60_000,
      });
    });

    it("never leaves the fee unlimited: a zero budget is sent as max_fee 0, not left out", async () => {
      emitPaying();
      await adapter.payInvoice({ ...args, maxFeeSats: 0n });
      const sent = sim.lastPayCall().args;
      expect(sent).toHaveProperty("max_fee", 0);
    });

    it("reads the block height when it pays, not earlier", async () => {
      emitPaying();
      sim.height = 912;
      await adapter.payInvoice(args);
      expect(sim.lastPayCall().args.max_timeout_height).toBe(912 + args.cltvLimit);
    });

    it("reports the invoice's payment hash", async () => {
      sim.onPay = (stream) => stream.emit("failed", failedEvent(PAYMENT_HASH, { is_route_not_found: true }));
      await expect(adapter.payInvoice(args)).resolves.toMatchObject({ paymentHash: PAYMENT_HASH });
    });

    it("checks for an existing payment of the invoice's hash before sending", async () => {
      emitPaying();
      await adapter.payInvoice(args);
      expect(sim.rpc.getPayment).toHaveBeenCalledWith({ lnd: sim.lnd, id: PAYMENT_HASH });
      expect(sim.rpc.getPayment.mock.invocationCallOrder[0]).toBeLessThan(sim.rpc.subscribeToPayViaRequest.mock.invocationCallOrder[0]!);
    });
  });

  /* ------------------------------------------------------------------------------------- argument checks */

  describe("argument checks (nothing is sent)", () => {
    const expectNothingSent = (): void => {
      expect(sim.rpc.subscribeToPayViaRequest).not.toHaveBeenCalled();
    };

    it("refuses a negative fee budget", async () => {
      await expect(adapter.payInvoice({ ...args, maxFeeSats: -1n })).rejects.toBeInstanceOf(RangeError);
      expectNothingSent();
    });

    it.each([200.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses a cltvLimit that is not a whole number of blocks (%p)", async (cltvLimit) => {
      await expect(adapter.payInvoice({ ...args, cltvLimit })).rejects.toBeInstanceOf(RangeError);
      expectNothingSent();
    });

    it.each([0, -5, Number.NaN])("refuses a timeout that is not positive (%p)", async (timeoutSeconds) => {
      await expect(adapter.payInvoice({ ...args, timeoutSeconds })).rejects.toBeInstanceOf(RangeError);
      expectNothingSent();
    });

    it("refuses a fee budget the package cannot carry as a number", async () => {
      await expect(adapter.payInvoice({ ...args, maxFeeSats: BigInt(Number.MAX_SAFE_INTEGER) + 1n })).rejects.toThrow();
      expectNothingSent();
    });

    it("refuses an unreadable invoice with LnInvoiceInvalidError", async () => {
      await expect(adapter.payInvoice({ ...args, paymentRequest: "lnbcrt1pgarbage" })).rejects.toBeInstanceOf(LnInvoiceInvalidError);
      expectNothingSent();
    });

    it("refuses an invoice for another network with LnInvoiceWrongNetworkError", async () => {
      const testnet = sim.addPayable({ hash: PAYMENT_HASH, prefix: "lntb", cltvDelta: INVOICE_CLTV });
      sim.rpc.decodePaymentRequest.mockRejectedValueOnce(libError("UnexpectedDecodePaymentRequestError", GRPC_CODE.UNKNOWN, LND_DETAILS.WRONG_NETWORK));
      await expect(adapter.payInvoice({ ...args, paymentRequest: testnet })).rejects.toBeInstanceOf(LnInvoiceWrongNetworkError);
      expectNothingSent();
    });

    it("sends nothing when the node's height cannot be read", async () => {
      sim.rpc.getWalletInfo.mockRejectedValueOnce(libError("GetWalletInfoErr", GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED));
      await expect(adapter.payInvoice(args)).rejects.toThrow();
      expectNothingSent();
    });
  });

  /* ---------------------------------------------------------------------------------------- CLTV safety */

  describe("cltv_limit safety", () => {
    it(`refuses, as FAILED ${LN_PAYMENT_REFUSAL_REASON.CLTV_LIMIT_TOO_LOW}, a limit that does not exceed the invoice CLTV + ${LND_BLOCK_PADDING_BLOCKS} blocks`, async () => {
      const status = await adapter.payInvoice({ ...args, cltvLimit: INVOICE_CLTV + LND_BLOCK_PADDING_BLOCKS });
      expect(status).toEqual({
        paymentHash: PAYMENT_HASH,
        state: "FAILED",
        preimage: null,
        feeMsat: 0n,
        failureReason: LN_PAYMENT_REFUSAL_REASON.CLTV_LIMIT_TOO_LOW,
      });
      expect(sim.rpc.subscribeToPayViaRequest).not.toHaveBeenCalled();
    });

    it("pays with the smallest limit above the invoice CLTV + padding", async () => {
      emitPaying();
      const cltvLimit = INVOICE_CLTV + LND_BLOCK_PADDING_BLOCKS + 1;
      await expect(adapter.payInvoice({ ...args, cltvLimit })).resolves.toMatchObject({ state: "IN_FLIGHT" });
      expect(sim.lastPayCall().args.max_timeout_height).toBe(START_HEIGHT + cltvLimit);
    });

    it("refuses cltvLimit 0 instead of letting LND fall back to its 2016-block default", async () => {
      await expect(adapter.payInvoice({ ...args, cltvLimit: 0 })).resolves.toMatchObject({ state: "FAILED", failureReason: LN_PAYMENT_REFUSAL_REASON.CLTV_LIMIT_TOO_LOW });
      expect(sim.rpc.subscribeToPayViaRequest).not.toHaveBeenCalled();
    });

    it("refuses a negative cltvLimit without sending", async () => {
      await expect(adapter.payInvoice({ ...args, cltvLimit: -10 })).resolves.toMatchObject({ state: "FAILED" });
      expect(sim.rpc.subscribeToPayViaRequest).not.toHaveBeenCalled();
    });

    it("uses the BOLT11 default CLTV (18) for an invoice without a `c` field", async () => {
      const noCltv = sim.addPayable({ hash: PAYMENT_HASH });
      await expect(adapter.payInvoice({ ...args, paymentRequest: noCltv, cltvLimit: 18 + LND_BLOCK_PADDING_BLOCKS })).resolves.toMatchObject({ state: "FAILED" });
      expect(sim.rpc.subscribeToPayViaRequest).not.toHaveBeenCalled();

      emitPaying();
      await expect(adapter.payInvoice({ ...args, paymentRequest: noCltv, cltvLimit: 18 + LND_BLOCK_PADDING_BLOCKS + 1 })).resolves.toMatchObject({ state: "IN_FLIGHT" });
    });
  });

  /* ---------------------------------------------------------------------------------------- idempotency */

  describe("idempotency per payment hash", () => {
    it("returns an existing SUCCEEDED payment and pays nothing", async () => {
      sim.setPayment(PAYMENT_HASH, confirmedPaymentResult(PAYMENT_HASH, PREIMAGE, "900"));
      await expect(adapter.payInvoice(args)).resolves.toEqual({ paymentHash: PAYMENT_HASH, state: "SUCCEEDED", preimage: PREIMAGE, feeMsat: 900n, failureReason: null });
      expect(sim.rpc.subscribeToPayViaRequest).not.toHaveBeenCalled();
      expect(sim.rpc.subscribeToPastPayment).not.toHaveBeenCalled();
    });

    it("returns an existing FAILED payment and never pays the hash a second time", async () => {
      sim.setPayment(PAYMENT_HASH, failedPaymentResult({ is_route_not_found: true }));
      await expect(adapter.payInvoice(args)).resolves.toMatchObject({ state: "FAILED", failureReason: LND_PAYMENT_FAILURE_REASON.NO_ROUTE });
      expect(sim.rpc.subscribeToPayViaRequest).not.toHaveBeenCalled();
      expect(sim.rpc.subscribeToPastPayment).not.toHaveBeenCalled();
    });

    it("returns an existing payment even when the new cltvLimit would be refused", async () => {
      sim.setPayment(PAYMENT_HASH, pendingPaymentResult(PAYMENT_HASH));
      await expect(adapter.payInvoice({ ...args, cltvLimit: 0 })).resolves.toEqual(inFlight);
      expect(sim.rpc.subscribeToPayViaRequest).not.toHaveBeenCalled();
    });

    it("follows an existing in-flight payment (after a restart) so its outcome reaches onUpdate", async () => {
      const listener = jest.fn();
      adapter.onUpdate(listener);
      sim.setPayment(PAYMENT_HASH, pendingPaymentResult(PAYMENT_HASH));

      await expect(adapter.payInvoice(args)).resolves.toEqual(inFlight);
      expect(sim.rpc.subscribeToPayViaRequest).not.toHaveBeenCalled();
      expect(sim.rpc.subscribeToPastPayment).toHaveBeenCalledWith({ lnd: sim.lnd, id: PAYMENT_HASH });

      const past = sim.pastPaymentCalls[0]!.stream;
      past.emit("paying", payingEvent(PAYMENT_HASH));
      expect(listener).not.toHaveBeenCalled();
      past.emit("confirmed", confirmedEvent(PAYMENT_HASH, PREIMAGE));
      expect(listener).toHaveBeenCalledWith(PAYMENT_HASH);
      expect(past.listenerCount("confirmed")).toBe(0);
    });

    it("follows an in-flight payment only once however often it is asked", async () => {
      sim.setPayment(PAYMENT_HASH, pendingPaymentResult(PAYMENT_HASH));
      await adapter.payInvoice(args);
      await adapter.payInvoice(args);
      expect(sim.rpc.subscribeToPastPayment).toHaveBeenCalledTimes(1);
    });

    it("pays once when asked twice: the second call sees LND's record and the stream already followed", async () => {
      emitPaying();
      await adapter.payInvoice(args);
      sim.setPayment(PAYMENT_HASH, pendingPaymentResult(PAYMENT_HASH));

      await expect(adapter.payInvoice(args)).resolves.toEqual(inFlight);
      expect(sim.rpc.subscribeToPayViaRequest).toHaveBeenCalledTimes(1);
      expect(sim.rpc.subscribeToPastPayment).not.toHaveBeenCalled();
    });

    it("does not pay when the existing-payment check cannot reach LND", async () => {
      sim.rpc.getPayment.mockRejectedValueOnce(libError("UnexpectedGetPaymentError", GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED));
      await expect(adapter.payInvoice(args)).rejects.toBeInstanceOf(LndUnavailableError);
      expect(sim.rpc.subscribeToPayViaRequest).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------------------------- stream outcomes */

  describe("first status and later outcomes", () => {
    it("resolves SUCCEEDED with the preimage and fee when the first event is the settlement", async () => {
      sim.onPay = (stream) => stream.emit("confirmed", confirmedEvent(PAYMENT_HASH, PREIMAGE.toUpperCase(), "2500"));
      await expect(adapter.payInvoice(args)).resolves.toEqual({ paymentHash: PAYMENT_HASH, state: "SUCCEEDED", preimage: PREIMAGE, feeMsat: 2_500n, failureReason: null });
    });

    it.each([
      [{ is_invalid_payment: true }, LND_PAYMENT_FAILURE_REASON.INCORRECT_PAYMENT_DETAILS],
      [{ is_insufficient_balance: true }, LND_PAYMENT_FAILURE_REASON.INSUFFICIENT_BALANCE],
      [{ is_route_not_found: true }, LND_PAYMENT_FAILURE_REASON.NO_ROUTE],
      [{ is_pathfinding_timeout: true }, LND_PAYMENT_FAILURE_REASON.TIMEOUT],
      [{ is_canceled: true }, LND_PAYMENT_FAILURE_REASON.CANCELED],
      [{}, LND_PAYMENT_FAILURE_REASON.ERROR],
    ])("resolves FAILED when LND reports failure %p (%s)", async (flags, reason) => {
      sim.onPay = (stream) => stream.emit("failed", failedEvent(PAYMENT_HASH, flags));
      await expect(adapter.payInvoice(args)).resolves.toEqual({ paymentHash: PAYMENT_HASH, state: "FAILED", preimage: null, feeMsat: 0n, failureReason: reason });
    });

    it("keeps listening after IN_FLIGHT: the settlement reaches onUpdate and the stream is released", async () => {
      const listener = jest.fn();
      adapter.onUpdate(listener);
      emitPaying();
      await adapter.payInvoice(args);
      const { stream } = sim.lastPayCall();

      stream.emit("paying", payingEvent(PAYMENT_HASH));
      expect(listener).not.toHaveBeenCalled();
      stream.emit("confirmed", confirmedEvent(PAYMENT_HASH, PREIMAGE));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(PAYMENT_HASH);
      expect(stream.listenerCount("confirmed")).toBe(0);
    });

    it("keeps listening after IN_FLIGHT: a failure reaches onUpdate", async () => {
      const listener = jest.fn();
      adapter.onUpdate(listener);
      emitPaying();
      await adapter.payInvoice(args);

      sim.lastPayCall().stream.emit("failed", failedEvent(PAYMENT_HASH, { is_invalid_payment: true }));
      expect(listener).toHaveBeenCalledWith(PAYMENT_HASH);
    });

    it("notifies listeners when the stream breaks after IN_FLIGHT, so the engine re-reads the payment", async () => {
      const listener = jest.fn();
      adapter.onUpdate(listener);
      emitPaying();
      await adapter.payInvoice(args);

      sim.lastPayCall().stream.emit("error", libError("UnexpectedPaymentError", GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED));
      expect(listener).toHaveBeenCalledWith(PAYMENT_HASH);
    });

    it("notifies listeners of a payment that fails at once", async () => {
      const listener = jest.fn();
      adapter.onUpdate(listener);
      sim.onPay = (stream) => stream.emit("failed", failedEvent(PAYMENT_HASH, { is_route_not_found: true }));
      await adapter.payInvoice(args);
      expect(listener).toHaveBeenCalledWith(PAYMENT_HASH);
    });

    it("stops following open payments on close", async () => {
      emitPaying();
      await adapter.payInvoice(args);
      const { stream } = sim.lastPayCall();
      adapter.close();
      expect(stream.listenerCount("confirmed")).toBe(0);
      expect(stream.listenerCount("error")).toBe(0);
    });
  });

  /* ------------------------------------------------------------------------- stream broken before a status */

  describe("a stream that breaks before its first status", () => {
    it.each([
      [LIGHTNING_LIB_ERROR.MAX_TIMEOUT_TOO_NEAR, LN_PAYMENT_REFUSAL_REASON.CLTV_LIMIT_TOO_LOW],
      [LIGHTNING_LIB_ERROR.UNSUPPORTED_PAYMENT_FEATURE, LN_PAYMENT_REFUSAL_REASON.UNSUPPORTED_INVOICE_FEATURE],
    ])("reports the package's pre-send refusal %s as FAILED %s (nothing was sent)", async (name, reason) => {
      sim.onPay = (stream) => stream.emit("error", [400, name, {}]);
      await expect(adapter.payInvoice(args)).resolves.toEqual({ paymentHash: PAYMENT_HASH, state: "FAILED", preimage: null, feeMsat: 0n, failureReason: reason });
    });

    it("takes LND's own record when it has one (IN_FLIGHT), and follows it", async () => {
      sim.onPay = (stream) => {
        sim.setPayment(PAYMENT_HASH, pendingPaymentResult(PAYMENT_HASH));
        stream.emit("error", libError("UnexpectedPaymentError", GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED));
      };
      await expect(adapter.payInvoice(args)).resolves.toEqual(inFlight);
      expect(sim.rpc.subscribeToPastPayment).toHaveBeenCalledWith({ lnd: sim.lnd, id: PAYMENT_HASH });
    });

    it("takes LND's own record when it has one (SUCCEEDED)", async () => {
      sim.onPay = (stream) => {
        sim.setPayment(PAYMENT_HASH, confirmedPaymentResult(PAYMENT_HASH, PREIMAGE));
        stream.emit("error", libError("UnexpectedPaymentError", GRPC_CODE.UNKNOWN, "stream reset"));
      };
      await expect(adapter.payInvoice(args)).resolves.toMatchObject({ state: "SUCCEEDED", preimage: PREIMAGE });
    });

    it("reports FAILED only when LND's record says FAILED", async () => {
      sim.onPay = (stream) => {
        sim.setPayment(PAYMENT_HASH, failedPaymentResult({ is_insufficient_balance: true }));
        stream.emit("error", libError("UnexpectedPaymentError", GRPC_CODE.UNKNOWN, "stream reset"));
      };
      await expect(adapter.payInvoice(args)).resolves.toMatchObject({ state: "FAILED", failureReason: LND_PAYMENT_FAILURE_REASON.INSUFFICIENT_BALANCE });
    });

    it("throws LndUnavailableError, never FAILED, when the stream broke in transport and LND has no record", async () => {
      sim.onPay = (stream) => stream.emit("error", libError("UnexpectedPaymentError", GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED));
      await expect(adapter.payInvoice(args)).rejects.toBeInstanceOf(LndUnavailableError);
    });

    it("throws, never FAILED, on an unexpected stream error with no record", async () => {
      sim.onPay = (stream) => stream.emit("error", libOnlyError("UnexpectedErrorInPaymentStream"));
      await expect(adapter.payInvoice(args)).rejects.toBeInstanceOf(LndRpcError);
    });

    it("throws, never FAILED, when LND's record cannot be read either", async () => {
      sim.onPay = (stream) => {
        sim.rpc.getPayment.mockRejectedValueOnce(libError("UnexpectedGetPaymentError", GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED));
        stream.emit("error", libError("UnexpectedPaymentError", GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED));
      };
      await expect(adapter.payInvoice(args)).rejects.toBeInstanceOf(LndUnavailableError);
    });

    it("throws, never FAILED, when the package refuses the call synchronously", async () => {
      sim.rpc.subscribeToPayViaRequest.mockImplementationOnce(() => {
        throw new Error("ExpectedValidPaymentRequestToMakePayment");
      });
      const result = await adapter.payInvoice(args).then(
        (status) => ({ status }),
        (error: unknown) => ({ error }),
      );
      expect(result).toHaveProperty("error");
    });

    it("answers once: a later event of the broken stream does not change the result", async () => {
      sim.onPay = (stream) => {
        stream.emit("error", [400, LIGHTNING_LIB_ERROR.MAX_TIMEOUT_TOO_NEAR, {}]);
        stream.emit("paying", payingEvent(PAYMENT_HASH));
      };
      await expect(adapter.payInvoice(args)).resolves.toMatchObject({ state: "FAILED" });
      await flushPromises();
    });
  });
});
