import type { FiberNodeDto, Script } from "@/lib/hub/contract";
import { withPayment, WITHDRAW_STATUS_SENT, type ActivityEntry } from "./activity";
import {
  BRIDGE_ERROR,
  type FiberInvoiceParams,
  type FiberInvoicePreview,
  type FiberPaymentRoute,
  type OnChainSendParams,
  type OnChainSendResult,
  type PaymentStatusParams,
  type PaymentStatusResult,
  type RequestPaymentResult,
} from "./bridge-protocol";
import { channelsMovingFunds, CKB_ASSET, liquidityOf } from "./channels";
import type { ConfirmView } from "./confirmations";
import { fiberErrorMessage } from "./errors";
import { parseBaseUnits } from "./invoice-request";
import { browserKeystoreDeps, decryptKeys, type KeystoreRecord } from "./keystore";
import { normalizeNodeId } from "./hex";
import type { BrowserFiberNode, SendPaymentOptions } from "./node-port";
import { checkInvoiceText, checkParsedInvoice, PAYMENT_MESSAGE, type InvoicePreview } from "./payments";
import { NodeRequestError } from "./request-error";
import { walletTokens } from "./tokens";
import { parseCkbDestination, sendBlock, withdrawErrors, WithdrawError } from "./withdraw";
import { PAY_NOTE_MAX_CHARS, PAYMENT_STATUS, PAYMENT_STATUS_CREATED, type BrowserNodeNetwork } from "./constants";

/**
 * What the node does for Pay on /app (docs/pay-get-paid.md, part B), with every check in the node's own tab: it reads a
 * Fiber invoice, pays one only after the visitor confirmed it in the node (./confirmations.ts), keeps the payment's hash
 * in its History before send_payment, reads a payment's status, and sends CKB on chain once the visitor confirmed it
 * with the node's password, typed in the node. The bridge carries none of the secrets.
 */

export const PAY_REQUEST_MESSAGE = {
  NOT_IN_HISTORY: "This payment is not in your node's History.",
  NOT_RUNNING: "Your Fiber node is not running. Unlock it, then try again.",
  INVALID_AMOUNT: "The page sent an amount your node cannot use.",
  EMPTY_ADDRESS: "Paste a CKB address.",
  /** A dry run that came back Failed without fnn's reason. */
  NO_ROUTE_REASON: "Your node found no route.",
  /** fnn's reasons when neither its own route nor the hub's worked (the detail behind Pay's no-route line). */
  NO_ROUTE_BOTH: (direct: string, hub: string) => `Direct: ${direct}; through the CKBolt hub: ${hub}`,
} as const;

export interface FiberPayDeps {
  node: BrowserFiberNode;
  network: BrowserNodeNetwork;
  /**
   * The hub's Fiber node when it runs on the node's network (its tokens and id), or null. Its id is the trampoline a
   * payment goes through when the node has no route of its own (not `hubNodeIds`, which may hold an id kept from before).
   */
  hubNode: FiberNodeDto | null;
  /** Every id the hub is known by: its invoices are a swap's, paid from Swap only. */
  hubNodeIds: readonly string[];
  ownNodeId: string | null;
  now: () => number;
}

const refused = (message: string) => new NodeRequestError(BRIDGE_ERROR.REFUSED, message);

/**
 * How the node will pay an invoice, as its dry runs found (docs/pay-get-paid.md, "B: routes"): `direct`, a route of
 * its own to the payee; `hub`, through the CKBolt hub as a trampoline (the node needs a route to the hub only; the hub
 * finds the rest over its own channels). Every browser node's channel with the hub is private, so another browser node
 * is reached only through the hub.
 */
export type PaymentRoute = { kind: "direct" } | { kind: "hub"; trampolineHops: readonly string[] };

/** An invoice the node checked and found a route for: what it shows, and exactly how it will send once confirmed. */
export interface PayablePreview extends InvoicePreview {
  route: PaymentRoute;
}

const DIRECT: PaymentRoute = { kind: "direct" };

