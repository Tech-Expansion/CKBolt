import { HttpException, HttpStatus } from "@nestjs/common";
import { ZodError } from "zod";
import { API_ERROR_CODE, type ApiErrorCode } from "../../../common/constants/api.constants";
import { ERROR_CODE_BY_STATUS, ERROR_MESSAGE_BY_STATUS, HTTP_ERROR_MESSAGE, HTTP_HEADER } from "../../../common/constants/http.constants";
import { HubError, RateLimitedError } from "../../../common/errors/hub.error";
import { formatValidationIssues } from "../../../common/utils/validation-message.util";
import type { ErrorBody } from "../contract/responses";

/** Field name used in a validation message when a zod issue has no path. */
const WHOLE_REQUEST_FIELD = "request";

/** What the API answers for an error: status, `{ error: { code, message } }` body and extra headers. */
export interface ErrorResponse {
  status: number;
  body: ErrorBody;
  headers: Record<string, string>;
}

const errorResponse = (status: number, code: ApiErrorCode, message: string, headers: Record<string, string> = {}): ErrorResponse => ({
  status,
  body: { error: { code, message } },
  headers,
});

const isServerError = (status: number): boolean => status >= HttpStatus.INTERNAL_SERVER_ERROR;

const headersFor = (error: HubError): Record<string, string> =>
  error instanceof RateLimitedError ? { [HTTP_HEADER.RETRY_AFTER]: String(error.retryAfterSeconds) } : {};

const fromHubError = (error: HubError): ErrorResponse => errorResponse(error.status, error.code, error.message, headersFor(error));

/** A status raised by the framework or the HTTP stack: plain message by status, never the internal one. */
function fromStatus(status: number): ErrorResponse {
  const server = isServerError(status);
  const code = ERROR_CODE_BY_STATUS[status] ?? (server ? API_ERROR_CODE.INTERNAL : API_ERROR_CODE.BAD_REQUEST);
  const message = server ? HTTP_ERROR_MESSAGE.INTERNAL : (ERROR_MESSAGE_BY_STATUS[status] ?? HTTP_ERROR_MESSAGE.CLIENT);
  return errorResponse(status, code, message);
}

/**
 * The status of a client error raised before Nest's router, such as body-parser's unreadable JSON. Those errors (the
 * http-errors package) say they are safe to expose; other errors with a `status` field (upstream clients) are not
 * the client's fault and stay 500.
 */
function exposedClientStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const { expose, status } = error as { expose?: unknown; status?: unknown };
  const isClientStatus = typeof status === "number" && status >= HttpStatus.BAD_REQUEST && !isServerError(status);
  return expose === true && isClientStatus ? status : null;
}

/** Maps anything thrown while handling a request to the API's error response. Unknown errors become a bare 500. */
export function toErrorResponse(exception: unknown): ErrorResponse {
  if (exception instanceof HubError) return fromHubError(exception);
  if (exception instanceof ZodError) {
    return errorResponse(HttpStatus.BAD_REQUEST, API_ERROR_CODE.VALIDATION, formatValidationIssues(exception.issues, WHOLE_REQUEST_FIELD));
  }
  if (exception instanceof HttpException) return fromStatus(exception.getStatus());
  const clientStatus = exposedClientStatus(exception);
  if (clientStatus !== null) return fromStatus(clientStatus);
  return fromStatus(HttpStatus.INTERNAL_SERVER_ERROR);
}
