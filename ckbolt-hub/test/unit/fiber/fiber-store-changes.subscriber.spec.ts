import { FiberStoreChangesSubscriber } from "../../../src/infrastructure/fiber/fiber-store-changes.subscriber";
import type { FiberSocket, FiberSocketFactory, FiberSocketHandlers } from "../../../src/infrastructure/fiber/fiber-ws.socket";
import { OTHER_HASH, PAYMENT_HASH, PREIMAGE } from "./fiber.fixtures";

const WS_URL = "ws://10.0.0.5:8227/";
const TOKEN = "biscuit-token";
const RECONNECT_MS = 5_000;

/** A socket the test drives by hand: open, push messages, drop. */
class FakeSocket implements FiberSocket {
  readonly sent: Record<string, unknown>[] = [];
  closeCalls = 0;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
    private readonly handlers: FiberSocketHandlers,
  ) {}

  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }

  close(): void {
    this.closeCalls++;
  }

  open(): void {
    this.handlers.onOpen();
  }

  receive(message: unknown): void {
    this.handlers.onMessage(typeof message === "string" ? message : JSON.stringify(message));
  }

  fail(error = new Error("ECONNREFUSED")): void {
    this.handlers.onError(error);
  }

  drop(): void {
    this.handlers.onClose();
  }
}

class FakeSockets {
  readonly opened: FakeSocket[] = [];
  readonly factory: FiberSocketFactory = (url, headers, handlers) => {
    const socket = new FakeSocket(url, headers, handlers);
    this.opened.push(socket);
    return socket;
  };

  get last(): FakeSocket {
    const socket = this.opened.at(-1);
    if (!socket) throw new Error("no socket opened");
    return socket;
  }
}

const storeChange = (variant: string, body: Record<string, unknown>, subscription = 1) => ({
  jsonrpc: "2.0",
  method: "store_changes",
  params: { subscription, result: { [variant]: body } },
});
const invoiceStatusChange = (hash = PAYMENT_HASH) => storeChange("PutCkbInvoiceStatus", { payment_hash: `0x${hash}`, invoice_status: "Received" });