/** send_payment's options for a payment on `route`: the max fee shown, the route's trampoline, a dry run or not. */
const sendOptions = (maxFee: bigint, route: PaymentRoute, dryRun: boolean): SendPaymentOptions => ({
  maxFeeAmount: maxFee,
  ...(route.kind === "hub" ? { trampolineHops: route.trampolineHops } : {}),
  ...(dryRun ? { dryRun: true } : {}),
});

/**
 * Asks fnn whether it can pay `invoice` on `route` without paying it (send_payment with dry_run: no payment session, no
 * History entry): null when it built a route within the max fee, fnn's reason when it did not.
 */
export async function probePayment(node: BrowserFiberNode, invoice: string, maxFee: bigint, route: PaymentRoute): Promise<string | null> {
  try {
    const probe = await node.sendPayment(invoice, sendOptions(maxFee, route, true));
    return probe.status === PAYMENT_STATUS.FAILED ? (probe.failedError ?? PAY_REQUEST_MESSAGE.NO_ROUTE_REASON) : null;
  } catch (e) {
    return fiberErrorMessage(e);
  }
}

/**
 * The route the node will pay on: its own, when a dry run finds one; else through the hub's Fiber node as a trampoline,
 * when the hub runs on the node's network and is not the payee; else no route, refused with fnn's reasons.
 */
export async function chooseRoute(deps: FiberPayDeps, invoice: string, preview: InvoicePreview): Promise<PaymentRoute> {
  const direct = await probePayment(deps.node, invoice, preview.maxFee, DIRECT);
  if (direct === null) return DIRECT;
  const hubId = deps.hubNode?.nodeId ? normalizeNodeId(deps.hubNode.nodeId) : null;
  // fnn refuses a trampoline that is the payment's target, and a payment through the hub to itself means nothing.
  const viaHub = hubId !== null && hubId !== preview.payee && hubId !== deps.ownNodeId;
  if (!viaHub) throw new NodeRequestError(BRIDGE_ERROR.NO_ROUTE, direct);
  const hub: PaymentRoute = { kind: "hub", trampolineHops: [hubId] };
  const throughHub = await probePayment(deps.node, invoice, preview.maxFee, hub);
  if (throughHub === null) return hub;
  throw new NodeRequestError(BRIDGE_ERROR.NO_ROUTE, PAY_REQUEST_MESSAGE.NO_ROUTE_BOTH(direct, throughHub));
}

/**
 * Reads a Fiber invoice with the node (parse_invoice) and checks it: network, expiry, amount, token, payee, what can be
 * sent; then finds the route it will pay on with dry runs (chooseRoute).
 */
export async function readFiberInvoice(deps: FiberPayDeps, params: FiberInvoiceParams): Promise<PayablePreview> {
  const text = checkInvoiceText(params.invoice, deps.network);
  if (text.status !== "ok") {
    throw new NodeRequestError(BRIDGE_ERROR.INVALID_REQUEST, text.status === "invalid" ? text.error : PAYMENT_MESSAGE.NOT_FIBER("fib"));
  }
  let parsed;
  try {
    parsed = await deps.node.parseInvoice(text.invoice);
  } catch (e) {
    throw refused(PAYMENT_MESSAGE.UNREADABLE(fiberErrorMessage(e)));
  }
  const channels = await deps.node.listChannels();
  const assets = deps.hubNode?.assets ?? [];
  const verdict = checkParsedInvoice(parsed, {
    network: deps.network,
    tokens: walletTokens(deps.hubNode, []),
    ownNodeId: deps.ownNodeId,
    hubNodeIds: deps.hubNodeIds,
    nowMs: deps.now(),
    sendable: (token) => liquidityOf(channels, token.id, assets).send,
  });
  if (!verdict.ok) throw new NodeRequestError(verdict.cannotSend ? BRIDGE_ERROR.NO_OUTBOUND : BRIDGE_ERROR.REFUSED, verdict.error);
  const route = await chooseRoute(deps, text.invoice, verdict.preview);
  return { ...verdict.preview, route };
}

/** The route's kind, all a page or the Confirm page learns of it. */
const routeKind = (route: PaymentRoute): FiberPaymentRoute => route.kind;

