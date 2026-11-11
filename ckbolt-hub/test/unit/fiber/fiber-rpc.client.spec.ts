import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { FIBER_RPC_METHOD } from "../../../src/common/constants/fiber-rpc.constants";
import { HubError } from "../../../src/common/errors/hub.error";
import { FiberRpcClient, type HttpPost, type HttpResponseLike } from "../../../src/infrastructure/fiber/fiber-rpc.client";
import {
  FIBER_TRANSPORT_FAILURE,
  FiberInvoiceInvalidError,
  FiberRpcError,
  FiberRpcResponseError,
  FiberRpcTransportError,
  isFiberRpcErrorMatching,
} from "../../../src/infrastructure/fiber/fiber-rpc.errors";
import { PAYMENT_HASH, PREIMAGE, with0x, wireChannel, wireNodeInfo, wireTlc } from "./fiber.fixtures";

const RPC_URL = "http://10.0.0.5:8227";
const TOKEN = "EoQKCAoGCAESAhgBEgYIARICGAEaIK-secret-biscuit";

type PostInit = Parameters<HttpPost>[1];

interface Recorder {
  post: HttpPost;
  calls: { url: string; init: PostInit; body: Record<string, unknown> }[];
}

const okResponse = (text: string): HttpResponseLike => ({ ok: true, status: 200, text: async () => text });
const statusResponse = (status: number, text = ""): HttpResponseLike => ({ ok: status >= 200 && status < 300, status, text: async () => text });

/** An HttpPost that records every request and answers with `answer(body)`; the default echoes `result`. */
function recorder(answer: (body: Record<string, unknown>) => HttpResponseLike | Promise<HttpResponseLike>): Recorder {
  const calls: Recorder["calls"] = [];
  return {
    calls,
    post: async (url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ url, init, body });
      return answer(body);
    },
  };
}

const resultOf = (result: unknown) => (body: Record<string, unknown>) => okResponse(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
const errorOf = (error: unknown) => (body: Record<string, unknown>) => okResponse(JSON.stringify({ jsonrpc: "2.0", id: body.id, error }));

const client = (post: HttpPost, overrides: { authToken?: string; timeoutMs?: number } = {}) =>
  new FiberRpcClient({ url: RPC_URL, authToken: overrides.authToken, timeoutMs: overrides.timeoutMs ?? 1_000, httpPost: post });

/** Waits for the abort signal, as fetch does, and then rejects like fetch (AbortError). */
const hangingPost: HttpPost = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
  });

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

