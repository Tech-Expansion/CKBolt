import "reflect-metadata";
import { HttpStatus, Logger, type ArgumentsHost } from "@nestjs/common";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { FIBER_RPC_METHOD } from "../../../src/common/constants/fiber-rpc.constants";
import { LND_RPC } from "../../../src/common/constants/lnd.constants";
import { BOLT11_PREFIXES } from "../../../src/common/constants/protocol.constants";
import { HubError } from "../../../src/common/errors/hub.error";
import { describeError } from "../../../src/common/utils/error.util";
import { FiberRpcAdapter } from "../../../src/infrastructure/fiber/fiber-rpc.adapter";
import { FiberRpcClient, type HttpPost } from "../../../src/infrastructure/fiber/fiber-rpc.client";
import {
  FIBER_TRANSPORT_FAILURE,
  FiberInvoiceContentError,
  FiberInvoiceInvalidError,
  FiberRpcResponseError,
  FiberRpcTransportError,
} from "../../../src/infrastructure/fiber/fiber-rpc.errors";
import { LndUnavailableError, LnInvoiceInvalidError, toLndError } from "../../../src/infrastructure/lightning/lnd.errors";
import { toErrorResponse } from "../../../src/interfaces/http/filters/error-response";
import { HubExceptionFilter } from "../../../src/interfaces/http/filters/hub-exception.filter";
import { failWith, holdInvoiceAttrs, INVOICE_ADDRESS, PAYMENT_HASH, ScriptedFiberRpc, wireInvoiceResult } from "../fiber/fiber.fixtures";
import { GRPC_CODE, LND_DETAILS, libError } from "../lightning/lightning.fixtures";
import { createAdapter, LndPackageSimulator } from "../lightning/lnd-package.simulator";

/**
 * Security review H10: the node's own error text never reaches an API client. The five adapter errors a client can
 * receive answer with fixed sentences the hub wrote; the node's text and the call go into the log-only `detail`, which
 * describeError prints and the HTTP filter logs (never sends). A sentence the hub wrote about the user's own invoice
 * (an unknown prefix, a repeated or unreadable attribute, an unknown currency) is still shown.
 */

/** Text an LND or fnn node could put in an error: internal hosts, versions, file paths, its own wording. */
const NODE_TEXT = {
  LND_DECODE: "invalid index of 1: checksum failed at /home/lnd/zpay32",
  LND_DOWN: "failed to connect to all addresses; last error: connect ECONNREFUSED 10.1.2.3:10009",
  FNN_PARSE: "Failed to parse invoice: Bech32 error at fiber-lib/src/invoice/invoice_impl.rs:412",
  FNN_HOST: "connect ECONNREFUSED 10.1.2.3:8227",
  FNN_DATA: "result.version Expected string, received number (fnn v0.10.1-rc3)",
} as const;

const caught = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );

/** Asserts the client-facing sentence holds none of `texts`, and the log-only detail holds each. */
function expectTextOnlyInDetail(error: unknown, ...texts: string[]): void {
  expect(error).toBeInstanceOf(HubError);
  const hubError = error as HubError;
  const body = JSON.stringify(toErrorResponse(hubError).body);
  for (const text of texts) {
    expect(hubError.message).not.toContain(text);
    expect(body).not.toContain(text);
    expect(hubError.detail).toContain(text);
  }
  expect(Object.keys(toErrorResponse(hubError).body.error).sort()).toEqual(["code", "message"]);
}

