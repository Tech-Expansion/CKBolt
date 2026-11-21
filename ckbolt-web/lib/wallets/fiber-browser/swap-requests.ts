import { decodeBolt11 } from "@/lib/bolt11";
import type { HubClient } from "@/lib/hub/client";
import type { FiberAssetId, FiberNodeDto } from "@/lib/hub/contract";
import { BRIDGE_ERROR, type BridgeErrorCode, type MakeInvoiceParams, type MakeInvoiceResult, type PayInvoiceParams, type PayInvoiceResult } from "./bridge-protocol";
import { assetScript, swapLiquidity, type HubAssets } from "./channels";
import type { ConfirmView } from "./confirmations";
import { normalizeNodeId } from "./hex";
import { maxFeeOf } from "./payments";
import { sameScript } from "./scripts";
import { isInvoiceOfNetwork, parseBaseUnits, payoutInvoiceArgs } from "./invoice-request";
import type { RandomBytes } from "./keys";
import type { BrowserFiberNode, NodePaymentStatus } from "./node-port";
import { fiberErrorMessage } from "./errors";
import { NodeRequestError } from "./request-error";
import { PAYMENT_STATUS, PREIMAGE_BYTES, type BrowserNodeNetwork } from "./constants";

/**
 * What the node does when the swap form asks, with every check before it acts. The hub's swap state stays the source
 * of truth on /app; these answers only say whether the node did its part.
 */

/** A swap request the node refuses, with a bridge error code and a sentence for the swap form. */
export class SwapRequestError extends NodeRequestError {
  constructor(code: BridgeErrorCode, message: string) {
    super(code, message);
    this.name = "SwapRequestError";
  }
}

export interface SwapRequestDeps {
  node: BrowserFiberNode;
  network: BrowserNodeNetwork;
  /**
   * The hub's Fiber node (network, assets and their scripts) as GET /v1/fiber/node reported it, whatever its network:
   * the checks here refuse a hub on another network. Null when the node page could not read it.
   */
  hubNode: FiberNodeDto | null;
  hub: Pick<HubClient, "getSwap">;
  random: RandomBytes;
  now: () => number;
}

const hubAssets = (deps: SwapRequestDeps): HubAssets => deps.hubNode?.assets ?? [];

/** The hub's node; requireSameNetwork has checked it is there. */
function requireHubNode(deps: SwapRequestDeps): FiberNodeDto {
  if (!deps.hubNode) throw new SwapRequestError(BRIDGE_ERROR.HUB_ERROR, "Your node could not read the hub's Fiber node. Reload the page, then try again.");
  return deps.hubNode;
}

/**
 * The node acts only for a hub it knows runs on its own CKB network, as the hub's Fiber node reports it, and on the
 * network the swap form names, when it names one. Any page of the site can post on the bridge, so this check is the
 * node's own and does not rely on the swap form's.
 */
function requireSameNetwork(deps: SwapRequestDeps, requested: string | null | undefined): void {
  const hubNetwork = deps.hubNode?.network;
  if (!hubNetwork) {
    throw new SwapRequestError(
      BRIDGE_ERROR.HUB_ERROR,
      "Your node page could not read the hub's Fiber node, so it cannot check which network the hub runs on. Reload the node page, then try again.",
    );
  }
  for (const other of [hubNetwork, requested]) {
    if (other && other !== deps.network) {
      throw new SwapRequestError(
        BRIDGE_ERROR.WRONG_NETWORK,
        `The hub runs on CKB ${other} and your browser node on CKB ${deps.network}, so they cannot pay each other.`,
      );
    }
  }
}

