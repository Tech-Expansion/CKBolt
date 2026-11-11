import { Logger, type LoggerService } from "@nestjs/common";
import { FIBER_PUBSUB } from "../../common/constants/fiber-rpc.constants";
import { describeError } from "../../common/utils/error.util";
import type { Hex32 } from "../../domain/types";
import { paymentHashFromStoreChange } from "./fiber-rpc.mappers";
import { authorizationHeaders, buildJsonRpcRequest, parseJsonRpcMessage } from "./fiber-rpc.protocol";
import { openWsSocket, type FiberSocket, type FiberSocketFactory } from "./fiber-ws.socket";

export type PaymentHashListener = (paymentHash: Hex32) => void;

/** Push hints about payment hashes whose invoice, preimage or payment changed on the node. */
export interface FiberUpdateSource {
  /** Returns the unsubscribe function. */
  subscribe(listener: PaymentHashListener): () => void;
  close(): void;
}

export interface FiberStoreChangesOptions {
  /** ws:// or wss:// URL of the fnn RPC (same host and port as HTTP). */
  url: string;
  authToken?: string;
  reconnectDelayMs: number;
  openSocket?: FiberSocketFactory;
  logger?: Pick<LoggerService, "log" | "warn">;
}

/**
 * Keeps one `subscribe_store_changes` WebSocket open while anyone listens, and reopens it after a close. fnn does not
 * replay missed events, so listeners must still poll; these pushes only make them react sooner.
 */
export class FiberStoreChangesSubscriber implements FiberUpdateSource {
  private readonly listeners = new Set<PaymentHashListener>();
  private readonly openSocket: FiberSocketFactory;
  private readonly logger: Pick<LoggerService, "log" | "warn">;
  private socket: FiberSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped whenever the current socket is dropped, so late events from an old socket are ignored. */
  private generation = 0;
  private nextRequestId = 1;
  private closed = false;

  constructor(private readonly options: FiberStoreChangesOptions) {
    this.openSocket = options.openSocket ?? openWsSocket;
    this.logger = options.logger ?? new Logger(FiberStoreChangesSubscriber.name);
  }

  subscribe(listener: PaymentHashListener): () => void {
    this.listeners.add(listener);
    this.ensureConnected();
    return () => this.unsubscribe(listener);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.disconnect();
  }

  private unsubscribe(listener: PaymentHashListener): void {
    this.listeners.delete(listener);
    if (this.listeners.size === 0) this.disconnect();
  }

  private ensureConnected(): void {
    if (this.closed || this.socket || this.reconnectTimer) return;
    this.connect();
  }

  private connect(): void {
    const generation = ++this.generation;
    const isCurrent = (): boolean => generation === this.generation;
    this.socket = this.openSocket(this.options.url, authorizationHeaders(this.options.authToken), {
      onOpen: () => {
        if (isCurrent()) this.requestSubscription();
      },
      onMessage: (text) => {
        if (isCurrent()) this.handleMessage(text);
      },
      onError: (error) => {
        if (isCurrent()) this.logger.warn(`Fiber store-changes socket error: ${describeError(error)}`);
      },
      onClose: () => {
        if (isCurrent()) this.handleClose();
      },
    });
  }

  private requestSubscription(): void {
    this.socket?.send(buildJsonRpcRequest(this.nextRequestId++, FIBER_PUBSUB.SUBSCRIBE_METHOD, []));
  }

  /** A message is the answer to our subscribe request (no `method`) or a `store_changes` notification. */
  private handleMessage(text: string): void {
    const message = parseJsonRpcMessage(text);
    if (!message) return;
    if (message.error) {
      this.logger.warn(`Fiber ${FIBER_PUBSUB.SUBSCRIBE_METHOD} failed: ${message.error.message}. Is "pubsub" in fnn rpc.enabled_modules?`);
      return;
    }
    if (message.method === undefined) {
      this.logger.log("Subscribed to Fiber store changes");
      return;
    }
    const paymentHash = paymentHashFromStoreChange(message);
    if (paymentHash) this.notify(paymentHash);
  }

  private notify(paymentHash: Hex32): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(paymentHash);
      } catch (error) {
        this.logger.warn(`A Fiber update listener failed: ${describeError(error)}`);
      }
    }
  }

  private handleClose(): void {
    this.socket = null;
    if (this.closed || this.listeners.size === 0) return;
    this.logger.warn(`Fiber store-changes socket closed; reconnecting in ${this.options.reconnectDelayMs} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, this.options.reconnectDelayMs);
  }

  private disconnect(): void {
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }
}
