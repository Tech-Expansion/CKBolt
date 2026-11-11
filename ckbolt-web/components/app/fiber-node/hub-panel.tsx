"use client";

import type { HubClient } from "@/lib/hub/client";
import type { FiberAssetId, FiberNodeDto, Script } from "@/lib/hub/contract";
import { formatUnits } from "@/lib/hub/format";
import { spendableContribution } from "@/lib/wallets/fiber-browser/channel-contribution";
import { ownTokenOffer } from "@/lib/wallets/fiber-browser/own-token-channel";
import type { BrowserFiberNode, NodeChannel } from "@/lib/wallets/fiber-browser/node-port";
import type { BrowserNodeNetwork } from "@/lib/wallets/fiber-browser/constants";
import { StatusBadge, StatusNotice } from "../status";
import { InfoTip } from "../swap/info-tip";
import { Panel, Row, shorten } from "../ui";
import { ActionNotice } from "./action-notice";
import type { ActivityEntry } from "@/lib/wallets/fiber-browser/activity";
import type { TokenLook } from "@/lib/token-display";
import { CHANNEL_ACTION, closeChannel, openOwnTokenChannel, recorded, requestHubChannel, type ChannelHistoryContext } from "./channel-actions";
import { ChannelList } from "./channel-list";
import { HubChannelRequest, type ChannelContribution } from "./hub-channel-request";
import { noteBox, pillButton, textButton } from "./styles";
import type { HubFiberNodeState } from "./use-hub-fiber-node";
import type { HubLink } from "./use-hub-link";
import { useNodeAction } from "./use-node-action";

interface HubPanelProps {
  hub: HubFiberNodeState;
  network: BrowserNodeNetwork;
  /** The running node, or null. */
  node: BrowserFiberNode | null;
  nodeId: string | null;
  /** The node's own lock (its CKB address), or null until it runs. */
  nodeLock: Script | null;
  link: HubLink;
  channels: NodeChannel[];
  /** Shannons the node can spend on-chain, or null until read. */
  balance: bigint | null;
  /** The CKB the node puts into the hub's CKB channel, as the visitor last chose it. */
  contribution: ChannelContribution;
  client: Pick<HubClient, "requestInboundChannel" | "getFiberNode">;
  /** Adds a channel action to the node's history; `assetOf` names a channel's asset for it. */
  record: (entry: ActivityEntry) => void;
  assetOf: ChannelHistoryContext["assetOf"];
  decimalsOf: (asset: string) => number;
  symbolOf: (asset: string) => string;
  /** How an asset looks (NodeWorkspace.lookOf). */
  lookOf: (asset: string) => TokenLook;
  /** What the node holds of a token on chain (NodeWorkspace.readTokenBalance). */
  readTokenBalance: ((script: Script) => Promise<bigint>) | null;
  /** Tokens the running node takes the hub's channel in only after a restart (NodeWorkspace.restartFor). */
  restartFor: readonly FiberAssetId[];
  /** Stops the node (it restarts with the hub's whitelist once unlocked); `nodeBusy` while a swap needs it. */
  onLock: () => void;
  nodeBusy: boolean;
  /** Reads the node again after a change. */
  onChanged: () => void;
}

const formatCkb = (ckb: number): string => ckb.toLocaleString("en-US");

/**
 * Panel 03: the hub's node, the connection to it, and the channels with the hub. The node receives and pays over the
 * channels the hub opens to it: the hub takes payments only over channels it opened itself, whose safety delay it knows,
 * except in a token whose `peerChannels` it serves, where the node may open its own channel (the hub then assumes the
 * longest delay, own-token-channel.ts).
 */