describe("FiberStoreChangesSubscriber (subscribe_store_changes over WebSocket)", () => {
  let sockets: FakeSockets;
  let logger: { log: jest.Mock; warn: jest.Mock };
  let subscriber: FiberStoreChangesSubscriber;

  const make = (authToken?: string) =>
    new FiberStoreChangesSubscriber({ url: WS_URL, authToken, reconnectDelayMs: RECONNECT_MS, openSocket: sockets.factory, logger });

  /** Subscribes a recording listener and opens the socket. */
  const listen = (): string[] => {
    const seen: string[] = [];
    subscriber.subscribe((hash) => seen.push(hash));
    return seen;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    sockets = new FakeSockets();
    logger = { log: jest.fn(), warn: jest.fn() };
    subscriber = make(TOKEN);
  });

  afterEach(() => {
    subscriber.close();
    jest.useRealTimers();
  });

  describe("connecting", () => {
    it("opens nothing until someone subscribes", () => {
      expect(sockets.opened).toHaveLength(0);
    });

    it("opens one socket to the ws URL with the Biscuit token on the first subscribe, and reuses it", () => {
      listen();
      listen();
      expect(sockets.opened).toHaveLength(1);
      expect(sockets.last.url).toBe(WS_URL);
      expect(sockets.last.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    });

    it("sends no Authorization header without a token", () => {
      subscriber = make();
      listen();
      expect(sockets.last.headers).toEqual({});
    });

    it("asks for subscribe_store_changes with params [] once the socket is open, not before", () => {
      listen();
      expect(sockets.last.sent).toEqual([]);
      sockets.last.open();
      expect(sockets.last.sent).toEqual([{ jsonrpc: "2.0", id: expect.any(Number), method: "subscribe_store_changes", params: [] }]);
    });
  });

  describe("notifications", () => {
    it.each([
      ["PutCkbInvoiceStatus", { payment_hash: `0x${PAYMENT_HASH}`, invoice_status: "Received" }],
      ["PutPreimage", { payment_hash: `0x${PAYMENT_HASH}`, payment_preimage: `0x${PREIMAGE}` }],
      ["PutPaymentSession", { payment_hash: `0x${PAYMENT_HASH}`, payment_session: {}, payment_preimage: null }],
      ["PutAttempt", { payment_hash: `0x${PAYMENT_HASH}`, attempt_status: "Success" }],
    ])("passes the payment hash of a %s change to the listeners", (variant, body) => {
      const seen = listen();
      sockets.last.open();
      sockets.last.receive(storeChange(variant, body));
      expect(seen).toEqual([PAYMENT_HASH]);
    });

    it("tells every listener", () => {
      const first = listen();
      const second = listen();
      sockets.last.open();
      sockets.last.receive(invoiceStatusChange());
      sockets.last.receive(invoiceStatusChange(OTHER_HASH));
      expect(first).toEqual([PAYMENT_HASH, OTHER_HASH]);
      expect(second).toEqual([PAYMENT_HASH, OTHER_HASH]);
    });

    it("does not treat the subscribe answer as a change", () => {
      const seen = listen();
      sockets.last.open();
      sockets.last.receive({ jsonrpc: "2.0", id: 1, result: 42 });
      expect(seen).toEqual([]);
      expect(logger.log).toHaveBeenCalled();
    });

    it("warns when fnn refuses the subscription (pubsub module not enabled) and delivers nothing", () => {
      const seen = listen();
      sockets.last.open();
      sockets.last.receive({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
      expect(seen).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("pubsub"));
    });

    it.each([
      ["text that is not JSON", "not json"],
      ["another notification", { jsonrpc: "2.0", method: "other_event", params: { result: { PutPreimage: { payment_hash: `0x${PAYMENT_HASH}` } } } }],
      ["a change without a payment hash", storeChange("PutChannelState", { channel_id: "0x01" })],
      ["a hash of the wrong length", storeChange("PutPreimage", { payment_hash: "0xabcd" })],
    ])("ignores %s", (_label, message) => {
      const seen = listen();
      sockets.last.open();
      sockets.last.receive(message);
      expect(seen).toEqual([]);
    });

    it("keeps telling the other listeners when one throws", () => {
      subscriber.subscribe(() => {
        throw new Error("listener bug");
      });
      const seen = listen();
      sockets.last.open();
      sockets.last.receive(invoiceStatusChange());
      expect(seen).toEqual([PAYMENT_HASH]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("listener bug"));
    });

    it("logs socket errors without throwing", () => {
      listen();
      expect(() => sockets.last.fail(new Error("ECONNRESET"))).not.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ECONNRESET"));
    });
  });

  describe("unsubscribing", () => {
    it("stops telling a listener that unsubscribed, and keeps the socket for the others", () => {
      const kept = listen();
      const dropped: string[] = [];
      const unsubscribe = subscriber.subscribe((hash) => dropped.push(hash));
      sockets.last.open();
      unsubscribe();
      sockets.last.receive(invoiceStatusChange());
      expect(kept).toEqual([PAYMENT_HASH]);
      expect(dropped).toEqual([]);
      expect(sockets.last.closeCalls).toBe(0);
    });

    it("closes the socket when the last listener leaves, ignores its late events and does not reconnect", () => {
      const seen: string[] = [];
      const unsubscribe = subscriber.subscribe((hash) => seen.push(hash));
      const socket = sockets.last;
      socket.open();
      unsubscribe();
      expect(socket.closeCalls).toBe(1);

      socket.receive(invoiceStatusChange());
      socket.drop();
      jest.advanceTimersByTime(RECONNECT_MS * 3);
      expect(seen).toEqual([]);
      expect(sockets.opened).toHaveLength(1);
    });

    it("opens a new socket for a listener that comes after everyone left", () => {
      const unsubscribe = subscriber.subscribe(() => undefined);
      unsubscribe();
      listen();
      expect(sockets.opened).toHaveLength(2);
    });
  });

  describe("reconnecting (fnn keeps no subscribers across restarts)", () => {
    it("reopens the socket after the reconnect delay and subscribes again", () => {
      const seen = listen();
      const first = sockets.last;
      first.open();
      first.drop();

      jest.advanceTimersByTime(RECONNECT_MS - 1);
      expect(sockets.opened).toHaveLength(1);
      jest.advanceTimersByTime(1);
      expect(sockets.opened).toHaveLength(2);

      const second = sockets.last;
      expect(second.url).toBe(WS_URL);
      expect(second.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
      second.open();
      expect(second.sent).toEqual([expect.objectContaining({ method: "subscribe_store_changes", params: [] })]);

      second.receive(invoiceStatusChange());
      expect(seen).toEqual([PAYMENT_HASH]);
    });

    it("ignores anything the old socket still says after it closed", () => {
      const seen = listen();
      const first = sockets.last;
      first.open();
      first.drop();
      jest.advanceTimersByTime(RECONNECT_MS);
      first.receive(invoiceStatusChange());
      first.drop();
      jest.advanceTimersByTime(RECONNECT_MS);
      expect(seen).toEqual([]);
      expect(sockets.opened).toHaveLength(2);
    });

    it("keeps retrying while the node is down (error then close on each attempt)", () => {
      listen();
      for (let attempt = 1; attempt <= 4; attempt++) {
        sockets.last.fail();
        sockets.last.drop();
        jest.advanceTimersByTime(RECONNECT_MS);
        expect(sockets.opened).toHaveLength(attempt + 1);
      }
    });

    it("does not open a second socket when someone subscribes while a reconnect is pending", () => {
      listen();
      sockets.last.drop();
      listen();
      expect(sockets.opened).toHaveLength(1);
      jest.advanceTimersByTime(RECONNECT_MS);
      expect(sockets.opened).toHaveLength(2);
    });

    it("does not reconnect when the last listener left before the close arrived", () => {
      const unsubscribe = subscriber.subscribe(() => undefined);
      const socket = sockets.last;
      unsubscribe();
      socket.drop();
      jest.advanceTimersByTime(RECONNECT_MS * 2);
      expect(sockets.opened).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe("close (module shutdown)", () => {
    it("closes the socket and never reconnects", () => {
      const seen = listen();
      const socket = sockets.last;
      socket.open();
      subscriber.close();
      expect(socket.closeCalls).toBe(1);
      socket.receive(invoiceStatusChange());
      socket.drop();
      jest.advanceTimersByTime(RECONNECT_MS * 3);
      expect(seen).toEqual([]);
      expect(sockets.opened).toHaveLength(1);
    });

    it("cancels a pending reconnect", () => {
      listen();
      sockets.last.drop();
      expect(jest.getTimerCount()).toBe(1);
      subscriber.close();
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(RECONNECT_MS * 2);
      expect(sockets.opened).toHaveLength(1);
    });

    it("does not connect for a listener added after close", () => {
      subscriber.close();
      listen();
      expect(sockets.opened).toHaveLength(0);
    });

    it("can be called twice", () => {
      listen();
      subscriber.close();
      expect(() => subscriber.close()).not.toThrow();
    });
  });
});