describe("H10: the five client-facing adapter errors answer with fixed sentences", () => {
  it("LndUnavailableError: a fixed 503 sentence; the call and LND's text are the detail", () => {
    const error = new LndUnavailableError(LND_RPC.GET_INFO, { name: "UnexpectedErr", grpcCode: GRPC_CODE.UNAVAILABLE, details: NODE_TEXT.LND_DOWN });
    expect(error.message).toBe("The Lightning node is unavailable. Try again in a moment.");
    expect(error).toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE, code: API_ERROR_CODE.UPSTREAM_UNAVAILABLE });
    expect(error.detail).toBe(`${LND_RPC.GET_INFO}: ${NODE_TEXT.LND_DOWN}`);
    expect(error.message).not.toContain(LND_RPC.GET_INFO);
    expectTextOnlyInDetail(error, NODE_TEXT.LND_DOWN);
  });

  it("LndUnavailableError: the package's error name is the detail when LND sent no text", () => {
    const error = new LndUnavailableError(LND_RPC.GET_INFO, { name: "FailedToConnectToDaemon", grpcCode: null, details: "" });
    expect(error.detail).toBe(`${LND_RPC.GET_INFO}: FailedToConnectToDaemon`);
    expect(error.message).not.toContain("FailedToConnectToDaemon");
  });

  it("LndUnavailableError built by toLndError from a package error keeps LND's text out of the message", () => {
    const error = toLndError(LND_RPC.GET_INFO, libError("UnexpectedGetWalletInfoErr", GRPC_CODE.UNAVAILABLE, NODE_TEXT.LND_DOWN));
    expect(error).toBeInstanceOf(LndUnavailableError);
    expectTextOnlyInDetail(error, NODE_TEXT.LND_DOWN);
  });

  it("LnInvoiceInvalidError: a fixed 400 sentence; LND's text is the detail", () => {
    const error = new LnInvoiceInvalidError(NODE_TEXT.LND_DECODE);
    expect(error.message).toBe("This Lightning invoice cannot be read. Check that it is a complete BOLT11 invoice.");
    expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: API_ERROR_CODE.INVOICE_INVALID, detail: NODE_TEXT.LND_DECODE });
    expectTextOnlyInDetail(error, NODE_TEXT.LND_DECODE);
  });

  it("FiberRpcTransportError: a fixed 503 sentence; the method, the kind of failure and the cause are the detail", () => {
    const error = new FiberRpcTransportError(FIBER_RPC_METHOD.NODE_INFO, FIBER_TRANSPORT_FAILURE.NETWORK, NODE_TEXT.FNN_HOST);
    expect(error.message).toBe("The Fiber node is unavailable. Try again in a moment.");
    expect(error).toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE, code: API_ERROR_CODE.UPSTREAM_UNAVAILABLE });
    expect(error.detail).toBe(`${FIBER_RPC_METHOD.NODE_INFO} (${FIBER_TRANSPORT_FAILURE.NETWORK}): ${NODE_TEXT.FNN_HOST}`);
    // Callers still read the method and the kind of failure from their fields.
    expect(error).toMatchObject({ method: FIBER_RPC_METHOD.NODE_INFO, failure: FIBER_TRANSPORT_FAILURE.NETWORK });
    expect(error.message).not.toContain(FIBER_RPC_METHOD.NODE_INFO);
    expect(error.message).not.toContain(FIBER_TRANSPORT_FAILURE.NETWORK);
    expectTextOnlyInDetail(error, NODE_TEXT.FNN_HOST);
  });

  it("FiberRpcResponseError: a fixed 503 sentence; what the node sent is the detail", () => {
    const error = new FiberRpcResponseError(NODE_TEXT.FNN_DATA);
    expect(error.message).toBe("The Fiber node sent data the hub cannot read. Try again later.");
    expect(error).toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE, code: API_ERROR_CODE.UPSTREAM_UNAVAILABLE, detail: NODE_TEXT.FNN_DATA });
    expectTextOnlyInDetail(error, NODE_TEXT.FNN_DATA);
  });

  it("FiberInvoiceInvalidError: a fixed 400 sentence without a reason; fnn's text is the detail", () => {
    const error = new FiberInvoiceInvalidError(NODE_TEXT.FNN_PARSE);
    expect(error.message).toBe("This Fiber invoice cannot be read. Check that it is a complete Fiber invoice.");
    expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: API_ERROR_CODE.INVOICE_INVALID, detail: NODE_TEXT.FNN_PARSE });
    expectTextOnlyInDetail(error, NODE_TEXT.FNN_PARSE);
  });

  it("FiberInvoiceInvalidError shows a reason the hub wrote, in parentheses", () => {
    const error = new FiberInvoiceInvalidError("the detail for logs", 'unknown currency "Fibx"');
    expect(error.message).toBe('This Fiber invoice cannot be read (unknown currency "Fibx"). Check that it is a complete Fiber invoice.');
    expect(error.detail).toBe("the detail for logs");
  });
});

