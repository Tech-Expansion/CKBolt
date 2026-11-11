"use client";

import { ArrowUpRight } from "lucide-react";
import type { FiberWalletState } from "../contracts";
import type { AssetDto } from "@/lib/hub/contract";
import { CKB_ASSET } from "@/lib/wallets/fiber-browser/channels";
import { fiberNodePageHref } from "@/lib/wallets/fiber-browser/links";
import { liquidityRows } from "@/lib/wallets/fiber-wallet/liquidity";
import { nodeFixPage, type NodeFixPage } from "@/lib/wallets/fiber-wallet/node-page";
import { nodeRuns, nodeStatusLines, nodeStatusTones } from "@/lib/wallets/fiber-wallet/node-status";
import type { BrowserNodeView } from "@/lib/wallets/fiber-wallet/state";
import { LiquidityTable } from "../../fiber-node/liquidity-table";
import { useWalletHost } from "../../fiber-wallet/host/wallet-host";
import { StatusDot } from "../../status";
import { InfoTip } from "../info-tip";
import { FIBER_COPY, WALLET_ACTION } from "./copy";
import { monoLabel, pillButton, textButton } from "./styles";

/**
 * The browser node in the Fiber dialog: its status and link to the hub, what it can send and receive per asset, and
 * buttons to the page of the header's Fiber node that fixes it (Home, Channels, Add funds). Funding (the only CKB L1
 * step) happens there.
 */
export function BrowserNodeDetails({
  wallet,
  view,
  check,
  assets,
  onLeave,
}: {
  wallet: FiberWalletState;
  view: BrowserNodeView;
  check: () => Promise<void>;
  assets: readonly AssetDto[];
  /** Closes the dialog before the header's Fiber node opens over the page. */
  onLeave?: () => void;
}) {
  const host = useWalletHost();
  const lines = nodeStatusLines(view);
  const tones = nodeStatusTones(view);
  const runs = nodeRuns(view);
  const rows = liquidityRows(wallet.liquidity, assets);
  // Until the node runs, its status line already says what is wrong (not open, locked) and the button below fixes it.
  const problem = runs ? wallet.problem : null;
  // A channel from the hub in CKB comes first; the swap card itself knows the swap's token.
  const fix = runs ? nodeFixPage({ problem, shortfall: null, funds: wallet.funds, asset: CKB_ASSET }) : null;
  const openPage = (page: NodeFixPage) => {
    onLeave?.();
    host?.show(page);
  };

  return (
    <div className="space-y-4 border border-foreground/10 p-4" data-testid="fiber-node-status">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 text-sm">
        <dt className={monoLabel}>{FIBER_COPY.STATUS_NODE}</dt>
        <dd className="flex items-center gap-2" data-testid="fiber-node-phase">
          <StatusDot tone={tones.node} />
          {lines.node}
        </dd>
        {lines.hub && (
          <>
            <dt className={monoLabel}>{FIBER_COPY.STATUS_HUB}</dt>
            <dd className="flex items-center gap-2" data-testid="fiber-node-hub">
              {tones.hub && <StatusDot tone={tones.hub} />}
              {lines.hub}
            </dd>
          </>
        )}
      </dl>

      {rows.length > 0 && <LiquidityTable rows={rows} />}

      <div aria-live="polite">
        {problem && (
          <p className="text-sm" role="status" data-testid="fiber-node-problem">
            {problem}
          </p>
        )}
      </div>

      {runs ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {host && fix && fix !== "add-funds" && (
            <button type="button" className={pillButton} onClick={() => openPage(fix)} data-testid="fiber-fix-in-node">
              {FIBER_COPY.OPEN_PAGE[fix]}
            </button>
          )}
          {host ? (
            <button
              type="button"
              className={fix === "add-funds" ? pillButton : textButton}
              onClick={() => openPage("add-funds")}
              data-testid="fiber-add-funds"
            >
              {FIBER_COPY.ADD_FUNDS}
            </button>
          ) : (
            <span className="text-sm">{FIBER_COPY.ADD_FUNDS}</span>
          )}
          <InfoTip label={FIBER_COPY.ADD_FUNDS_TIP_LABEL} align="start">
            {FIBER_COPY.ADD_FUNDS_TIP}
          </InfoTip>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {host ? (
            // The node runs in the header's Fiber node popup: open it on Home over this page (it offers a window where it cannot run).
            <button type="button" className={pillButton} onClick={() => openPage("home")} data-testid="fiber-open-node">
              {WALLET_ACTION.OPEN_NODE}
            </button>
          ) : (
            <a href={fiberNodePageHref()} target="_blank" rel="noopener" className={pillButton} data-testid="fiber-open-node">
              {WALLET_ACTION.OPEN_NODE}
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">{WALLET_ACTION.NEW_TAB}</span>
            </a>
          )}
          <InfoTip label={FIBER_COPY.OPEN_NODE_TIP_LABEL} align="start">
            {FIBER_COPY.OPEN_NODE_TIP}
          </InfoTip>
          <button type="button" className={textButton} onClick={() => void check()} data-testid="fiber-check-again">
            {WALLET_ACTION.CHECK_AGAIN}
          </button>
        </div>
      )}
    </div>
  );
}
