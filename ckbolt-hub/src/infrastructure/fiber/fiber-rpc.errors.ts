import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../common/constants/api.constants";
import { HubError } from "../../common/errors/hub.error";

/**
 * Errors of the fnn JSON-RPC layer.
 * - FiberRpcTransportError: the call may or may not have reached the node (network, timeout, HTTP status, not JSON-RPC).
 *   Callers must treat the outcome as unknown and re-read state before acting.
 * - FiberRpcResponseError: the node answered, but with data the hub cannot read (usually an fnn version mismatch).
 * - FiberRpcError: the node answered with a JSON-RPC error object; the call did not happen.
 * - FiberInvoiceInvalidError: a user-supplied Fiber invoice that fnn cannot parse or the hub cannot read.
 */

export const FIBER_TRANSPORT_FAILURE = {
  NETWORK: "network",
  TIMEOUT: "timeout",
  HTTP_STATUS: "http_status",
  INVALID_RESPONSE: "invalid_response",
} as const;

export type FiberTransportFailure = (typeof FIBER_TRANSPORT_FAILURE)[keyof typeof FIBER_TRANSPORT_FAILURE];

/** The public message names the method and the kind of failure; `detail` (hosts, causes) is for logs only. */
export class FiberRpcTransportError extends HubError {
  constructor(
    readonly method: string,
    readonly failure: FiberTransportFailure,
    readonly detail: string,
  ) {
    super(`The Fiber node is unavailable (${method}: ${failure}). Try again in a moment.`, HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
    this.name = "FiberRpcTransportError";
  }
}

export class FiberRpcResponseError extends HubError {
  constructor(readonly detail: string) {
    super(`The Fiber node sent data the hub cannot read (${detail}).`, HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
    this.name = "FiberRpcResponseError";
  }
}

export class FiberRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly rpcMessage: string,
    readonly data?: unknown,
  ) {
    super(`fnn ${method} failed (${code}): ${rpcMessage}`);
    this.name = "FiberRpcError";
  }
}

export class FiberInvoiceInvalidError extends HubError {
  constructor(readonly detail: string) {
    super(`This Fiber invoice cannot be read (${detail}). Check that it is a complete Fiber invoice.`, HttpStatus.BAD_REQUEST, API_ERROR_CODE.INVOICE_INVALID);
    this.name = "FiberInvoiceInvalidError";
  }
}

/** True for a JSON-RPC error from fnn whose message matches `pattern`. */
export const isFiberRpcErrorMatching = (error: unknown, pattern: RegExp): error is FiberRpcError =>
  error instanceof FiberRpcError && pattern.test(error.rpcMessage);
