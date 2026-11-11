"use client";

import { useId, type ReactNode } from "react";
import type { AssetDto, FiberAssetId, FiberNodeDto, LightningNodeDto } from "@/lib/hub/contract";
import { DETAILS_COPY, PRIMARY_LABEL } from "@/lib/swap/copy";
import { formatSats } from "@/lib/swap/format";
import { withPeerId } from "@/lib/wallets/fiber-browser/peer-id";
import { assetDecimals, formatAssetUnits } from "@/lib/wallets/fiber-browser/tokens";
import { InfoTip } from "../swap/info-tip";
import { hubLightningNetworkName } from "../swap/wallets/copy";
import { hubStateTone } from "@/lib/status-tone";
import { StatusBadge } from "../status";
import { hubOffersChannel } from "@/lib/wallets/lightning/hub-channel";
import { CopyButton, Panel } from "../ui";
import { GUIDE_HUB_ANCHOR } from "./constants";
import { HUB_CARD_COPY } from "./copy";
import { ConnectCommand, FiberChannelRequest } from "./fiber-channel";
import { HubChannelRequest } from "./hub-channel";
import { useHubConnection, type HubRead } from "./use-hub-connection";

/**
 * "CKBolt hub" at the top of the testnet guide (#hub): what a tester connects to, read live from the hub's API through
 * the app's proxy. Lightning: the URIs a wallet adds as a peer, the channel the hub opens, and the request for one with
 * the wallet's pasted node id (F3.1); Fiber: the node id, the
 * TCP address for Fiber Studio or fnn (the browser node's WebSocket ones behind the "?") and the inbound channels; and
 * the per-swap limits, as the swap card writes them. Nothing here is hard-coded: another hub shows its own.
 */
