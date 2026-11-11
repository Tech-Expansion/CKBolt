"use client";

import type { ReactNode } from "react";
import type { TokenFaucet } from "@/lib/faucets";
import { formatUnits } from "@/lib/hub/format";
import type { NodePhase } from "@/lib/wallets/fiber-browser/bridge-protocol";
import type { NodeState } from "@/lib/wallets/fiber-browser/node-controller";
import { urlHost } from "@/lib/wallets/fiber-browser/links";
import { CKB_DECIMALS, FIBER_JS_VERSION } from "@/lib/wallets/fiber-browser/constants";
import { nodePhaseTone } from "@/lib/status-tone";
import { StatusBadge, StatusNotice } from "../status";
import { Panel, Row, shorten } from "../ui";
import { NodeAddress } from "./node-address";
import { NodeStatusNotice, shownPhase } from "./node-status-notice";

export const PHASE_LABEL: Record<NodePhase, string> = {
  locked: "Locked",
  starting: "Starting…",
  running: "Running",
  "other-tab": "Runs in another tab",
  failed: "Failed",
};

interface NodePanelProps {
  state: NodeState;
  /** Another tab of this browser already runs the node (seen before unlocking). */
  otherTabHolds: boolean;
  address: string | null;
  balance: bigint | null;
  balanceError: string | null;
  nodeError: string | null;
  rpcUrl: string;
  onRefreshBalance: () => void;
  /** Faucets of the tokens the hub serves, under the CKB faucet. */
  faucets?: readonly TokenFaucet[];
  /** Getting the on-chain CKB back (withdraw-section.tsx), under the funding controls once the address is known. */
  withdraw?: ReactNode;
}

/** Panel 02: the node's status, id, CKB address, on-chain balance, how to fund it, and how to take the CKB back. */
export function NodePanel({ state, otherTabHolds, address, balance, balanceError, nodeError, rpcUrl, onRefreshBalance, faucets, withdraw }: NodePanelProps) {
  const phase = shownPhase(state, otherTabHolds);
  return (
    <Panel step="02" title="Node" aside={<StatusBadge tone={nodePhaseTone(phase)} dot>{PHASE_LABEL[phase]}</StatusBadge>}>
      <div className="space-y-6" data-testid="fiber-node-status">
        <NodeStatusNotice state={state} otherTabHolds={otherTabHolds} />
        {state.info && (
          <dl>
            <Row label="Node id" value={shorten(state.info.nodeId, 10)} note="Public key of the node's P2P key" />
            <Row label="Fiber node" value={`fiber-js ${state.info.version || FIBER_JS_VERSION}`} note="Runs in this tab, on CKB testnet" />
            <Row
              label="On-chain CKB"
              value={balance === null ? "…" : `${formatUnits(balance.toString(), CKB_DECIMALS)} CKB`}
              note={`At its address, read from ${urlHost(rpcUrl)}`}
            />
          </dl>
        )}
        {nodeError && <StatusNotice tone="error">{nodeError}</StatusNotice>}
        {balanceError && <StatusNotice tone="error">{balanceError}</StatusNotice>}
        {address && (
          <NodeAddress address={address} onRefreshBalance={onRefreshBalance} faucets={faucets}>
            {withdraw}
          </NodeAddress>
        )}
      </div>
    </Panel>
  );
}
