"use client";

import { useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { readContribution, spendableContribution } from "@/lib/wallets/fiber-browser/channel-contribution";
import { readBrowserNodeConfig } from "@/lib/wallets/fiber-browser/config";
import { fiberNodePageHref, readFundAddress, urlHost } from "@/lib/wallets/fiber-browser/links";
import { webStore } from "@/lib/wallets/fiber-browser/storage";
import { CKB_TESTNET_FAUCET_URL } from "@/lib/wallets/fiber-browser/constants";
import { CKB_SYMBOL } from "@/lib/wallets/fiber-byo/constants";
import { ckbPresetAmount, FUNDING_PRESETS, type FundingPreset } from "@/lib/wallets/fiber-byo/funding";
import { CkbWalletProvider } from "../ckb-wallet";
import { FundFiberNode } from "../fund-fiber-node";
import { InfoTip } from "../swap/info-tip";
import { TestnetBadge } from "../fiber-wallet/wallet-heading";
import { CopyButton, Panel } from "../ui";
import { pillButton } from "./styles";

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

/**
 * The funding page's client side: "Fund my Fiber node" (the shared component of components/app/fund-fiber-node.tsx)
 * for the browser node's address in the URL, with this page's own CCC wallet connector. Without a valid CKB testnet
 * address it offers the way back to the node page instead.
 */
export function FundNodePage() {
  // Rendered on the client only (fund-node-app.tsx), so the URL is there on the first render.
  const [address] = useState(() => readFundAddress(window.location.search));
  const [presets] = useState((): readonly FundingPreset[] => [
    hubChannelPreset(readContribution(webStore("localStorage"), readBrowserNodeConfig().network)),
    ...FUNDING_PRESETS,
  ]);
  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_420px] gap-6 lg:gap-10 items-start" data-testid="fund-node-page">
      <div className="min-w-0">
        {address ? (
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
