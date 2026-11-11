"use client";

import { useId } from "react";
import { formatUnits } from "@/lib/hub/format";
import type { FiberAssetId } from "@/lib/hub/contract";
import { ActionNotice } from "../fiber-node/action-notice";
import { CHANNEL_ACTION, closeChannel, openOwnTokenChannel, recorded, requestHubChannel } from "../fiber-node/channel-actions";
import { ChannelList } from "../fiber-node/channel-list";
import { HubChannelRequest } from "../fiber-node/hub-channel-request";
import { PeerChannelForm } from "../fiber-node/peer-channel-form";
import { textButton } from "../fiber-node/styles";
import { useNodeAction } from "../fiber-node/use-node-action";
import type { NodeWorkspace } from "../fiber-node/use-node-workspace";
import { CHANNELS_COPY } from "./copy";
import { sectionTitle } from "./styles";

/** The test ids of the page's action results (one shows at a time, next to its action). */
const NOTICE_TEST_ID = "fiber-wallet-channels";

/**
 * Channels: first the channels from the hub (ticked and opened in one press, with what the node puts in), then every channel of the node, each
 * closable to the node or to the visitor's wallet, and last, under Advanced, a channel with another node, which the
 * node opens and funds itself and swaps never use.
 */
export function ChannelsPage({ ws }: { ws: NodeWorkspace }) {
  const { node, hub, hubNode, data, link, state, config } = ws;
  const action = useNodeAction(data.refreshNode);
  const yoursId = useId();
  const format = (asset: FiberAssetId, amount: string) => `${formatUnits(amount, ws.decimalsOf(asset))} ${ws.symbolOf(asset)}`;
  const history = { channels: data.channels, assetOf: ws.assetOf };

  return (
    <div className="space-y-6" data-testid="fiber-wallet-channels">
      <div className="space-y-2">
        {hubNode ? (
          <HubChannelRequest
            hubNode={hubNode}
            node={node}
            hubConnected={link.connected}
            channels={data.channels}
            balance={data.balance}
            contribution={ws.contribution}
            action={action}
            decimalsOf={ws.decimalsOf}
            symbolOf={ws.symbolOf}
            lookOf={ws.lookOf}
            restartFor={ws.restartFor}
            onLock={ws.lock}
            lockBusy={ws.activity.busy}
            request={(asset, text) =>
              recorded(ws.activity.record)(
                requestHubChannel(
                  ws.client,
                  node,
                  { nodeId: state.info?.nodeId ?? null, hubNodeId: hubNode.nodeId },
                  asset,
                  { text, balance: data.balance },
                  format,
                  history,
                ),
              )
            }
            readTokenBalance={ws.readTokenBalance}
            hubAddress={link.addresses[0] ?? null}
            openOwn={(plan) => recorded(ws.activity.record)(openOwnTokenChannel(node, plan, format, history, () => ws.client.getFiberNode()))}
            onRunEnd={() => void hub.reload()}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <p>
              {hub.node
                ? CHANNELS_COPY.HUB_WRONG_NETWORK(hub.node.network, config.network)
                : hub.loading
                  ? CHANNELS_COPY.HUB_LOADING
                  : CHANNELS_COPY.HUB_UNAVAILABLE}
            </p>
            {!hub.node && !hub.loading && (
              <button type="button" onClick={() => void hub.reload()} className={textButton}>
                {CHANNELS_COPY.TRY_AGAIN}
              </button>
            )}
          </div>
        )}
        {/* Each result shows next to what asked for it: the hub's channels in their card (an unexpected error here), a close under the list. */}
        <ActionNotice action={action} testId={NOTICE_TEST_ID} of={CHANNEL_ACTION.isInbound} />
      </div>

      <section className="space-y-2" aria-labelledby={yoursId}>
        <div className="flex items-center justify-between gap-3">
          <h3 id={yoursId} className={sectionTitle}>
            {CHANNELS_COPY.YOURS}
          </h3>
          <button type="button" onClick={() => void data.refreshNode()} className={textButton}>
            {CHANNELS_COPY.REFRESH}
          </button>
        </div>
        <ChannelList
          layout="cards"
          channels={data.channels}
          hubNodeId={hubNode?.nodeId ?? null}
          assets={hubNode?.assets ?? []}
          decimalsOf={ws.decimalsOf}
          symbolOf={ws.symbolOf}
          network={config.network}
          nodeLock={ws.fundingLock}
          onClose={(channel, target) =>
            action.run(CHANNEL_ACTION.close(channel.channelId), () => recorded(ws.activity.record)(closeChannel(node, channel, target, history)))
          }
        />
        <ActionNotice action={action} testId={NOTICE_TEST_ID} of={CHANNEL_ACTION.isClose} />
      </section>

      <PeerChannelForm ws={ws} action={action} noticeTestId={NOTICE_TEST_ID} label={CHANNELS_COPY.ADVANCED} />
    </div>
  );
}
