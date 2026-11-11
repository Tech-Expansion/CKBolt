"use client";

import { useEffect, useRef } from "react";
import type { HubClient } from "@/lib/hub/client";
import type { FiberAssetId, FiberNodeDto, Script } from "@/lib/hub/contract";
import type { ActivityEntry, SwapLeg } from "@/lib/wallets/fiber-browser/activity";
import type { NodePresence } from "@/lib/wallets/fiber-browser/bridge-protocol";
import { startBridgeServer } from "@/lib/wallets/fiber-browser/bridge-server";
import { CKB_ASSET, swapLiquidity } from "@/lib/wallets/fiber-browser/channels";
import type { ConfirmationQueue } from "@/lib/wallets/fiber-browser/confirmations";
import { browserRandomBytes } from "@/lib/wallets/fiber-browser/keys";
import { WrongPasswordError, type KeystoreRecord } from "@/lib/wallets/fiber-browser/keystore";
import type { NodeState } from "@/lib/wallets/fiber-browser/node-controller";
import type { BrowserFiberNode, NodeChannel } from "@/lib/wallets/fiber-browser/node-port";
import {
  invoicePreviewDto,
  onChainConfirmView,
  payConfirmedInvoice,
  paymentConfirmView,
  prepareOnChainSend,
  readFiberInvoice,
  readPaymentStatus,
  sendConfirmedOnChain,
  type FiberPayDeps,
  type OnChainDeps,
} from "@/lib/wallets/fiber-browser/pay-requests";
import { makeReceiveInvoice, readRequestInvoiceStatus, type RequestInvoiceDeps } from "@/lib/wallets/fiber-browser/request-invoices";
import { makePayoutInvoice, payHoldInvoice, type SwapRequestDeps } from "@/lib/wallets/fiber-browser/swap-requests";
import { BRIDGE_TIMING, INVOICE_STATUS_OPEN, type BrowserNodeNetwork } from "@/lib/wallets/fiber-browser/constants";

export interface BridgeContext {
  state: NodeState;
  node: BrowserFiberNode | null;
  network: BrowserNodeNetwork;
  /** The hub's Fiber node as GET /v1/fiber/node reported it, on any network (requests for another one are refused). */
  hubNode: FiberNodeDto | null;
  hubConnected: boolean;
  channels: NodeChannel[];
  /** Shannons the node holds on chain, or null until read. */
  balance: bigint | null;
  /** Whole CKB the node puts into the hub's next CKB channel (the visitor's last choice) while it runs, or null. */
  contributionCkb: number | null;
  hub: Pick<HubClient, "getSwap">;
  record: (entry: ActivityEntry) => void;
  /** Pay and Get paid: the node's History, to read the status of a payment it made or an invoice it made for a request. */
  entries: readonly ActivityEntry[];
  /** Pay: every id the hub is known by (its invoices are paid from Swap only). */
  hubNodeIds: readonly string[];
  /** Pay: where requests wait for the visitor's Confirm in the node. */
  confirmations: ConfirmationQueue;
  /** Pay, on chain: the node's lock, its CKB RPC and its encrypted keys (the password typed in the node opens them). */
  nodeLock: Script | null;
  rpcUrl: string;
  keystore: KeystoreRecord | null;
}

/** What the node tab tells the swap form about itself. */
export function presenceOf(ctx: BridgeContext): NodePresence {
  // Only the hub's channels count for a swap; a hub on another network has none with this node.
  const hubNode = ctx.hubNode && ctx.hubNode.network === ctx.network ? ctx.hubNode : null;
  const liquidity: NodePresence["liquidity"] = {};
  // CKB always, then the assets the hub serves (none without a hub on this network).
  const ids = [CKB_ASSET, ...(hubNode?.assets.map((a) => a.id).filter((id) => id !== CKB_ASSET) ?? [])];
  for (const id of ids) {
    const { send, receive } = hubNode ? swapLiquidity(ctx.channels, id, hubNode) : { send: BigInt(0), receive: BigInt(0) };
    liquidity[id] = { send: send.toString(), receive: receive.toString() };
  }
  return {
    phase: ctx.state.phase,
    nodeId: ctx.state.info?.nodeId ?? null,
    network: ctx.network,
    hubConnected: ctx.hubConnected,
    liquidity,
    onChainCkb: ctx.balance === null ? null : ctx.balance.toString(),
    contributionCkb: ctx.contributionCkb,
  };
}

/** A swap the node served, keyed by its payment hash (both legs of a swap share it). */
const swapEntry = (o: {
  leg: SwapLeg;
  asset: FiberAssetId;
  amount: string;
  paymentHash: string;
  status: ActivityEntry["status"];
  swapId: string | null;
  lightningSats: string | null;
  /** Get paid: the request the payout invoice is for. */
  request?: string | null;
}): ActivityEntry => ({
  id: o.paymentHash,
  kind: "swap",
  asset: o.asset,
  amount: o.amount,
  status: o.status,
  error: null,
  at: Date.now(),
  swap: { id: o.swapId, leg: o.leg, lightningSats: o.lightningSats, ...(o.request ? { request: o.request } : {}) },
});

