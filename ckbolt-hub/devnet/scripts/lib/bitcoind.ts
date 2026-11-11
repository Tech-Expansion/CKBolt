import type { ChainTip, TipStore } from "./bitcoin-tip";
import type { DockerCompose } from "./compose";
import { BITCOIN_CLI, BITCOIN_FLUSH_ARGS, BITCOIN_HEIGHT_OUT_OF_RANGE, SERVICE } from "./devnet.constants";
import { CommandError } from "./process";

/** What `gettxoutsetinfo` prints, only the fields the devnet reads. */
interface UtxoSetInfo {
  height: number;
  bestblock: string;
}

/** The regtest bitcoind, driven with bitcoin-cli inside its container. It has no wallet: blocks pay LND addresses. */
export class BitcoinNode {
  constructor(
    private readonly compose: DockerCompose,
    private readonly tipStore: TipStore,
  ) {}

  /**
   * Mines `blocks` to `address`, makes bitcoind write them to disk at once and records the new tip. Every regtest block
   * comes from here (bootstrap, `npm run mine`, `npm run up`, the hub's e2e tests), so none is left unflushed.
   */
  async mineTo(address: string, blocks: number): Promise<void> {
    if (blocks <= 0) return;
    await this.cli(["generatetoaddress", String(blocks), address]);
    await this.tipStore.save(await this.flush());
  }

  async blockCount(): Promise<number> {
    return Number((await this.cli(["getblockcount"])).trim());
  }

  /** Hash of the active chain's block at `height`; null when the chain is shorter. */
  async blockHash(height: number): Promise<string | null> {
    try {
      return (await this.cli(["getblockhash", String(height)])).trim();
    } catch (error) {
      if (error instanceof CommandError && error.output.includes(BITCOIN_HEIGHT_OUT_OF_RANGE)) return null;
      throw error;
    }
  }

  /** The tip recorded after the scripts' last mine; null before the first one (or after `npm run reset`). */
  recordedTip(): Promise<ChainTip | null> {
    return this.tipStore.load();
  }

  /** Writes everything bitcoind holds in memory to disk and returns the tip it wrote. */
  private async flush(): Promise<ChainTip> {
    const { height, bestblock } = await this.compose.execJson<UtxoSetInfo>(SERVICE.BITCOIND, [...BITCOIN_CLI, ...BITCOIN_FLUSH_ARGS]);
    return { height, hash: bestblock };
  }

  private cli(args: readonly string[]): Promise<string> {
    return this.compose.exec(SERVICE.BITCOIND, [...BITCOIN_CLI, ...args]);
  }
}