/** What crosses the bridge of a preview: amounts as decimal strings, the route's kind only, no note. */
export const invoicePreviewDto = (preview: PayablePreview): FiberInvoicePreview => ({
  paymentHash: preview.paymentHash,
  asset: preview.token.id,
  amount: preview.amount.toString(),
  maxFee: preview.maxFee.toString(),
  expiresAt: preview.expiresAtMs,
  payee: preview.payee,
  route: routeKind(preview.route),
});

/** An invoice's note as the node shows it: trimmed, cut to a short length, or null. */
export function shortNote(note: string | null): string | null {
  const text = note?.trim() ?? "";
  if (!text) return null;
  return text.length > PAY_NOTE_MAX_CHARS ? `${text.slice(0, PAY_NOTE_MAX_CHARS)}…` : text;
}

/** What the node shows the visitor to confirm a Fiber payment. */
export const paymentConfirmView = (preview: PayablePreview): ConfirmView => ({
  kind: "fiber-payment",
  asset: preview.token.id,
  amount: preview.amount.toString(),
  maxFee: preview.maxFee.toString(),
  payee: preview.payee,
  note: shortNote(preview.description),
  expiresAt: preview.expiresAtMs,
  route: routeKind(preview.route),
});

/** The History entry of a payment from Pay, as it stands before send_payment: Created, with its hash and its max fee. */
export const paymentEntry = (preview: InvoicePreview, atMs: number): ActivityEntry => ({
  id: preview.paymentHash,
  kind: "payment",
  asset: preview.token.id,
  amount: preview.amount.toString(),
  status: PAYMENT_STATUS_CREATED,
  error: null,
  at: atMs,
  fee: null,
  payment: { maxFee: preview.maxFee.toString(), payee: preview.payee },
});

/**
 * Pays a Fiber invoice the visitor confirmed: checks its expiry again, keeps the payment in History with its hash
 * BEFORE send_payment (so a reload finds it and reads it again with get_payment), then sends with the max fee shown, on
 * exactly the route the read found (through the hub: its trampoline hop; direct: as before).
 */
export async function payConfirmedInvoice(
  deps: FiberPayDeps,
  invoice: string,
  preview: PayablePreview,
  record: (entry: ActivityEntry) => void,
): Promise<RequestPaymentResult> {
  if (preview.expiresAtMs !== null && preview.expiresAtMs <= deps.now()) throw refused(PAYMENT_MESSAGE.EXPIRED);
  const entry = paymentEntry(preview, deps.now());
  record(entry);
  let payment;
  try {
    payment = await deps.node.sendPayment(invoice, sendOptions(preview.maxFee, preview.route, false));
  } catch (e) {
    const message = fiberErrorMessage(e);
    record({ ...entry, status: PAYMENT_STATUS.FAILED, error: message });
    throw new NodeRequestError(BRIDGE_ERROR.NODE_ERROR, message);
  }
  record(withPayment(entry, payment));
  return { paymentHash: entry.id, status: payment.status, maxFee: preview.maxFee.toString() };
}

/** A payment from Pay as get_payment reports it now; only one the node's History holds. Its entry follows it. */
export async function readPaymentStatus(
  deps: Pick<FiberPayDeps, "node">,
  entries: readonly ActivityEntry[],
  params: PaymentStatusParams,
  record: (entry: ActivityEntry) => void,
): Promise<PaymentStatusResult> {
  const hash = params.paymentHash.toLowerCase();
  const entry = entries.find((e) => e.kind === "payment" && e.id.toLowerCase() === hash);
  if (!entry) throw refused(PAY_REQUEST_MESSAGE.NOT_IN_HISTORY);
  let payment;
  try {
    payment = await deps.node.getPayment(hash);
  } catch (e) {
    throw new NodeRequestError(BRIDGE_ERROR.NODE_ERROR, fiberErrorMessage(e));
  }
  record(withPayment(entry, payment));
  return { paymentHash: hash, status: payment.status, fee: payment.fee.toString(), failedError: payment.failedError };
}

/* ------------------------------------------------------------------------------------------- on chain */

export interface OnChainDeps {
  node: BrowserFiberNode;
  network: BrowserNodeNetwork;
  /** The node's own lock: it signs for it, and the change goes back to it. */
  nodeLock: Script | null;
  /** Shannons in plain cells at the node, or null until read. */
  balance: bigint | null;
  /** The node's CKB RPC. */
  rpcUrl: string;
  /** The stored, encrypted keys: the visitor's password, typed in the node, opens them to sign. */
  keystore: KeystoreRecord | null;
  now: () => number;
}

