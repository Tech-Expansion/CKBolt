"use client";

import { useCallback, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { BridgeClient } from "@/lib/wallets/fiber-browser/bridge-client";
import { readContribution, spendableContribution } from "@/lib/wallets/fiber-browser/channel-contribution";
import type { CkbAddressNetwork } from "@/lib/wallets/fiber-browser/ckb-address";
import { readBrowserNodeConfig } from "@/lib/wallets/fiber-browser/config";
import { fundTarget, ownNodeAddress, type FundTarget } from "@/lib/wallets/fiber-browser/fund-address";
import { fiberNodePageHref, fundNodeHref, readFundAddress, urlHost } from "@/lib/wallets/fiber-browser/links";
import { KeystoreRepository, webStore } from "@/lib/wallets/fiber-browser/storage";
import { BRIDGE_TIMING, CKB_TESTNET_FAUCET_URL, STORAGE_NAME } from "@/lib/wallets/fiber-browser/constants";
import { CKB_SYMBOL } from "@/lib/wallets/fiber-byo/constants";
import { ckbPresetAmount, FUNDING_PRESETS, type FundingPreset } from "@/lib/wallets/fiber-byo/funding";
import { CkbWalletProvider } from "../ckb-wallet";
import { FundFiberNode } from "../fund-fiber-node";
import { InfoTip } from "../swap/info-tip";
import { TestnetBadge } from "../fiber-wallet/wallet-heading";
import { CopyButton, Panel } from "../ui";
import { StatusNotice } from "../status";
import { pillButton, textButton } from "./styles";
import { usePolling } from "./use-polling";

/**
 * What the browser node needs for the hub's CKB channel: the CKB it puts in (as chosen on the node page, in this
 * browser), plus change and fees. First in the list.
 */
function hubChannelPreset(contributionCkb: number): FundingPreset {
  return {
    id: "hub-channel",
    symbol: CKB_SYMBOL,
    amount: ckbPresetAmount(contributionCkb),
    label: "Channel with the CKBolt hub",
    detail: `Your node puts ${contributionCkb.toLocaleString("en-US")} CKB into the hub's channel, so it can pay at once (${spendableContribution(contributionCkb).toLocaleString("en-US")} CKB spendable); the rest covers change and fees.`,
  };
}

/** The address the node kept next to its key in this browser (written once it ran), or null. */
function storedNodeAddress(network: CkbAddressNetwork): string | null {
  const store = webStore("localStorage");
  return store ? (new KeystoreRepository(store, network, STORAGE_NAME.KEYSTORE).load()?.address ?? null) : null;
}

/** The node's own address as far as this page knows: null until the first check ends (`checked`). */
interface OwnAddressRead {
  checked: boolean;
  address: string | null;
}

/**
 * The browser node's own address (security review W7): asks the node tabs over the bridge, then falls back to the
 * address kept next to the node's key. While neither is known it asks again every few seconds, so the page turns ready
 * once the visitor opens and unlocks the node in another tab. Off while `enabled` is false (a link without an address).
 */
function useOwnNodeAddress(network: CkbAddressNetwork, enabled: boolean): OwnAddressRead {
  const [client] = useState(() => new BridgeClient());
  const [read, setRead] = useState<OwnAddressRead>({ checked: false, address: null });
  const found = useCallback((address: string | null) => setRead((last) => (last.address ? last : { checked: true, address })), []);
  usePolling(
    async () => {
      // A busy node tab can answer after the status window; its late answer still counts.
      const presence = await client.status((late) => found(ownNodeAddress(late, storedNodeAddress(network), network)));
      found(ownNodeAddress(presence, storedNodeAddress(network), network));
    },
    BRIDGE_TIMING.statusRefreshMs,
    enabled && read.address === null,
  );
  return read;
}

/**
 * The funding page's client side: "Fund my Fiber node" (the shared component of components/app/fund-fiber-node.tsx)
 * for the browser node's own address, with this page's own CCC wallet connector. The URL's address is only a claim
 * (security review W7): the form appears only once it matches the node's own address, from the node's tab or from what
 * the node kept next to its key, and it sends to the node's own spelling of it. A link to any other address funds
 * nothing; without a valid CKB testnet address the page offers the way back to the node page instead.
 */
export function FundNodePage() {
  // Rendered on the client only (fund-node-app.tsx), so the URL is there on the first render.
  const [network] = useState(() => readBrowserNodeConfig().network);
  const [linkAddress] = useState(() => readFundAddress(window.location.search));
  const own = useOwnNodeAddress(network, linkAddress !== null);
  const target: FundTarget | null = !linkAddress ? { kind: "missing" } : own.checked ? fundTarget(linkAddress, own.address) : null;
  const [presets] = useState((): readonly FundingPreset[] => [hubChannelPreset(readContribution(webStore("localStorage"), network)), ...FUNDING_PRESETS]);
  const address = target?.kind === "own" ? target.address : null;
  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_420px] gap-6 lg:gap-10 items-start" data-testid="fund-node-page">
      <div className="min-w-0">
        {target === null ? (
          <Panel step="01" title="Checking the address" aside={<TestnetBadge />}>
            <p className="text-sm text-muted-foreground leading-relaxed" role="status" data-testid="fund-node-checking">
              Checking that this is your Fiber node&apos;s address…
            </p>
          </Panel>
        ) : target.kind === "mismatch" ? (
          <MismatchPanel own={target.own} />
        ) : target.kind === "unconfirmed" ? (
          <UnconfirmedPanel />
        ) : address ? (
          <ccc.Provider name="CKBolt" hideMark>
            <CkbWalletProvider>
              <Panel step="01" title="Send test CKB to your node" aside={<TestnetBadge />}>
                <div className="space-y-6">
                  <div className="space-y-2" data-testid="fund-node-address">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium">Your node&apos;s CKB testnet address</p>
                      <CopyButton value={address} label="Copy address" />
                    </div>
                    <p className="font-mono text-xs text-muted-foreground break-all">{address}</p>
                  </div>
                  <FundFiberNode address={address} presets={presets} />
                </div>
              </Panel>
            </CkbWalletProvider>
          </ccc.Provider>
        ) : (
          <Panel step="01" title="No node address" aside={<TestnetBadge />}>
            <div className="space-y-4" data-testid="fund-node-missing">
              <p className="text-sm text-muted-foreground leading-relaxed" role="status">
                This link has no CKB testnet node address. Open it with Fund this node.
              </p>
              <a href={fiberNodePageHref()} className={pillButton}>
                Open your Fiber node
              </a>
            </div>
          </Panel>
        )}
      </div>
      <aside className="space-y-6 lg:sticky lg:top-28">
        <Panel step="02" title="Then, on the node page">
          <div className="space-y-3 text-sm text-muted-foreground leading-relaxed">
            <ol className="list-decimal pl-5 space-y-1">
              <li>Wait until the transfer confirms.</li>
              <li>
                Ask the hub for a channel.{" "}
                <InfoTip label="About the node page" align="start">
                  Your node page is still open in the tab you came from, and shows the new balance once the transfer confirms. Keep a single
                  node tab: only one tab runs the node.
                </InfoTip>
              </li>
            </ol>
            <p>
              No test CKB yet? Claim some at{" "}
              <a href={CKB_TESTNET_FAUCET_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                {urlHost(CKB_TESTNET_FAUCET_URL)}
              </a>
              .
            </p>
          </div>
        </Panel>
      </aside>
    </div>
  );
}

