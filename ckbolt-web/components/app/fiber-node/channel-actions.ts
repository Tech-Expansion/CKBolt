import { toHubApiError, type HubClient } from "@/lib/hub/client";
import type { FiberAssetId, FiberNodeDto } from "@/lib/hub/contract";
import { CHANNEL_ACTIVITY_STATUS, readyChannels, type ActivityEntry } from "@/lib/wallets/fiber-browser/activity";
import { CKB_ASSET } from "@/lib/wallets/fiber-browser/channels";
import type { BrowserFiberNode, NodeChannel } from "@/lib/wallets/fiber-browser/node-port";
import type { PeerChannelPlan } from "@/lib/wallets/fiber-browser/peer-channel";
import { acceptHubChannel, planHubContribution, type HubAcceptDeps } from "@/lib/wallets/fiber-browser/hub-accept";
import { connectAndOpenChannel, type PeerConnectDeps } from "@/lib/wallets/fiber-browser/peer-connect";
import { OWN_OFFER_MESSAGE, ownOfferChange } from "@/lib/wallets/fiber-browser/own-token-channel";
import { shorten } from "../ui";
import type { CloseTarget } from "./channel-list";
import { CLOSE_COPY, HUB_PANEL_COPY, PEER_CHANNEL_COPY } from "./copy";

/**
 * The node's channel actions. Each returns the sentence the page shows once it is done and the entry it adds to the
 * node's history (lib/wallets/fiber-browser/activity.ts); `recorded` hands the entry over and keeps the sentence.
 */

/** The keys of the channel actions (useNodeAction), so each result shows next to its control. */
export const CHANNEL_ACTION = {
  /** Channels from the hub, asked for one after another in one press (hub-channel-request.tsx). */
  HUB_RUN: "inbound-run",
  close: (channelId: string): string => `close-${channelId}`,
  PEER: "peer-channel",
  isInbound: (key: string): boolean => key.startsWith("inbound-"),
  isClose: (key: string): boolean => key.startsWith("close-"),
  isPeer: (key: string): boolean => key === "peer-channel",
} as const;

export interface ChannelActionResult {
  message: string;
  entry: ActivityEntry;
}

/** What the history needs to tell when a channel asked for is open: the node's channels now, and their assets. */
export interface ChannelHistoryContext {
  channels: readonly NodeChannel[];
  assetOf: (channel: Pick<NodeChannel, "udtTypeScript">) => FiberAssetId | null;
}

/** Records the action's history entry, and gives its sentence to useNodeAction. */
export const recorded =
  (record: (entry: ActivityEntry) => void) =>
  async (result: Promise<ChannelActionResult>): Promise<string> => {
    const { message, entry } = await result;
    record(entry);
    return message;
  };

/** A channel the visitor asked for or closed, opening or closing. */
const channelEntry = (o: {
  id: string;
  asset: FiberAssetId;
  amount: bigint | string;
  peerId: string;
  action: "open" | "close";
  channelId: string | null;
  readyBefore: number;
  address?: string | null;
}): ActivityEntry => ({
  id: o.id,
  kind: "channel",
  asset: o.asset,
  amount: o.amount.toString(),
  status: o.action === "open" ? CHANNEL_ACTIVITY_STATUS.OPENING : CHANNEL_ACTIVITY_STATUS.CLOSING,
  error: null,
  at: Date.now(),
  counterparty: o.peerId,
  channel: { action: o.action, channelId: o.channelId, readyBefore: o.readyBefore },
  address: o.address ?? null,
});

/** What the node puts into the hub's CKB channel: the amount typed for this request, and what the node holds on chain. */
export interface HubContribution {
  text: string;
  /** Shannons the node can spend on chain, or null until read. */
  balance: bigint | null;
}

/**
 * Asks the hub to open a channel in `asset` to the node: only the node's public id goes out. A CKB channel is then
 * accepted by the node with the amount the visitor chose (checked before the hub is asked); a token channel is accepted
 * by fnn itself, with nothing from the node.
 */