export function HubCard() {
  const { status, lightning, fiber } = useHubConnection();
  const paused = status.live && !!status.health?.swaps.paused;
  const tag = paused ? PRIMARY_LABEL.PAUSED : HUB_CARD_COPY.STATUS[status.state];
  const reachable = status.state !== "offline" && status.state !== "off";
  return (
    <div id={GUIDE_HUB_ANCHOR} className="mb-6 scroll-mt-28 lg:mb-10" data-testid="hub-card">
      <Panel
        step={HUB_CARD_COPY.STEP}
        title={HUB_CARD_COPY.TITLE}
        aside={
          <span data-testid="hub-card-status">
            <StatusBadge tone={hubStateTone(status.state, paused)} dot>
              {tag}
            </StatusBadge>
          </span>
        }
      >
        <div className="space-y-6">
          <div aria-live="polite">
            <StatusLine state={status.state} paused={paused} reason={status.health?.reason ?? null} />
          </div>
          {reachable && (
            <>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2 lg:gap-10">
                <Part title={HUB_CARD_COPY.LIGHTNING} note={lightningNote(lightning, status.health?.lightning.network ?? null)} testId="hub-card-lightning">
                  <ReadState read={lightning}>{(node) => <LightningNode node={node} />}</ReadState>
                </Part>
                <Part title={HUB_CARD_COPY.FIBER} note={fiberNote(fiber)} testId="hub-card-fiber">
                  <ReadState read={fiber}>{(node) => <FiberNode node={node} assets={status.assets} />}</ReadState>
                </Part>
              </div>
              <Limits assets={status.assets} />
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}

function StatusLine({ state, paused, reason }: { state: string; paused: boolean; reason: string | null }) {
  const line = (text: ReactNode) => (
    <p className="text-sm" role="status" data-testid="hub-card-line">
      {text}
    </p>
  );
  if (state === "checking") return line(HUB_CARD_COPY.CHECKING);
  if (state === "offline" || state === "off") return line(HUB_CARD_COPY.OFFLINE);
  if (state === "degraded") {
    return line(
      <>
        {HUB_CARD_COPY.DEGRADED}{" "}
        {reason && (
          <InfoTip label={HUB_CARD_COPY.DEGRADED_TIP_LABEL} align="start">
            {reason}
          </InfoTip>
        )}
      </>,
    );
  }
  return paused ? line(HUB_CARD_COPY.PAUSED) : null;
}

const lightningNote = (read: HubRead<LightningNodeDto>, healthNetwork: string | null): string =>
  hubLightningNetworkName(read.status === "ok" ? (read.value.network ?? healthNetwork) : healthNetwork);

const fiberNote = (read: HubRead<FiberNodeDto>): string | null => (read.status === "ok" ? `CKB ${read.value.network}` : null);

/** One side of the hub: a column with a mono heading and the network it runs on. */
function Part({ title, note, testId, children }: { title: string; note: string | null; testId: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-3 border-t border-foreground pt-4" data-testid={testId}>
      <h3 id={id} className="font-mono text-xs text-muted-foreground">
        {title}
        {note && <span className="text-foreground/70"> · {note}</span>}
      </h3>
      {children}
    </section>
  );
}

/** A read's answer, or a short line while it loads or when the hub cannot give it (its message behind the "?"). */
function ReadState<T>({ read, children }: { read: HubRead<T>; children: (value: T) => ReactNode }) {
  if (read.status === "loading") return <p className="text-sm text-muted-foreground">{HUB_CARD_COPY.LOADING}</p>;
  if (read.status === "error") {
    return (
      <p className="text-sm text-muted-foreground" data-testid="hub-card-unavailable">
        {HUB_CARD_COPY.UNREADABLE}{" "}
        <InfoTip label={HUB_CARD_COPY.ERROR_TIP_LABEL} align="start">
          {read.message}
        </InfoTip>
      </p>
    );
  }
  return <>{children(read.value)}</>;
}

/** A value to copy: in full, wrapped anywhere on a phone, with its Copy button. */
function CopyValue({ value, label, testId }: { value: string; label: string; testId: string }) {
  return (
    <div>
      <p className="break-all font-mono text-xs text-muted-foreground" data-testid={testId}>
        {value}
      </p>
      <CopyButton value={value} label={label} />
    </div>
  );
}

/** A label and its value, as the app's Row lays them out, with a test id on the value. */
function Fact({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-foreground/5 py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-mono text-sm tabular-nums [overflow-wrap:anywhere] sm:text-right" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function LightningNode({ node }: { node: LightningNodeDto }) {
  const { uris, inbound } = node;
  return (
    <>
      <p className="text-sm">{HUB_CARD_COPY.ADD_PEER}</p>
      {uris.length > 0 ? (
        uris.map((uri) => <CopyValue key={uri} value={uri} label={HUB_CARD_COPY.COPY_ADDRESS} testId="hub-card-lightning-uri" />)
      ) : (
        <p className="text-sm text-muted-foreground">{HUB_CARD_COPY.NO_URIS}</p>
      )}
      <dl>
        <Fact
          label={HUB_CARD_COPY.CHANNELS}
          value={inbound.enabled ? HUB_CARD_COPY.LIGHTNING_CHANNEL(formatSats(inbound.capacitySats), formatSats(inbound.pushSats)) : HUB_CARD_COPY.NOT_OFFERED}
          testId="hub-card-lightning-channels"
        />
      </dl>
      {hubOffersChannel(node) && <HubChannelRequest />}
    </>
  );
}

/** "1,000 CKB · 20 RUSD": what the hub funds an inbound channel with, per asset, in the asset's own units. */
function inboundAmounts(node: FiberNodeDto, assets: readonly AssetDto[]): string | null {
  const entries = Object.entries(node.inbound.amounts).filter(([, amount]) => !!amount) as [FiberAssetId, string][];
  if (!node.inbound.enabled || entries.length === 0) return null;
  return entries
    .map(([id, amount]) => {
      // The hub's decimals and symbol; a token it did not list in GET /v1/assets shows in base units, not at a guess.
      const asset = assets.find((a) => a.id === id);
      return formatAssetUnits(amount, assetDecimals(id, assets), asset?.symbol ?? id);
    })
    .join(" · ");
}

function FiberNode({ node, assets }: { node: FiberNodeDto; assets: readonly AssetDto[] }) {
  const inbound = inboundAmounts(node, assets);
  return (
    <>
      <div className="space-y-1">
        <p className="text-sm">{HUB_CARD_COPY.NODE_ID}</p>
        <CopyValue value={node.nodeId} label={HUB_CARD_COPY.COPY_NODE_ID} testId="hub-card-fiber-node-id" />
      </div>
      <div className="space-y-1">
        <p className="flex items-center gap-1 text-sm">
          {HUB_CARD_COPY.P2P}
          <InfoTip label={HUB_CARD_COPY.WS_TIP_LABEL} align="start">
            {node.addresses.ws.length > 0 ? (
              <>
                {HUB_CARD_COPY.WS_TIP}
                <span className="mt-2 block space-y-1" data-testid="hub-card-fiber-ws">
                  {node.addresses.ws.map((address) => (
                    <span key={address} className="block break-all font-mono text-xs">
                      {withPeerId(address, node.nodeId)}
                    </span>
                  ))}
                </span>
              </>
            ) : (
              HUB_CARD_COPY.WS_NONE
            )}
          </InfoTip>
        </p>
        {node.addresses.p2p.length > 0 ? (
          node.addresses.p2p.map((address) => {
            const full = withPeerId(address, node.nodeId);
            return <CopyValue key={full} value={full} label={HUB_CARD_COPY.COPY_ADDRESS} testId="hub-card-fiber-p2p" />;
          })
        ) : (
          <p className="text-sm text-muted-foreground">{HUB_CARD_COPY.NO_P2P}</p>
        )}
        {node.addresses.p2p[0] && <ConnectCommand address={withPeerId(node.addresses.p2p[0], node.nodeId)} />}
      </div>
      <dl>
        <Fact
          label={HUB_CARD_COPY.CHANNELS}
          value={inbound ? HUB_CARD_COPY.FIBER_CHANNEL(inbound) : HUB_CARD_COPY.NOT_OFFERED}
          testId="hub-card-fiber-inbound"
        />
      </dl>
      <FiberChannelRequest node={node} assets={assets} />
    </>
  );
}

/** The per-swap limits of each asset the hub swaps, as the swap card's Details write them. */
function Limits({ assets }: { assets: readonly AssetDto[] }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-foreground pt-4" data-testid="hub-card-limits">
      <h3 id={id} className="font-mono text-xs text-muted-foreground">
        {HUB_CARD_COPY.LIMITS}
      </h3>
      {assets.length > 0 ? (
        <dl>
          {assets.map((asset) => (
            <Fact key={asset.id} label={asset.symbol} value={DETAILS_COPY.PER_SWAP_VALUE(formatSats(asset.minSats), formatSats(asset.maxSats))} />
          ))}
        </dl>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">{HUB_CARD_COPY.NO_LIMITS}</p>
      )}
    </section>
  );
}
