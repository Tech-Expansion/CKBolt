import { bytesToHex } from "./hex";
import {
  BRIDGE_ERROR,
  BRIDGE_METHOD,
  isInvoiceStatusResult,
  isMakeInvoiceResult,
  isNodePresence,
  isOnChainSendResult,
  isPayInvoiceResult,
  isPaymentStatusResult,
  isRequestPaymentResult,
  parseResponse,
  pickInvoicePreview,
  pickReceiveInvoice,
  request,
  type BridgeErrorCode,
  type BridgeRequestBody,
  type FiberInvoiceParams,
  type FiberInvoicePreview,
  type InvoiceStatusParams,
  type InvoiceStatusResult,
  type MakeInvoiceParams,
  type MakeInvoiceResult,
  type NodePhase,
  type NodePresence,
  type OnChainSendParams,
  type OnChainSendResult,
  type PayInvoiceParams,
  type PayInvoiceResult,
  type PaymentStatusParams,
  type PaymentStatusResult,
  type ReceiveInvoiceParams,
  type ReceiveInvoiceResult,
  type RequestPaymentResult,
} from "./bridge-protocol";
import { BRIDGE_CHANNEL_NAME, BRIDGE_TIMING } from "./constants";

/** The part of BroadcastChannel the bridge uses; injectable for tests. */
export interface BroadcastLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close(): void;
}

export type ChannelFactory = (name: string) => BroadcastLike | null;

/** A BroadcastChannel, or null where the browser has none. */
export const browserChannel: ChannelFactory = (name) => (typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null);

const REQUEST_ID_BYTES = 16;
const randomRequestId = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(REQUEST_ID_BYTES)));

/** A request the node tab refused or did not answer; `code` says why, `message` is for the page. */
export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface BridgeTiming {
  statusWindowMs: number;
  statusLateMs: number;
  invoiceTimeoutMs: number;
  paymentTimeoutMs: number;
  readTimeoutMs: number;
  confirmTimeoutMs: number;
}

/** Status answers rank by how useful the node is: the running one wins over a locked or waiting tab. */
const PHASE_RANK: Record<NodePhase, number> = { running: 4, starting: 3, locked: 2, "other-tab": 1, failed: 0 };

const NO_NODE_MESSAGE = "No Fiber node answered. Open your Fiber node and unlock it, then try again.";
const TIMEOUT_MESSAGE = "Your Fiber node did not answer in time. Check it at the top of the page, then try again.";
const UNREADABLE_MESSAGE = "Your Fiber node sent an answer CKBolt could not read.";

/** The swap form's last view of the node: its presence, and how many status windows in a row brought no answer. */
export interface PresenceRead {
  presence: NodePresence | null;
  misses: number;
}

export const NO_PRESENCE: PresenceRead = { presence: null, misses: 0 };

/**
 * The view after one status window: an answer replaces it; a window without one keeps the last presence until
 * `missesBeforeGone` windows in a row brought none (the tab closed), so one late answer does not erase the node.
 */
export function nextPresenceRead(previous: PresenceRead, answer: NodePresence | null, missesBeforeGone: number = BRIDGE_TIMING.missesBeforeGone): PresenceRead {
  if (answer) return { presence: answer, misses: 0 };
  const misses = previous.misses + 1;
  return misses < missesBeforeGone ? { presence: previous.presence, misses } : { presence: null, misses };
}

/**
 * The swap form's side of the bridge. Each call opens its own channel and closes it when done, so nothing stays open
 * on /app when no node tab exists.
 */
export class BridgeClient {
  constructor(
    private readonly openChannel: ChannelFactory = browserChannel,
    private readonly timing: BridgeTiming = BRIDGE_TIMING,
    private readonly newId: () => string = randomRequestId,
  ) {}

  /**
   * The best answer of the open node tabs within the status window, or null when none answered. When none did, the
   * first answer that still arrives before `statusLateMs` goes to `onLate`: a busy tab answers late, it is not gone.
   */
  async status(onLate?: (presence: NodePresence) => void): Promise<NodePresence | null> {
    const answers = await this.collect({ method: BRIDGE_METHOD.STATUS }, this.timing.statusWindowMs, onLate ? this.timing.statusLateMs : 0, (late) => {
      if (isNodePresence(late)) onLate?.(late);
      return isNodePresence(late);
    });
    const presences = answers.filter(isNodePresence);
    return presences.sort((a, b) => PHASE_RANK[b.phase] - PHASE_RANK[a.phase])[0] ?? null;
  }

  /** ln_to_fiber: the payout invoice from the node; throws BridgeError. */
  async makeInvoice(params: MakeInvoiceParams): Promise<MakeInvoiceResult> {
    const result = await this.first({ method: BRIDGE_METHOD.MAKE_INVOICE, params }, this.timing.invoiceTimeoutMs);
    if (!isMakeInvoiceResult(result)) throw new BridgeError(BRIDGE_ERROR.NODE_ERROR, UNREADABLE_MESSAGE);
    return result;
  }

  /** fiber_to_ln: asks the node to pay the hub's hold invoice; throws BridgeError. */
  async payInvoice(params: PayInvoiceParams): Promise<PayInvoiceResult> {
    const result = await this.first({ method: BRIDGE_METHOD.PAY_INVOICE, params }, this.timing.paymentTimeoutMs);
    if (!isPayInvoiceResult(result)) throw new BridgeError(BRIDGE_ERROR.NODE_ERROR, UNREADABLE_MESSAGE);
    return result;
  }

