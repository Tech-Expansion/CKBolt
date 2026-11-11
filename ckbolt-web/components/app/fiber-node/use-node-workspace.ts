"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useHubClient } from "@/hooks/use-hub-client";
import type { HubClient } from "@/lib/hub/client";
import type { FiberAssetId, FiberNodeDto, Script } from "@/lib/hub/contract";
import { readContribution, saveContribution } from "@/lib/wallets/fiber-browser/channel-contribution";
import { channelAsset, swapLiquidity, type Liquidity } from "@/lib/wallets/fiber-browser/channels";
import { scriptToAddress } from "@/lib/wallets/fiber-browser/ckb-address";
import { CkbRpcClient } from "@/lib/wallets/fiber-browser/ckb-rpc";
import type { BrowserNodeConfig } from "@/lib/wallets/fiber-browser/config";
import type { NodeKeys } from "@/lib/wallets/fiber-browser/keys";
import { nodeLockName, type BrowserNodeController, type NodeState } from "@/lib/wallets/fiber-browser/node-controller";
import { hubNodeIdsOf, readKnownHubNodeId, rememberHubNodeId } from "@/lib/wallets/fiber-browser/hub-link";
import { isNodeLockHeld } from "@/lib/wallets/fiber-browser/node-lock";
import type { BrowserFiberNode, NodeChannel } from "@/lib/wallets/fiber-browser/node-port";
import { shownTokens, type WalletToken } from "@/lib/wallets/fiber-browser/tokens";
import { assetsNeedingRestart, hubWhitelist } from "@/lib/wallets/fiber-browser/udt-whitelist";
import { webStore } from "@/lib/wallets/fiber-browser/storage";
import { tokenLook, type TokenLook } from "@/lib/token-display";
import { PAY_TOKENS } from "@/lib/tokens";
import { CKB_DECIMALS, NODE_TIMING } from "@/lib/wallets/fiber-browser/constants";
import type { ChannelContribution } from "./hub-channel-request";
import { useActivity, type Activity } from "./use-activity";
import { useBridgeServer } from "./use-bridge-server";
import { useConfirmations, type Confirmations } from "./use-confirmations";
import { useHubFiberNode, type HubFiberNodeState } from "./use-hub-fiber-node";
import { pageDialAddresses, useHubLink, type HubLink } from "./use-hub-link";
import { useNodeController } from "./use-node-controller";
import { useNodeData, type NodeData } from "./use-node-data";
import { useNodeKey, type NodeKey } from "./use-node-key";
import { usePolling } from "./use-polling";
import { withdrawableTokens, type WithdrawableToken } from "@/lib/wallets/fiber-browser/token-withdraw";

