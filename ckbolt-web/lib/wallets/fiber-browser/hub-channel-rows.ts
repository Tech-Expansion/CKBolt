import type { FiberAssetId, FiberNodeDto } from "@/lib/hub/contract";
import type { StatusTone } from "@/lib/status-tone";
import { ckbNeededToAccept, largestContribution } from "./channel-contribution";
import { CKB_ASSET, channelAsset, ckbToShannons, hubChannels, isChannelFunding, isChannelReady, swapLiquidity, type Liquidity } from "./channels";
import { CKB_DECIMALS, HUB_RUN_TIMING } from "./constants";
import { fiberErrorMessage } from "./errors";
import type { NodeChannel } from "./node-port";
import { ownTokenOffer, type OwnTokenOffer } from "./own-token-channel";

/**
 * "Channel with the hub" as one card (components/app/fiber-node/hub-channel-request.tsx): a row per asset the hub opens
 * inbound channels in, or lets the node open its own channel in (`peerChannels`), built from GET /v1/fiber/node alone
 * (CKB first, then the hub's tokens in its order), so a token the hub adds shows with no change here. The visitor ticks
 * rows and opens them in one press; each is its own channel and its own funding transaction (fnn 0.9.1 cannot fund
 * several channels in one transaction, nor add to an open one), so the run takes them one after another, and waits
 * between them until the node's last funding is committed. A token row the hub offers `peerChannels` for may instead be
 * opened by the node with its own on-chain tokens (own-token-channel.ts): no request to the hub for that row.
 */

/** Where a row stands between runs: from the node's channels with the hub and the hub's offer. */
export type HubRowState =
  /** A ready channel with the hub in this asset: what a swap can move over it now. */
  | { kind: "open"; liquidity: Liquidity }
  /** A channel with the hub in this asset whose funding is not confirmed yet. */
  | { kind: "opening" }
  /** A token the running node started without (fnn reads its UDT whitelist at start): it would refuse the channel. */
  | { kind: "restart" }
  /** The hub says it cannot fund a channel in this asset now (inbound.fundable false), and the node may not open its own. */
  | { kind: "unfundable" }
  /** No channel yet: the visitor may tick it. */
  | { kind: "available" };

export interface HubRow {
  asset: FiberAssetId;
  /** What the hub funds a new channel in this asset with, in its base units; null when it funds none (own tokens only). */
  hubAmount: bigint | null;
  /** The hub would fund a new channel in this asset now: it has an amount for it and does not say it cannot. */
  hubFunds: boolean;
  /** The node may open its own channel to the hub in this token instead (the hub's peerChannels); null otherwise. */
  own: OwnTokenOffer | null;
  state: HubRowState;
}

const AMOUNT = /^\d+$/;

/** What the hub funds an inbound channel in `asset` with (inbound.amounts), or null: none, off, or unreadable. */
const inboundAmount = (hubNode: Pick<FiberNodeDto, "inbound">, asset: FiberAssetId): bigint | null => {
  const raw = hubNode.inbound.enabled ? hubNode.inbound.amounts[asset] : undefined;
  return raw && AMOUNT.test(raw) ? BigInt(raw) : null;
};

/** The hub's offer for the node's own channel in `asset`, from its entry in GET /v1/fiber/node. */
const ownOffer = (hubNode: Pick<FiberNodeDto, "assets">, asset: FiberAssetId): OwnTokenOffer | null => {
  const dto = hubNode.assets.find((a) => a.id === asset);
  return dto ? ownTokenOffer(dto) : null;
};

/**
 * The card's assets: those the hub opens inbound channels in (an amount in inbound.amounts) and the tokens a node may
 * open its own channel to the hub in (peerChannels). CKB first, then the hub's order.
 */
export function hubRowAssets(hubNode: Pick<FiberNodeDto, "assets" | "inbound">): FiberAssetId[] {
  const offered = hubNode.assets
    .map((a) => a.id)
    .filter((id, i, all) => all.indexOf(id) === i && ((hubNode.inbound.enabled && !!hubNode.inbound.amounts[id]) || ownOffer(hubNode, id) !== null));
  return [...offered.filter((id) => id === CKB_ASSET), ...offered.filter((id) => id !== CKB_ASSET)];
}

