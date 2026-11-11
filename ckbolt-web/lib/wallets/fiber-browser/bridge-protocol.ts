import type { FiberAssetId } from "@/lib/hub/contract";
import { isFiberAssetId, UUID_PATTERN } from "@/lib/hub/constants";
import { MAX_PAYOUT_INVOICE_LENGTH } from "@/lib/wallets/fiber-byo/constants";
import type { NodeInvoiceStatus } from "./node-port";
import { BRIDGE_PROTOCOL_VERSION, INVOICE_NOTE_MAX_LENGTH, MAX_CKB_ADDRESS_LENGTH } from "./constants";

/**
 * The bridge between the app on /app (Swap, Pay and Get paid) and the node (the header's Fiber node, its window, or
 * /app/fiber): a same-origin BroadcastChannel, so it works although the isolated node page has no opener. The app sends
 * requests; the tab that runs the node answers. Every message carries the protocol version and a random id that pairs a request with
 * its response. Nothing secret crosses it: no key, no password, no preimage. A payment that is not a swap's is never
 * made because a page asked: the node asks the visitor to confirm it in the node first.
 */

export const BRIDGE_METHOD = {
  /** Is a node tab open, and what can its node do? Every node tab answers. */
  STATUS: "status",
  /** ln_to_fiber: make the payout invoice. Only the tab that runs the node answers. */
  MAKE_INVOICE: "make-invoice",
  /** fiber_to_ln: pay the hub's hold invoice. Only the tab that runs the node answers. */
  PAY_INVOICE: "pay-invoice",
  /** Pay: read a Fiber invoice (parse_invoice) and check it, without paying it. */
  READ_INVOICE: "read-invoice",
  /** Pay: pay a Fiber invoice, once the visitor confirms it in the node. */
  REQUEST_PAYMENT: "request-payment",
  /** Pay: a payment of the node's History (one it made for Pay) as get_payment reports it now. */
  PAYMENT_STATUS: "payment-status",
  /** Pay: send CKB on chain from the node's balance, once the visitor confirms it with the node's password in the node. */
  REQUEST_ON_CHAIN: "request-on-chain",
  /** Get paid: make a Fiber invoice a Fiber payer pays directly. Spends nothing, so it needs no Confirm. */
  MAKE_RECEIVE_INVOICE: "make-receive-invoice",
  /** Get paid: an invoice of the node's History (one it made for Get paid) as get_invoice reports it now. */
  INVOICE_STATUS: "invoice-status",
} as const;

export type BridgeMethod = (typeof BRIDGE_METHOD)[keyof typeof BRIDGE_METHOD];

export const BRIDGE_ERROR = {
  /** No node tab answered in time. */
  NO_NODE: "no_node",
  TIMEOUT: "timeout",
  /** The node tab is open but its node is not running (locked, starting, or another tab runs it). */
  NOT_RUNNING: "not_running",
  INVALID_REQUEST: "invalid_request",
  /** The node is on another CKB network than the hub. */
  WRONG_NETWORK: "wrong_network",
  /** Not enough in the node's ready channels to receive the payout. */
  NO_INBOUND: "no_inbound",
  /** Not enough in the node's ready channels to pay. */
  NO_OUTBOUND: "no_outbound",
  /** The node refused: the invoice is not the hub's hold invoice for a waiting swap. */
  REFUSED: "refused",
  /** The hub could not be asked. */
  HUB_ERROR: "hub_error",
  NODE_ERROR: "node_error",
  /** The visitor declined in the node, or did not confirm in time: nothing was sent. */
  DECLINED: "declined",
  /** The node already waits for the visitor to confirm another request. */
  BUSY: "busy",
  /**
   * Pay: the node's dry runs found no route to the payee, its own nor through the hub; the message is fnn's reason
   * (the page shows its own line, the reason behind a "?").
   */
  NO_ROUTE: "no_route",
} as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR)[keyof typeof BRIDGE_ERROR];

export type NodePhase = "locked" | "starting" | "running" | "other-tab" | "failed";

