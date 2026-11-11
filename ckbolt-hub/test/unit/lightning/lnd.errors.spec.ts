import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { LIGHTNING_LIB_ERROR, LND_RPC } from "../../../src/common/constants/lnd.constants";
import { BOLT11_PREFIXES } from "../../../src/common/constants/protocol.constants";
import { DuplicateHashError, HubError } from "../../../src/common/errors/hub.error";
import {
  hasLndDetails,
  isAccessDenied,
  isInvoiceNotFound,
  isPaymentNotFound,
  isTransportFailure,
  LndRpcError,
  LndUnavailableError,
  LnInvoiceInvalidError,
  LnInvoiceWrongNetworkError,
  readLndError,
  toLndError,
  type LndErrorInfo,
} from "../../../src/infrastructure/lightning/lnd.errors";
import { GRPC_CODE, LND_DETAILS, grpcError, libError, libOnlyError } from "./lightning.fixtures";

const info = (grpcCode: number | null, details = "", name = "SomeError"): LndErrorInfo => ({ name, grpcCode, details });

describe("readLndError", () => {
  it("reads the name and LND's gRPC code and details from a `lightning` package error array", () => {
    expect(readLndError(libError("UnexpectedLookupInvoiceErr", GRPC_CODE.NOT_FOUND, LND_DETAILS.INVOICE_NOT_FOUND))).toEqual({
      name: "UnexpectedLookupInvoiceErr",
      grpcCode: GRPC_CODE.NOT_FOUND,
      details: LND_DETAILS.INVOICE_NOT_FOUND,
    });
  });

  it("reads a package error array that carries no gRPC error", () => {
    expect(readLndError(libOnlyError(LIGHTNING_LIB_ERROR.PAYMENT_NOT_FOUND, 404))).toEqual({ name: LIGHTNING_LIB_ERROR.PAYMENT_NOT_FOUND, grpcCode: null, details: "" });
    expect(readLndError([400, LIGHTNING_LIB_ERROR.MAX_TIMEOUT_TOO_NEAR, { last_cltv: 40, max_delta: 30 }])).toEqual({
      name: LIGHTNING_LIB_ERROR.MAX_TIMEOUT_TOO_NEAR,
      grpcCode: null,
      details: "",
    });
  });

  it("reads a raw gRPC error thrown as an Error", () => {
    expect(readLndError(grpcError(GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED))).toEqual({
      name: `${GRPC_CODE.UNAVAILABLE} ${LND_DETAILS.CONNECT_FAILED}`,
      grpcCode: GRPC_CODE.UNAVAILABLE,
      details: LND_DETAILS.CONNECT_FAILED,
    });
  });

  it("reads a plain Error and anything else thrown", () => {
    expect(readLndError(new Error("ExpectedValidPaymentRequestToMakePayment"))).toEqual({ name: "ExpectedValidPaymentRequestToMakePayment", grpcCode: null, details: "" });
    expect(readLndError("boom")).toEqual({ name: "boom", grpcCode: null, details: "" });
    expect(readLndError(undefined)).toEqual({ name: "undefined", grpcCode: null, details: "" });
  });

  it("ignores gRPC fields of the wrong type", () => {
    expect(readLndError([503, "X", { err: { code: "14", details: 42 } }])).toEqual({ name: "X", grpcCode: null, details: "" });
  });
});

describe("LND error classifiers", () => {
  it.each([
    [GRPC_CODE.UNAVAILABLE, true],
    [GRPC_CODE.DEADLINE_EXCEEDED, true],
    [GRPC_CODE.NOT_FOUND, false],
    [GRPC_CODE.UNKNOWN, false],
    [null, false],
  ])("isTransportFailure(code %p) is %p", (code, expected) => {
    expect(isTransportFailure(info(code))).toBe(expected);
  });

  it("isAccessDenied recognises PERMISSION_DENIED, UNAUTHENTICATED and LND's permission text", () => {
    expect(isAccessDenied(info(GRPC_CODE.PERMISSION_DENIED))).toBe(true);
    expect(isAccessDenied(info(GRPC_CODE.UNAUTHENTICATED))).toBe(true);
    expect(isAccessDenied(info(GRPC_CODE.UNKNOWN, "verification failed: permission denied"))).toBe(true);
    expect(isAccessDenied(info(GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED))).toBe(false);
  });

  it("isInvoiceNotFound recognises NOT_FOUND and both of LND's 'no invoice' texts", () => {
    expect(isInvoiceNotFound(info(GRPC_CODE.NOT_FOUND))).toBe(true);
    expect(isInvoiceNotFound(info(GRPC_CODE.UNKNOWN, LND_DETAILS.INVOICE_NOT_FOUND))).toBe(true);
    expect(isInvoiceNotFound(info(GRPC_CODE.UNKNOWN, LND_DETAILS.NO_INVOICES))).toBe(true);
    expect(isInvoiceNotFound(info(GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED))).toBe(false);
    expect(isInvoiceNotFound(info(null, "", "UnexpectedLookupInvoiceErr"))).toBe(false);
  });

  it("isPaymentNotFound recognises the package's SentPaymentNotFound and gRPC NOT_FOUND only", () => {
    expect(isPaymentNotFound(info(null, "", LIGHTNING_LIB_ERROR.PAYMENT_NOT_FOUND))).toBe(true);
    expect(isPaymentNotFound(info(GRPC_CODE.NOT_FOUND))).toBe(true);
    expect(isPaymentNotFound(info(null, "", "UnknownStatusOfPayment"))).toBe(false);
    expect(isPaymentNotFound(info(GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED))).toBe(false);
  });

  it("hasLndDetails matches a substring of LND's details", () => {
    expect(hasLndDetails(info(GRPC_CODE.UNKNOWN, LND_DETAILS.WRONG_NETWORK), "invoice not for current active network")).toBe(true);
    expect(hasLndDetails(info(GRPC_CODE.UNKNOWN, ""), "invoice")).toBe(false);
  });
});