/**
 * Answers the app on /app for as long as the page is open: status from any node tab, everything else only from the tab
 * whose node runs. Swaps: the payout invoice, and the hub's hold invoice once the hub says it is the swap's. Pay: a Fiber
 * invoice read, then paid only once the visitor confirmed it in the node; a payment's status; CKB on chain once the
 * visitor confirmed it with the node's password in the node. Get paid: a Fiber invoice (it spends nothing, so no
 * Confirm) and its status. Every invoice or payment made is recorded in History.
 */
export function useBridgeServer(ctx: BridgeContext): void {
  const latest = useRef(ctx);
  useEffect(() => {
    latest.current = ctx;
  });

  useEffect(() => {
    const deps = (): SwapRequestDeps => {
      const c = latest.current;
      if (!c.node) throw new Error("The node is not running.");
      return { node: c.node, network: c.network, hubNode: c.hubNode, hub: c.hub, random: browserRandomBytes, now: () => Date.now() };
    };
    const payDeps = (): FiberPayDeps => {
      const c = latest.current;
      if (!c.node) throw new Error("The node is not running.");
      // Only a hub on this node's network lends its tokens and its id.
      const hubNode = c.hubNode && c.hubNode.network === c.network ? c.hubNode : null;
      return { node: c.node, network: c.network, hubNode, hubNodeIds: c.hubNodeIds, ownNodeId: c.state.info?.nodeId ?? null, now: () => Date.now() };
    };
    const requestDeps = (): RequestInvoiceDeps => {
      const c = latest.current;
      if (!c.node) throw new Error("The node is not running.");
      // Only a hub on this node's network lends its tokens' scripts.
      const hubNode = c.hubNode && c.hubNode.network === c.network ? c.hubNode : null;
      return { node: c.node, network: c.network, hubNode, random: browserRandomBytes, now: () => Date.now() };
    };
    const chainDeps = (): OnChainDeps => {
      const c = latest.current;
      if (!c.node) throw new Error("The node is not running.");
      return { node: c.node, network: c.network, nodeLock: c.nodeLock, balance: c.balance, rpcUrl: c.rpcUrl, keystore: c.keystore, now: () => Date.now() };
    };
    const record = (entry: ActivityEntry) => latest.current.record(entry);
    return startBridgeServer({
      presence: () => presenceOf(latest.current),
      serves: () => latest.current.state.phase === "running" && latest.current.node !== null,
      makeInvoice: async (params) => {
        const result = await makePayoutInvoice(deps(), params);
        // The hub creates the swap with this invoice, so its id is not known yet.
        latest.current.record(
          swapEntry({
            leg: "invoice",
            asset: params.asset,
            amount: params.amount,
            paymentHash: result.paymentHash,
            status: INVOICE_STATUS_OPEN,
            swapId: null,
            lightningSats: null,
            request: params.request ?? null,
          }),
        );
        return result;
      },
      payInvoice: async (params) => {
        const sent = await payHoldInvoice(deps(), params);
        latest.current.record(
          swapEntry({
            leg: "payment",
            asset: sent.asset,
            amount: sent.amount,
            paymentHash: sent.paymentHash,
            status: sent.status,
            swapId: params.swapId,
            lightningSats: sent.lightningSats,
          }),
        );
        return { paymentHash: sent.paymentHash, status: sent.status };
      },
      readInvoice: async (params) => invoicePreviewDto(await readFiberInvoice(payDeps(), params)),
      requestPayment: async (params) => {
        const preview = await readFiberInvoice(payDeps(), params);
        return latest.current.confirmations.ask(paymentConfirmView(preview), () => payConfirmedInvoice(payDeps(), params.invoice, preview, record), {
          timeoutMs: BRIDGE_TIMING.confirmTimeoutMs,
        });
      },
      paymentStatus: (params) => readPaymentStatus(payDeps(), latest.current.entries, params, record),
      requestOnChain: async (params) => {
        const send = await prepareOnChainSend(chainDeps(), params);
        return latest.current.confirmations.ask(onChainConfirmView(send), (password) => sendConfirmedOnChain(chainDeps(), send, password, record), {
          timeoutMs: BRIDGE_TIMING.confirmTimeoutMs,
          // A wrong password leaves the request up: the visitor types it again.
          retryable: (e) => e instanceof WrongPasswordError,
        });
      },
      makeReceiveInvoice: (params) => makeReceiveInvoice(requestDeps(), params, record),
      invoiceStatus: (params) => readRequestInvoiceStatus(requestDeps(), latest.current.entries, params, record),
    });
  }, []);
}