/** What a node tab says about itself. Amounts are decimal strings of base units. */
export interface NodePresence {
  phase: NodePhase;
  nodeId: string | null;
  network: string;
  /** Connected to the hub's Fiber node right now. */
  hubConnected: boolean;
  /** Per asset, what the node can send and receive over its ready channels. */
  liquidity: Partial<Record<FiberAssetId, { send: string; receive: string }>>;
  /** Shannons the node holds on chain, or null until read (a tab of an older page leaves it out). */
  onChainCkb?: string | null;
  /** Whole CKB the running node puts into a channel from the hub, or null when it does not run. */
  contributionCkb?: number | null;
}

export interface MakeInvoiceParams {
  asset: FiberAssetId;
  /** The quote's receive amount, base units. */
  amount: string;
  /** The invoice must stay valid past this. */
  quoteExpiresAt: string;
  /** The hub's CKB network, from its health, when the swap form knows it. */
  network: string | null;
  /** Get paid: the request this payout invoice is for (a UUID); left out for a swap. */
  request?: string | null;
}

export interface MakeInvoiceResult {
  invoice: string;
  paymentHash: string;
}

export interface PayInvoiceParams {
  swapId: string;
  invoice: string;
}

export interface PayInvoiceResult {
  paymentHash: string;
  /** fiber's payment status when send_payment returned (Created, Inflight...); the hub's swap state is what counts. */
  status: string;
}

/** Pay: a Fiber invoice the visitor pasted (read-invoice, request-payment). */
export interface FiberInvoiceParams {
  invoice: string;
}

/**
 * Pay: how the node will pay a Fiber invoice, as its dry runs found: `direct`, a route of its own; `hub`, through the
 * CKBolt hub's Fiber node as a trampoline. Only the kind crosses the bridge; the node keeps the hop it probed.
 */
export type FiberPaymentRoute = "direct" | "hub";

const PAYMENT_ROUTES: readonly string[] = ["direct", "hub"] satisfies FiberPaymentRoute[];

/** Pay: what the node read in a Fiber invoice and will pay, once checked. Amounts are decimal strings of base units. */
export interface FiberInvoicePreview {
  /** 0x, lower case. */
  paymentHash: string;
  asset: FiberAssetId;
  amount: string;
  /** The most its routing fee may be (send_payment `max_fee_amount`). */
  maxFee: string;
  /** Epoch ms it stops being payable, or null when it never expires. */
  expiresAt: number | null;
  /** The node it pays, or null when it names none. */
  payee: string | null;
  /** The route it will pay on. */
  route: FiberPaymentRoute;
}

/** Pay: the payment the node sent once the visitor confirmed it. */
export interface RequestPaymentResult {
  paymentHash: string;
  /** fiber's payment status when send_payment returned (Created, Inflight, Success, Failed). */
  status: string;
  maxFee: string;
}

export interface PaymentStatusParams {
  /** 0x and 64 hex characters. */
  paymentHash: string;
}

/** Pay: a payment as get_payment reports it now. */
export interface PaymentStatusResult {
  paymentHash: string;
  status: string;
  /** The routing fee it paid, base units (0 until it succeeds). */
  fee: string;
  failedError: string | null;
}

/** Pay: CKB on chain to an address. */
export interface OnChainSendParams {
  address: string;
  /** Shannons, decimal. */
  amount: string;
}

/** Pay: the on-chain send that went out once the visitor confirmed it. */
export interface OnChainSendResult {
  txHash: string;
  /** Shannons the address receives. */
  amount: string;
  /** Shannons paid in fees. */
  fee: string;
}

/** Get paid: the Fiber invoice to make. */
export interface ReceiveInvoiceParams {
  asset: FiberAssetId;
  /** Base units, decimal, above zero. */
  amount: string;
  /** The visitor's note, at most INVOICE_NOTE_MAX_LENGTH characters, or null. */
  note: string | null;
  /** The request it is for (a UUID), which its Lightning invoice's payout invoice carries too; left out by an older page. */
  request?: string | null;
}

/** Get paid: the invoice the node made (its preimage stays in the node, wiped once handed to fnn). */
export interface ReceiveInvoiceResult {
  invoice: string;
  /** 0x, lower case. */
  paymentHash: string;
  /** Epoch ms it stops being payable. */
  expiresAt: number;
}

export interface InvoiceStatusParams {
  /** 0x and 64 hex characters. */
  paymentHash: string;
}

