import { CKB_ASSET_ID, type FiberAssetId, type FiberNodeDto, type Script } from "@/lib/hub/contract";
import type { NodeChannel } from "./node-port";
import { sameScript } from "./scripts";
import { CHANNEL_STATE, CHANNEL_STATE_LABEL, CHANNEL_STATE_OPENING_LABEL, CKB_DECIMALS } from "./constants";

/** The native asset: a channel without a UDT type script carries CKB. */
export const CKB_ASSET: FiberAssetId = CKB_ASSET_ID;

/** Whole CKB as shannons, exactly. */
export const ckbToShannons = (ckb: number): bigint => BigInt(ckb) * BigInt(10 ** CKB_DECIMALS);

export type HubAssets = FiberNodeDto["assets"];

/** The asset a channel carries, from the hub's asset list (null for a token the hub does not know). */
export function channelAsset(channel: Pick<NodeChannel, "udtTypeScript">, assets: HubAssets): FiberAssetId | null {
  if (!channel.udtTypeScript) return CKB_ASSET;
  const script = channel.udtTypeScript;
  return assets.find((a) => a.udtTypeScript !== null && sameScript(a.udtTypeScript, script))?.id ?? null;
}

/** The asset's UDT type script from the hub's list; null for CKB; undefined when the hub does not list the asset. */
export function assetScript(asset: FiberAssetId, assets: HubAssets): Script | null | undefined {
  if (asset === CKB_ASSET) return null;
  const found = assets.find((a) => a.id === asset);
  return found ? found.udtTypeScript : undefined;
}

export const isChannelReady = (channel: Pick<NodeChannel, "state">): boolean => channel.state === CHANNEL_STATE.READY;

/** Closed and closing channels no longer count as open. */
export const isChannelOpenOrOpening = (channel: Pick<NodeChannel, "state">): boolean =>
  channel.state !== CHANNEL_STATE.CLOSED && channel.state !== CHANNEL_STATE.SHUTTING_DOWN;

/**
 * A channel whose funding transaction is not committed yet (opening, or waiting for its confirmations): fnn keeps the
 * node's cells in it out of any other funding until then. A closing channel spends only its own funding cell.
 */
export const isChannelFunding = (channel: Pick<NodeChannel, "state">): boolean =>
  channel.state !== CHANNEL_STATE.READY && channel.state !== CHANNEL_STATE.CLOSED && channel.state !== CHANNEL_STATE.SHUTTING_DOWN;

export const channelStateLabel =(state: string): string => CHANNEL_STATE_LABEL[state] ?? CHANNEL_STATE_OPENING_LABEL;

export interface Liquidity {
  /** Base units this node can send now. */
  send: bigint;
  /** Base units this node can receive now. */
  receive: bigint;
}

/** What the node can send and receive in `asset`, over its ready, enabled channels. */
export function liquidityOf(channels: readonly NodeChannel[], asset: FiberAssetId, assets: HubAssets): Liquidity {
  let send = BigInt(0);
  let receive = BigInt(0);
  for (const c of channels) {
    if (!isChannelReady(c) || !c.enabled || channelAsset(c, assets) !== asset) continue;
    send += c.localBalance;
    receive += c.remoteBalance;
  }
  return { send, receive };
}

/**
 * Channels opening or closing: their funding or closing transaction is not final, and fnn may be spending the node's
 * on-chain cells for them, so nothing else may spend those cells now.
 */
export const channelsMovingFunds = <T extends Pick<NodeChannel, "state">>(channels: readonly T[]): T[] =>
  channels.filter((c) => c.state !== CHANNEL_STATE.READY && c.state !== CHANNEL_STATE.CLOSED);

/** The node's channels with the hub (any state but closed). */
export const hubChannels = (channels: readonly NodeChannel[], hubNodeId: string): NodeChannel[] =>
  channels.filter((c) => c.peerId === hubNodeId && isChannelOpenOrOpening(c));

/**
 * What a swap can move in `asset`: over the node's channels with the hub only (those the hub opened, and in a token whose
 * peerChannels the hub serves, one the node opened to it with its own tokens), so a channel the node opened with another
 * node adds nothing to a swap.
 */
export const swapLiquidity = (channels: readonly NodeChannel[], asset: FiberAssetId, hubNode: Pick<FiberNodeDto, "nodeId" | "assets">): Liquidity =>
  liquidityOf(hubChannels(channels, hubNode.nodeId), asset, hubNode.assets);