/** Everything a view of the browser node uses: the full page (/app/fiber) and the wallet popup render the same state. */
export interface NodeWorkspace {
  config: BrowserNodeConfig;
  client: HubClient;
  controller: BrowserNodeController;
  state: NodeState;
  nodeKey: NodeKey;
  hub: HubFiberNodeState;
  /** The hub's Fiber node when it runs on this node's network; null otherwise. */
  hubNode: FiberNodeDto | null;
  /** Every id the hub is known by, also while it cannot be reached: the wallet never treats it as another node. */
  hubNodeIds: string[];
  data: NodeData;
  /** The CKB RPC the node's balances are read from. */
  rpc: CkbRpcClient;
  link: HubLink;
  activity: Activity;
  /** Pay's requests waiting for the visitor's Confirm in the node, and how the last one ended. */
  confirmations: Confirmations;
  /** The running node, or null. */
  node: BrowserFiberNode | null;
  /** The node's own lock (its CKB address), or null until it runs. */
  fundingLock: Script | null;
  address: string | null;
  /** Another tab or wallet window already runs this node (seen before unlocking). */
  otherTabHolds: boolean;
  contribution: ChannelContribution;
  /** CKB and the tokens the hub lists for this network, with symbols and decimals. */
  tokens: WalletToken[];
  /** What a swap can move per asset now: over the node's ready channels with the hub (swapLiquidity). */
  liquidity: Partial<Record<FiberAssetId, Liquidity>>;
  decimalsOf: (asset: string) => number;
  symbolOf: (asset: string) => string;
  /** A channel's asset, from the hub's list (null for a token the hub does not list). */
  assetOf: (channel: Pick<NodeChannel, "udtTypeScript">) => FiberAssetId | null;
  /** How an asset looks: the hub's display name and icon, else the app's, else the hub's name and initials. */
  lookOf: (asset: string) => TokenLook;
  /** What the node holds of a token on chain (base units, from the CKB RPC); null until the node's lock is known. */
  readTokenBalance: ((script: Script) => Promise<bigint>) | null;
  /** The hub's tokens the node can send away from its address with Withdraw (lib/wallets/fiber-browser/token-withdraw.ts). */
  withdrawTokens: WithdrawableToken[];
  /**
   * Tokens the hub funds channels in that the running node does not take by itself yet: it started before the hub
   * served them (or before the hub answered), and fnn reads its UDT whitelist only at start. A restart fixes them.
   */
  restartFor: FiberAssetId[];
  /** Starts the node with keys that were just created, unlocked or restored. */
  start: (keys: NodeKeys) => void;
  /** Stops the node; the key is asked for again. */
  lock: () => void;
  /** Stops the node and deletes its key from this browser. */
  forget: () => Promise<void>;
}

/**
 * The browser node and all it works with: its controller and key, the hub's node and the link to it, its channels and
 * balance, its activity, the channel contribution, and the bridge that serves the swap form. One per document.
 */