export function HubPanel(props: HubPanelProps) {
  const { hub, network, node, nodeId, nodeLock, link, channels, balance, contribution, client, record, assetOf, decimalsOf, symbolOf, lookOf, readTokenBalance, restartFor, onLock, nodeBusy, onChanged } =
    props;
  const history = { channels, assetOf };
  const action = useNodeAction(onChanged);
  const hubNode: FiberNodeDto | null = hub.node;
  const inUse = contribution.chosen;
  const format = (asset: FiberAssetId, amount: string) => `${formatUnits(amount, decimalsOf(asset))} ${symbolOf(asset)}`;
  const ownSymbols = (hubNode?.assets ?? []).filter((a) => ownTokenOffer(a) !== null).map((a) => symbolOf(a.id));

  return (
    <Panel step="03" title="Channels with the hub" aside={<StatusBadge tone="pending">Testnet</StatusBadge>}>
      <div className="space-y-6" data-testid="fiber-node-hub">
        {hub.loading && !hubNode && <p className="text-sm text-muted-foreground">Asking the CKBolt hub for its Fiber node…</p>}
        {hub.error && !hubNode && (
          <div className="space-y-2">
            <StatusNotice tone="error">{hub.error.message}</StatusNotice>
            <p className="text-xs text-muted-foreground">The node still runs, but without channels from the hub.</p>
            <button type="button" onClick={() => void hub.reload()} className={pillButton}>
              Try again
            </button>
          </div>
        )}
        {hubNode && hubNode.network !== network && (
          <StatusNotice tone="error" role="status" data-testid="fiber-node-hub-network">
            The CKBolt hub runs on CKB {hubNode.network}; this node runs on CKB {network}. No channels are possible.
          </StatusNotice>
        )}
        {hubNode && hubNode.network === network && (
          <>
            <dl>
              <Row label="Hub node" value={shorten(hubNode.nodeId, 10)} note={`CKB ${hubNode.network}`} />
              <Row
                label="Connection"
                value={link.connected ? "Connected" : link.dialing ? "Connecting…" : "Not connected"}
                tone={link.connected ? "ok" : link.dialing ? "pending" : "off"}
                note={link.addresses.length > 0 ? `${link.addresses.length} WebSocket address(es) to dial` : "No WebSocket address this page can dial"}
              />
            </dl>
            {link.error && !link.connected && <StatusNotice tone="error">{link.error}</StatusNotice>}
            {node && !link.connected && (
              <button type="button" onClick={() => void link.dial()} disabled={link.dialing} className={pillButton}>
                {link.dialing ? "Connecting…" : "Connect to the hub"}
              </button>
            )}

            <HubChannelRequest
              hubNode={hubNode}
              node={node}
              hubConnected={link.connected}
              channels={channels}
              balance={balance}
              contribution={contribution}
              action={action}
              decimalsOf={decimalsOf}
              symbolOf={symbolOf}
              lookOf={lookOf}
              restartFor={restartFor}
              onLock={onLock}
              lockBusy={nodeBusy}
              request={(asset, text) =>
                recorded(record)(requestHubChannel(client, node, { nodeId, hubNodeId: hubNode.nodeId }, asset, { text, balance }, format, history))
              }
              readTokenBalance={readTokenBalance}
              hubAddress={link.addresses[0] ?? null}
              openOwn={(plan) => recorded(record)(openOwnTokenChannel(node, plan, format, history, () => client.getFiberNode()))}
              onRunEnd={() => void hub.reload()}
            />

            <div className={noteBox} data-testid="fiber-node-hub-pay-note">
              <p className="text-sm font-medium">
                Paying from your node{" "}
                <InfoTip label="About paying from your node" align="start">
                  Your node pays swaps from CKB to BTC over the hub&apos;s channel, out of the CKB it put in and what it received.{" "}
                  {ownSymbols.length > 0
                    ? `The hub takes payments only over channels it opened itself, whose safety delay it knows, except in ${new Intl.ListFormat("en-US", { type: "conjunction" }).format(ownSymbols)}: there your node may open its own channel to the hub.`
                    : "The hub takes payments only over channels it opened itself, whose safety delay it knows, so swaps never use a channel your node opened."}
                </InfoTip>
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                A new channel lets it pay {formatCkb(spendableContribution(inUse))} CKB at once.
              </p>
            </div>
          </>
        )}

        <ActionNotice action={action} testId="fiber-node-hub" />

        {node && (
          <div className="space-y-2">
            <p className="font-mono text-xs text-muted-foreground">Channels of your node</p>
            <ChannelList
              channels={channels}
              hubNodeId={hubNode?.nodeId ?? null}
              assets={hubNode?.assets ?? []}
              decimalsOf={decimalsOf}
              symbolOf={symbolOf}
              network={network}
              nodeLock={nodeLock}
              onClose={(channel, target) => action.run(CHANNEL_ACTION.close(channel.channelId), () => recorded(record)(closeChannel(node, channel, target, history)))}
            />
            <button type="button" onClick={onChanged} className={textButton}>
              Refresh channels
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
}