/** An on-chain send checked and priced, waiting for the visitor's Confirm. */
export interface PreparedSend {
  address: string;
  to: Script;
  amount: bigint;
  fee: bigint;
}

/**
 * Checks an on-chain send in the node: an address of its network that is not its own, an amount it holds and a cell
 * can carry, no channel moving funds; then builds the transaction without the key for its fee.
 */
export async function prepareOnChainSend(deps: OnChainDeps, params: OnChainSendParams): Promise<PreparedSend> {
  if (!deps.nodeLock || !deps.keystore) throw new NodeRequestError(BRIDGE_ERROR.NOT_RUNNING, PAY_REQUEST_MESSAGE.NOT_RUNNING);
  const destination = parseCkbDestination(params.address, deps.network, deps.nodeLock);
  if (destination.status === "empty") throw new NodeRequestError(BRIDGE_ERROR.INVALID_REQUEST, PAY_REQUEST_MESSAGE.EMPTY_ADDRESS);
  if (destination.status === "invalid") throw refused(destination.error);
  const amount = parseBaseUnits(params.amount);
  if (amount === null) throw new NodeRequestError(BRIDGE_ERROR.INVALID_REQUEST, PAY_REQUEST_MESSAGE.INVALID_AMOUNT);
  const blocked = sendBlock(amount, destination.script, deps.balance, await deps.node.listChannels());
  if (blocked) throw refused(blocked);
  // CCC loads only now: the node page does not carry it until a send needs it.
  const { cccNodeClient, previewSend } = await import("./ccc-withdraw");
  try {
    const { fee } = await previewSend({ client: cccNodeClient(deps.rpcUrl, deps.network), nodeLock: deps.nodeLock, to: destination.script, amount });
    return { address: destination.address, to: destination.script, amount, fee };
  } catch (e) {
    throw e instanceof WithdrawError ? refused(e.message) : new NodeRequestError(BRIDGE_ERROR.NODE_ERROR, e instanceof Error ? e.message : String(e));
  }
}

/** What the node shows the visitor to confirm an on-chain send. */
export const onChainConfirmView = (send: PreparedSend): ConfirmView => ({
  kind: "on-chain",
  address: send.address,
  amount: send.amount.toString(),
  fee: send.fee.toString(),
});

/**
 * Sends an on-chain send the visitor confirmed with the node's password: no channel may have started moving funds
 * since, the password opens the keystore (a wrong one throws WrongPasswordError, and the visitor may try again), the
 * keys are wiped once signed, and the send goes to History as a withdrawal.
 */
export async function sendConfirmedOnChain(
  deps: OnChainDeps,
  send: PreparedSend,
  password: string | null,
  record: (entry: ActivityEntry) => void,
): Promise<OnChainSendResult> {
  if (!deps.nodeLock || !deps.keystore) throw new NodeRequestError(BRIDGE_ERROR.NOT_RUNNING, PAY_REQUEST_MESSAGE.NOT_RUNNING);
  const { cccNodeClient, sendAmount } = await import("./ccc-withdraw");
  if (channelsMovingFunds(await deps.node.listChannels()).length > 0) throw withdrawErrors.channelsMoving();
  // The password is checked before anything is built: WrongPasswordError leaves the request up for another try.
  const keys = await decryptKeys(deps.keystore, password ?? "", browserKeystoreDeps());
  const receipt = await sendAmount({ client: cccNodeClient(deps.rpcUrl, deps.network), keys, nodeLock: deps.nodeLock, to: send.to, amount: send.amount });
  record({
    id: receipt.txHash,
    kind: "withdraw",
    asset: CKB_ASSET,
    amount: receipt.amount.toString(),
    status: WITHDRAW_STATUS_SENT,
    error: null,
    at: deps.now(),
    fee: receipt.fee.toString(),
    txHash: receipt.txHash,
    address: send.address,
  });
  return { txHash: receipt.txHash, amount: receipt.amount.toString(), fee: receipt.fee.toString() };
}