export async function requestHubChannel(
  client: Pick<HubClient, "requestInboundChannel">,
  node: Pick<BrowserFiberNode, "acceptChannel"> | null,
  ids: { nodeId: string | null; hubNodeId: string },
  asset: FiberAssetId,
  contribution: HubContribution,
  format: (asset: FiberAssetId, amount: string) => string,
  history: ChannelHistoryContext,
  acceptDeps?: HubAcceptDeps,
): Promise<ChannelActionResult> {
  if (!ids.nodeId || !node) throw new Error(HUB_PANEL_COPY.START_FIRST);
  const plan = asset === CKB_ASSET ? planHubContribution(contribution.text, contribution.balance) : null;
  if (plan && !plan.ok) throw new Error(plan.error);
  const readyBefore = readyChannels(history.channels, ids.hubNodeId, asset, history.assetOf);
  let opening: Awaited<ReturnType<HubClient["requestInboundChannel"]>>;
  try {
    opening = await client.requestInboundChannel({ nodeId: ids.nodeId, asset });
  } catch (e) {
    throw new Error(toHubApiError(e).message);
  }
  if (plan?.ok) await acceptHubChannel(node, { temporaryChannelId: opening.temporaryChannelId, fundingAmount: plan.shannons }, acceptDeps);
  return {
    message: HUB_PANEL_COPY.OPENING(format(asset, opening.fundingAmount), plan?.ok ? format(CKB_ASSET, plan.shannons.toString()) : null),
    entry: channelEntry({
      id: opening.temporaryChannelId,
      asset,
      amount: opening.fundingAmount,
      peerId: ids.hubNodeId,
      action: "open",
      channelId: null,
      readyBefore,
    }),
  };
}

/** Closes a channel cooperatively; the node's share goes to `target`, or back to the node. */
export async function closeChannel(
  node: BrowserFiberNode | null,
  channel: NodeChannel,
  target: CloseTarget | null,
  history: ChannelHistoryContext,
): Promise<ChannelActionResult> {
  if (!node) throw new Error(HUB_PANEL_COPY.START_FIRST);
  await node.shutdownChannel(channel.channelId, target?.script ?? null);
  return {
    message: target ? CLOSE_COPY.CLOSING_TO_WALLET(shorten(target.address, 12)) : CLOSE_COPY.CLOSING_TO_NODE,
    entry: channelEntry({
      id: channel.channelId,
      asset: history.assetOf(channel) ?? CKB_ASSET,
      amount: channel.localBalance,
      peerId: channel.peerId,
      action: "close",
      channelId: channel.channelId,
      readyBefore: 0,
      address: target?.address ?? null,
    }),
  };
}

/**
 * Opens a channel to the hub with the node's own tokens (the hub's peerChannels, own-token-channel.ts): open_channel to
 * the hub's node id in the token, private, with fnn's default commitment delay and TLC expiry. The hub's node accepts
 * the channel by itself, so the hub is only read: its offer as it stands now (`hubNow`, GET /v1/fiber/node), since the
 * page read it once and the hub stops offering such channels at its cap or may have raised the minimum since. Dials the
 * hub first only when it is not a peer any more.
 */
export async function openOwnTokenChannel(
  node: BrowserFiberNode | null,
  plan: PeerChannelPlan,
  format: (asset: FiberAssetId, amount: string) => string,
  history: ChannelHistoryContext,
  hubNow: () => Promise<Pick<FiberNodeDto, "nodeId" | "assets">>,
  deps?: PeerConnectDeps,
): Promise<ChannelActionResult> {
  if (!node) throw new Error(HUB_PANEL_COPY.START_FIRST);
  let hub: Pick<FiberNodeDto, "nodeId" | "assets">;
  try {
    hub = await hubNow();
  } catch (e) {
    throw new Error(toHubApiError(e).message);
  }
  const change = ownOfferChange(hub, plan);
  if (change?.kind === "gone") throw new Error(OWN_OFFER_MESSAGE.GONE);
  if (change?.kind === "min") throw new Error(OWN_OFFER_MESSAGE.MIN(format(plan.asset, change.minAmount.toString())));
  if (!plan.address && !(await node.listPeers()).includes(plan.peerId)) throw new Error(HUB_PANEL_COPY.CONNECT_FIRST);
  const readyBefore = readyChannels(history.channels, plan.peerId, plan.asset, history.assetOf);
  const { temporaryChannelId } = await connectAndOpenChannel(node, plan, deps);
  return {
    message: HUB_PANEL_COPY.OWN_OPENING(format(plan.asset, plan.fundingAmount.toString())),
    entry: channelEntry({
      id: temporaryChannelId,
      asset: plan.asset,
      amount: plan.fundingAmount,
      peerId: plan.peerId,
      action: "open",
      channelId: null,
      readyBefore,
    }),
  };
}

/** Dials another node unless it is already a peer, waits until it is connected, then opens and funds a channel with it. */
export async function openPeerChannel(node: BrowserFiberNode | null, plan: PeerChannelPlan, history: ChannelHistoryContext): Promise<ChannelActionResult> {
  if (!node) throw new Error(HUB_PANEL_COPY.START_FIRST);
  const readyBefore = readyChannels(history.channels, plan.peerId, plan.asset, history.assetOf);
  const { temporaryChannelId } = await connectAndOpenChannel(node, plan);
  return {
    message: PEER_CHANNEL_COPY.OPENING(shorten(plan.peerId, 6)),
    entry: channelEntry({
      id: temporaryChannelId,
      asset: plan.asset,
      amount: plan.fundingAmount,
      peerId: plan.peerId,
      action: "open",
      channelId: null,
      readyBefore,
    }),
  };
}
