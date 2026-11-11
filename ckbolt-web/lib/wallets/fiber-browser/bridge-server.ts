import { browserChannel, type ChannelFactory } from "./bridge-client";
import {
  BRIDGE_ERROR,
  BRIDGE_METHOD,
  errorResponse,
  okResponse,
  parseRequest,
  requestId,
  type BridgeRequest,
  type FiberInvoiceParams,
  type FiberInvoicePreview,
  type InvoiceStatusParams,
  type InvoiceStatusResult,
  type MakeInvoiceParams,
  type MakeInvoiceResult,
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
import { NodeRequestError } from "./request-error";
import { BRIDGE_CHANNEL_NAME } from "./constants";

const INVALID_REQUEST_MESSAGE = "Your Fiber node could not read this request. Reload the page and try again.";

/** What the node page does for the app (Swap, Pay and Get paid). */
export interface BridgeHandlers {
  presence(): NodePresence;
  /** True in the one tab whose node runs: only it answers anything but status. */
  serves(): boolean;
  makeInvoice(params: MakeInvoiceParams): Promise<MakeInvoiceResult>;
  payInvoice(params: PayInvoiceParams): Promise<PayInvoiceResult>;
  /** Pay: reads a Fiber invoice; pays nothing. */
  readInvoice(params: FiberInvoiceParams): Promise<FiberInvoicePreview>;
  /** Pay: pays a Fiber invoice once the visitor confirmed it in the node. */
  requestPayment(params: FiberInvoiceParams): Promise<RequestPaymentResult>;
  /** Pay: a payment of the node's History, as get_payment reports it. */
  paymentStatus(params: PaymentStatusParams): Promise<PaymentStatusResult>;
  /** Pay: CKB on chain once the visitor confirmed it with the node's password in the node. */
  requestOnChain(params: OnChainSendParams): Promise<OnChainSendResult>;
  /** Get paid: makes a Fiber invoice (spends nothing, so no Confirm). */
  makeReceiveInvoice(params: ReceiveInvoiceParams): Promise<ReceiveInvoiceResult>;
  /** Get paid: an invoice of the node's History, as get_invoice reports it. */
  invoiceStatus(params: InvoiceStatusParams): Promise<InvoiceStatusResult>;
}

function handle(handlers: BridgeHandlers, req: Exclude<BridgeRequest, { method: typeof BRIDGE_METHOD.STATUS }>): Promise<unknown> {
  switch (req.method) {
    case BRIDGE_METHOD.MAKE_INVOICE:
      return handlers.makeInvoice(req.params);
    case BRIDGE_METHOD.PAY_INVOICE:
      return handlers.payInvoice(req.params);
    case BRIDGE_METHOD.READ_INVOICE:
      return handlers.readInvoice(req.params);
    case BRIDGE_METHOD.REQUEST_PAYMENT:
      return handlers.requestPayment(req.params);
    case BRIDGE_METHOD.PAYMENT_STATUS:
      return handlers.paymentStatus(req.params);
    case BRIDGE_METHOD.REQUEST_ON_CHAIN:
      return handlers.requestOnChain(req.params);
    case BRIDGE_METHOD.MAKE_RECEIVE_INVOICE:
      return handlers.makeReceiveInvoice(req.params);
    case BRIDGE_METHOD.INVOICE_STATUS:
      return handlers.invoiceStatus(req.params);
  }
}

async function answer(handlers: BridgeHandlers, req: BridgeRequest) {
  if (req.method === BRIDGE_METHOD.STATUS) return okResponse(req.id, handlers.presence());
  try {
    return okResponse(req.id, await handle(handlers, req));
  } catch (e) {
    return e instanceof NodeRequestError
      ? errorResponse(req.id, e.code, e.message)
      : errorResponse(req.id, BRIDGE_ERROR.NODE_ERROR, e instanceof Error ? e.message : String(e));
  }
}

/** Answers the app's requests until the returned stop is called. */
export function startBridgeServer(handlers: BridgeHandlers, openChannel: ChannelFactory = browserChannel): () => void {
  const channel = openChannel(BRIDGE_CHANNEL_NAME);
  if (!channel) return () => undefined;
  const onMessage = (event: MessageEvent) => {
    const req = parseRequest(event.data);
    if (!req) {
      // A request of this version with params the node cannot use gets an answer, so the app does not wait.
      const id = requestId(event.data);
      if (id && handlers.serves()) channel.postMessage(errorResponse(id, BRIDGE_ERROR.INVALID_REQUEST, INVALID_REQUEST_MESSAGE));
      return;
    }
    if (req.method !== BRIDGE_METHOD.STATUS && !handlers.serves()) return;
    void answer(handlers, req).then((response) => channel.postMessage(response));
  };
  channel.addEventListener("message", onMessage);
  return () => {
    channel.removeEventListener("message", onMessage);
    channel.close();
  };
}
