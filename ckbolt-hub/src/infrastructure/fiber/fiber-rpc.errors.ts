import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../common/constants/api.constants";
import { HubError } from "../../common/errors/hub.error";

/**
 * Errors of the fnn JSON-RPC layer.
 * - FiberRpcTransportError: the call may or may not have reached the node (network, timeout, HTTP status, not JSON-RPC).
 *   Callers must treat the outcome as unknown and re-read state before acting.
 * - FiberRpcResponseError: the node answered, but with data the hub cannot read (usually an fnn version mismatch).
 * - FiberInvoiceContentError: fnn read a user's invoice, but an attribute in it is one the hub refuses or cannot read.
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

/** The user reads a fixed sentence; the method, the kind of failure and `cause` (hosts, causes) are the log-only detail. */
export class FiberRpcTransportError extends HubError {
  constructor(
    readonly method: string,
    readonly failure: FiberTransportFailure,
    cause: string,
  ) {
    super("The Fiber node is unavailable. Try again in a moment.", HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE, {
      detail: `${method} (${failure}): ${cause}`,
    });
    this.name = "FiberRpcTransportError";
  }
}

/** The user reads a fixed sentence; `detail` (the field and what the node sent) is for logs only. */
export class FiberRpcResponseError extends HubError {
  declare readonly detail: string;

  constructor(detail: string) {
    super("The Fiber node sent data the hub cannot read. Try again later.", HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE, {
      detail,
    });
    this.name = "FiberRpcResponseError";
  }
}

/**
 * An attribute of the user's own invoice the hub refuses or cannot read (a repeated hash_algorithm, an unknown currency).
 * `detail` is a sentence the hub wrote about that invoice, so the invoice error may show it (asInvoiceError).
 */
export class FiberInvoiceContentError extends FiberRpcResponseError {
  constructor(detail: string) {
    super(detail);
    this.name = "FiberInvoiceContentError";
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

/** What a user reads of a Fiber invoice the hub cannot use, after the reason when there is one the hub wrote. */
const FIBER_INVOICE_UNREADABLE = "This Fiber invoice cannot be read";
const FIBER_INVOICE_HINT = "Check that it is a complete Fiber invoice.";

/**
 * `detail` says why the invoice cannot be read, for logs only: often fnn's own text. `reason` is a clause the hub wrote
 * about the invoice itself (FiberInvoiceContentError), which the user may read; without it the user reads a fixed sentence.
 */
export class FiberInvoiceInvalidError extends HubError {
  constructor(detail: string, reason?: string) {
    const unreadable = reason === undefined ? FIBER_INVOICE_UNREADABLE : `${FIBER_INVOICE_UNREADABLE} (${reason})`;
    super(`${unreadable}. ${FIBER_INVOICE_HINT}`, HttpStatus.BAD_REQUEST, API_ERROR_CODE.INVOICE_INVALID, { detail });
    this.name = "FiberInvoiceInvalidError";
  }
}

/** True for a JSON-RPC error from fnn whose message matches `pattern`. */
export const isFiberRpcErrorMatching = (error: unknown, pattern: RegExp): error is FiberRpcError =>
  error instanceof FiberRpcError && pattern.test(error.rpcMessage);
