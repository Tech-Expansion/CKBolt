import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { FiberStoreChangesSubscriber } from "../../../src/infrastructure/fiber/fiber-store-changes.subscriber";
import { openWsSocket, type FiberSocket, type FiberSocketHandlers } from "../../../src/infrastructure/fiber/fiber-ws.socket";
import { toWebSocketUrl } from "../../../src/infrastructure/fiber/fiber-rpc.protocol";
import { OTHER_HASH, PAYMENT_HASH } from "./fiber.fixtures";
import { eventually, FnnSimulator, startFakeFnnServer, type FakeFnnServer } from "./fnn-simulator";

/** Real sockets on 127.0.0.1: the `ws` adapter and the subscriber's reconnect against a node that restarts. */

interface Recorded {
  events: string[];
  messages: string[];
  handlers: FiberSocketHandlers;
}

function recordHandlers(): Recorded {
  const events: string[] = [];
  const messages: string[] = [];
  return {
    events,
    messages,
    handlers: {
      onOpen: () => events.push("open"),
      onMessage: (text) => messages.push(text),
      onError: () => events.push("error"),
      onClose: () => events.push("close"),
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const quietLogger = { log: () => undefined, warn: () => undefined };

describe("openWsSocket (ws package)", () => {
  let wss: WebSocketServer;
  let url: string;
  let serverSockets: WebSocket[];
  let received: string[];
  let upgradeHeaders: Record<string, string | string[] | undefined>[];
  let client: FiberSocket | undefined;

  beforeEach(async () => {
    serverSockets = [];
    received = [];
    upgradeHeaders = [];
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wss.on("connection", (socket, req) => {
      serverSockets.push(socket);
      upgradeHeaders.push(req.headers);
      socket.on("message", (data) => received.push(String(data)));
    });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`;
  });

  afterEach(async () => {
    client?.close();
    client = undefined;
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("connects with the given headers and reports open", async () => {
    const rec = recordHandlers();
    client = openWsSocket(url, { authorization: "Bearer t0ken" }, rec.handlers);
    await eventually(() => rec.events.includes("open"));
    expect(upgradeHeaders[0]?.authorization).toBe("Bearer t0ken");
  });

  it("calls no handler before the factory returns", () => {
    const rec = recordHandlers();
    client = openWsSocket(url, {}, rec.handlers);
    expect(rec.events).toEqual([]);
  });

  it("sends text to the node and delivers text and binary frames as UTF-8 text", async () => {
    const rec = recordHandlers();
    client = openWsSocket(url, {}, rec.handlers);
    await eventually(() => rec.events.includes("open") && serverSockets.length === 1);

    client.send('{"jsonrpc":"2.0","id":1,"method":"subscribe_store_changes","params":[]}');
    await eventually(() => received.length === 1);
    expect(JSON.parse(received[0]!)).toMatchObject({ method: "subscribe_store_changes" });

    serverSockets[0]!.send('{"text":"frame"}');
    serverSockets[0]!.send(Buffer.from('{"binary":"frame é"}', "utf8"), { binary: true });
    await eventually(() => rec.messages.length === 2);
    expect(rec.messages).toEqual(['{"text":"frame"}', '{"binary":"frame é"}']);
  });

  it("reports close when it closes itself", async () => {
    const rec = recordHandlers();
    client = openWsSocket(url, {}, rec.handlers);
    await eventually(() => rec.events.includes("open"));
    client.close();
    await eventually(() => rec.events.includes("close"));
  });

  it("reports close when the node goes away", async () => {
    const rec = recordHandlers();
    client = openWsSocket(url, {}, rec.handlers);
    await eventually(() => rec.events.includes("open") && serverSockets.length === 1);
    serverSockets[0]!.terminate();
    await eventually(() => rec.events.includes("close"));
  });

  it("reports error then close when nothing listens", async () => {
    const rec = recordHandlers();
    client = openWsSocket(`ws://127.0.0.1:${await freePort()}/`, {}, rec.handlers);
    await eventually(() => rec.events.includes("close"));
    expect(rec.events).toEqual(["error", "close"]);
  });
});

describe("FiberStoreChangesSubscriber over real sockets", () => {
  let servers: FakeFnnServer[];
  let subscriber: FiberStoreChangesSubscriber | undefined;

  const start = async (port = 0): Promise<FakeFnnServer> => {
    const server = await startFakeFnnServer(new FnnSimulator(), port);
    servers.push(server);
    return server;
  };

  const subscribe = (rpcUrl: string, reconnectDelayMs = 50): string[] => {
    const seen: string[] = [];
    subscriber = new FiberStoreChangesSubscriber({ url: toWebSocketUrl(rpcUrl), authToken: "biscuit", reconnectDelayMs, logger: quietLogger });
    subscriber.subscribe((hash) => seen.push(hash));
    return seen;
  };

  const change = (hash: string) => ({ PutCkbInvoiceStatus: { payment_hash: `0x${hash}`, invoice_status: "Received" } });

  beforeEach(() => {
    servers = [];
    subscriber = undefined;
  });

  afterEach(async () => {
    subscriber?.close();
    for (const server of servers) await server.close();
  });

  it("subscribes with the Biscuit token and receives pushes", async () => {
    const server = await start();
    const seen = subscribe(server.rpcUrl);
    await server.waitForSubscribers(1);
    expect(server.wsHeaders[0]?.authorization).toBe("Bearer biscuit");
    expect(server.wsRequests).toEqual([{ method: "subscribe_store_changes", params: [] }]);

    server.push(change(PAYMENT_HASH));
    await eventually(() => seen.length === 1);
    expect(seen).toEqual([PAYMENT_HASH]);
  });

  it("reconnects and subscribes again after the node restarts", async () => {
    const first = await start();
    const seen = subscribe(first.rpcUrl);
    await first.waitForSubscribers(1);
    await first.close();

    const restarted = await start(first.port);
    await restarted.waitForSubscribers(1);
    restarted.push(change(OTHER_HASH));
    await eventually(() => seen.length === 1);
    expect(seen).toEqual([OTHER_HASH]);
  });

  it("connects once the node comes up after the hub", async () => {
    const port = await freePort();
    const seen = subscribe(`http://127.0.0.1:${port}`);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const server = await start(port);
    await server.waitForSubscribers(1);
    server.push(change(PAYMENT_HASH));
    await eventually(() => seen.length === 1);
  });

  it("closes its socket on close and does not come back", async () => {
    const server = await start();
    subscribe(server.rpcUrl);
    await server.waitForSubscribers(1);
    subscriber?.close();
    await eventually(() => server.subscribers() === 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.subscribers()).toBe(0);
    expect(server.wsHeaders).toHaveLength(1);
  });
});
