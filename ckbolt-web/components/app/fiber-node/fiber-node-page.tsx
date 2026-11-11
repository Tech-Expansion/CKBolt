"use client";

import { useEffect, useMemo, useState } from "react";
import { readBrowserNodeConfig, type BrowserNodeConfig } from "@/lib/wallets/fiber-browser/config";
import { canRunNode, checkIsolation, reloadOnceForIsolation } from "@/lib/wallets/fiber-browser/isolation";
import { storageKey, webStore } from "@/lib/wallets/fiber-browser/storage";
import { STORAGE_NAME } from "@/lib/wallets/fiber-browser/constants";
import { assetDecimals } from "@/lib/wallets/fiber-browser/tokens";
import { tokenFaucets } from "@/lib/faucets";
import { TestnetBadge } from "../fiber-wallet/wallet-heading";
import { Panel } from "../ui";
import { ActivityPanel } from "./activity-panel";
import { ConfirmRequest } from "./confirm-request";
import { DiagnosticsPanel } from "./diagnostics-panel";
import { CONFIRM_COPY, FULL_PAGE_COPY } from "./copy";
import { historyNames } from "./history-list";
import { HubPanel } from "./hub-panel";
import { IsolationNotice, NodeLimits } from "./isolation-notice";
import { KeyPanel } from "./key-panel";
import { NodePanel } from "./node-panel";
import { PeerChannelForm } from "./peer-channel-form";
import { useNodeAction } from "./use-node-action";
import { useNodeWorkspace } from "./use-node-workspace";
import { WalletPickerProvider } from "./wallet-picker";
import { WithdrawSection } from "./withdraw-section";

/**
 * The node page's client side: checks isolation (reloading once if a client-side navigation brought the page in
 * without its headers), then runs the node workspace.
 */
export function FiberNodePage() {
  const config = useMemo(readBrowserNodeConfig, []);
  const [report] = useState(checkIsolation);
  const [reloading] = useState(() =>
    reloadOnceForIsolation(report, webStore("sessionStorage"), storageKey(config.network, STORAGE_NAME.ISOLATION_RELOAD)),
  );
  useEffect(() => {
    if (reloading) window.location.reload();
  }, [reloading]);

  if (reloading) return <p className="text-muted-foreground">Reloading the page to isolate it…</p>;
  if (!canRunNode(report)) {
    return (
      <div className="grid lg:grid-cols-[minmax(0,1fr)_420px] gap-6 lg:gap-10 items-start" data-testid="fiber-node">
        <IsolationNotice report={report} />
        <NodeLimits />
      </div>
    );
  }
  return <NodeWorkspaceView config={config} />;
}

function NodeWorkspaceView({ config }: { config: BrowserNodeConfig }) {
  const ws = useNodeWorkspace(config);
  const { state, nodeKey, hub, data, link, activity, node, fundingLock, contribution, confirmations } = ws;
  const peers = useNodeAction(data.refreshNode);
  const names = historyNames(ws.decimalsOf, ws.symbolOf, ws.hubNodeIds, ws.lookOf);

  return (
    // The visitor's CKB wallet, as a source of their address for a channel's close or a withdrawal (never a signer here).
    <WalletPickerProvider rpcUrl={config.ckbRpcUrl} network={config.network}>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_420px] gap-6 lg:gap-10 items-start" data-testid="fiber-node">
        <div className="space-y-6 min-w-0">
          {/* Pay on /app asked this node for something: the visitor confirms it here, as in the popup. */}
          {node && (confirmations.pending || confirmations.last) && (
            <section className="border border-foreground/10 p-6 space-y-3" aria-label={CONFIRM_COPY.TITLE} data-testid="fiber-node-confirm">
              <h2 className="font-display text-2xl">{CONFIRM_COPY.TITLE}</h2>
              <ConfirmRequest confirmations={confirmations} names={names} />
            </section>
          )}
          <KeyPanel nodeKey={nodeKey} phase={state.phase} nodeBusy={activity.busy} onKeys={ws.start} onForget={ws.forget} />
          <NodePanel
            state={state}
            otherTabHolds={ws.otherTabHolds}
            address={ws.address}
            balance={data.balance}
            balanceError={data.balanceError}
            nodeError={data.nodeError}
            rpcUrl={config.ckbRpcUrl}
            onRefreshBalance={() => void data.refreshBalance()}
            faucets={tokenFaucets(ws.tokens)}
            withdraw={
              fundingLock && (
                <WithdrawSection
                  record={nodeKey.record}
                  rpcUrl={config.ckbRpcUrl}
                  network={config.network}
                  node={node}
                  nodeLock={fundingLock}
                  balance={data.balance}
                  channels={data.channels}
                  onSent={() => void data.refreshBalance()}
                  onRecord={activity.record}
                  tokens={ws.withdrawTokens}
                  readTokenBalance={ws.readTokenBalance}
                />
              )
            }
          />
          <HubPanel
            hub={hub}
            network={config.network}
            node={node}
            nodeId={state.info?.nodeId ?? null}
            nodeLock={fundingLock}
            link={link}
            channels={data.channels}
            balance={data.balance}
            contribution={contribution}
            client={ws.client}
            record={activity.record}
            assetOf={ws.assetOf}
            decimalsOf={ws.decimalsOf}
            symbolOf={ws.symbolOf}
            lookOf={ws.lookOf}
            readTokenBalance={ws.readTokenBalance}
            restartFor={ws.restartFor}
            onLock={ws.lock}
            nodeBusy={activity.busy}
            onChanged={() => void data.refreshNode()}
          />
          {node && (
            <Panel step="04" title={FULL_PAGE_COPY.OTHER_NODES} aside={<TestnetBadge />}>
              <div className="space-y-4" data-testid="fiber-node-peers">
                <PeerChannelForm ws={ws} action={peers} noticeTestId="fiber-node-peers" />
              </div>
            </Panel>
          )}
          {node && (
            <DiagnosticsPanel
              node={node}
              network={config.network}
              hubNodeId={ws.hubNode?.nodeId ?? null}
              hubNodeIds={ws.hubNodeIds}
              assets={ws.hubNode?.assets ?? []}
              decimalsOf={(asset) => assetDecimals(asset, ws.hub.assets)}
              symbolOf={ws.symbolOf}
            />
          )}
        </div>
        <aside className="space-y-6 lg:sticky lg:top-28">
          <ActivityPanel
            items={activity.items}
            onKeepSwap={activity.keepSwap}
            serving={node !== null}
            busy={activity.busy}
            names={names}
          />
          <NodeLimits />
        </aside>
      </div>
    </WalletPickerProvider>
  );
}
