import {
  authorizationHeaders,
  buildJsonRpcRequest,
  parseJsonRpcMessage,
  toWebSocketUrl,
} from "../../../src/infrastructure/fiber/fiber-rpc.protocol";

describe("fiber-rpc.protocol (JSON-RPC framing shared by HTTP and WebSocket)", () => {
  describe("buildJsonRpcRequest", () => {
    it("writes a JSON-RPC 2.0 request with the params array as given", () => {
      const body = buildJsonRpcRequest(7, "get_invoice", [{ payment_hash: "0xab" }]);
      expect(JSON.parse(body)).toEqual({ jsonrpc: "2.0", id: 7, method: "get_invoice", params: [{ payment_hash: "0xab" }] });
    });

    it("writes [] for a method without params (node_info, subscribe_store_changes)", () => {
      expect(JSON.parse(buildJsonRpcRequest(1, "node_info", []))).toMatchObject({ params: [] });
    });
  });

  describe("parseJsonRpcMessage", () => {
    it("reads a result", () => {
      expect(parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"result":{"a":1}}')).toMatchObject({ id: 1, result: { a: 1 } });
    });

    it("reads a null result (settle_invoice)", () => {
      const message = parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"result":null}');
      expect(message).not.toBeNull();
      expect(message?.result).toBeNull();
    });

    it("reads an error object with code, message and data", () => {
      const message = parseJsonRpcMessage('{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Hash mismatch","data":[{}]}}');
      expect(message?.error).toEqual({ code: -32000, message: "Hash mismatch", data: [{}] });
    });

    it("reads a subscription notification", () => {
      const text = '{"jsonrpc":"2.0","method":"store_changes","params":{"subscription":1,"result":{}}}';
      expect(parseJsonRpcMessage(text)).toMatchObject({ method: "store_changes", params: { subscription: 1 } });
    });

    it.each([
      ["text that is not JSON", "<html>502 Bad Gateway</html>"],
      ["an empty body", ""],
      ["a JSON array", "[1,2]"],
      ["a JSON string", '"ok"'],
      ["null", "null"],
      ["an error without a numeric code", '{"error":{"code":"x","message":"m"}}'],
    ])("returns null for %s", (_label, text) => {
      expect(parseJsonRpcMessage(text)).toBeNull();
    });
  });

  describe("authorizationHeaders", () => {
    it("sends a Biscuit token as Authorization: Bearer <token>", () => {
      expect(authorizationHeaders("EoQKCAoGCAESAhgB")).toEqual({ authorization: "Bearer EoQKCAoGCAESAhgB" });
    });

    it.each([undefined, ""])("sends no Authorization header without a token (%p)", (token) => {
      expect(authorizationHeaders(token)).toEqual({});
    });
  });

  describe("toWebSocketUrl", () => {
    it("keeps host and port and switches http to ws", () => {
      expect(toWebSocketUrl("http://127.0.0.1:8227")).toBe("ws://127.0.0.1:8227/");
    });

    it("switches https to wss and keeps the path", () => {
      expect(toWebSocketUrl("https://fnn.example.org:8443/rpc")).toBe("wss://fnn.example.org:8443/rpc");
    });

    it.each(["ftp://host:8227", "ws://host:8227"])("rejects a non-http URL (%s)", (url) => {
      expect(() => toWebSocketUrl(url)).toThrow(/http or https/);
    });

    it("rejects text that is not a URL", () => {
      expect(() => toWebSocketUrl("not a url")).toThrow();
    });
  });
});