describe("H10: the hub's own sentences about the user's invoice are still shown", () => {
  it("LnInvoiceInvalidError.unknownPrefix names the prefixes the hub reads, in the message and the detail", () => {
    const error = LnInvoiceInvalidError.unknownPrefix();
    const prefixes = BOLT11_PREFIXES.map(({ prefix }) => prefix).join(", ");
    expect(error.message).toBe(`This Lightning invoice cannot be read (it does not start with one of ${prefixes}). Check that it is a complete BOLT11 invoice.`);
    expect(error.detail).toBe(`it does not start with one of ${prefixes}`);
  });

  it("FiberInvoiceContentError is a FiberRpcResponseError: on its own it answers the fixed 503 sentence, its sentence is the detail", () => {
    const error = new FiberInvoiceContentError("invoice attribute hash_algorithm appears more than once");
    expect(error).toBeInstanceOf(FiberRpcResponseError);
    expect(error).toBeInstanceOf(HubError);
    expect(error.name).toBe("FiberInvoiceContentError");
    expect(error.message).toBe("The Fiber node sent data the hub cannot read. Try again later.");
    expect(error.detail).toBe("invoice attribute hash_algorithm appears more than once");
  });

  describe("parseInvoice (the user's payout or refund invoice) turns it into invoice_invalid with that sentence", () => {
    let rpc: ScriptedFiberRpc;
    let adapter: FiberRpcAdapter;

    beforeEach(() => {
      rpc = new ScriptedFiberRpc();
      adapter = new FiberRpcAdapter(rpc, "testnet");
    });

    const parseError = async (): Promise<FiberInvoiceInvalidError> => {
      const error = await caught(adapter.parseInvoice(INVOICE_ADDRESS));
      expect(error).toBeInstanceOf(FiberInvoiceInvalidError);
      expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: API_ERROR_CODE.INVOICE_INVALID });
      return error as FiberInvoiceInvalidError;
    };

    it("an unknown currency", async () => {
      rpc.on("parse_invoice", () => ({ invoice: wireInvoiceResult({ currency: "Fibx" }).invoice }));
      const error = await parseError();
      expect(error.message).toBe('This Fiber invoice cannot be read (unknown currency "Fibx"). Check that it is a complete Fiber invoice.');
      expect(error.detail).toBe('unknown currency "Fibx"');
    });

    it("a repeated attribute", async () => {
      rpc.on("parse_invoice", () => ({ invoice: wireInvoiceResult({ attrs: [...holdInvoiceAttrs(), { hash_algorithm: "ckb_hash" }] }).invoice }));
      const error = await parseError();
      expect(error.message).toContain("(invoice attribute hash_algorithm appears more than once)");
    });

    it("an attribute the hub cannot read (a hash_algorithm that is not a string)", async () => {
      const attrs = holdInvoiceAttrs().map((attr) => ("hash_algorithm" in attr ? { hash_algorithm: 42 } : attr));
      rpc.on("parse_invoice", () => ({ invoice: wireInvoiceResult({ attrs }).invoice }));
      const error = await parseError();
      expect(error.message).toMatch(/\(invoice attribute \w+ is not a string\)/);
    });

    it("an attribute the hub cannot read (a udt_script that is not a script)", async () => {
      const attrs = holdInvoiceAttrs().map((attr) => ("udt_script" in attr ? { udt_script: { code_hash: 7 } } : attr));
      rpc.on("parse_invoice", () => ({ invoice: wireInvoiceResult({ attrs }).invoice }));
      const error = await parseError();
      expect(error.message).toContain("(invoice attribute udt_script is not a script)");
    });

    it("an invoice fnn refuses: fnn's text only in the detail, the fixed sentence in the message", async () => {
      rpc.on("parse_invoice", failWith("parse_invoice", NODE_TEXT.FNN_PARSE));
      const error = await parseError();
      expect(error.message).toBe("This Fiber invoice cannot be read. Check that it is a complete Fiber invoice.");
      expectTextOnlyInDetail(error, NODE_TEXT.FNN_PARSE);
    });
  });
});

