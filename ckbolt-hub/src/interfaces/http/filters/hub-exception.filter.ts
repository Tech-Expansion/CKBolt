import { Catch, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { HubError } from "../../../common/errors/hub.error";
import { describeError } from "../../../common/utils/error.util";
import { setHeaders } from "../http-headers";
import { toErrorResponse, type ErrorResponse } from "./error-response";

/** True when a HubError holds what the client was not told: a log-only detail (a node's own text) or a cause. */
const hasLogOnlyDetail = (error: HubError): boolean => error.detail !== undefined || error.cause !== undefined;

/**
 * Global filter: every error leaves the API as `{ error: { code, message } }`. HubErrors keep their status, code and
 * message, and their log-only detail and cause go to the log (a client error's at debug level); anything unexpected is
 * logged with its stack and answered with a bare 500 internal_error.
 */
@Catch()
export class HubExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HubExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const errorResponse = toErrorResponse(exception);
    this.log(exception, errorResponse);
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    setHeaders(response, errorResponse.headers);
    response.status(errorResponse.status).json(errorResponse.body);
  }

  private log(exception: unknown, errorResponse: ErrorResponse): void {
    const isServerError = errorResponse.status >= HttpStatus.INTERNAL_SERVER_ERROR;
    if (exception instanceof HubError) return this.logHubError(exception, errorResponse.body.error.code, isServerError);
    if (isServerError) this.logger.error(describeError(exception), exception instanceof Error ? exception.stack : undefined);
  }

  /** A client error is logged only when it holds what the client was not told. */
  private logHubError(exception: HubError, code: string, isServerError: boolean): void {
    const line = `${code}: ${describeError(exception)}`;
    if (isServerError) this.logger.warn(line);
    else if (hasLogOnlyDetail(exception)) this.logger.debug(line);
  }
}