/** Get paid: an invoice as get_invoice reports it now. */
export interface InvoiceStatusResult {
  paymentHash: string;
  status: NodeInvoiceStatus;
}

type Envelope = { v: typeof BRIDGE_PROTOCOL_VERSION; kind: "request"; id: string };

export type BridgeRequest =
  | (Envelope & { method: typeof BRIDGE_METHOD.STATUS })
  | (Envelope & { method: typeof BRIDGE_METHOD.MAKE_INVOICE; params: MakeInvoiceParams })
  | (Envelope & { method: typeof BRIDGE_METHOD.PAY_INVOICE; params: PayInvoiceParams })
  | (Envelope & { method: typeof BRIDGE_METHOD.READ_INVOICE; params: FiberInvoiceParams })
  | (Envelope & { method: typeof BRIDGE_METHOD.REQUEST_PAYMENT; params: FiberInvoiceParams })
  | (Envelope & { method: typeof BRIDGE_METHOD.PAYMENT_STATUS; params: PaymentStatusParams })
  | (Envelope & { method: typeof BRIDGE_METHOD.REQUEST_ON_CHAIN; params: OnChainSendParams })
  | (Envelope & { method: typeof BRIDGE_METHOD.MAKE_RECEIVE_INVOICE; params: ReceiveInvoiceParams })
  | (Envelope & { method: typeof BRIDGE_METHOD.INVOICE_STATUS; params: InvoiceStatusParams });

export type BridgeResponse =
  | { v: typeof BRIDGE_PROTOCOL_VERSION; kind: "response"; id: string; ok: true; result: unknown }
  | { v: typeof BRIDGE_PROTOCOL_VERSION; kind: "response"; id: string; ok: false; error: { code: BridgeErrorCode; message: string } };

/* ------------------------------------------------------------------------------------------------ guards */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const ERROR_CODES: readonly string[] = Object.values(BRIDGE_ERROR);
const PHASES: readonly string[] = ["locked", "starting", "running", "other-tab", "failed"];

/** A Get paid request's id: a UUID, or null when there is none (missing from an older page); anything else is refused. */
const requestRef = (v: unknown): string | null | undefined =>
  v === undefined || v === null ? null : typeof v === "string" && UUID_PATTERN.test(v) ? v.toLowerCase() : undefined;

const makeInvoiceParams = (p: unknown): MakeInvoiceParams | null => {
  // Any well-formed asset id: the node itself refuses one its hub does not list for its network (swap-requests.ts).
  if (!isRecord(p) || !isFiberAssetId(p.asset) || !isString(p.amount) || !isString(p.quoteExpiresAt)) return null;
  if (p.network !== null && !isString(p.network)) return null;
  const request = requestRef(p.request);
  if (request === undefined) return null;
  return { asset: p.asset, amount: p.amount, quoteExpiresAt: p.quoteExpiresAt, network: p.network, ...(request ? { request } : {}) };
};

const isPayInvoiceParams = (p: unknown): p is PayInvoiceParams => isRecord(p) && isString(p.swapId) && isString(p.invoice);

const BASE_UNITS = /^\d{1,30}$/;
const POSITIVE_UNITS = /^[1-9]\d{0,29}$/;
const PAYMENT_HASH = /^0x[0-9a-f]{64}$/i;
const isBaseUnits = (v: unknown): v is string => typeof v === "string" && BASE_UNITS.test(v);
/** An asset id as the hub writes them; whether the hub serves it is checked where it is used, against the hub's list. */
const isFiberAsset = isFiberAssetId;
/** get_invoice's statuses (fnn 0.9.1). */
const INVOICE_STATUSES: readonly string[] = ["Open", "Cancelled", "Expired", "Received", "Paid"];

/** Params are rebuilt from their listed fields only, so nothing else a page sends reaches the node's handlers. */
const fiberInvoiceParams = (p: unknown): FiberInvoiceParams | null =>
  isRecord(p) && isString(p.invoice) && p.invoice.length <= MAX_PAYOUT_INVOICE_LENGTH ? { invoice: p.invoice } : null;

const hashParams = (p: unknown): { paymentHash: string } | null =>
  isRecord(p) && typeof p.paymentHash === "string" && PAYMENT_HASH.test(p.paymentHash) ? { paymentHash: p.paymentHash.toLowerCase() } : null;

