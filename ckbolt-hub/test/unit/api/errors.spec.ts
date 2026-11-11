import "reflect-metadata";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  type ArgumentsHost,
} from "@nestjs/common";
import { z, ZodError } from "zod";
import { DemoAssetUnavailableError, DemoDisabledError, DemoWalletUnavailableError, SwapNotAwaitingPaymentError } from "../../../src/application/demo/demo.errors";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { HTTP_ERROR_MESSAGE, VALIDATION_MESSAGE } from "../../../src/common/constants/http.constants";
import { DuplicateHashError, HubError, NotFoundError, QuoteAlreadyUsedError, RateLimitedError } from "../../../src/common/errors/hub.error";
import { formatValidationIssues } from "../../../src/common/utils/validation-message.util";
import { createDemoPaymentBodySchema, createQuoteBodySchema, createSwapBodySchema, uuidSchema } from "../../../src/interfaces/http/contract/requests";
import { RequestValidationError } from "../../../src/interfaces/http/errors/http.errors";
import { toErrorResponse } from "../../../src/interfaces/http/filters/error-response";
import { HubExceptionFilter } from "../../../src/interfaces/http/filters/hub-exception.filter";
import { ZodValidationPipe } from "../../../src/interfaces/http/pipes/zod-validation.pipe";
import { QUOTE_ID, spyOnLogger } from "./api.fixtures";

const ALL_CODES = new Set<string>(Object.values(API_ERROR_CODE));

describe("toErrorResponse", () => {
  it("keeps a HubError's status, code and message", () => {
    const error = new HubError("Use a testnet Fiber invoice.", 422, API_ERROR_CODE.INVOICE_INVALID);
    expect(toErrorResponse(error)).toEqual({
      status: 422,
      body: { error: { code: "invoice_invalid", message: "Use a testnet Fiber invoice." } },
      headers: {},
    });
  });

  it.each([
    ["NotFoundError", new NotFoundError("Swap"), 404, API_ERROR_CODE.NOT_FOUND],
    ["DuplicateHashError", new DuplicateHashError(), 409, API_ERROR_CODE.DUPLICATE_HASH],
    ["RequestValidationError", new RequestValidationError("Invalid request. id: Invalid uuid."), 400, API_ERROR_CODE.VALIDATION],
    ["DemoDisabledError", new DemoDisabledError(), 404, API_ERROR_CODE.DEMO_DISABLED],
    ["DemoAssetUnavailableError", new DemoAssetUnavailableError("CWBTC"), 422, API_ERROR_CODE.ASSET_UNAVAILABLE],
    ["SwapNotAwaitingPaymentError", new SwapNotAwaitingPaymentError(), 409, API_ERROR_CODE.CONFLICT],
    ["QuoteAlreadyUsedError", new QuoteAlreadyUsedError(), 409, API_ERROR_CODE.CONFLICT],
    ["DemoWalletUnavailableError", new DemoWalletUnavailableError(), 503, API_ERROR_CODE.UPSTREAM_UNAVAILABLE],
  ])("%s -> %i %s", (_name, error, status, code) => {
    const response = toErrorResponse(error);
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
    expect(response.body.error.message).toBe(error.message);
  });

  it("a RateLimitedError adds Retry-After in whole seconds", () => {
    const response = toErrorResponse(new RateLimitedError("Slow down.", 42));
    expect(response).toEqual({
      status: 429,
      body: { error: { code: API_ERROR_CODE.RATE_LIMITED, message: "Slow down." } },
      headers: { "Retry-After": "42" },
    });
  });

  it("a ZodError is 400 validation_failed with a plain message", () => {
    const parsed = createQuoteBodySchema.safeParse({ direction: "ln_to_fiber" });
    if (parsed.success) throw new Error("test setup: expected a failure");
    const response = toErrorResponse(parsed.error);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(API_ERROR_CODE.VALIDATION);
    expect(response.body.error.message).toMatch(/^Invalid request\. .*asset.*\.$/);
  });

  it.each([
    ["NotFoundException", new NotFoundException("Cannot GET /x"), 404, API_ERROR_CODE.NOT_FOUND, HTTP_ERROR_MESSAGE.NOT_FOUND],
    ["BadRequestException", new BadRequestException("Unexpected token } in JSON"), 400, API_ERROR_CODE.BAD_REQUEST, HTTP_ERROR_MESSAGE.BAD_REQUEST],
    ["PayloadTooLargeException", new PayloadTooLargeException(), 413, API_ERROR_CODE.BAD_REQUEST, HTTP_ERROR_MESSAGE.PAYLOAD_TOO_LARGE],
    ["a 405 HttpException", new HttpException("nope", HttpStatus.METHOD_NOT_ALLOWED), 405, API_ERROR_CODE.BAD_REQUEST, HTTP_ERROR_MESSAGE.CLIENT],
    ["ServiceUnavailableException", new ServiceUnavailableException("db down at 10.0.0.5"), 503, API_ERROR_CODE.UPSTREAM_UNAVAILABLE, HTTP_ERROR_MESSAGE.INTERNAL],
    ["InternalServerErrorException", new InternalServerErrorException("stack here"), 500, API_ERROR_CODE.INTERNAL, HTTP_ERROR_MESSAGE.INTERNAL],
  ])("a framework %s -> %i %s with a plain message of the hub's own", (_name, error, status, code, message) => {
    const response = toErrorResponse(error);
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code, message } });
  });

  it("a body-parser error that is safe to expose keeps its 4xx status but not its message", () => {
    const parseError = Object.assign(new SyntaxError("Unexpected end of JSON input"), { status: 400, statusCode: 400, expose: true, type: "entity.parse.failed" });
    expect(toErrorResponse(parseError)).toEqual({
      status: 400,
      body: { error: { code: API_ERROR_CODE.BAD_REQUEST, message: HTTP_ERROR_MESSAGE.BAD_REQUEST } },
      headers: {},
    });
  });

  it("a body-parser 413 is a 413 with the payload message", () => {
    const tooLarge = Object.assign(new Error("request entity too large"), { status: 413, expose: true, type: "entity.too.large" });
    const response = toErrorResponse(tooLarge);
    expect(response.status).toBe(413);
    expect(response.body.error.message).toBe(HTTP_ERROR_MESSAGE.PAYLOAD_TOO_LARGE);
  });

  it.each([
    ["an upstream client error that is not marked safe to expose", Object.assign(new Error("LND said 404"), { status: 404 })],
    ["an exposed error with a 5xx status", Object.assign(new Error("bad gateway"), { status: 502, expose: true })],
    ["an exposed error with a non-numeric status", Object.assign(new Error("odd"), { status: "400", expose: true })],
    ["a plain Error", new Error("ECONNREFUSED 127.0.0.1:10009")],
    ["a TypeError", new TypeError("Cannot read properties of undefined (reading 'id')")],
    ["a thrown string", "secret string"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
  ])("%s is a bare 500 internal_error", (_label, thrown) => {
    expect(toErrorResponse(thrown)).toEqual({
      status: 500,
      body: { error: { code: API_ERROR_CODE.INTERNAL, message: HTTP_ERROR_MESSAGE.INTERNAL } },
      headers: {},
    });
  });

  it("every error code it can produce is an API_ERROR_CODE", () => {
    const samples: unknown[] = [new NotFoundException(), new PayloadTooLargeException(), new HttpException("x", 418), new HttpException("x", 504), new Error("x")];
    for (const sample of samples) expect(ALL_CODES.has(toErrorResponse(sample).body.error.code)).toBe(true);
  });
});