/**
 * The card's rows. A channel the node has with the hub wins over everything else (a token with a channel is Open, never
 * "cannot fund"), whoever opened it; then a restart the node needs, then "cannot fund now" when the hub says so and the
 * node may not open its own channel in the token either.
 */
export function hubRows(
  hubNode: Pick<FiberNodeDto, "nodeId" | "assets" | "inbound">,
  channels: readonly NodeChannel[],
  restartFor: readonly FiberAssetId[],
): HubRow[] {
  const withHub = hubChannels(channels, hubNode.nodeId);
  return hubRowAssets(hubNode).map((asset) => {
    const hubAmount = inboundAmount(hubNode, asset);
    const hubFunds = hubAmount !== null && hubNode.inbound.fundable?.[asset] !== false;
    const own = ownOffer(hubNode, asset);
    const inAsset = withHub.filter((c) => channelAsset(c, hubNode.assets) === asset);
    const state: HubRowState = inAsset.some(isChannelReady)
      ? { kind: "open", liquidity: swapLiquidity(channels, asset, hubNode) }
      : inAsset.length > 0
        ? { kind: "opening" }
        : restartFor.includes(asset)
          ? { kind: "restart" }
          : !hubFunds && own === null
            ? { kind: "unfundable" }
            : { kind: "available" };
    return { asset, hubAmount, hubFunds, own, state };
  });
}

/** Who puts the tokens into a row's new channel: the hub (asked for it), or the node itself (open_channel). */
export type HubRowFunding = "hub" | "own";

/**
 * Who funds a row's new channel: the hub, unless the visitor chose the node's own tokens; the node's own when the hub
 * cannot fund one but the node may open its own.
 */
export function rowFunding(row: Pick<HubRow, "hubFunds" | "own">, ownChosen: boolean): HubRowFunding {
  if (row.own === null) return "hub";
  return !row.hubFunds || ownChosen ? "own" : "hub";
}

/** Both are possible, so the row offers the choice (the hub funds it, or the node puts in its own tokens). */
export const offersFundingChoice = (row: Pick<HubRow, "hubFunds" | "own" | "state">): boolean =>
  row.state.kind === "available" && row.hubFunds && row.own !== null;

/* ------------------------------------------------------------------------------------------- selection */

export interface SelectionNeeds {
  /** Whole CKB the node must hold on chain for every ticked row: CKB's contribution and each token's reserve, each with its fee margin. */
  neededCkb: number;
  /** Whole CKB the node holds (rounded down), or null until read. */
  haveCkb: number | null;
  /** The node holds enough. */
  enough: boolean;
  /** Whole CKB still missing (rounded up), 0 when enough or unknown. */
  shortCkb: number;
}

const SHANNONS_PER_CKB = BigInt(10 ** CKB_DECIMALS);

/**
 * What the ticked rows need on chain, by the same maths as one channel (ckbNeededToAccept): the CKB the node puts into a
 * CKB channel plus the fee margin, and each token channel's reserve plus the fee margin (181 CKB).
 */
export function selectionNeeds(selected: readonly FiberAssetId[], contributionCkb: number, balance: bigint | null): SelectionNeeds {
  const neededCkb = selected.reduce((sum, asset) => sum + ckbNeededToAccept(asset, contributionCkb), 0);
  if (balance === null) return { neededCkb, haveCkb: null, enough: false, shortCkb: 0 };
  const needed = ckbToShannons(neededCkb);
  const enough = balance >= needed;
  const missing = enough ? BigInt(0) : needed - balance;
  const shortCkb = Number((missing + SHANNONS_PER_CKB - BigInt(1)) / SHANNONS_PER_CKB);
  return { neededCkb, haveCkb: Number(balance / SHANNONS_PER_CKB), enough, shortCkb };
}

/**
 * Max for the CKB field: all the node holds but the fee margin (largestContribution), less what the ticked token rows
 * need, so the total still fits. 0 when nothing is left.
 */
export function maxContribution(balance: bigint, selected: readonly FiberAssetId[]): number {
  const tokens = selected.filter((asset) => asset !== CKB_ASSET).reduce((sum, asset) => sum + ckbNeededToAccept(asset, 0), 0);
  return Math.max(0, largestContribution(balance) - tokens);
}

/* ------------------------------------------------------------------------------------------------- run */