/** A note is optional: missing, null or a string no longer than the node writes. */
const receiveInvoiceParams = (p: unknown): ReceiveInvoiceParams | null => {
  if (!isRecord(p) || !isFiberAsset(p.asset) || typeof p.amount !== "string" || !POSITIVE_UNITS.test(p.amount)) return null;
  const note = p.note === undefined ? null : p.note;
  if (note !== null && (typeof note !== "string" || note.length > INVOICE_NOTE_MAX_LENGTH)) return null;
  const request = requestRef(p.request);
  if (request === undefined) return null;
  return { asset: p.asset, amount: p.amount, note, ...(request ? { request } : {}) };
};

const onChainSendParams = (p: unknown): OnChainSendParams | null =>
  isRecord(p) && isString(p.address) && p.address.length <= MAX_CKB_ADDRESS_LENGTH && typeof p.amount === "string" && POSITIVE_UNITS.test(p.amount)
    ? { address: p.address, amount: p.amount }
    : null;

/** A well-formed request of this protocol version, or null. */
export function parseRequest(data: unknown): BridgeRequest | null {
  if (!isRecord(data) || data.v !== BRIDGE_PROTOCOL_VERSION || data.kind !== "request" || !isString(data.id)) return null;
  const envelope: Envelope = { v: BRIDGE_PROTOCOL_VERSION, kind: "request", id: data.id };
  switch (data.method) {
    case BRIDGE_METHOD.STATUS:
      return { ...envelope, method: BRIDGE_METHOD.STATUS };
    case BRIDGE_METHOD.MAKE_INVOICE: {
      const params = makeInvoiceParams(data.params);
      return params ? { ...envelope, method: BRIDGE_METHOD.MAKE_INVOICE, params } : null;
    }
    case BRIDGE_METHOD.PAY_INVOICE:
      return isPayInvoiceParams(data.params) ? { ...envelope, method: BRIDGE_METHOD.PAY_INVOICE, params: data.params } : null;
    case BRIDGE_METHOD.READ_INVOICE:
    case BRIDGE_METHOD.REQUEST_PAYMENT: {
      const params = fiberInvoiceParams(data.params);
      return params ? { ...envelope, method: data.method, params } : null;
    }
    case BRIDGE_METHOD.PAYMENT_STATUS:
    case BRIDGE_METHOD.INVOICE_STATUS: {
      const params = hashParams(data.params);
      return params ? { ...envelope, method: data.method, params } : null;
    }
    case BRIDGE_METHOD.REQUEST_ON_CHAIN: {
      const params = onChainSendParams(data.params);
      return params ? { ...envelope, method: BRIDGE_METHOD.REQUEST_ON_CHAIN, params } : null;
    }
    case BRIDGE_METHOD.MAKE_RECEIVE_INVOICE: {
      const params = receiveInvoiceParams(data.params);
      return params ? { ...envelope, method: BRIDGE_METHOD.MAKE_RECEIVE_INVOICE, params } : null;
    }
    default:
      return null;
  }
}

/** The id of a request envelope of this protocol version (even when its params are malformed), or null. */
export function requestId(data: unknown): string | null {
  return isRecord(data) && data.v === BRIDGE_PROTOCOL_VERSION && data.kind === "request" && isString(data.id) ? data.id : null;
}

/** A well-formed response of this protocol version, or null. */
export function parseResponse(data: unknown): BridgeResponse | null {
  if (!isRecord(data) || data.v !== BRIDGE_PROTOCOL_VERSION || data.kind !== "response" || !isString(data.id)) return null;
  if (data.ok === true) return { v: BRIDGE_PROTOCOL_VERSION, kind: "response", id: data.id, ok: true, result: data.result };
  const error = data.error;
  if (data.ok === false && isRecord(error) && isString(error.code) && ERROR_CODES.includes(error.code) && typeof error.message === "string") {
    return {
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "response",
      id: data.id,
      ok: false,
      error: { code: error.code as BridgeErrorCode, message: error.message },
    };
  }
  return null;
}

