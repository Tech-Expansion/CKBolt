import type { HubClient } from "@/lib/hub/client";
import type { FiberAssetId, FiberNodeDto } from "@/lib/hub/contract";
import { BRIDGE_ERROR, type BridgeErrorCode, type MakeInvoiceParams, type MakeInvoiceResult, type PayInvoiceParams, type PayInvoiceResult } from "./bridge-protocol";
import { assetScript, swapLiquidity, type HubAssets } from "./channels";
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

/** fiber_to_ln: pays the hold invoice only when the hub says it belongs to that swap and the swap waits for it. */
export async function payHoldInvoice(deps: SwapRequestDeps, params: PayInvoiceParams): Promise<SentPayment> {
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
    throw new SwapRequestError(BRIDGE_ERROR.REFUSED, "This is not the hub's Fiber invoice for that swap, so your node did not pay it.");
  }
  if (swap.state !== "pending") {
    throw new SwapRequestError(BRIDGE_ERROR.REFUSED, "This swap no longer waits for a payment, so your node did not pay.");
  }
  const amount = parseBaseUnits(swap.pay.amount) ?? BigInt(0);
  const liquidity = swapLiquidity(await deps.node.listChannels(), swap.asset, requireHubNode(deps));
  if (liquidity.send < amount) {
    throw new SwapRequestError(
      BRIDGE_ERROR.NO_OUTBOUND,
      `Your node cannot send this much ${swap.asset} yet. Receive it first: ask the hub for a channel on the node page, then swap BTC to ${swap.asset}.`,
    );
  }
  let payment;
  try {
    payment = await deps.node.sendPayment(params.invoice);
  } catch (e) {
    throw new SwapRequestError(BRIDGE_ERROR.NODE_ERROR, fiberErrorMessage(e));
  }
  if (payment.status === PAYMENT_STATUS.FAILED) {
    throw new SwapRequestError(BRIDGE_ERROR.NODE_ERROR, payment.failedError ?? "Your node could not send the payment.");
  }
  return { paymentHash: payment.paymentHash, status: payment.status, asset: swap.asset, amount: swap.pay.amount, lightningSats: swap.receive.amount };
}
