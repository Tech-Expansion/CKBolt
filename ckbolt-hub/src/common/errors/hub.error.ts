import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE, type ApiErrorCode } from "../constants/api.constants";

/**
 * Options of a HubError, both for logs only (describeError prints them; the API never sends them): `cause` keeps the
 * error it replaces, `detail` says what went wrong in words the user must not see, such as a node's own error text.
 */
export interface HubErrorOptions {
  cause?: unknown;
  detail?: string;
}

/**
 * An error the API can show to the user. `message` is a plain sentence that says what is wrong and, where possible,
 * what to do ("Use a testnet Fiber invoice."). The HTTP layer maps it to `{ error: { code, message } }` with `status`.
 */
export class HubError extends Error {
  /** For logs only (HubErrorOptions.detail). */
  readonly detail?: string;

  constructor(
    message: string,
    readonly status: number = HttpStatus.BAD_REQUEST,
    readonly code: ApiErrorCode = API_ERROR_CODE.BAD_REQUEST,
    options: HubErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HubError";
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

export class NotFoundError extends HubError {
  constructor(what: string) {
    super(`${what} was not found.`, HttpStatus.NOT_FOUND, API_ERROR_CODE.NOT_FOUND);
    this.name = "NotFoundError";
  }
}

/** A payment hash already used by another swap or invoice. */
export class DuplicateHashError extends HubError {
  constructor() {
    super("This payment hash is already in use. Make a new invoice.", HttpStatus.CONFLICT, API_ERROR_CODE.DUPLICATE_HASH);
    this.name = "DuplicateHashError";
  }
}

/**
 * A client (or every client together) went over a budget: requests, demo actions, swaps waiting for their payment.
 * `retryAfterSeconds` goes out as the Retry-After header.
 */
export class RateLimitedError extends HubError {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message, HttpStatus.TOO_MANY_REQUESTS, API_ERROR_CODE.RATE_LIMITED);
    this.name = "RateLimitedError";
  }
}

/** One swap per quote: the quote already has one. */
export class QuoteAlreadyUsedError extends HubError {
  constructor() {
    super("This quote already has a swap. Ask for a new quote to start another swap.", HttpStatus.CONFLICT, API_ERROR_CODE.CONFLICT);
    this.name = "QuoteAlreadyUsedError";
  }
}
