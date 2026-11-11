import type { ChainTip } from "../lib/bitcoin-tip";
import {
  blocksText,
  CATCH_UP_BLOCKS,
  describeCatchUp,
  nextCatchUpBatch,
  planCatchUp,
  walletAheadOfChain,
  type ChainCheck,
} from "../lib/chain-heal";
import { waitOptions } from "../lib/context";
import type { LndInfo } from "../lib/lnd";
import type { Logger } from "../lib/logger";
import { waitFor, type Clock } from "../lib/poll";
import type { DevnetSettings } from "../lib/settings";

/** The part of `lncli getinfo` the catch-up reads. */
type LndSyncInfo = Pick<LndInfo, "synced_to_chain" | "block_height">;

/** What the catch-up needs from bitcoind (BitcoinNode). */
export interface ChainMiner {
  mineTo(address: string, blocks: number): Promise<void>;
  blockCount(): Promise<number>;
  blockHash(height: number): Promise<string | null>;
  recordedTip(): Promise<ChainTip | null>;
}

/** What it needs from an LND node (LndNode). */
export interface SyncingLnd {
  readonly service: string;
  info(): Promise<LndSyncInfo>;
  recentLog(lines: number): Promise<string>;
}

export interface LightningSync {
  bitcoin: ChainMiner;
  nodes: readonly SyncingLnd[];
  /** A new address of the wallet that receives the coinbases of the blocks mined here. */
  rewardAddress(): Promise<string>;
  settings: Pick<DevnetSettings, "waits" | "chainHeal">;
  logger: Logger;
  clock: Clock;
}

/**
 * Waits until every LND node is synced to bitcoind's tip, mining when they cannot get there alone (lib/chain-heal.ts):
 * - bitcoind came back below the tip the scripts recorded: mine past it, so each wallet finds the fork and rolls back;
 * - an LND log says its wallet is ahead of bitcoind: mine one block, then, while the log still says so, blocks in
 *   doubling batches every `chainHeal.stuckMs`;
 * - otherwise a node that is not synced only has an old tip: mine one block.
 * Says in the output what it found and mined; times out after `waits.timeoutMs` like any other wait.
 */
export async function syncLightningToChain(sync: LightningSync): Promise<void> {
  await new LightningCatchUp(sync).run();
}

interface NodeState {
  node: SyncingLnd;
  info: LndSyncInfo;
}

/** One catch-up run; holds what it mined so far. */
class LightningCatchUp {
  private address: string | undefined;
  private minedTotal = 0;
  private lastBatch = CATCH_UP_BLOCKS;
  private minedInBatches = 0;
  private nextLogReadAt = 0;
  private batchesSpentReported = false;

  constructor(private readonly sync: LightningSync) {}

  async run(): Promise<void> {
    const unsynced = (await this.nodeStates()).filter(({ info }) => !info.synced_to_chain).map(({ node }) => node);
    if (unsynced.length > 0) await this.firstCatchUp(unsynced);
    this.scheduleLogRead();
    const description = `${this.sync.nodes.map((node) => node.service).join(" and ")} to sync to the chain tip`;
    const height = await waitFor(description, () => this.syncedHeight(), waitOptions(this.sync, true));
    if (this.minedTotal > 0) this.sync.logger.info(`LND synced at height ${height} after mining ${blocksText(this.minedTotal)}`);
  }

  private nodeStates(): Promise<NodeState[]> {
    return Promise.all(this.sync.nodes.map(async (node) => ({ node, info: await node.info() })));
  }

  private async firstCatchUp(unsynced: readonly SyncingLnd[]): Promise<void> {
    const plan = planCatchUp(await this.checkChain(unsynced));
    this.sync.logger.info(describeCatchUp(plan));
    await this.mine(plan.blocks);
  }

  private async checkChain(unsynced: readonly SyncingLnd[]): Promise<ChainCheck> {
    const { bitcoin } = this.sync;
    const [recorded, height, walletAhead] = await Promise.all([bitcoin.recordedTip(), bitcoin.blockCount(), this.walletAheadServices(unsynced)]);
    const hashAtRecordedHeight = recorded ? await bitcoin.blockHash(recorded.height) : null;
    return { recorded, height, hashAtRecordedHeight, unsynced: unsynced.map((node) => node.service), walletAhead };
  }

  /** bitcoind's height once every node is synced to it; until then undefined, after mining more if a wallet is still ahead. */
  private async syncedHeight(): Promise<number | undefined> {
    const [height, states] = await Promise.all([this.sync.bitcoin.blockCount(), this.nodeStates()]);
    const behind = states.filter(({ info }) => !(info.synced_to_chain && info.block_height === height)).map(({ node }) => node);
    if (behind.length === 0) return height;
    if (this.sync.clock.now() >= this.nextLogReadAt) await this.mineWhileWalletAhead(behind, height);
    return undefined;
  }

  private async mineWhileWalletAhead(behind: readonly SyncingLnd[], height: number): Promise<void> {
    const services = await this.walletAheadServices(behind);
    if (services.length > 0) await this.mineNextBatch(services, height);
    this.scheduleLogRead();
  }

  private async mineNextBatch(services: readonly string[], height: number): Promise<void> {
    const { maxCatchUpBlocks } = this.sync.settings.chainHeal;
    const batch = nextCatchUpBatch(this.lastBatch, this.minedInBatches, maxCatchUpBlocks);
    if (batch === 0) {
      this.reportBatchesSpent(services, maxCatchUpBlocks);
      return;
    }
    this.sync.logger.info(`${services.join(", ")}: wallet still ahead of bitcoind at height ${height}. Mining ${blocksText(batch)} more`);
    await this.mine(batch);
    this.lastBatch = batch;
    this.minedInBatches += batch;
  }

  private reportBatchesSpent(services: readonly string[], maxCatchUpBlocks: number): void {
    if (this.batchesSpentReported) return;
    this.batchesSpentReported = true;
    this.sync.logger.info(
      `${services.join(", ")}: wallet still ahead of bitcoind after the doubling batches added ${blocksText(this.minedInBatches)} ` +
        `(DEVNET_MAX_CATCH_UP_BLOCKS=${maxCatchUpBlocks}); waiting without mining more`,
    );
  }

  private async walletAheadServices(nodes: readonly SyncingLnd[]): Promise<string[]> {
    const { logTailLines } = this.sync.settings.chainHeal;
    const verdicts = await Promise.all(nodes.map(async (node) => ({ node, ahead: walletAheadOfChain(await node.recentLog(logTailLines)) })));
    return verdicts.filter(({ ahead }) => ahead).map(({ node }) => node.service);
  }

  private scheduleLogRead(): void {
    this.nextLogReadAt = this.sync.clock.now() + this.sync.settings.chainHeal.stuckMs;
  }

  private async mine(blocks: number): Promise<void> {
    this.address ??= await this.sync.rewardAddress();
    await this.sync.bitcoin.mineTo(this.address, blocks);
    this.minedTotal += blocks;
  }
}
