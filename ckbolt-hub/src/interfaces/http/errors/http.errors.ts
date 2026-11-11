import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../../common/constants/api.constants";
import { HTTP_ERROR_MESSAGE } from "../../../common/constants/http.constants";
import { HubError } from "../../../common/errors/hub.error";

/** A request body or route parameter that does not match the API contract. */
export class RequestValidationError extends HubError {
  constructor(message: string) {
    super(message, HttpStatus.BAD_REQUEST, API_ERROR_CODE.VALIDATION);
    this.name = "RequestValidationError";
  }
}

/** HUB_PROXY_SECRET is set and the request does not carry it in X-CKBolt-Proxy-Secret. */
export class UnauthorizedError extends HubError {
  constructor() {
    super(HTTP_ERROR_MESSAGE.UNAUTHORIZED, HttpStatus.UNAUTHORIZED, API_ERROR_CODE.UNAUTHORIZED);
    this.name = "UnauthorizedError";
  }
}

/** SWAPS_PAUSED: a new quote, swap or inbound channel while the hub is paused for maintenance. */
export class MaintenanceError extends HubError {
  constructor() {
    super(HTTP_ERROR_MESSAGE.MAINTENANCE, HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.MAINTENANCE);
    this.name = "MaintenanceError";
  }
}
