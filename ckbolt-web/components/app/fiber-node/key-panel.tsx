"use client";

import { useId } from "react";
import type { NodePhase } from "@/lib/wallets/fiber-browser/bridge-protocol";
import type { NodeKeys } from "@/lib/wallets/fiber-browser/keys";
import { InfoTip } from "../swap/info-tip";
import { StatusBadge } from "../status";
import { Panel } from "../ui";
import { CreateKeyForm, ForgetKey, KeyBackup, KeyError, RestoreKeyForm, UnlockKeyForm, UnreadableKeyNotice } from "./key-forms";
import type { NodeKey } from "./use-node-key";

interface KeyPanelProps {
  nodeKey: NodeKey;
  phase: NodePhase;
  /** The node still has work in flight, so it must not be forgotten now. */
  nodeBusy: boolean;
  /** Starts the node with keys that were just created, unlocked or restored. */
  onKeys: (keys: NodeKeys) => void;
  /** Stops the node and deletes its key from this browser. */
  onForget: () => Promise<void>;
}

/** Panel 01: create, unlock or restore the node key; back it up; forget it. */
export function KeyPanel({ nodeKey, phase, nodeBusy, onKeys, onForget }: KeyPanelProps) {
  const errorId = useId();
  const running = phase === "running" || phase === "starting";
  const tag = !nodeKey.record ? "No key yet" : running ? "Unlocked" : "Locked";
  const tone = nodeKey.record && running ? "ok" : "off";
  return (
    <Panel step="01" title="Node key" aside={<StatusBadge tone={tone}>{tag}</StatusBadge>}>
      <div className="space-y-6" data-testid="fiber-node-key">
        <UnreadableKeyNotice nodeKey={nodeKey} />
        {!nodeKey.record && <CreateKeyForm nodeKey={nodeKey} onKeys={onKeys} errorId={errorId} />}
        {nodeKey.record && !running && <UnlockKeyForm nodeKey={nodeKey} onKeys={onKeys} errorId={errorId} />}
        {nodeKey.record && running && (
          <p className="text-muted-foreground leading-relaxed">
            Unlocked in this tab.{" "}
            <InfoTip label="About the unlocked key" align="start">
              fiber-js holds the keys in its workers until the tab closes. They never leave this browser.
            </InfoTip>
          </p>
        )}
        <KeyError nodeKey={nodeKey} id={errorId} />
        {!running && <RestoreKeyForm nodeKey={nodeKey} onKeys={onKeys} replacing={!!nodeKey.record} errorId={errorId} />}
        {nodeKey.record && <KeyBackup nodeKey={nodeKey} />}
        {nodeKey.record && <ForgetKey nodeBusy={nodeBusy} onForget={onForget} />}
      </div>
    </Panel>
  );
}
