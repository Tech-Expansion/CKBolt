import type { FiberAssetId, FiberNodeDto, Script } from "@/lib/hub/contract";
import { MS_PER_SECOND } from "@/lib/hub/constants";
import type { ActivityEntry } from "./activity";
import { BRIDGE_ERROR, type InvoiceStatusParams, type InvoiceStatusResult, type ReceiveInvoiceParams, type ReceiveInvoiceResult } from "./bridge-protocol";
import { assetScript, liquidityOf } from "./channels";
import { fiberErrorMessage } from "./errors";
import { toHexBytes } from "./hex";
import { parseBaseUnits } from "./invoice-request";
import type { RandomBytes } from "./keys";
import type { BrowserFiberNode, NewInvoiceArgs } from "./node-port";
import { NodeRequestError } from "./request-error";
import {
  FIBER_CURRENCY,
  INVOICE_NOTE_MAX_LENGTH,
  PREIMAGE_BYTES,
  RECEIVE_INVOICE_EXPIRY_SECONDS,
  REQUEST_INVOICE_DESCRIPTION,
  type BrowserNodeNetwork,
} from "./constants";

/**
 * What the node does for Get paid on /app (docs/pay-get-paid.md, part C), with every check in the node's own tab: it
 * makes a Fiber invoice a Fiber payer pays directly, with a preimage drawn here and wiped once fnn has it, and reads the
 * status of an invoice it made for Get paid. Making an invoice spends nothing, so it needs no Confirm in the node. The
 * request's Lightning invoice is a swap's (the node makes its payout invoice with make-invoice, as for Swap).
 */

export const REQUEST_MESSAGE = {
  NOTE: `Keep the note to ${INVOICE_NOTE_MAX_LENGTH} characters, on one line.`,
  AMOUNT: "The page sent an amount your node cannot use.",
  NO_SCRIPT: (asset: string) => `The hub did not list ${asset}'s token script, so your node cannot ask for it.`,
  CANNOT_RECEIVE: (asset: string) => `Your node cannot receive this much ${asset} yet. Ask the hub for a bigger channel, then try again.`,
  NOT_IN_HISTORY: "This invoice is not one your node made for Get paid.",
} as const;

export interface RequestInvoiceDeps {
  node: BrowserFiberNode;
  network: BrowserNodeNetwork;
  /** The hub's Fiber node when it runs on the node's network (its tokens' scripts), or null. */
  hubNode: Pick<FiberNodeDto, "assets"> | null;
  random: RandomBytes;
  now: () => number;
}

/** Control characters (a new line, a tab) have no place in an invoice's one-line note. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** The visitor's note as the node writes it: trimmed, or null when empty; refused when too long or not one line. */
export function requestNote(note: string | null): string | null {
  const text = note?.trim() ?? "";
  if (text.length > INVOICE_NOTE_MAX_LENGTH || CONTROL_CHARS.test(text)) throw new NodeRequestError(BRIDGE_ERROR.INVALID_REQUEST, REQUEST_MESSAGE.NOTE);
  return text || null;
}

/**
 * new_invoice arguments for Get paid: a regular (not hold) invoice the node settles by itself with a preimage it drew,
 * sha256 like every invoice of this node (set by the adapter), valid for RECEIVE_INVOICE_EXPIRY_SECONDS.
 */
export const receiveInvoiceArgs = (args: {
  amount: bigint;
  network: BrowserNodeNetwork;
  udtTypeScript: Script | null;
  note: string | null;
  preimage: Uint8Array;
}): NewInvoiceArgs => ({
  amount: args.amount,
  currency: FIBER_CURRENCY[args.network],
  preimage: toHexBytes(args.preimage),
  expirySeconds: RECEIVE_INVOICE_EXPIRY_SECONDS,
  description: args.note ?? REQUEST_INVOICE_DESCRIPTION,
  udtTypeScript: args.udtTypeScript,
});

