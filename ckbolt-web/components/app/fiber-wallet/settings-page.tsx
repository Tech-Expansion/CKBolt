"use client";

import { useId } from "react";
import { ArrowUpRight } from "lucide-react";
import { FIBER_NODE_PAGE_PATH } from "@/lib/wallets/fiber-browser/constants";
import { GUIDE_PAGE_PATH } from "../guide/constants";
import { ForgetKey, KeyBackup, KeyError, RestoreKeyForm } from "../fiber-node/key-forms";
import { pillButton } from "../fiber-node/styles";
import type { NodeWorkspace } from "../fiber-node/use-node-workspace";
import { InfoTip } from "../swap/info-tip";
import { WALLET_ACTION } from "../swap/wallets/copy";
import { CopyButton, shorten } from "../ui";
import { SETTINGS_COPY } from "./copy";
import { sectionTitle } from "./styles";

/** Settings: the key (back up, restore, forget), the running node (its id, Lock), and links to the full page and the guide. */
export function SettingsPage({ ws }: { ws: NodeWorkspace }) {
  const { nodeKey, state, activity } = ws;
  const running = state.phase === "running";
  const errorId = useId();
  const keyId = useId();
  const nodeId = useId();
  const linksId = useId();
  const id = state.info?.nodeId ?? "";
  return (
    <div className="space-y-8" data-testid="fiber-wallet-settings">
      {running && (
        <section className="space-y-3" aria-labelledby={nodeId} data-testid="fiber-wallet-node">
          <h3 id={nodeId} className={sectionTitle}>
            {SETTINGS_COPY.NODE}
          </h3>
          <div className="flex flex-wrap items-center justify-between gap-x-3" data-testid="fiber-wallet-node-id">
            <span className="text-sm">
              <span className="sr-only">{SETTINGS_COPY.NODE_ID}: </span>
              <span className="font-mono text-xs">{shorten(id, 8)}</span>
            </span>
            <CopyButton value={id} label={SETTINGS_COPY.COPY_NODE_ID} />
          </div>
          <button
            type="button"
            onClick={ws.lock}
            disabled={activity.busy}
            title={activity.busy ? SETTINGS_COPY.LOCK_BUSY : undefined}
            className={pillButton}
            data-testid="fiber-wallet-lock"
          >
            {SETTINGS_COPY.LOCK}
          </button>
        </section>
      )}

      <section className="space-y-4" aria-labelledby={keyId}>
        <h3 id={keyId} className={sectionTitle}>
          {SETTINGS_COPY.KEY}
        </h3>
        {nodeKey.record && <KeyBackup nodeKey={nodeKey} />}
        {!running && state.phase !== "starting" && (
          <RestoreKeyForm nodeKey={nodeKey} onKeys={ws.start} replacing={!!nodeKey.record} errorId={errorId} />
        )}
        <KeyError nodeKey={nodeKey} id={errorId} />
        {nodeKey.record && <ForgetKey nodeBusy={activity.busy} onForget={ws.forget} />}
      </section>

      <section className="space-y-3" aria-labelledby={linksId}>
        <h3 id={linksId} className={sectionTitle}>
          {SETTINGS_COPY.LINKS}
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          {/* Plain links in a new tab: the node page needs a full load for its isolation, and this page keeps its node. */}
          <a href={FIBER_NODE_PAGE_PATH} target="_blank" rel="noopener" className={pillButton} data-testid="fiber-wallet-full-page">
            {SETTINGS_COPY.FULL_PAGE}
            <ArrowUpRight className="ml-1 h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{WALLET_ACTION.NEW_TAB}</span>
          </a>
          <InfoTip label={SETTINGS_COPY.FULL_PAGE_TIP_LABEL} align="start">
            {SETTINGS_COPY.FULL_PAGE_TIP}
          </InfoTip>
          <a href={GUIDE_PAGE_PATH} target="_blank" rel="noopener" className={pillButton} data-testid="fiber-wallet-guide">
            {SETTINGS_COPY.GUIDE}
            <ArrowUpRight className="ml-1 h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{WALLET_ACTION.NEW_TAB}</span>
          </a>
        </div>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {SETTINGS_COPY.LIMITS_LABEL}
          <InfoTip label={SETTINGS_COPY.LIMITS_TIP_LABEL} align="start">
            {SETTINGS_COPY.LIMITS_TIP}
          </InfoTip>
        </p>
      </section>
    </div>
  );
}