/** A minimal Express response for the filter. */
class FakeResponse {
  statusCode = 200;
  body: unknown = undefined;
  headersSent = false;
  readonly headers: Record<string, string> = {};

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
}

const hostFor = (response: FakeResponse): ArgumentsHost =>
  ({ switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }) }) as unknown as ArgumentsHost;

describe("HubError", () => {
  it("keeps the error it replaces as its cause, given at construction", () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:10009");
    const error = new HubError("The node is unavailable.", HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE, { cause });

    expect(error.cause).toBe(cause);
    expect(toErrorResponse(error).body.error.message).toBe("The node is unavailable.");
  });

  it("has no cause unless one is given", () => {
    expect(new HubError("Bad input.")).not.toHaveProperty("cause");
    expect(new HubError("Bad input.", HttpStatus.BAD_REQUEST, API_ERROR_CODE.BAD_REQUEST, { cause: undefined })).not.toHaveProperty("cause");
  });
});

describe("HubExceptionFilter", () => {
  let logs: ReturnType<typeof spyOnLogger>;
  const filter = new HubExceptionFilter();

  beforeEach(() => {
    logs = spyOnLogger();
  });

  afterEach(() => jest.restoreAllMocks());

  it("writes { error: { code, message } } with the error's status", () => {
    const response = new FakeResponse();
    filter.catch(new NotFoundError("Quote"), hostFor(response));
    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: { code: API_ERROR_CODE.NOT_FOUND, message: "Quote was not found." } });
  });

  it("sets Retry-After for a rate-limited request", () => {
    const response = new FakeResponse();
    filter.catch(new RateLimitedError("Too many.", 7), hostFor(response));
    expect(response.statusCode).toBe(429);
    expect(response.headers).toEqual({ "Retry-After": "7" });
  });

  it("logs an unexpected error with its stack, and sends none of it", () => {
    const response = new FakeResponse();
    const error = new Error("connect ECONNREFUSED 10.1.2.3:8227");
    filter.catch(error, hostFor(response));
    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: { code: API_ERROR_CODE.INTERNAL, message: HTTP_ERROR_MESSAGE.INTERNAL } });
    expect(logs.error).toHaveBeenCalledTimes(1);
    const [message, stack] = logs.error.mock.calls[0] as [string, string | undefined];
    expect(message).toContain("ECONNREFUSED");
    expect(stack).toBe(error.stack);
    expect(JSON.stringify(response.body)).not.toContain("10.1.2.3");
  });

  it("logs a non-Error throw without a stack", () => {
    filter.catch("weird", hostFor(new FakeResponse()));
    expect(logs.error).toHaveBeenCalledWith("weird", undefined);
  });

  it("logs a 5xx HubError as a warning, not an error", () => {
    filter.catch(new DemoWalletUnavailableError(), hostFor(new FakeResponse()));
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.error).not.toHaveBeenCalled();
  });

  it("does not log client errors", () => {
    filter.catch(new RequestValidationError("Invalid request."), hostFor(new FakeResponse()));
    filter.catch(new NotFoundException(), hostFor(new FakeResponse()));
    expect(logs.error).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it("does not write when the headers were already sent, but still logs", () => {
    const response = new FakeResponse();
    response.headersSent = true;
    filter.catch(new Error("late failure"), hostFor(response));
    expect(response.body).toBeUndefined();
    expect(response.statusCode).toBe(200);
    expect(logs.error).toHaveBeenCalledTimes(1);
  });
});