describe("FiberRpcClient (JSON-RPC 2.0 over HTTP POST to fnn)", () => {
  describe("request format", () => {
    it("POSTs a JSON-RPC 2.0 body with the params as a one-object array to the configured URL", async () => {
      const rec = recorder(resultOf({ invoice_address: "x", invoice: { currency: "Fibt", data: { timestamp: "0x1", payment_hash: "0x1" } }, status: "Open" }));
      await client(rec.post).request(FIBER_RPC_METHOD.GET_INVOICE, { payment_hash: with0x(PAYMENT_HASH) });

      expect(rec.calls).toHaveLength(1);
      const [call] = rec.calls;
      expect(call?.url).toBe(RPC_URL);
      expect(call?.init.method).toBe("POST");
      expect(call?.init.headers["content-type"]).toBe("application/json");
      expect(call?.body).toEqual({ jsonrpc: "2.0", id: expect.any(Number), method: "get_invoice", params: [{ payment_hash: with0x(PAYMENT_HASH) }] });
    });

    it("sends params [] for a method without params (node_info)", async () => {
      const rec = recorder(resultOf(wireNodeInfo()));
      await client(rec.post).request(FIBER_RPC_METHOD.NODE_INFO);
      expect(rec.calls[0]?.body.params).toEqual([]);
    });

    it("gives every request a new id", async () => {
      const rec = recorder(resultOf(wireNodeInfo()));
      const rpc = client(rec.post);
      await rpc.request(FIBER_RPC_METHOD.NODE_INFO);
      await rpc.request(FIBER_RPC_METHOD.NODE_INFO);
      await rpc.request(FIBER_RPC_METHOD.NODE_INFO);
      const ids = rec.calls.map((c) => c.body.id);
      expect(new Set(ids).size).toBe(3);
    });

    it("sends Authorization: Bearer <token> when a Biscuit token is configured", async () => {
      const rec = recorder(resultOf(wireNodeInfo()));
      await client(rec.post, { authToken: TOKEN }).request(FIBER_RPC_METHOD.NODE_INFO);
      expect(rec.calls[0]?.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("sends no Authorization header without a token", async () => {
      const rec = recorder(resultOf(wireNodeInfo()));
      await client(rec.post).request(FIBER_RPC_METHOD.NODE_INFO);
      const names = Object.keys(rec.calls[0]?.init.headers ?? {}).map((name) => name.toLowerCase());
      expect(names).not.toContain("authorization");
    });

    it("uses the global fetch when no HTTP function is injected", async () => {
      const fetchSpy = jest
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: wireNodeInfo() }), { status: 200 }));
      try {
        const rpc = new FiberRpcClient({ url: RPC_URL, authToken: TOKEN, timeoutMs: 1_000 });
        await expect(rpc.request(FIBER_RPC_METHOD.NODE_INFO)).resolves.toMatchObject({ version: "0.9.1" });
        const [url, init] = fetchSpy.mock.calls[0] ?? [];
        expect(url).toBe(RPC_URL);
        expect(init).toMatchObject({ method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe("results", () => {
    it("returns the result validated against the method's schema, keeping only the fields the hub reads", async () => {
      const rec = recorder(resultOf(wireNodeInfo()));
      await expect(client(rec.post).request(FIBER_RPC_METHOD.NODE_INFO)).resolves.toEqual({ version: "0.9.1", pubkey: wireNodeInfo().pubkey, chain_hash: wireNodeInfo().chain_hash });
    });

    it("keeps u128 quantities as exact hex strings (no JSON number rounding)", async () => {
      const huge = "0xffffffffffffffffffffffffffffffff";
      const rec = recorder(resultOf({ channels: [wireChannel({ pendingTlcs: [{ ...wireTlc(), amount: huge }] })] }));
      const result = await client(rec.post).request(FIBER_RPC_METHOD.LIST_CHANNELS, {});
      expect(result.channels[0]?.pending_tlcs[0]?.amount).toBe(huge);
    });

    it("accepts a null result (settle_invoice returns nothing useful)", async () => {
      const rec = recorder(resultOf(null));
      const params = { payment_hash: with0x(PAYMENT_HASH), payment_preimage: with0x(PREIMAGE) };
      await expect(client(rec.post).request(FIBER_RPC_METHOD.SETTLE_INVOICE, params)).resolves.toBeNull();
    });

    it("throws FiberRpcResponseError (503) when the result does not have the expected shape", async () => {
      const rec = recorder(resultOf({ version: 91 }));
      const error = await caught(client(rec.post).request(FIBER_RPC_METHOD.NODE_INFO));
      expect(error).toBeInstanceOf(FiberRpcResponseError);
      expect(error).toBeInstanceOf(HubError);
      expect(error).toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE, code: API_ERROR_CODE.UPSTREAM_UNAVAILABLE });
      expect((error as FiberRpcResponseError).detail).toMatch(/node_info/);
    });
  });

  describe("JSON-RPC errors", () => {
    it("throws FiberRpcError with the method, code, message and data", async () => {
      const rec = recorder(errorOf({ code: -32000, message: "Hash mismatch", data: [{ payment_hash: "0x1" }] }));
      const params = { payment_hash: with0x(PAYMENT_HASH), payment_preimage: with0x(PREIMAGE) };
      const error = await caught(client(rec.post).request(FIBER_RPC_METHOD.SETTLE_INVOICE, params));
      expect(error).toBeInstanceOf(FiberRpcError);
      expect(error).toMatchObject({ method: "settle_invoice", code: -32000, rpcMessage: "Hash mismatch", data: [{ payment_hash: "0x1" }] });
      expect(error).not.toBeInstanceOf(FiberRpcTransportError);
    });

    it("prefers the error when an answer carries both error and result", async () => {
      const rec = recorder((body) => okResponse(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {}, error: { code: -32601, message: "Method not found" } })));
      await expect(client(rec.post).request(FIBER_RPC_METHOD.NODE_INFO)).rejects.toMatchObject({ code: -32601 });
    });
  });

  describe("transport failures (outcome unknown: 503 upstream_unavailable)", () => {
    const expectTransport = (error: unknown, failure: string, method = "node_info") => {
      expect(error).toBeInstanceOf(FiberRpcTransportError);
      expect(error).toBeInstanceOf(HubError);
      expect(error).toMatchObject({ method, failure, status: HttpStatus.SERVICE_UNAVAILABLE, code: API_ERROR_CODE.UPSTREAM_UNAVAILABLE });
    };

    it("reports a network failure with the cause kept for logs only", async () => {
      const post: HttpPost = async () => {
        throw new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED ${RPC_URL}`) });
      };
      const error = await caught(client(post, { authToken: TOKEN }).request(FIBER_RPC_METHOD.NODE_INFO));
      expectTransport(error, FIBER_TRANSPORT_FAILURE.NETWORK);
      expect((error as FiberRpcTransportError).detail).toMatch(/ECONNREFUSED/);
      expect((error as Error).message).not.toContain("10.0.0.5");
      expect((error as Error).message).not.toContain(TOKEN);
    });

    it.each([500, 502, 401, 403])("reports HTTP status %i", async (status) => {
      const error = await caught(client(async () => statusResponse(status, "denied")).request(FIBER_RPC_METHOD.NODE_INFO));
      expectTransport(error, FIBER_TRANSPORT_FAILURE.HTTP_STATUS);
      expect((error as FiberRpcTransportError).detail).toContain(String(status));
    });

    it("reports a body that is not JSON as an invalid response", async () => {
      const error = await caught(client(async () => okResponse("<html>gateway</html>")).request(FIBER_RPC_METHOD.NODE_INFO));
      expectTransport(error, FIBER_TRANSPORT_FAILURE.INVALID_RESPONSE);
    });

    it("reports JSON without result or error as an invalid response", async () => {
      const error = await caught(client(async () => okResponse('{"jsonrpc":"2.0","id":1}')).request(FIBER_RPC_METHOD.NODE_INFO));
      expectTransport(error, FIBER_TRANSPORT_FAILURE.INVALID_RESPONSE);
    });

    it("times out a request the node does not answer, aborting it", async () => {
      let signal: AbortSignal | undefined;
      const post: HttpPost = (url, init) => {
        signal = init.signal;
        return hangingPost(url, init);
      };
      const started = Date.now();
      const error = await caught(client(post, { timeoutMs: 40 }).request(FIBER_RPC_METHOD.NODE_INFO));
      expectTransport(error, FIBER_TRANSPORT_FAILURE.TIMEOUT);
      expect(signal?.aborted).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("times out a response whose body never arrives", async () => {
      const post: HttpPost = async (_url, init) => ({
        ok: true,
        status: 200,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      });
      const error = await caught(client(post, { timeoutMs: 40 }).request(FIBER_RPC_METHOD.NODE_INFO));
      expectTransport(error, FIBER_TRANSPORT_FAILURE.TIMEOUT);
    });

    it("clears its timeout timer once the answer is in", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
      try {
        const rec = recorder(resultOf(wireNodeInfo()));
        await client(rec.post, { timeoutMs: 60_000 }).request(FIBER_RPC_METHOD.NODE_INFO);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it("clears its timeout timer when the call fails", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
      try {
        await caught(client(async () => statusResponse(500), { timeoutMs: 60_000 }).request(FIBER_RPC_METHOD.NODE_INFO));
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

describe("fiber-rpc errors", () => {
  it("FiberInvoiceInvalidError is a 400 invoice_invalid HubError that keeps the detail", () => {
    const error = new FiberInvoiceInvalidError("checksum failed");
    expect(error).toBeInstanceOf(HubError);
    expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: API_ERROR_CODE.INVOICE_INVALID, detail: "checksum failed" });
    expect(error.message).toContain("checksum failed");
  });

  it("isFiberRpcErrorMatching matches only fnn JSON-RPC errors whose message matches", () => {
    const rpcError = new FiberRpcError("get_invoice", -32000, "invoice not found");
    expect(isFiberRpcErrorMatching(rpcError, /not found/i)).toBe(true);
    expect(isFiberRpcErrorMatching(rpcError, /mismatch/i)).toBe(false);
    expect(isFiberRpcErrorMatching(new Error("invoice not found"), /not found/i)).toBe(false);
    expect(isFiberRpcErrorMatching(new FiberRpcTransportError("get_invoice", "network", "not found"), /not found/i)).toBe(false);
  });
});