/** ln_to_fiber: a sha256 invoice for exactly the quote's receive amount, valid past the quote. */
export async function makePayoutInvoice(deps: SwapRequestDeps, params: MakeInvoiceParams): Promise<MakeInvoiceResult> {
  requireSameNetwork(deps, params.network);
  const amount = parseBaseUnits(params.amount);
  if (amount === null || !Number.isFinite(Date.parse(params.quoteExpiresAt))) {
    throw new SwapRequestError(BRIDGE_ERROR.INVALID_REQUEST, "The swap form sent an amount or expiry the node cannot use.");
  }
  if (Date.parse(params.quoteExpiresAt) <= deps.now()) {
    throw new SwapRequestError(BRIDGE_ERROR.INVALID_REQUEST, "The quote has expired. Get a new quote first.");
  }
  const script = assetScript(params.asset, hubAssets(deps));
  if (script === undefined) {
    throw new SwapRequestError(BRIDGE_ERROR.HUB_ERROR, `The hub did not list ${params.asset}'s token script, so the node cannot ask for it.`);
  }
  const liquidity = swapLiquidity(await deps.node.listChannels(), params.asset, requireHubNode(deps));
  if (liquidity.receive < amount) {
    throw new SwapRequestError(
      BRIDGE_ERROR.NO_INBOUND,
      `Your node cannot receive this much ${params.asset} yet. On the node page, ask the hub for inbound liquidity, then try again.`,
    );
  }
  const preimage = deps.random(PREIMAGE_BYTES);
  try {
    return await deps.node.newInvoice(
      payoutInvoiceArgs({ amount, network: deps.network, udtTypeScript: script, quoteExpiresAt: params.quoteExpiresAt, nowMs: deps.now(), preimage }),
    );
  } catch (e) {
    throw new SwapRequestError(BRIDGE_ERROR.NODE_ERROR, fiberErrorMessage(e));
  } finally {
    preimage.fill(0);
  }
}

/** A payment the node sent, with what the hub's swap says it pays. */
export interface SentPayment extends PayInvoiceResult {
  status: NodePaymentStatus;
  asset: FiberAssetId;
  /** Base units. */
  amount: string;
  /** The swap's other leg: the sats the visitor receives on Lightning. */
  lightningSats: string;
}

/** Why the node refuses a swap's hold invoice before asking the visitor anything. Each ends with what was not done. */
export const SWAP_PAYMENT_MESSAGE = {
  NOT_THE_SWAPS: "This is not the hub's Fiber invoice for that swap, so your node did not pay it.",
  NOT_PENDING: "This swap no longer waits for a payment, so your node did not pay.",
  NOT_ACCEPTED: "The hub's swap does not match the quote you accepted (amount, token or payout), so your node did not pay.",
  UNREADABLE: (reason: string) => `Your node could not read the hub's invoice (${reason}), so it did not pay.`,
  WRONG_HASH: "The hub's invoice is not locked to your Lightning invoice's payment hash, so your node did not pay.",
  WRONG_AMOUNT: "The hub's invoice asks for another amount or token than the quote you accepted, so your node did not pay.",
  WRONG_PAYEE: "The hub's invoice does not pay the hub's own Fiber node, so your node did not pay.",
  PAYOUT_UNREADABLE: "Your node could not read the payment hash of your Lightning invoice, so it did not pay.",
  EXPIRED: "The hub's invoice has expired, so your node did not pay.",
} as const;

/** A swap payment the node checked, waiting for the visitor's Confirm. */
export interface PreparedSwapPayment {
  swapId: string;
  invoice: string;
  /** 0x, lower case: the hold invoice's hash, which is the payout invoice's. */
  paymentHash: string;
  asset: FiberAssetId;
  amount: bigint;
  maxFee: bigint;
  /** What the visitor's Lightning invoice receives, in sats. */
  receiveSats: string;
  expiresAtMs: number | null;
}

const refuse = (message: string) => new SwapRequestError(BRIDGE_ERROR.REFUSED, message);
const sameHash = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase().replace(/^0x/, "") === b.toLowerCase().replace(/^0x/, "");

/** The payment hash of the visitor's Lightning payout invoice, as the page sent it. */
function payoutHashOf(payoutInvoice: string): string {
  try {
    const hash = decodeBolt11(payoutInvoice.trim()).paymentHash;
    if (hash) return hash;
  } catch {
    // Unreadable: refused below.
  }
  throw refuse(SWAP_PAYMENT_MESSAGE.PAYOUT_UNREADABLE);
}

/**
 * fiber_to_ln, before anything is paid: the hold invoice must be the hub's for that swap (as the hub reports it), the
 * swap must wait for it, and the swap must be the one the visitor accepted. The node does not take the hub's word for
 * the rest: it reads the invoice itself and requires the hash of the visitor's own Lightning invoice (so the hub can
 * settle only by paying it out), the quoted amount and token, and the hub's own node as payee.
 */
