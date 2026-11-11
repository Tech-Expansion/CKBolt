import type { ZodError } from "zod";
import { FIBER_RPC_HTTP } from "../../common/constants/fiber-rpc.constants";
import { FIBER_TRANSPORT_FAILURE, FiberRpcError, FiberRpcResponseError, FiberRpcTransportError } from "./fiber-rpc.errors";
import { describeError } from "../../common/utils/error.util";
import { authorizationHeaders, buildJsonRpcRequest, parseJsonRpcMessage } from "./fiber-rpc.protocol";
import {
  FIBER_RPC_RESULT_SCHEMAS,
  type FiberRpc,
  type FiberRpcCalls,
  type FiberRpcParams,
  type FiberRpcResult,
  type JsonRpcMessage,
} from "./fiber-rpc.schemas";

/** The slice of `fetch` the client uses, so tests can answer requests without a network. */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type HttpPost = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<HttpResponseLike>;

export interface FiberRpcClientOptions {
  url: string;
  /** Biscuit token, sent as `Authorization: Bearer <token>`. */
  authToken?: string;
  timeoutMs: number;
  /** Defaults to the global fetch. */
  httpPost?: HttpPost;
}

const globalFetch: HttpPost = (url, init) => fetch(url, init);

/** JSON-RPC 2.0 over HTTP POST to an fnn node. Results are validated against the wire schemas before they are returned. */
export class FiberRpcClient implements FiberRpc {
  private nextId = 1;
  private readonly headers: Record<string, string>;
  private readonly httpPost: HttpPost;

  constructor(private readonly options: FiberRpcClientOptions) {
    this.headers = { [FIBER_RPC_HTTP.CONTENT_TYPE_HEADER]: FIBER_RPC_HTTP.CONTENT_TYPE, ...authorizationHeaders(options.authToken) };
    this.httpPost = options.httpPost ?? globalFetch;
  }

  async request<M extends keyof FiberRpcCalls>(method: M, ...params: FiberRpcParams<M>): Promise<FiberRpcResult<M>> {
    const message = await this.exchange(method, buildJsonRpcRequest(this.nextId++, method, params));
    if (message.error) throw new FiberRpcError(method, message.error.code, message.error.message, message.error.data);
    return this.validate(method, message.result);
  }

  private async exchange(method: string, body: string): Promise<JsonRpcMessage> {
    const message = parseJsonRpcMessage(await this.post(method, body));
    if (!message || (message.error === undefined && message.result === undefined)) {
      throw new FiberRpcTransportError(method, FIBER_TRANSPORT_FAILURE.INVALID_RESPONSE, "the answer is not a JSON-RPC response");
    }
    return message;
  }

  private async post(method: string, body: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.httpPost(this.options.url, { method: FIBER_RPC_HTTP.METHOD, headers: this.headers, body, signal: controller.signal });
      if (!response.ok) throw new FiberRpcTransportError(method, FIBER_TRANSPORT_FAILURE.HTTP_STATUS, `HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      if (error instanceof FiberRpcTransportError) throw error;
      if (controller.signal.aborted) {
        throw new FiberRpcTransportError(method, FIBER_TRANSPORT_FAILURE.TIMEOUT, `no answer within ${this.options.timeoutMs} ms`);
      }
      throw new FiberRpcTransportError(method, FIBER_TRANSPORT_FAILURE.NETWORK, describeError(error));
    } finally {
      clearTimeout(timer);
    }
  }

  private validate<M extends keyof FiberRpcCalls>(method: M, result: unknown): FiberRpcResult<M> {
    const parsed = FIBER_RPC_RESULT_SCHEMAS[method].safeParse(result);
    if (!parsed.success) throw new FiberRpcResponseError(`${method}: ${formatIssues(parsed.error)}`);
    return parsed.data;
  }
}

const formatIssues = (error: ZodError): string => error.issues.map((i) => `${i.path.join(".") || "result"} ${i.message}`).join("; ");
