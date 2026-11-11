import { FIBER_RPC_HTTP, FIBER_WS_PROTOCOL_BY_HTTP, JSON_RPC_VERSION } from "../../common/constants/fiber-rpc.constants";
import { jsonRpcMessageSchema, type JsonRpcMessage } from "./fiber-rpc.schemas";

/** JSON-RPC framing shared by the HTTP client and the store-changes WebSocket. */

export const buildJsonRpcRequest = (id: number, method: string, params: readonly unknown[]): string =>
  JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method, params });

/** Parses one JSON-RPC message; null when the text is not JSON or not a JSON-RPC object. */
export function parseJsonRpcMessage(text: string): JsonRpcMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = jsonRpcMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** `Authorization: Bearer <token>` when a Biscuit token is configured, nothing otherwise. */
export const authorizationHeaders = (authToken?: string): Record<string, string> =>
  authToken ? { [FIBER_RPC_HTTP.AUTHORIZATION_HEADER]: `${FIBER_RPC_HTTP.AUTH_SCHEME} ${authToken}` } : {};

/** fnn serves WebSocket on the HTTP RPC host and port: http://h:8227 -> ws://h:8227. */
export function toWebSocketUrl(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  const protocol = FIBER_WS_PROTOCOL_BY_HTTP[url.protocol];
  if (!protocol) throw new Error(`Fiber RPC URL must be http or https: ${rpcUrl}`);
  url.protocol = protocol;
  return url.toString();
}