describe("toLndError", () => {
  it("passes HubErrors and LndRpcErrors through unchanged", () => {
    const duplicate = new DuplicateHashError();
    const rpcError = new LndRpcError(LND_RPC.GET_INFO, info(GRPC_CODE.UNKNOWN, "x"));
    expect(toLndError(LND_RPC.ADD_HOLD_INVOICE, duplicate)).toBe(duplicate);
    expect(toLndError(LND_RPC.ADD_HOLD_INVOICE, rpcError)).toBe(rpcError);
  });

  it.each([GRPC_CODE.UNAVAILABLE, GRPC_CODE.DEADLINE_EXCEEDED])("turns transport failure code %p into LndUnavailableError (503)", (code) => {
    const error = toLndError(LND_RPC.SETTLE_INVOICE, libError("UnexpectedErrorWhenSettlingHodlInvoice", code, LND_DETAILS.CONNECT_FAILED));
    expect(error).toBeInstanceOf(LndUnavailableError);
    expect(error).toBeInstanceOf(HubError);
    expect(error).toMatchObject({ rpc: LND_RPC.SETTLE_INVOICE, status: HttpStatus.SERVICE_UNAVAILABLE, code: API_ERROR_CODE.UPSTREAM_UNAVAILABLE });
  });

  it("turns any other error into an internal LndRpcError naming the RPC and LND's details", () => {
    const error = toLndError(LND_RPC.CANCEL_INVOICE, libError("UnexpectedErrorCancelingHodlInvoice", GRPC_CODE.UNKNOWN, LND_DETAILS.ALREADY_SETTLED));
    expect(error).toBeInstanceOf(LndRpcError);
    expect(error).not.toBeInstanceOf(HubError);
    expect(error.message).toBe(`LND ${LND_RPC.CANCEL_INVOICE} failed: ${LND_DETAILS.ALREADY_SETTLED}`);
  });

  it("falls back to the package's error name when LND sent no details", () => {
    expect(toLndError(LND_RPC.TRACK_PAYMENT, libOnlyError("UnknownStatusOfPayment")).message).toBe(`LND ${LND_RPC.TRACK_PAYMENT} failed: UnknownStatusOfPayment`);
  });
});

describe("user-facing LND errors", () => {
  it("LndUnavailableError is a plain sentence without LND's internal details", () => {
    const error = new LndUnavailableError(LND_RPC.GET_INFO, info(GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED));
    expect(error.message).not.toContain(LND_DETAILS.CONNECT_FAILED);
    expect(error.message).toMatch(/\.$/);
  });

  it("LnInvoiceInvalidError is 400 invoice_invalid and says what to do", () => {
    const error = new LnInvoiceInvalidError("invalid checksum");
    expect(error).toBeInstanceOf(HubError);
    expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: API_ERROR_CODE.INVOICE_INVALID });
    expect(error.message).toContain("BOLT11");
  });

  it("LnInvoiceInvalidError.unknownPrefix lists every prefix the hub accepts", () => {
    const message = LnInvoiceInvalidError.unknownPrefix().message;
    for (const { prefix } of BOLT11_PREFIXES) expect(message).toContain(prefix);
  });

  it("LnInvoiceWrongNetworkError is 422 invoice_invalid and names both networks", () => {
    const error = new LnInvoiceWrongNetworkError("mainnet", "signet");
    expect(error).toBeInstanceOf(HubError);
    expect(error).toMatchObject({ status: HttpStatus.UNPROCESSABLE_ENTITY, code: API_ERROR_CODE.INVOICE_INVALID });
    expect(error.message).toContain("mainnet");
    expect(error.message).toContain("signet");
  });
});