export const isNodePresence = (v: unknown): v is NodePresence =>
  isRecord(v) &&
  isString(v.phase) &&
  PHASES.includes(v.phase) &&
  (v.nodeId === null || isString(v.nodeId)) &&
  typeof v.network === "string" &&
  typeof v.hubConnected === "boolean" &&
  isRecord(v.liquidity);

export const isMakeInvoiceResult = (v: unknown): v is MakeInvoiceResult => isRecord(v) && isString(v.invoice) && isString(v.paymentHash);

export const isPayInvoiceResult = (v: unknown): v is PayInvoiceResult => isRecord(v) && isString(v.paymentHash) && typeof v.status === "string";

/** The preview with exactly its listed fields, each checked; null when one is not what it should be. */
export function pickInvoicePreview(v: unknown): FiberInvoicePreview | null {
  if (!isRecord(v) || typeof v.paymentHash !== "string" || !PAYMENT_HASH.test(v.paymentHash) || !isFiberAsset(v.asset)) return null;
  if (!isBaseUnits(v.amount) || !isBaseUnits(v.maxFee)) return null;
  if (v.expiresAt !== null && (typeof v.expiresAt !== "number" || !Number.isFinite(v.expiresAt))) return null;
  if (v.payee !== null && typeof v.payee !== "string") return null;
  if (typeof v.route !== "string" || !PAYMENT_ROUTES.includes(v.route)) return null;
  return {
    paymentHash: v.paymentHash.toLowerCase(),
    asset: v.asset,
    amount: v.amount,
    maxFee: v.maxFee,
    expiresAt: v.expiresAt,
    payee: v.payee,
    route: v.route as FiberPaymentRoute,
  };
}

export const isRequestPaymentResult = (v: unknown): v is RequestPaymentResult =>
  isRecord(v) && typeof v.paymentHash === "string" && PAYMENT_HASH.test(v.paymentHash) && typeof v.status === "string" && isBaseUnits(v.maxFee);

export const isPaymentStatusResult = (v: unknown): v is PaymentStatusResult =>
  isRecord(v) &&
  typeof v.paymentHash === "string" &&
  PAYMENT_HASH.test(v.paymentHash) &&
  typeof v.status === "string" &&
  isBaseUnits(v.fee) &&
  (v.failedError === null || typeof v.failedError === "string");

export const isOnChainSendResult = (v: unknown): v is OnChainSendResult =>
  isRecord(v) && typeof v.txHash === "string" && PAYMENT_HASH.test(v.txHash) && isBaseUnits(v.amount) && isBaseUnits(v.fee);

/** Get paid: the made invoice with exactly its listed fields, each checked; null when one is not what it should be. */
export function pickReceiveInvoice(v: unknown): ReceiveInvoiceResult | null {
  if (!isRecord(v) || !isString(v.invoice) || v.invoice.length > MAX_PAYOUT_INVOICE_LENGTH) return null;
  if (typeof v.paymentHash !== "string" || !PAYMENT_HASH.test(v.paymentHash)) return null;
  if (typeof v.expiresAt !== "number" || !Number.isFinite(v.expiresAt)) return null;
  return { invoice: v.invoice, paymentHash: v.paymentHash.toLowerCase(), expiresAt: v.expiresAt };
}

export const isInvoiceStatusResult = (v: unknown): v is InvoiceStatusResult =>
  isRecord(v) && typeof v.paymentHash === "string" && PAYMENT_HASH.test(v.paymentHash) && typeof v.status === "string" && INVOICE_STATUSES.includes(v.status);

/** Omit applied to each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a caller gives for a request: the method and its params. */
export type BridgeRequestBody = DistributiveOmit<BridgeRequest, "v" | "kind" | "id">;

export const request = (id: string, body: BridgeRequestBody): BridgeRequest =>
  ({ v: BRIDGE_PROTOCOL_VERSION, kind: "request", id, ...body }) as BridgeRequest;

export const okResponse = (id: string, result: unknown): BridgeResponse => ({ v: BRIDGE_PROTOCOL_VERSION, kind: "response", id, ok: true, result });

export const errorResponse = (id: string, code: BridgeErrorCode, message: string): BridgeResponse => ({
  v: BRIDGE_PROTOCOL_VERSION,
  kind: "response",
  id,
  ok: false,
  error: { code, message },
});
