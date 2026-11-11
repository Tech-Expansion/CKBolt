import { nodePhaseTone, type StatusTone } from "@/lib/status-tone";
import type { NodePhase } from "@/lib/wallets/fiber-browser/bridge-protocol";
import { FIBER_WALLET_PROBLEM } from "./messages";
import type { BrowserNodeView } from "./state";

/** How the browser node's tab reads in the swap card's Fiber node dialog: one word or two per line. */
export const NODE_STATUS_LABEL = {
  CHECKING: "Checking…",
  NOT_OPEN: "Not open",
  PHASE: {
    locked: "Locked",
    starting: "Starting…",
    running: "Running",
    "other-tab": "Runs in another tab",
    failed: "Error",
  } satisfies Record<NodePhase, string>,
  HUB_CONNECTED: "Connected",
  HUB_NOT_CONNECTED: "Not connected",
} as const;

export interface NodeStatusLines {
  /** The node tab: not open, locked, running... */
  node: string;
  /** The link to the hub's Fiber node, only while the node runs. */
  hub: string | null;
}

/** The status lines of the browser node, from its tab's last answer. */
export function nodeStatusLines(view: BrowserNodeView): NodeStatusLines {
  const { presence } = view;
  if (!presence) return { node: view.checking ? NODE_STATUS_LABEL.CHECKING : NODE_STATUS_LABEL.NOT_OPEN, hub: null };
  const hub = presence.phase === "running" ? (presence.hubConnected ? NODE_STATUS_LABEL.HUB_CONNECTED : NODE_STATUS_LABEL.HUB_NOT_CONNECTED) : null;
  return { node: NODE_STATUS_LABEL.PHASE[presence.phase], hub };
}

/** The status lines' colours: running green, starting or still looking amber, failed red, not open or locked grey. */
export function nodeStatusTones(view: BrowserNodeView): { node: StatusTone; hub: StatusTone | null } {
  const { presence } = view;
  if (!presence) return { node: view.checking ? "pending" : "off", hub: null };
  return { node: nodePhaseTone(presence.phase), hub: presence.phase === "running" ? (presence.hubConnected ? "ok" : "off") : null };
}

/** Problems that pass on their own (an answer is on its way, the node is starting): not the visitor's to fix. */
const PASSING_PROBLEMS: readonly string[] = [FIBER_WALLET_PROBLEM.LOOKING, FIBER_WALLET_PROBLEM.STARTING];

export const isPassingProblem = (problem: string | null): boolean => problem !== null && PASSING_PROBLEMS.includes(problem);

/** "Hub is on CKB <network>: use your own node", for any network: the sentence around its network. */
const NETWORK_SLOT = "{network}";
const [WRONG_NETWORK_HEAD, WRONG_NETWORK_TAIL] = FIBER_WALLET_PROBLEM.WRONG_NETWORK(NETWORK_SLOT).split(NETWORK_SLOT);
const isWrongNetwork = (problem: string): boolean =>
  problem.length > WRONG_NETWORK_HEAD.length + WRONG_NETWORK_TAIL.length && problem.startsWith(WRONG_NETWORK_HEAD) && problem.endsWith(WRONG_NETWORK_TAIL);

/**
 * Problems that are failures, not a step to take: the node failed to start, or the hub runs on another network (the
 * browser node cannot swap there). Everything else (open, unlock, connect, a channel) only needs the visitor.
 */
export const isFailureProblem = (problem: string | null): boolean =>
  problem !== null && (problem === FIBER_WALLET_PROBLEM.FAILED || isWrongNetwork(problem));

/** True when the node runs in a tab that answered; until then the dialog offers to open the node page. */
export const nodeRuns = (view: BrowserNodeView): boolean => view.presence?.phase === "running";