/** A ticked row during and after a run. */
export type HubRunStatus = "queued" | "asking" | "done" | "failed";

export interface HubRunRow {
  status: HubRunStatus;
  /** Why it failed: the hub's message or the node's refusal, one line. */
  reason?: string;
}

/** What the run is doing now, for one line under the button. */
export type HubRunProgress = { kind: "asking"; asset: FiberAssetId; index: number; total: number } | { kind: "waiting"; asset: FiberAssetId };

export interface HubRunOutcome {
  done: FiberAssetId[];
  failed: FiberAssetId[];
  /** Not asked: the visitor stopped the run, or left. */
  skipped: FiberAssetId[];
}

export interface HubRunDeps {
  /**
   * Opens the row's channel: asks the hub for it (and, for CKB, accepts it), requestHubChannel, or opens the node's own
   * (runRowRequest). Throws a sentence.
   */
  request: (asset: FiberAssetId) => Promise<unknown>;
  /**
   * Waits until the channel just asked for is funded (waitForFunding); never throws. After a failed row (`failed`) it
   * waits only while a channel of the node is still being funded: a request can fail after the hub or fnn acted on it.
   * "timeout": a funding is still pending after the longest wait, so the run asks for nothing more.
   */
  waitForFunding: (asset: FiberAssetId, failed: boolean) => Promise<FundingWaitResult | void>;
  /** A row changed; null: back to how it was before the run (not asked). */
  onRow: (asset: FiberAssetId, row: HubRunRow | null) => void;
  onProgress: (progress: HubRunProgress | null) => void;
  /** The visitor stopped the run, or the card went away: ask nothing more. */
  stopped: () => boolean;
}

/** The reason on the rows a run did not ask for because a funding was still pending after the longest wait. */
export const FUNDING_STUCK_REASON = "Not asked: a channel is still being funded. Try again once it is ready.";

/**
 * Asks for each asset in turn. A failed row does not stop the next ones; between two rows the run waits for the first
 * one's funding (after a failure, only while a channel of the node is still being funded). A funding still pending
 * after the longest wait stops the run: fnn would refuse the next funding, or the hub would open a channel the node
 * cannot accept, so the rows not asked fail with that reason and can be ticked again. Stopping asks nothing more; the
 * row being asked finishes, as each row is a request of its own the hub may already have acted on.
 */
export async function runHubRequests(assets: readonly FiberAssetId[], deps: HubRunDeps): Promise<HubRunOutcome> {
  const outcome: HubRunOutcome = { done: [], failed: [], skipped: [] };
  for (const asset of assets) deps.onRow(asset, { status: "queued" });
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    if (deps.stopped()) {
      for (const rest of assets.slice(i)) deps.onRow(rest, null);
      outcome.skipped.push(...assets.slice(i));
      break;
    }
    deps.onRow(asset, { status: "asking" });
    deps.onProgress({ kind: "asking", asset, index: i + 1, total: assets.length });
    let failed = false;
    try {
      await deps.request(asset);
      outcome.done.push(asset);
      deps.onRow(asset, { status: "done" });
    } catch (error) {
      failed = true;
      outcome.failed.push(asset);
      deps.onRow(asset, { status: "failed", reason: fiberErrorMessage(error) });
    }
    if (i < assets.length - 1 && !deps.stopped()) {
      if (!failed) deps.onProgress({ kind: "waiting", asset });
      if ((await deps.waitForFunding(asset, failed)) === "timeout") {
        const rest = assets.slice(i + 1);
        for (const next of rest) deps.onRow(next, { status: "failed", reason: FUNDING_STUCK_REASON });
        outcome.failed.push(...rest);
        break;
      }
    }
  }
  deps.onProgress(null);
  return outcome;
}

/**
 * One row of a run: the node's own channel in the token when the visitor put in its own (`own` has the amount, base
 * units), so the hub is not asked for it; otherwise the hub's channel.
 */
export const runRowRequest =
  (deps: {
    own: Readonly<Partial<Record<FiberAssetId, bigint>>>;
    askHub: (asset: FiberAssetId) => Promise<unknown>;
    openOwn: (asset: FiberAssetId, amount: bigint) => Promise<unknown>;
  }) =>
  (asset: FiberAssetId): Promise<unknown> => {
    const amount = deps.own[asset];
    return amount === undefined ? deps.askHub(asset) : deps.openOwn(asset, amount);
  };

