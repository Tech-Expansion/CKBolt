"use client";

import type { NodePhase } from "@/lib/wallets/fiber-browser/bridge-protocol";
import type { NodeState } from "@/lib/wallets/fiber-browser/node-controller";
import { FIBER_JS_DOWNLOAD_MB, FIBER_JS_VERSION } from "@/lib/wallets/fiber-browser/constants";
import { StatusNotice } from "../status";
import { NODE_STATUS_COPY } from "./copy";

/** The phase to show: a locked node that another tab already runs reads "other-tab" before the password is asked. */
export const shownPhase = (state: Pick<NodeState, "phase">, otherTabHolds: boolean): NodePhase =>
  otherTabHolds && state.phase === "locked" ? "other-tab" : state.phase;

/** One line on where the node stands, unless it simply runs: starting, held by another tab, failed, or locked. */
export function NodeStatusNotice({ state, otherTabHolds, showLocked = true }: { state: NodeState; otherTabHolds: boolean; showLocked?: boolean }) {
  const phase = shownPhase(state, otherTabHolds);
  return (
    <>
      {phase === "locked" && showLocked && <p className="text-muted-foreground leading-relaxed">{NODE_STATUS_COPY.LOCKED}</p>}
      {phase === "starting" && (
        <StatusNotice tone="pending" role="status">
          {NODE_STATUS_COPY.STARTING(FIBER_JS_VERSION, FIBER_JS_DOWNLOAD_MB)}
        </StatusNotice>
      )}
      {phase === "other-tab" && (
        <StatusNotice tone="pending" role="status" data-testid="fiber-node-other-tab">
          {NODE_STATUS_COPY.OTHER_TAB}
        </StatusNotice>
      )}
      {phase === "failed" && (
        <StatusNotice tone="error" role="alert">
          <p>{NODE_STATUS_COPY.FAILED}</p>
          {state.error && <p className="mt-1 font-mono text-xs">{state.error}</p>}
        </StatusNotice>
      )}
      {state.phase === "running" && !state.exclusive && <p className="text-xs text-muted-foreground">{NODE_STATUS_COPY.NOT_EXCLUSIVE}</p>}
    </>
  );
}
