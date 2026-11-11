import { blocksText } from "./lib/chain-heal";
import { createDevnetContext } from "./lib/context";
import { readCount } from "./lib/env";
import { runMain } from "./lib/main";

const DEFAULT_BLOCKS = 1;

/**
 * Mines regtest blocks to lnd-hub: `npm run mine -- <count>`. Use it after a long pause (LND reports itself unsynced
 * when the tip is old) or to move block heights forward in a test. bitcoind writes the blocks to disk at once and the
 * new tip is recorded in state/bitcoin-tip.json. CKB blocks come from the ckb-miner service.
 */
async function mine(): Promise<void> {
  const ctx = createDevnetContext();
  const blocks = readCount({ blocks: process.argv[2] }, "blocks", DEFAULT_BLOCKS);
  await ctx.bitcoin.mineTo(await ctx.lnd.hub.newAddress(), blocks);
  ctx.logger.info(`mined ${blocksText(blocks)}; height ${await ctx.bitcoin.blockCount()}`);
}

runMain("mine", mine);
