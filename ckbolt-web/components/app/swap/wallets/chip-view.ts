import type { FiberWalletKind, FiberWalletState } from "../contracts";
import { isFailureProblem, isPassingProblem } from "@/lib/wallets/fiber-wallet/node-status";
import type { WalletTone } from "./status-dot";

/** What the Fiber chip shows: nothing chosen ("Connect Fiber"), or a short name with a status dot. */
export type ChipView = { connected: false } | { connected: true; name: string; tone: WalletTone; fiberKind: FiberWalletKind };

const DISCONNECTED: ChipView = { connected: false };

/**
 * The Fiber chip: the chosen kind and how it stands. Ready is green unless the swap on the card needs a step of it
 * (`attention`: a channel, or a bigger one); a passing state or a step to take is amber; only a failure is red.
 */
export function fiberChipView(state: FiberWalletState, attention = false): ChipView {
  if (!state.kind || !state.label) return DISCONNECTED;
  const tone: WalletTone = state.ready
    ? attention
      ? "attention"
      : "ok"
    : isPassingProblem(state.problem)
      ? "wait"
      : isFailureProblem(state.problem)
        ? "problem"
        : "attention";
  return { connected: true, name: state.label, tone, fiberKind: state.kind };
}