describe("H10: node text reaching the hub through the real clients stays in the detail", () => {
  const RPC_URL = "http://10.1.2.3:8227";
  const answering =
    (status: number, body: string): HttpPost =>
    async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
  const fiberClient = (post: HttpPost) => new FiberRpcClient({ url: RPC_URL, timeoutMs: 1_000, httpPost: post });

  it("fnn unreachable: the host and the socket error only in the detail", async () => {
    const post: HttpPost = async () => {
      throw new TypeError("fetch failed", { cause: new Error(NODE_TEXT.FNN_HOST) });
    };
    const error = await caught(fiberClient(post).request(FIBER_RPC_METHOD.NODE_INFO));
    expect(error).toBeInstanceOf(FiberRpcTransportError);
    expectTextOnlyInDetail(error, NODE_TEXT.FNN_HOST, FIBER_RPC_METHOD.NODE_INFO);
  });

  it("fnn answering an HTTP error: the status only in the detail", async () => {
    const error = await caught(fiberClient(answering(502, "Bad Gateway from nginx/1.25.3")).request(FIBER_RPC_METHOD.NODE_INFO));
    expect(error).toBeInstanceOf(FiberRpcTransportError);
    expectTextOnlyInDetail(error, "HTTP 502");
  });

  it("fnn answering data the hub cannot read: the field and the value only in the detail", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { version: 10, pubkey: "x", chain_hash: "y" } });
    const error = await caught(fiberClient(answering(200, body)).request(FIBER_RPC_METHOD.NODE_INFO));
    expect(error).toBeInstanceOf(FiberRpcResponseError);
    expectTextOnlyInDetail(error, `${FIBER_RPC_METHOD.NODE_INFO}: version`);
  });

  it("parse_invoice data the hub cannot read becomes invoice_invalid with the fixed sentence", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { invoice: { currency: 7 } } });
    const adapter = new FiberRpcAdapter(fiberClient(answering(200, body)), "testnet");
    const error = await caught(adapter.parseInvoice(INVOICE_ADDRESS));
    expect(error).toBeInstanceOf(FiberInvoiceInvalidError);
    expect((error as Error).message).toBe("This Fiber invoice cannot be read. Check that it is a complete Fiber invoice.");
    expect((error as HubError).detail).toContain(FIBER_RPC_METHOD.PARSE_INVOICE);
  });

  describe("the LND adapter", () => {
    let sim: LndPackageSimulator;

    beforeEach(() => {
      sim = new LndPackageSimulator();
    });

    it("an invoice LND cannot decode: LND's text only in the detail", async () => {
      const adapter = createAdapter(sim);
      try {
        const request = sim.addPayable({ hash: PAYMENT_HASH });
        sim.rpc.decodePaymentRequest.mockRejectedValueOnce(libError("UnexpectedDecodePaymentRequestError", GRPC_CODE.UNKNOWN, NODE_TEXT.LND_DECODE));
        const error = await caught(adapter.decodeInvoice(request));
        expect(error).toBeInstanceOf(LnInvoiceInvalidError);
        expect((error as Error).message).toBe("This Lightning invoice cannot be read. Check that it is a complete BOLT11 invoice.");
        expectTextOnlyInDetail(error, NODE_TEXT.LND_DECODE);
      } finally {
        adapter.close();
      }
    });

    it("an LND that cannot be reached: the call and LND's text only in the detail", async () => {
      const adapter = createAdapter(sim);
      try {
        sim.rpc.getWalletInfo.mockRejectedValueOnce(libError("UnexpectedGetWalletInfoErr", GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED));
        const error = await caught(adapter.getInfo());
        expect(error).toBeInstanceOf(LndUnavailableError);
        expectTextOnlyInDetail(error, LND_DETAILS.CONNECT_FAILED);
      } finally {
        adapter.close();
      }
    });
  });
});

describe("H10: describeError prints the log-only detail", () => {
  it("puts a HubError's detail in brackets after its message", () => {
    const error = new FiberInvoiceInvalidError(NODE_TEXT.FNN_PARSE);
    expect(describeError(error)).toBe(`${error.message} [${NODE_TEXT.FNN_PARSE}]`);
  });

  it("puts the detail before the cause chain", () => {
    const cause = new Error("connect ECONNREFUSED 10.1.2.3:10009");
    const error = new HubError("The node is unavailable.", HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE, { cause, detail: "GetInfo" });
    expect(describeError(error)).toBe("The node is unavailable. [GetInfo]: connect ECONNREFUSED 10.1.2.3:10009");
  });

  it("prints a detail held by a cause too", () => {
    const inner = new FiberRpcTransportError(FIBER_RPC_METHOD.GET_PAYMENT, FIBER_TRANSPORT_FAILURE.TIMEOUT, "no answer within 10000 ms");
    const outer = new Error("payout lookup failed", { cause: inner });
    expect(describeError(outer)).toBe(
      `payout lookup failed: The Fiber node is unavailable. Try again in a moment. [${FIBER_RPC_METHOD.GET_PAYMENT} (timeout): no answer within 10000 ms]`,
    );
  });

  it("prints nothing extra for an error without a detail, an empty detail or a detail that is not text", () => {
    expect(describeError(new HubError("Bad input."))).toBe("Bad input.");
    expect(describeError(new HubError("Bad input.", HttpStatus.BAD_REQUEST, API_ERROR_CODE.BAD_REQUEST, { detail: "" }))).toBe("Bad input.");
    expect(describeError(Object.assign(new Error("plain"), { detail: 42 }))).toBe("plain");
  });

  it("reads a string detail on any Error, not only a HubError", () => {
    expect(describeError(Object.assign(new Error("plain"), { detail: "extra" }))).toBe("plain [extra]");
  });

  it("a HubError has no detail unless one is given", () => {
    expect(new HubError("Bad input.").detail).toBeUndefined();
    expect(new HubError("Bad input.", HttpStatus.BAD_REQUEST, API_ERROR_CODE.BAD_REQUEST, { detail: undefined }).detail).toBeUndefined();
    expect(new HubError("Bad input.", HttpStatus.BAD_REQUEST, API_ERROR_CODE.BAD_REQUEST, { detail: "x" }).detail).toBe("x");
  });
});

