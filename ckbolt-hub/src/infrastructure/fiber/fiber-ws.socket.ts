import WebSocket from "ws";

/** The few socket events the store-changes subscriber needs. Handlers are called asynchronously, after the factory returns. */
export interface FiberSocketHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onError(error: Error): void;
  onClose(): void;
}

export interface FiberSocket {
  send(text: string): void;
  close(): void;
}

/** Opens a socket; injected so tests can drive the subscriber without a node. */
export type FiberSocketFactory = (url: string, headers: Record<string, string>, handlers: FiberSocketHandlers) => FiberSocket;

const rawDataToText = (data: WebSocket.RawData): string => {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString("utf8");
};

/** FiberSocketFactory over the `ws` package. */
export const openWsSocket: FiberSocketFactory = (url, headers, handlers) => {
  const socket = new WebSocket(url, { headers });
  socket.on("open", () => handlers.onOpen());
  socket.on("message", (data) => handlers.onMessage(rawDataToText(data)));
  socket.on("error", (error) => handlers.onError(error));
  socket.on("close", () => handlers.onClose());
  return { send: (text) => socket.send(text), close: () => socket.close() };
};