export interface FundingWaitDeps {
  listChannels: () => Promise<readonly NodeChannel[]>;
  hubNode: Pick<FiberNodeDto, "nodeId" | "assets">;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  stopped: () => boolean;
}

export type FundingWaitResult = "funded" | "timeout" | "stopped";

/**
 * Waits until the channel in `asset` the hub was just asked for shows on the node and no channel of the node is still
 * being funded. A token channel reaches the node a moment after the hub answers; one that never shows (refused by
 * fnn, or lost) stops the wait after `appearMs` (0 after a failed row: only a pending funding is waited for). Gives up
 * after `waitMs` (a channel stuck in funding: "timeout", and the run asks for nothing more), and reads of the node that
 * fail are only retried.
 */
export async function waitForFunding(
  asset: FiberAssetId,
  deps: FundingWaitDeps,
  timing: { [K in keyof typeof HUB_RUN_TIMING]: number } = HUB_RUN_TIMING,
): Promise<FundingWaitResult> {
  const start = deps.now();
  for (;;) {
    if (deps.stopped()) return "stopped";
    const elapsed = deps.now() - start;
    let channels: readonly NodeChannel[] | null = null;
    try {
      channels = await deps.listChannels();
    } catch {
      channels = null;
    }
    if (channels) {
      const shown = hubChannels(channels, deps.hubNode.nodeId).some((c) => channelAsset(c, deps.hubNode.assets) === asset);
      if (!channels.some(isChannelFunding) && (shown || elapsed >= timing.appearMs)) return "funded";
    }
    if (elapsed >= timing.waitMs) return "timeout";
    await deps.sleep(timing.pollMs);
  }
}

/* --------------------------------------------------------------------------------------------- display */

/** What a row says: its run status while a run asks for it, then the node's channel once it shows. */
export type HubRowView = HubRowState["kind"] | HubRunStatus;

/**
 * A row's word and whether it may be ticked. Queued and asking show while the run is on them. Once the node lists the
 * channel, its own state (opening, open) shows; until then Done or Failed stay. A row may be ticked only without a
 * channel and without a run on it (a failed one may be tried again; a done one waits for its channel).
 */
export function hubRowView(state: HubRowState, run: HubRunRow | undefined): { view: HubRowView; selectable: boolean } {
  const view: HubRowView =
    run && (run.status === "queued" || run.status === "asking")
      ? run.status
      : state.kind === "open" || state.kind === "opening"
        ? state.kind
        : (run?.status ?? state.kind);
  const selectable = state.kind === "available" && (run === undefined || run.status === "failed");
  return { view, selectable };
}

/** Each row word's colour (docs/style-guide.md, Status colours): open and done green, under way amber, failed red. */
const ROW_TONE: Readonly<Record<HubRowView, StatusTone>> = {
  open: "ok",
  opening: "pending",
  available: "off",
  unfundable: "off",
  restart: "pending",
  queued: "pending",
  asking: "pending",
  done: "ok",
  failed: "error",
};
export const hubRowTone = (view: HubRowView): StatusTone => ROW_TONE[view];

/** How a finished run ended, for its summary line. */
export type HubRunSummary =
  | { kind: "all_done"; done: number }
  | { kind: "some_failed"; done: number; total: number; failed: number }
  | { kind: "none_done"; total: number }
  | { kind: "stopped"; done: number; total: number };

export function hubRunSummary(outcome: HubRunOutcome): HubRunSummary {
  const total = outcome.done.length + outcome.failed.length + outcome.skipped.length;
  if (outcome.skipped.length > 0) return { kind: "stopped", done: outcome.done.length, total };
  if (outcome.failed.length === 0) return { kind: "all_done", done: outcome.done.length };
  if (outcome.done.length === 0) return { kind: "none_done", total };
  return { kind: "some_failed", done: outcome.done.length, total, failed: outcome.failed.length };
}

/** The summary's colour: all asked for green, stopped or partly failed amber (a row needs a look), nothing red. */
export const hubRunSummaryTone = (summary: HubRunSummary): StatusTone =>
  summary.kind === "all_done" ? "ok" : summary.kind === "none_done" ? "error" : "pending";