/* ------------------------------------------------------------------------------------------- the HTTP filter */

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

describe("H10: the HTTP filter logs the detail and never returns it", () => {
  const filter = new HubExceptionFilter();
  let logs: Record<"error" | "warn" | "log" | "debug", jest.SpyInstance>;

  beforeEach(() => {
    logs = {
      error: jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined),
      warn: jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined),
      log: jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined),
      debug: jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined),
    };
  });

  afterEach(() => jest.restoreAllMocks());

  const send = (error: unknown): FakeResponse => {
    const response = new FakeResponse();
    filter.catch(error, hostFor(response));
    return response;
  };
  const logged = (spy: jest.SpyInstance): string => spy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");

  it("a 5xx (node unavailable): the detail in a warning line with the code, the fixed sentence in the body", () => {
    const error = new FiberRpcTransportError(FIBER_RPC_METHOD.NODE_INFO, FIBER_TRANSPORT_FAILURE.NETWORK, NODE_TEXT.FNN_HOST);
    const response = send(error);
    expect(response.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(response.body).toEqual({ error: { code: API_ERROR_CODE.UPSTREAM_UNAVAILABLE, message: "The Fiber node is unavailable. Try again in a moment." } });
    expect(JSON.stringify(response.body)).not.toContain("10.1.2.3");
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logged(logs.warn)).toBe(`${API_ERROR_CODE.UPSTREAM_UNAVAILABLE}: ${describeError(error)}`);
    expect(logged(logs.warn)).toContain(NODE_TEXT.FNN_HOST);
    expect(logs.error).not.toHaveBeenCalled();
  });

  it("a 4xx with a detail (an invoice fnn refused): the detail at debug level, never in the body", () => {
    const response = send(new FiberInvoiceInvalidError(NODE_TEXT.FNN_PARSE));
    expect(response.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(response.body).toEqual({
      error: { code: API_ERROR_CODE.INVOICE_INVALID, message: "This Fiber invoice cannot be read. Check that it is a complete Fiber invoice." },
    });
    expect(JSON.stringify(response.body)).not.toContain("Bech32");
    expect(logs.debug).toHaveBeenCalledTimes(1);
    expect(logged(logs.debug)).toContain(`${API_ERROR_CODE.INVOICE_INVALID}: `);
    expect(logged(logs.debug)).toContain(NODE_TEXT.FNN_PARSE);
    expect(logs.warn).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });

  it("a 4xx with a cause and no detail is logged at debug level too, with the cause", () => {
    const error = new HubError("Bad input.", HttpStatus.BAD_REQUEST, API_ERROR_CODE.BAD_REQUEST, { cause: new Error("parser said: unexpected token") });
    const response = send(error);
    expect(response.body).toEqual({ error: { code: API_ERROR_CODE.BAD_REQUEST, message: "Bad input." } });
    expect(logged(logs.debug)).toContain("parser said: unexpected token");
  });

  it("a 4xx that holds nothing the client was not told is not logged", () => {
    send(new HubError("Bad input."));
    send(new HubError("Use a testnet invoice.", HttpStatus.UNPROCESSABLE_ENTITY, API_ERROR_CODE.INVOICE_INVALID));
    expect(logs.debug).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });

  it("every one of the five errors: the body is exactly { code, message } and holds no node text", () => {
    const errors: HubError[] = [
      new LndUnavailableError(LND_RPC.GET_INFO, { name: "X", grpcCode: GRPC_CODE.UNAVAILABLE, details: NODE_TEXT.LND_DOWN }),
      new LnInvoiceInvalidError(NODE_TEXT.LND_DECODE),
      new FiberRpcTransportError(FIBER_RPC_METHOD.NODE_INFO, FIBER_TRANSPORT_FAILURE.NETWORK, NODE_TEXT.FNN_HOST),
      new FiberRpcResponseError(NODE_TEXT.FNN_DATA),
      new FiberInvoiceInvalidError(NODE_TEXT.FNN_PARSE),
    ];
    for (const error of errors) {
      const body = send(error).body as { error: Record<string, unknown> };
      expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
      for (const text of Object.values(NODE_TEXT)) expect(JSON.stringify(body)).not.toContain(text);
      expect(`${logged(logs.warn)}\n${logged(logs.debug)}`).toContain(error.detail ?? "missing detail");
    }
  });
});
