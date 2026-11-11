import type { FiberAssetId } from "@/lib/hub/contract";
import type { FiberShortfall } from "@/lib/swap/fiber-liquidity";
import type { NodePresence } from "@/lib/wallets/fiber-browser/bridge-protocol";
import { ckbNeededToAccept } from "@/lib/wallets/fiber-browser/channel-contribution";
import { ckbToShannons } from "@/lib/wallets/fiber-browser/channels";
import type { WalletPage } from "@/lib/wallets/fiber-popup/constants";
import { FIBER_WALLET_PROBLEM } from "./messages";

/**
 * Where the swap card sends the visitor to fix their browser node (docs/live-swap-ui.md, part "wallets"): the page of
 * the header's Fiber node popup that does it. Home opens, unlocks and connects the node; Channels asks the hub for a
 * channel or a bigger one; Add funds comes first when the node holds too little CKB to accept that channel.
 */

/** What the running node holds on chain and puts into a channel from the hub, as its tab reported it. */
export interface NodeFunds {
  /** Shannons. */
  onChainCkb: bigint;
  /** Whole CKB. */
  contributionCkb: number;
}

const BASE_UNITS = /^\d{1,30}$/;

/** The node's funds from its tab's answer; null while unknown, or when the answer is not whole numbers. */
export function readNodeFunds(presence: Pick<NodePresence, "onChainCkb" | "contributionCkb"> | null): NodeFunds | null {
  const ckb = presence?.onChainCkb;
  const contribution = presence?.contributionCkb;
  if (typeof ckb !== "string" || !BASE_UNITS.test(ckb) || typeof contribution !== "number" || !Number.isSafeInteger(contribution) || contribution < 0) {
    return null;
  }
  return { onChainCkb: BigInt(ckb), contributionCkb: contribution };
}

/** True when the node holds too little CKB on chain to accept a channel from the hub in `asset`; false while unknown. */
export function shortOfChannelFunds(funds: NodeFunds | null, asset: FiberAssetId): boolean {
  if (!funds) return false;
  return funds.onChainCkb < ckbToShannons(ckbNeededToAccept(asset, funds.contributionCkb));
}

/** Problems fixed on Home: open or unlock the node, wait for it, see why it failed, connect it to the hub. */
const HOME_PROBLEMS: readonly string[] = [
  FIBER_WALLET_PROBLEM.LOOKING,
  FIBER_WALLET_PROBLEM.NOT_OPEN,
  FIBER_WALLET_PROBLEM.LOCKED,
  FIBER_WALLET_PROBLEM.STARTING,
  FIBER_WALLET_PROBLEM.FAILED,
  FIBER_WALLET_PROBLEM.HUB_NOT_CONNECTED,
];

/** The pages that fix the node for a swap. */
export type NodeFixPage = Extract<WalletPage, "home" | "channels" | "add-funds">;

export interface NodeFixInput {
  /** The browser node's problem (FIBER_WALLET_PROBLEM), or null when it is ready. */
  problem: string | null;
  /** The swap the node cannot carry, or null. */
  shortfall: FiberShortfall | null;
  funds: NodeFunds | null;
  /** The swap's Fiber asset. */
  asset: FiberAssetId;
}

/**
 * The popup's page that fixes what keeps the browser node from this swap, or null when there is nothing to fix there
 * (it runs in another tab, its hub is on another network, or it is ready).
 */
export function nodeFixPage({ problem, shortfall, funds, asset }: NodeFixInput): NodeFixPage | null {
  if (problem !== null && HOME_PROBLEMS.includes(problem)) return "home";
  const needsChannel = problem === FIBER_WALLET_PROBLEM.NO_CHANNEL || (problem === null && shortfall !== null);
  if (!needsChannel) return null;
  return shortOfChannelFunds(funds, asset) ? "add-funds" : "channels";
}