describe("ZodValidationPipe", () => {
  const bodyMeta = { type: "body" as const, metatype: undefined, data: undefined };
  const idMeta = { type: "param" as const, metatype: undefined, data: "id" };

  it("returns the parsed value with defaults applied", () => {
    const pipe = new ZodValidationPipe(createSwapBodySchema);
    expect(pipe.transform({ quoteId: QUOTE_ID, payoutInvoice: " inv " }, bodyMeta)).toEqual({ quoteId: QUOTE_ID, payoutInvoice: "inv" });
  });

  it("strips unknown fields", () => {
    const pipe = new ZodValidationPipe(createDemoPaymentBodySchema);
    expect(pipe.transform({ swapId: QUOTE_ID, admin: true }, bodyMeta)).toEqual({ swapId: QUOTE_ID });
  });

  it("accepts a uuid id and returns it unchanged", () => {
    expect(new ZodValidationPipe(uuidSchema).transform(QUOTE_ID, idMeta)).toBe(QUOTE_ID);
  });

  it("throws RequestValidationError (400 validation_failed) naming the route parameter", () => {
    const pipe = new ZodValidationPipe(uuidSchema);
    let thrown: unknown;
    try {
      pipe.transform("abc", idMeta);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RequestValidationError);
    const error = thrown as RequestValidationError;
    expect(error.status).toBe(400);
    expect(error.code).toBe(API_ERROR_CODE.VALIDATION);
    expect(error.message).toBe("Invalid request. id: Invalid uuid.");
  });

  it("names the body when the whole body is wrong", () => {
    const pipe = new ZodValidationPipe(createQuoteBodySchema);
    expect(() => pipe.transform(undefined, bodyMeta)).toThrow("Invalid request. body: Required.");
  });

  it("lists every issue with its field path", () => {
    const pipe = new ZodValidationPipe(createQuoteBodySchema);
    expect(() => pipe.transform({ direction: "ln_to_fiber", asset: "CKB", side: "pay", amount: "0" }, bodyMeta)).toThrow(
      "Invalid request. amount: must be a positive whole number of base units, as a string.",
    );
    let message = "";
    try {
      pipe.transform({}, bodyMeta);
    } catch (error) {
      message = (error as Error).message;
    }
    for (const field of ["direction", "asset", "side", "amount"]) expect(message).toContain(`${field}: Required`);
  });
});

describe("formatValidationIssues", () => {
  const issuesOf = (schema: z.ZodTypeAny, value: unknown): z.ZodIssue[] => {
    const parsed = schema.safeParse(value);
    if (parsed.success) throw new Error("test setup: expected a failure");
    return parsed.error.issues;
  };

  it("joins nested paths with dots and issues with semicolons", () => {
    const schema = z.object({ leg: z.object({ amount: z.string() }), id: z.string() });
    const message = formatValidationIssues(issuesOf(schema, { leg: { amount: 1 }, id: 2 }), "body");
    expect(message).toBe(
      `${VALIDATION_MESSAGE.PREFIX} leg.amount: Expected string, received number; id: Expected string, received number${VALIDATION_MESSAGE.END}`,
    );
  });

  it("uses the fallback field for an issue without a path", () => {
    expect(formatValidationIssues(issuesOf(z.string(), 5), "id")).toBe("Invalid request. id: Expected string, received number.");
  });

  it("is just the prefix when there are no issues", () => {
    expect(formatValidationIssues([], "body")).toBe(VALIDATION_MESSAGE.PREFIX);
  });

  it("is built from ZodError issues the same way", () => {
    const error = new ZodError(issuesOf(z.object({ a: z.number() }), {}));
    expect(formatValidationIssues(error.issues, "body")).toBe("Invalid request. a: Required.");
  });
});
