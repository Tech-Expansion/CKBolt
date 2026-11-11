/**
 * Decisions for catching LND up with bitcoind (pure; scripts/steps/lightning-sync.step.ts does the I/O).
 *
 * An unclean Docker stop can make bitcoind come back below the height LND's wallet already synced to: Bitcoin Core
 * writes its block index about once an hour, so blocks mined since are gone, and on regtest nobody sends them again.
 * LND's wallet then asks bitcoind for a block above its tip, logs LND_WALLET_AHEAD_LOG every few seconds and never
 * syncs, until the chain grows past the wallet's height; then it finds the fork, rolls back and syncs.
 */
import type { ChainTip } from "./bitcoin-tip";
import { LND_CHAIN_SYNCED_LOG, LND_WALLET_AHEAD_LOG } from "./devnet.constants";

/** Blocks mined for an LND node that is behind for no known reason (an old tip after a pause), and the first blind batch. */
export const CATCH_UP_BLOCKS = 1;

/** The factor each blind batch grows by while a wallet stays ahead of bitcoind. */
const BATCH_GROWTH = 2;

export const CATCH_UP_REASON = {
  /** bitcoind lost blocks the scripts mined: the gap is known. */
  LOST_BLOCKS: "lost_blocks",
  /** An LND wallet is ahead of bitcoind by blocks the scripts did not record: mine blind, in growing batches. */
  WALLET_AHEAD: "wallet_ahead",
  /** LND is not synced only because the tip is old. */
  STALE_TIP: "stale_tip",
} as const;

/** What the first catch-up looks at, read once when some LND node is not synced. */
export interface ChainCheck {
  /** The tip recorded after the scripts' last mine; null when none was. */
  recorded: ChainTip | null;
  /** bitcoind's height now. */
  height: number;
  /** bitcoind's block hash at the recorded height now; null when its chain is shorter (or nothing was recorded). */
  hashAtRecordedHeight: string | null;
  /** LND services that are not synced. */
  unsynced: readonly string[];
  /** Those whose log says their wallet is ahead of bitcoind. */
  walletAhead: readonly string[];
}

export type CatchUpPlan =
  | { reason: typeof CATCH_UP_REASON.LOST_BLOCKS; blocks: number; recorded: ChainTip; height: number }
  | { reason: typeof CATCH_UP_REASON.WALLET_AHEAD; blocks: number; services: readonly string[] }
  | { reason: typeof CATCH_UP_REASON.STALE_TIP; blocks: number; services: readonly string[] };

/**
 * Blocks to mine so bitcoind passes the tip the scripts recorded: 0 while the recorded block is still in its chain,
 * otherwise the gap plus one (also 1 when that height now holds another block), so LND's wallet sees a longer chain.
 */
export function lostBlocks(recorded: ChainTip, height: number, hashAtRecordedHeight: string | null): number {
  if (hashAtRecordedHeight === recorded.hash) return 0;
  return Math.max(recorded.height - height, 0) + 1;
}

/** True when the latest of LND's "wallet ahead of bitcoind" error and its "fully synced" line in `log` is the error. */
export function walletAheadOfChain(log: string): boolean {
  const lines = log.split(/\r?\n/);
  const lastAhead = lines.findLastIndex((line) => line.includes(LND_WALLET_AHEAD_LOG.MESSAGE) && line.includes(LND_WALLET_AHEAD_LOG.REASON));
  const lastSynced = lines.findLastIndex((line) => line.includes(LND_CHAIN_SYNCED_LOG));
  return lastAhead > lastSynced;
}

/** The first catch-up: the exact gap when bitcoind lost recorded blocks, else one block (blind or for an old tip). */
export function planCatchUp(check: ChainCheck): CatchUpPlan {
  const { recorded, height } = check;
  if (recorded) {
    const blocks = lostBlocks(recorded, height, check.hashAtRecordedHeight);
    if (blocks > 0) return { reason: CATCH_UP_REASON.LOST_BLOCKS, blocks, recorded, height };
  }
  if (check.walletAhead.length > 0) return { reason: CATCH_UP_REASON.WALLET_AHEAD, blocks: CATCH_UP_BLOCKS, services: check.walletAhead };
  return { reason: CATCH_UP_REASON.STALE_TIP, blocks: CATCH_UP_BLOCKS, services: check.unsynced };
}

/**
 * The next blind batch while a wallet stays ahead of bitcoind: twice the last one, within what is left of `maxBlocks`
 * for all batches; 0 once that is spent. From CATCH_UP_BLOCKS that is 2, 4, 8, ...: a gap of n heals in about log2(n)
 * rounds and is overshot by less than n.
 */
export function nextCatchUpBatch(lastBatch: number, minedInBatches: number, maxBlocks: number): number {
  return Math.max(Math.min(lastBatch * BATCH_GROWTH, maxBlocks - minedInBatches), 0);
}

/** "1 block", "18 blocks". */
export const blocksText = (count: number): string => `${count} block${count === 1 ? "" : "s"}`;

const servicesText = (services: readonly string[]): string => services.join(", ");

/** What the first catch-up found and does, for the output of `npm run up`. */
export function describeCatchUp(plan: CatchUpPlan): string {
  const mining = `Mining ${blocksText(plan.blocks)}`;
  switch (plan.reason) {
    case CATCH_UP_REASON.LOST_BLOCKS: {
      const { recorded, height } = plan;
      const found =
        height < recorded.height
          ? `bitcoind is at height ${height}, below the ${recorded.height} the devnet scripts mined to: an unclean Docker stop lost blocks it had not written to disk yet`
          : `bitcoind's block ${recorded.height} is not the one the devnet scripts mined: an unclean Docker stop lost it and other blocks were mined since`;
      return `${found}. ${mining} so LND rolls back to the fork and syncs`;
    }
    case CATCH_UP_REASON.WALLET_AHEAD:
      return (
        `${servicesText(plan.services)}: LND logs "${LND_WALLET_AHEAD_LOG.MESSAGE} ... ${LND_WALLET_AHEAD_LOG.REASON}", so its wallet is ` +
        `ahead of bitcoind, which lost blocks in an unclean Docker stop. ${mining}, then more in doubling batches until LND syncs`
      );
    case CATCH_UP_REASON.STALE_TIP:
      return `${servicesText(plan.services)}: not synced, the chain tip is old after a pause. ${mining} so LND sees a recent tip`;
  }
}
