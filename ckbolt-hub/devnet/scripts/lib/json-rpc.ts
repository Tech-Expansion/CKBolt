import { FIBER_RPC_HTTP, JSON_RPC_VERSION } from "../../../src/common/constants/fiber-rpc.constants";

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/** `rpcMessage` is the node's own error text, for matching; `message` adds the method and the data, for logs. */
export class JsonRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly rpcMessage: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${rpcMessage}${data === undefined ? "" : ` (${JSON.stringify(data)})`}`);
  }
}

/** Minimal JSON-RPC 2.0 client over HTTP POST (fnn and CKB both speak it). */
export class JsonRpcClient {
  private nextId = 1;

  constructor(
    readonly url: string,
    private readonly timeoutMs: number,
  ) {}

  async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    const response = await fetch(this.url, {
      method: FIBER_RPC_HTTP.METHOD,
      headers: { [FIBER_RPC_HTTP.CONTENT_TYPE_HEADER]: FIBER_RPC_HTTP.CONTENT_TYPE },
      body: JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status} from ${this.url}`);
    const body = (await response.json()) as JsonRpcResponse<T>;
    if (body.error) throw new JsonRpcError(method, body.error.code, body.error.message, body.error.data);
    return body.result as T;
  }
}