export async function prepareSwapPayment(deps: SwapRequestDeps, params: PayInvoiceParams): Promise<PreparedSwapPayment> {
  requireSameNetwork(deps, null);
  if (!isInvoiceOfNetwork(params.invoice, deps.network)) {
    throw new SwapRequestError(
      BRIDGE_ERROR.WRONG_NETWORK,
      `This is not a Fiber invoice of CKB ${deps.network}, so your node did not pay it.`,
    );
  }
  let swap;
  try {
    swap = await deps.hub.getSwap(params.swapId);
  } catch (e) {
    throw new SwapRequestError(BRIDGE_ERROR.HUB_ERROR, `The hub could not confirm this swap: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (swap.direction !== "fiber_to_ln" || swap.pay.network !== "fiber" || swap.pay.invoice !== params.invoice) {
    throw refuse(SWAP_PAYMENT_MESSAGE.NOT_THE_SWAPS);
  }
  if (swap.state !== "pending") throw refuse(SWAP_PAYMENT_MESSAGE.NOT_PENDING);
  if (swap.asset !== params.asset || swap.pay.amount !== params.amount || swap.receive.invoice.trim() !== params.payoutInvoice.trim()) {
    throw refuse(SWAP_PAYMENT_MESSAGE.NOT_ACCEPTED);
  }

  const hubNode = requireHubNode(deps);
  const amount = parseBaseUnits(params.amount) ?? BigInt(0);
  let parsed;
  try {
    parsed = await deps.node.parseInvoice(params.invoice);
  } catch (e) {
    throw refuse(SWAP_PAYMENT_MESSAGE.UNREADABLE(fiberErrorMessage(e)));
  }
  const payoutHash = payoutHashOf(params.payoutInvoice);
  if (!sameHash(parsed.paymentHash, payoutHash) || !sameHash(parsed.paymentHash, swap.paymentHash)) {
    throw refuse(SWAP_PAYMENT_MESSAGE.WRONG_HASH);
  }
  const script = assetScript(params.asset, hubAssets(deps));
  const sameAsset = script === null ? parsed.udtTypeScript === null : script !== undefined && parsed.udtTypeScript !== null && sameScript(parsed.udtTypeScript, script);
  if (parsed.amount !== amount || !sameAsset) throw refuse(SWAP_PAYMENT_MESSAGE.WRONG_AMOUNT);
  if (parsed.payee === null || normalizeNodeId(parsed.payee) !== normalizeNodeId(hubNode.nodeId)) {
    throw refuse(SWAP_PAYMENT_MESSAGE.WRONG_PAYEE);
  }
  if (parsed.expiresAtMs !== null && parsed.expiresAtMs <= deps.now()) throw refuse(SWAP_PAYMENT_MESSAGE.EXPIRED);

  const liquidity = swapLiquidity(await deps.node.listChannels(), params.asset, hubNode);
  if (liquidity.send < amount) {
    throw new SwapRequestError(
      BRIDGE_ERROR.NO_OUTBOUND,
      `Your node cannot send this much ${params.asset} yet. Receive it first: ask the hub for a channel on the node page, then swap BTC to ${params.asset}.`,
    );
  }
  return {
    swapId: params.swapId,
    invoice: params.invoice,
    paymentHash: `0x${payoutHash.toLowerCase().replace(/^0x/, "")}`,
    asset: params.asset,
    amount,
    maxFee: maxFeeOf(amount),
    receiveSats: swap.receive.amount,
    expiresAtMs: parsed.expiresAtMs,
  };
}

/** What the node shows the visitor to confirm a swap payment. */
export const swapPaymentConfirmView = (payment: PreparedSwapPayment): ConfirmView => ({
  kind: "swap-payment",
  asset: payment.asset,
  amount: payment.amount.toString(),
  maxFee: payment.maxFee.toString(),
  receiveSats: payment.receiveSats,
  expiresAt: payment.expiresAtMs,
});

/** Pays a swap's hold invoice the visitor confirmed, with the max fee shown. */
export async function sendSwapPayment(deps: SwapRequestDeps, payment: PreparedSwapPayment): Promise<SentPayment> {
  if (payment.expiresAtMs !== null && payment.expiresAtMs <= deps.now()) throw refuse(SWAP_PAYMENT_MESSAGE.EXPIRED);
  let sent;
  try {
    sent = await deps.node.sendPayment(payment.invoice, { maxFeeAmount: payment.maxFee });
  } catch (e) {
    throw new SwapRequestError(BRIDGE_ERROR.NODE_ERROR, fiberErrorMessage(e));
  }
  if (sent.status === PAYMENT_STATUS.FAILED) {
    throw new SwapRequestError(BRIDGE_ERROR.NODE_ERROR, sent.failedError ?? "Your node could not send the payment.");
  }
  return { paymentHash: sent.paymentHash, status: sent.status, asset: payment.asset, amount: payment.amount.toString(), lightningSats: payment.receiveSats };
}