/**
 * The History entry of an invoice made for Get paid: Open, with its hash, the note, when it expires and the request it
 * belongs to (its Lightning invoice's payout invoice carries the same id). No invoice text.
 */
export const requestEntry = (o: {
  paymentHash: string;
  asset: FiberAssetId;
  amount: bigint;
  note: string | null;
  atMs: number;
  expiresAt: number;
  requestId?: string | null;
}): ActivityEntry => ({
  id: o.paymentHash,
  kind: "request",
  asset: o.asset,
  amount: o.amount.toString(),
  status: "Open",
  error: null,
  at: o.atMs,
  request: { note: o.note, expiresAt: o.expiresAt, ...(o.requestId ? { id: o.requestId } : {}) },
});

/**
 * Makes the Fiber invoice of a Get paid request: an amount above zero of CKB or a token the hub lists, that the node's
 * ready channels can receive now (any peer's, since a Fiber payer may route through any), and a short one-line note.
 * The preimage is drawn here, handed to fnn and wiped; the invoice goes to History without its text.
 */
export async function makeReceiveInvoice(
  deps: RequestInvoiceDeps,
  params: ReceiveInvoiceParams,
  record: (entry: ActivityEntry) => void,
): Promise<ReceiveInvoiceResult> {
  const amount = parseBaseUnits(params.amount);
  if (amount === null) throw new NodeRequestError(BRIDGE_ERROR.INVALID_REQUEST, REQUEST_MESSAGE.AMOUNT);
  const note = requestNote(params.note);
  const assets = deps.hubNode?.assets ?? [];
  const script = assetScript(params.asset, assets);
  if (script === undefined) throw new NodeRequestError(BRIDGE_ERROR.HUB_ERROR, REQUEST_MESSAGE.NO_SCRIPT(params.asset));
  const { receive } = liquidityOf(await deps.node.listChannels(), params.asset, assets);
  if (receive < amount) throw new NodeRequestError(BRIDGE_ERROR.NO_INBOUND, REQUEST_MESSAGE.CANNOT_RECEIVE(params.asset));
  const preimage = deps.random(PREIMAGE_BYTES);
  let made;
  try {
    made = await deps.node.newInvoice(receiveInvoiceArgs({ amount, network: deps.network, udtTypeScript: script, note, preimage }));
  } catch (e) {
    throw new NodeRequestError(BRIDGE_ERROR.NODE_ERROR, fiberErrorMessage(e));
  } finally {
    preimage.fill(0);
  }
  const atMs = deps.now();
  const expiresAt = atMs + RECEIVE_INVOICE_EXPIRY_SECONDS * MS_PER_SECOND;
  const paymentHash = made.paymentHash.toLowerCase();
  record(requestEntry({ paymentHash, asset: params.asset, amount, note, atMs, expiresAt, requestId: params.request ?? null }));
  return { invoice: made.invoice, paymentHash, expiresAt };
}

/** An invoice made for Get paid as get_invoice reports it now; only one the node's History holds. Its entry follows it. */
export async function readRequestInvoiceStatus(
  deps: Pick<RequestInvoiceDeps, "node">,
  entries: readonly ActivityEntry[],
  params: InvoiceStatusParams,
  record: (entry: ActivityEntry) => void,
): Promise<InvoiceStatusResult> {
  const hash = params.paymentHash.toLowerCase();
  const entry = entries.find((e) => e.kind === "request" && e.id.toLowerCase() === hash);
  if (!entry) throw new NodeRequestError(BRIDGE_ERROR.REFUSED, REQUEST_MESSAGE.NOT_IN_HISTORY);
  let status;
  try {
    status = await deps.node.getInvoiceStatus(hash);
  } catch (e) {
    throw new NodeRequestError(BRIDGE_ERROR.NODE_ERROR, fiberErrorMessage(e));
  }
  if (status !== entry.status) record({ ...entry, status });
  return { paymentHash: hash, status };
}
