import type { FiberWalletKind, FiberWalletState } from "@/components/app/swap/contracts";
import type { NodePhase, NodePresence } from "@/lib/wallets/fiber-browser/bridge-protocol";
import { FIBER_WALLET_LABEL } from "./constants";
import { hasChannel, readLiquidity } from "./liquidity";
import { FIBER_WALLET_MESSAGE, FIBER_WALLET_PROBLEM } from "./messages";
import { readNodeFunds } from "./node-page";

/** What the swap page knows of the visitor's node tab (components/app/fiber-node/use-fiber-browser-bridge.ts). */
export interface BrowserNodeView {
  /** The best answer of the open node tabs, or null when none answered. */
  presence: NodePresence | null;
  /** No status answer has come back yet. */
  checking: boolean;
}

/** Nothing chosen: the swap card asks the visitor to connect a Fiber node. */
export const FIBER_WALLET_NONE: FiberWalletState = { kind: null, label: null, ready: false, liquidity: null, problem: null, funds: null };

/** The own node is driven by hand, so it is always ready and its liquidity is unknown. */
const OWN_NODE: FiberWalletState = { kind: "own-node", label: FIBER_WALLET_LABEL["own-node"], ready: true, liquidity: null, problem: null, funds: null };

const PHASE_PROBLEM: Readonly<Record<Exclude<NodePhase, "running">, string>> = {
  locked: FIBER_WALLET_PROBLEM.LOCKED,
  starting: FIBER_WALLET_PROBLEM.STARTING,
  "other-tab": FIBER_WALLET_PROBLEM.OTHER_TAB,
  failed: FIBER_WALLET_PROBLEM.FAILED,
};

/**
 * Why the browser node cannot act now, or null when it can. The first match wins: no tab, a tab whose node does not
 * run, a hub on another CKB network, no connection to the hub, no ready channel at all. A channel too small for one
 * swap is the swap card's check, since only it knows the amount.
 */
export function browserNodeProblem(view: BrowserNodeView, hubNetwork: string | null): string | null {
  const { presence } = view;
  if (!presence) return view.checking ? FIBER_WALLET_PROBLEM.LOOKING : FIBER_WALLET_PROBLEM.NOT_OPEN;
  if (presence.phase !== "running") return PHASE_PROBLEM[presence.phase];
  if (hubNetwork && presence.network !== hubNetwork) return FIBER_WALLET_PROBLEM.WRONG_NETWORK(hubNetwork);
  if (!presence.hubConnected) return FIBER_WALLET_PROBLEM.HUB_NOT_CONNECTED;
  if (!hasChannel(readLiquidity(presence.liquidity))) return FIBER_WALLET_PROBLEM.NO_CHANNEL;
  return null;
}

/** The browser node as the swap card sees it. */
export function browserNodeState(view: BrowserNodeView, hubNetwork: string | null): FiberWalletState {
  const problem = browserNodeProblem(view, hubNetwork);
  return {
    kind: "browser-node",
    label: FIBER_WALLET_LABEL["browser-node"],
    ready: problem === null,
    liquidity: view.presence ? readLiquidity(view.presence.liquidity) : null,
    problem,
    funds: readNodeFunds(view.presence),
  };
}

/** The Fiber wallet's state for a chosen kind (or none), the node tab's last answer and the hub's CKB network. */
export function fiberWalletState(kind: FiberWalletKind | null, view: BrowserNodeView, hubNetwork: string | null): FiberWalletState {
  if (kind === "own-node") return OWN_NODE;
  if (kind === "browser-node") return browserNodeState(view, hubNetwork);
  return FIBER_WALLET_NONE;
}

/**
 * Where a wallet action (make the payout invoice, pay the hold invoice) goes: to the browser node when it is ready, to
 * the visitor's own node by hand, or nowhere, with the sentence that says why.
 */
export type FiberActionRoute = { to: "browser-node" } | { to: "own-node" } | { to: "nowhere"; reason: string };

export function fiberActionRoute(state: FiberWalletState): FiberActionRoute {
  if (state.kind === "own-node") return { to: "own-node" };
  if (state.kind === "browser-node" && state.ready) return { to: "browser-node" };
  return { to: "nowhere", reason: state.problem ?? FIBER_WALLET_MESSAGE.NOT_CHOSEN };
}