/**
 * The link's address is not the node's own (security review W7): nothing is offered for it, and the link's address is
 * not shown. The way on is the funding page for the node's own address, which the node gave.
 */
function MismatchPanel({ own }: { own: string }) {
  return (
    <Panel step="01" title={"Not your node's address"} aside={<TestnetBadge />}>
      <div className="space-y-4" data-testid="fund-node-mismatch">
        <StatusNotice tone="error" role="alert">
          This link&apos;s address is not your Fiber node&apos;s. This page sends nothing to it.
        </StatusNotice>
        <div className="flex flex-wrap items-center gap-3">
          <a href={fundNodeHref(own)} className={pillButton} data-testid="fund-node-own">
            Fund your own node
          </a>
          <a href={fiberNodePageHref()} className={`${textButton} inline-flex items-center`}>
            Open your Fiber node
          </a>
        </div>
      </div>
    </Panel>
  );
}

/**
 * No node tab answered and this browser keeps no address for the node, so the link cannot be checked. The node page
 * opens in a new tab, so this page keeps asking and turns ready once the node runs.
 */
function UnconfirmedPanel() {
  return (
    <Panel step="01" title="Open your Fiber node first" aside={<TestnetBadge />}>
      <div className="space-y-4" data-testid="fund-node-unconfirmed">
        <StatusNotice tone="pending" role="status">
          This page sends only to your own Fiber node. Open and unlock it; this page then checks again.
        </StatusNotice>
        <a href={fiberNodePageHref()} target="_blank" rel="noopener" className={pillButton}>
          Open your Fiber node
        </a>
      </div>
    </Panel>
  );
}