  /** Pay: what the node reads in a Fiber invoice, checked by the node; nothing is paid. Throws BridgeError. */
  async readInvoice(params: FiberInvoiceParams): Promise<FiberInvoicePreview> {
    const preview = pickInvoicePreview(await this.first({ method: BRIDGE_METHOD.READ_INVOICE, params }, this.timing.readTimeoutMs));
    if (!preview) throw new BridgeError(BRIDGE_ERROR.NODE_ERROR, UNREADABLE_MESSAGE);
    return preview;
  }

  /**
   * Pay: asks the node to pay a Fiber invoice. The node asks the visitor to confirm it first, so this waits for that
   * (BridgeError `declined` when they do not), then for send_payment. Throws BridgeError.
   */
  async requestPayment(params: FiberInvoiceParams): Promise<RequestPaymentResult> {
    const result = await this.first({ method: BRIDGE_METHOD.REQUEST_PAYMENT, params }, this.timing.confirmTimeoutMs + this.timing.paymentTimeoutMs);
    if (!isRequestPaymentResult(result)) throw new BridgeError(BRIDGE_ERROR.NODE_ERROR, UNREADABLE_MESSAGE);
    return result;
  }

  /** Pay: a payment the node made for Pay, as get_payment reports it now. Throws BridgeError. */
  async paymentStatus(params: PaymentStatusParams): Promise<PaymentStatusResult> {
    const result = await this.first({ method: BRIDGE_METHOD.PAYMENT_STATUS, params }, this.timing.readTimeoutMs);
    if (!isPaymentStatusResult(result)) throw new BridgeError(BRIDGE_ERROR.NODE_ERROR, UNREADABLE_MESSAGE);
    return result;
  }

  /**
   * Pay: asks the node to send CKB on chain. The visitor confirms it in the node with the node's password (which never
   * crosses the bridge), so this waits for that, then for the CKB RPC. Throws BridgeError.
   */
  async requestOnChainSend(params: OnChainSendParams): Promise<OnChainSendResult> {
    const result = await this.first({ method: BRIDGE_METHOD.REQUEST_ON_CHAIN, params }, this.timing.confirmTimeoutMs + this.timing.paymentTimeoutMs);
    if (!isOnChainSendResult(result)) throw new BridgeError(BRIDGE_ERROR.NODE_ERROR, UNREADABLE_MESSAGE);
    return result;
  }

  /** Get paid: a Fiber invoice the node makes for a Fiber payer; nothing is spent. Throws BridgeError. */
  async makeReceiveInvoice(params: ReceiveInvoiceParams): Promise<ReceiveInvoiceResult> {
    const made = pickReceiveInvoice(await this.first({ method: BRIDGE_METHOD.MAKE_RECEIVE_INVOICE, params }, this.timing.invoiceTimeoutMs));
    if (!made) throw new BridgeError(BRIDGE_ERROR.NODE_ERROR, UNREADABLE_MESSAGE);
    return made;
  }

  /** Get paid: an invoice the node made for Get paid, as get_invoice reports it now. Throws BridgeError. */
  async invoiceStatus(params: InvoiceStatusParams): Promise<InvoiceStatusResult> {
    const result = await this.first({ method: BRIDGE_METHOD.INVOICE_STATUS, params }, this.timing.readTimeoutMs);
    if (!isInvoiceStatusResult(result)) throw new BridgeError(BRIDGE_ERROR.NODE_ERROR, UNREADABLE_MESSAGE);
    return { paymentHash: result.paymentHash.toLowerCase(), status: result.status };
  }

  /**
   * Every successful answer to one request within `windowMs`. When none came, the channel stays open until `lateMs`
   * after the request and hands answers to `late` until it takes one (returns true).
   */
  private collect(body: BridgeRequestBody, windowMs: number, lateMs = 0, late?: (result: unknown) => boolean): Promise<unknown[]> {
    const channel = this.openChannel(BRIDGE_CHANNEL_NAME);
    if (!channel) return Promise.resolve([]);
    const id = this.newId();
    const results: unknown[] = [];
    let windowOpen = true;
    let lateTimer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      clearTimeout(lateTimer);
      channel.removeEventListener("message", onMessage);
      channel.close();
    };
    const onMessage = (event: MessageEvent) => {
      const response = parseResponse(event.data);
      if (response?.id !== id || !response.ok) return;
      if (windowOpen) results.push(response.result);
      else if (late?.(response.result)) close();
    };
    return new Promise((resolve) => {
      channel.addEventListener("message", onMessage);
      channel.postMessage(request(id, body));
      setTimeout(() => {
        windowOpen = false;
        if (results.length > 0 || !late || lateMs <= windowMs) close();
        else lateTimer = setTimeout(close, lateMs - windowMs);
        resolve(results);
      }, windowMs);
    });
  }

  /** The first answer (result or error) to one request, or a timeout. */
  private first(body: BridgeRequestBody, timeoutMs: number): Promise<unknown> {
    const channel = this.openChannel(BRIDGE_CHANNEL_NAME);
    if (!channel) return Promise.reject(new BridgeError(BRIDGE_ERROR.NO_NODE, NO_NODE_MESSAGE));
    const id = this.newId();
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        channel.removeEventListener("message", onMessage);
        channel.close();
      };
      const onMessage = (event: MessageEvent) => {
        const response = parseResponse(event.data);
        if (response?.id !== id) return;
        done();
        if (response.ok) resolve(response.result);
        else reject(new BridgeError(response.error.code, response.error.message));
      };
      const timer = setTimeout(() => {
        done();
        reject(new BridgeError(BRIDGE_ERROR.TIMEOUT, TIMEOUT_MESSAGE));
      }, timeoutMs);
      channel.addEventListener("message", onMessage);
      channel.postMessage(request(id, body));
    });
  }
}