export function useNodeWorkspace(config: BrowserNodeConfig): NodeWorkspace {
  const client = useHubClient();
  const rpc = useMemo(() => new CkbRpcClient(config.ckbRpcUrl), [config.ckbRpcUrl]);
  const { controller, state } = useNodeController(config);
  const nodeKey = useNodeKey(config.network);
  const hub = useHubFiberNode(client);

  const node = state.phase === "running" ? controller.node : null;
  const fundingLock = state.info?.fundingLockScript ?? null;
  // Only a hub on this node's network is dialled and offered channels. The bridge gets the hub's node as reported, so
  // its own checks refuse swap requests for a hub on another network.
  const hubNode = hub.node && hub.node.network === config.network ? hub.node : null;
  const data = useNodeData(node, fundingLock, rpc);
  const link = useHubLink(node, hubNode, data.peers, data.refreshNode);
  const assetOf = useCallback((channel: Pick<NodeChannel, "udtTypeScript">) => channelAsset(channel, hubNode?.assets ?? []), [hubNode]);
  // The history of the node whose key is stored, also while it is locked, with the swaps the app kept.
  const activity = useActivity(node, {
    network: config.network,
    nodeId: state.info?.nodeId ?? nodeKey.record?.nodeId ?? null,
    channels: data.channels,
    assetOf,
    hub: client,
  });
  const confirmations = useConfirmations(node !== null);

  // Another tab may already run this node: say so before asking for the password, and notice when it closes.
  const [otherTabHolds, setOtherTabHolds] = useState(false);
  const idle = state.phase === "locked" || state.phase === "other-tab";
  usePolling(
    async () => setOtherTabHolds(await isNodeLockHeld(nodeLockName(config.network))),
    NODE_TIMING.nodePollMs,
    idle,
  );
  useEffect(() => {
    if (!idle) setOtherTabHolds(false);
  }, [idle]);

  // What the node puts into the hub's CKB channel: the visitor's last choice, the default of the next request.
  const localStore = useMemo(() => webStore("localStorage"), []);
  const [chosen, setChosen] = useState(() => readContribution(localStore, config.network));
  const changeContribution = useCallback(
    (ckb: number) => {
      setChosen(ckb);
      saveContribution(localStore, config.network, ckb);
    },
    [localStore, config.network],
  );

  const { rememberNodeId } = nodeKey;
  useEffect(() => {
    if (state.info) rememberNodeId(state.info.nodeId);
  }, [state.info, rememberNodeId]);

  // The hub's id, kept for when the hub cannot be reached or runs on another network.
  const [keptHubId, setKeptHubId] = useState(() => readKnownHubNodeId(localStore, config.network));
  const hubId = hubNode?.nodeId ?? null;
  useEffect(() => {
    if (!hubId) return;
    rememberHubNodeId(localStore, config.network, hubId);
    setKeptHubId(hubId);
  }, [hubId, localStore, config.network]);
  const hubNodeIds = useMemo(() => hubNodeIdsOf(hubId, hub.node?.nodeId, keptHubId), [hubId, hub.node?.nodeId, keptHubId]);

  useBridgeServer({
    state,
    node,
    network: config.network,
    hubNode: hub.node,
    hubConnected: link.connected,
    channels: data.channels,
    balance: data.balance,
    contributionCkb: node ? chosen : null,
    hub: client,
    record: activity.record,
    entries: activity.entries,
    hubNodeIds,
    confirmations: confirmations.queue,
    nodeLock: fundingLock,
    rpcUrl: config.ckbRpcUrl,
    keystore: nodeKey.record,
  });

  const address = useMemo(() => (fundingLock ? scriptToAddress(fundingLock, config.network) : null), [fundingLock, config.network]);
  const decimalsOf = useCallback((asset: string) => hub.assets.find((a) => a.id === asset)?.decimals ?? CKB_DECIMALS, [hub.assets]);
  const symbolOf = useCallback((asset: string) => hub.assets.find((a) => a.id === asset)?.symbol ?? asset, [hub.assets]);
  const lookOf = useCallback(
    (asset: string) => tokenLook(symbolOf(asset), hub.assets.find((a) => a.id === asset), PAY_TOKENS),
    [hub.assets, symbolOf],
  );
  const readTokenBalance = useMemo(() => (fundingLock ? (script: Script) => rpc.tokenAmount(fundingLock, script) : null), [rpc, fundingLock]);
  const tokens = useMemo(() => shownTokens(hubNode, hub.assets), [hubNode, hub.assets]);
  const withdrawTokens = useMemo(() => withdrawableTokens(tokens, hubWhitelist(hubNode)), [tokens, hubNode]);
  const liquidity = useMemo(
    () =>
      Object.fromEntries(
        tokens.map((t) => [t.id, hubNode ? swapLiquidity(data.channels, t.id, hubNode) : { send: BigInt(0), receive: BigInt(0) }]),
      ) as Partial<Record<FiberAssetId, Liquidity>>,
    [tokens, data.channels, hubNode],
  );

  const start = useCallback(
    (keys: NodeKeys) => void controller.start(keys, [...pageDialAddresses(hubNode), ...config.bootnodes], hubWhitelist(hubNode)),
    [controller, hubNode, config.bootnodes],
  );
  const restartFor = useMemo(() => (hubNode && node ? assetsNeedingRestart(state.udts, hubNode) : []), [hubNode, node, state.udts]);
  const lock = useCallback(() => void controller.stop(), [controller]);
  const forget = useCallback(async () => {
    await controller.stop();
    nodeKey.forget();
  }, [controller, nodeKey]);

  const contribution = useMemo<ChannelContribution>(
    () => ({ chosen, onChange: changeContribution }),
    [chosen, changeContribution],
  );

  return {
    config,
    client,
    controller,
    state,
    nodeKey,
    hub,
    hubNode,
    hubNodeIds,
    data,
    rpc,
    link,
    activity,
    confirmations,
    node,
    fundingLock,
    address,
    otherTabHolds,
    contribution,
    tokens,
    liquidity,
    decimalsOf,
    symbolOf,
    assetOf,
    lookOf,
    readTokenBalance,
    withdrawTokens,
    restartFor,
    start,
    lock,
    forget,
  };
}
