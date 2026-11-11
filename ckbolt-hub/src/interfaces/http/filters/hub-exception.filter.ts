import { Catch, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { HubError } from "../../../common/errors/hub.error";
import { describeError } from "../../../common/utils/error.util";
import { setHeaders } from "../http-headers";
import { toErrorResponse, type ErrorResponse } from "./error-response";

/**
 * Global filter: every error leaves the API as `{ error: { code, message } }`. HubErrors keep their status, code and
 * message; anything unexpected is logged with its stack and answered with a bare 500 internal_error.
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
    if (errorResponse.status < HttpStatus.INTERNAL_SERVER_ERROR) return;
    if (exception instanceof HubError) {
      this.logger.warn(`${errorResponse.body.error.code}: ${exception.message}`);
      return;
    }
    this.logger.error(describeError(exception), exception instanceof Error ? exception.stack : undefined);
  }
}
