/**
 * Independent tests of the devnet self-heal decisions (lib/chain-heal.ts), its settings and its docs (devnet/README.md):
 * after bitcoind loses blocks in an unclean Docker
 * stop, `npm run up` mines (recorded tip - current tip + 1) blocks, or, without a usable record, 1 block and then
 * doubling batches while LND logs "Unable to synchronize wallet to chain ... Block height out of range".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import type { ChainTip } from "../../scripts/lib/bitcoin-tip";
import {
  blocksText,
  CATCH_UP_BLOCKS,
  CATCH_UP_REASON,
  describeCatchUp,
  lostBlocks,
  nextCatchUpBatch,
  planCatchUp,
  walletAheadOfChain,
  type ChainCheck,
} from "../../scripts/lib/chain-heal";
import {
  BITCOIN_FLUSH_ARGS,
  BITCOIN_HEIGHT_OUT_OF_RANGE,
  DEVNET_FILE,
  LND_CHAIN_SYNCED_LOG,
  LND_WALLET_AHEAD_LOG,
  LND_WALLET_SYNC_RETRY_SECONDS,
} from "../../scripts/lib/devnet.constants";
import { resolveDevnetPaths } from "../../scripts/lib/paths";
import { loadDevnetSettings } from "../../scripts/lib/settings";

const hashOf = (n: number): string => n.toString(16).padStart(64, "0");
const tip = (height: number, hash = hashOf(height)): ChainTip => ({ height, hash });

/* Lines as `docker compose logs --no-color` prints them (container prefix, LND's timestamp and subsystem). */
const AHEAD = "lnd-hub-1  | 2026-10-23 11:21:57.121 [ERR] BTWL: Unable to synchronize wallet to chain, trying again in 5s: -8: Block height out of range";
const WAITING = "lnd-hub-1  | 2026-10-23 11:21:57.130 [INF] LTND: Waiting for chain backend to finish sync, start_height=160";
const SYNCED = "lnd-hub-1  | 2026-10-23 11:50:41.594 [INF] LTND: Chain backend is fully synced! end_height=182";
const NOISE = "lnd-hub-1  | 2026-10-23 14:51:10.124 [ERR] SRVR: Unable to retrieve initial bootstrap peers: no addresses found";
const ROLLBACK = "lnd-hub-1  | 2026-10-23 11:50:40.001 [INF] BTWL: Rolling back 1 transactions from block 6f3a... height 177";

describe("lostBlocks: recorded tip - current tip + 1", () => {
  it("matches the formula of the task for every gap, and the result always passes the recorded height", () => {
    for (let recordedHeight = 0; recordedHeight <= 40; recordedHeight++) {
      for (let height = 0; height < recordedHeight; height++) {
        const missing = lostBlocks(tip(recordedHeight), height, null);
        assert.equal(missing, recordedHeight - height + 1, `recorded ${recordedHeight}, bitcoind ${height}`);
        assert.ok(height + missing > recordedHeight, "mining that many passes the wallet's height");
      }
    }
  });

  it("replays the 2026-10-23 incident: bitcoind back at 160 below the recorded 177 needs 18 blocks", () => {
    assert.equal(lostBlocks(tip(177), 160, null), 18);
  });

  it("is 0 whenever the recorded block is still in bitcoind's chain, at the tip or below it", () => {
    for (const height of [177, 178, 500]) assert.equal(lostBlocks(tip(177), height, hashOf(177)), 0);
  });

  it("is 1 when the recorded height holds another block now (lost, then other blocks mined over it)", () => {
    for (const height of [177, 180, 1_000]) assert.equal(lostBlocks(tip(177), height, "f".repeat(64)), 1);
  });

  it("never returns 0 when the recorded block is missing, even if bitcoind answered no hash at or above its height", () => {
    assert.equal(lostBlocks(tip(177), 177, null), 1);
    assert.equal(lostBlocks(tip(177), 200, null), 1);
  });

  it("handles a record at genesis height", () => {
    assert.equal(lostBlocks(tip(0), 0, hashOf(0)), 0);
    assert.equal(lostBlocks(tip(0), 0, "e".repeat(64)), 1);
  });
});

describe("walletAheadOfChain: reading LND's log tail", () => {
  it("is true while LND keeps retrying a wallet sync bitcoind answers with -8 (the incident's log)", () => {
    const log = [SYNCED, NOISE, WAITING, AHEAD, NOISE, AHEAD, ""].join("\n");
    assert.equal(walletAheadOfChain(log), true);
  });

  it("reads Windows line endings and a trailing newline the same way", () => {
    assert.equal(walletAheadOfChain(`${NOISE}\r\n${AHEAD}\r\n`), true);
    assert.equal(walletAheadOfChain(`${AHEAD}\r\n${SYNCED}\r\n`), false);
  });

  it("is false once LND logged that its chain backend is fully synced after the error (the heal worked)", () => {
    assert.equal(walletAheadOfChain([AHEAD, AHEAD, ROLLBACK, SYNCED, NOISE].join("\n")), false);
  });

  it("goes by the latest of the two lines across container restarts: stuck again after a later restart", () => {
    assert.equal(walletAheadOfChain([AHEAD, SYNCED, NOISE, AHEAD].join("\n")), true);
  });

  it("is false for an empty tail, noise only, or a fully synced node", () => {
    assert.equal(walletAheadOfChain(""), false);
    assert.equal(walletAheadOfChain("\n\n"), false);
    assert.equal(walletAheadOfChain([NOISE, NOISE].join("\n")), false);
    assert.equal(walletAheadOfChain(SYNCED), false);
  });

  it("needs both the message and the -8 reason on one line", () => {
    const otherReason = "lnd-hub-1  | [ERR] BTWL: Unable to synchronize wallet to chain, trying again in 5s: dial tcp 172.27.0.2:18443: connect: connection refused";
    const reasonElsewhere = "lnd-hub-1  | [ERR] RPCS: getblockhash: -8: Block height out of range";
    assert.equal(walletAheadOfChain(otherReason), false);
    assert.equal(walletAheadOfChain(reasonElsewhere), false);
    assert.equal(walletAheadOfChain(`${otherReason}\n${reasonElsewhere}`), false, "split across lines is not the error");
  });

  it("matches the constants the step and the docs quote", () => {
    assert.ok(AHEAD.includes(LND_WALLET_AHEAD_LOG.MESSAGE) && AHEAD.includes(LND_WALLET_AHEAD_LOG.REASON));
    assert.equal(LND_WALLET_AHEAD_LOG.REASON, BITCOIN_HEIGHT_OUT_OF_RANGE);
    assert.ok(SYNCED.includes(LND_CHAIN_SYNCED_LOG));
  });
});

describe("planCatchUp: the first mine of `npm run up` when an LND node is not synced", () => {
  const check = (overrides: Partial<ChainCheck>): ChainCheck => ({
    recorded: null,
    height: 160,
    hashAtRecordedHeight: null,
    unsynced: ["lnd-hub", "lnd-user"],
    walletAhead: [],
    ...overrides,
  });

  it("mines the exact gap plus one when bitcoind is below the recorded tip, with or without LND's error in the log", () => {
    for (const walletAhead of [[], ["lnd-hub"], ["lnd-hub", "lnd-user"]]) {
      const plan = planCatchUp(check({ recorded: tip(177), walletAhead }));
      assert.deepEqual(plan, { reason: CATCH_UP_REASON.LOST_BLOCKS, blocks: 18, recorded: tip(177), height: 160 });
    }
  });

  it("mines 1 when the recorded height now holds another block", () => {
    const plan = planCatchUp(check({ recorded: tip(177), height: 179, hashAtRecordedHeight: "f".repeat(64) }));
    assert.equal(plan.reason, CATCH_UP_REASON.LOST_BLOCKS);
    assert.equal(plan.blocks, 1);
  });

  it("falls back to LND's log when there is no record: one blind block for the nodes whose wallet is ahead", () => {
    assert.deepEqual(planCatchUp(check({ walletAhead: ["lnd-user"] })), {
      reason: CATCH_UP_REASON.WALLET_AHEAD,
      blocks: CATCH_UP_BLOCKS,
      services: ["lnd-user"],
    });
  });

  it("falls back to the log when the record is intact (blocks lost were mined by hand, after the record)", () => {
    const plan = planCatchUp(check({ recorded: tip(160), hashAtRecordedHeight: hashOf(160), walletAhead: ["lnd-hub"] }));
    assert.equal(plan.reason, CATCH_UP_REASON.WALLET_AHEAD);
    assert.equal(plan.blocks, 1);
  });

  it("mines one block for an old tip, naming only the nodes that are not synced", () => {
    const plan = planCatchUp(check({ recorded: tip(160), hashAtRecordedHeight: hashOf(160), unsynced: ["lnd-user"] }));
    assert.deepEqual(plan, { reason: CATCH_UP_REASON.STALE_TIP, blocks: CATCH_UP_BLOCKS, services: ["lnd-user"] });
  });

  it("never plans to mine nothing", () => {
    const cases: Partial<ChainCheck>[] = [{}, { recorded: tip(160), hashAtRecordedHeight: hashOf(160) }, { walletAhead: ["lnd-hub"] }, { recorded: tip(177) }];
    for (const overrides of cases) assert.ok(planCatchUp(check(overrides)).blocks >= 1, JSON.stringify(overrides));
  });

  it("starts the blind catch-up with one block, as `npm run up` did before", () => {
    assert.equal(CATCH_UP_BLOCKS, 1);
  });
});

describe("nextCatchUpBatch: doubling batches under DEVNET_MAX_CATCH_UP_BLOCKS", () => {
  /** Every batch a wallet that never catches up would get, from the first blind block. */
  function allBatches(maxBlocks: number): number[] {
    const batches: number[] = [];
    let last = CATCH_UP_BLOCKS;
    let mined = 0;
    for (let round = 0; round < 64; round++) {
      const batch = nextCatchUpBatch(last, mined, maxBlocks);
      if (batch === 0) return batches;
      batches.push(batch);
      last = batch;
      mined += batch;
    }
    throw new Error(`batches never stop for a cap of ${maxBlocks}`);
  }

  it("doubles 2, 4, 8, ... from the first blind block", () => {
    assert.deepEqual(allBatches(2_016).slice(0, 6), [2, 4, 8, 16, 32, 64]);
  });

  it("adds exactly the cap in all, never more, and then stops, for every cap", () => {
    for (let cap = 0; cap <= 300; cap++) {
      const batches = allBatches(cap);
      assert.equal(batches.reduce((sum, batch) => sum + batch, 0), cap, `cap ${cap}`);
      assert.ok(batches.every((batch) => batch > 0));
    }
  });

  it("with the default cap of 2016, ends with a partial batch after ten rounds", () => {
    const batches = allBatches(2_016);
    assert.deepEqual(batches, [2, 4, 8, 16, 32, 64, 128, 256, 512, 994]);
  });

  it("heals the incident's 17-block gap blind in five mines (1 + 2 + 4 + 8 + 16), overshooting by less than the gap", () => {
    const gap = 17;
    let mined = CATCH_UP_BLOCKS;
    let rounds = 1;
    for (const batch of allBatches(2_016)) {
      if (mined > gap) break;
      mined += batch;
      rounds++;
    }
    assert.equal(rounds, 5);
    assert.ok(mined - gap < gap);
  });

  it("is 0 when the cap is off (0) or already spent, and never negative", () => {
    assert.equal(nextCatchUpBatch(CATCH_UP_BLOCKS, 0, 0), 0);
    assert.equal(nextCatchUpBatch(64, 100, 100), 0);
    assert.equal(nextCatchUpBatch(64, 150, 100), 0);
  });
});

describe("describeCatchUp and blocksText: what `npm run up` prints", () => {
  it("counts blocks in plain English", () => {
    assert.equal(blocksText(1), "1 block");
    assert.equal(blocksText(0), "0 blocks");
    assert.equal(blocksText(18), "18 blocks");
  });

  it("says why blocks were lost, both heights and how many it mines", () => {
    const text = describeCatchUp({ reason: CATCH_UP_REASON.LOST_BLOCKS, blocks: 18, recorded: tip(177), height: 160 });
    assert.match(text, /^bitcoind is at height 160, below the 177 /);
    assert.match(text, /unclean Docker stop/);
    assert.match(text, /Mining 18 blocks so LND rolls back to the fork and syncs$/);
  });

  it("explains a replaced block at the recorded height", () => {
    const text = describeCatchUp({ reason: CATCH_UP_REASON.LOST_BLOCKS, blocks: 1, recorded: tip(177), height: 180 });
    assert.match(text, /block 177 is not the one the devnet scripts mined/);
    assert.match(text, /Mining 1 block so/);
  });

  it("quotes LND's error for a wallet ahead, names the nodes and announces the doubling batches", () => {
    const text = describeCatchUp({ reason: CATCH_UP_REASON.WALLET_AHEAD, blocks: 1, services: ["lnd-user"] });
    assert.ok(text.startsWith("lnd-user: "));
    assert.ok(text.includes(`"${LND_WALLET_AHEAD_LOG.MESSAGE} ... ${LND_WALLET_AHEAD_LOG.REASON}"`));
    assert.match(text, /Mining 1 block, then more in doubling batches until LND syncs$/);
  });

  it("calls an unsynced node with nothing lost an old tip", () => {
    const text = describeCatchUp({ reason: CATCH_UP_REASON.STALE_TIP, blocks: 1, services: ["lnd-hub", "lnd-user"] });
    assert.match(text, /^lnd-hub, lnd-user: not synced, the chain tip is old/);
    assert.match(text, /Mining 1 block /);
  });
});

describe("chain-heal facts and settings", () => {
  it("flushes bitcoind with `gettxoutsetinfo none` (research section 6.3)", () => {
    assert.deepEqual([...BITCOIN_FLUSH_ARGS], ["gettxoutsetinfo", "none"]);
  });

  it("keeps the recorded tip in state/bitcoin-tip.json, inside state/ so `npm run reset` deletes it and git ignores it", () => {
    assert.equal(DEVNET_FILE.BITCOIN_TIP, "state/bitcoin-tip.json");
    assert.ok(DEVNET_FILE.BITCOIN_TIP.startsWith(`${DEVNET_FILE.STATE_DIR}/`));
    const paths = resolveDevnetPaths("C:\\work\\devnet");
    assert.equal(paths.bitcoinTipFile, join("C:\\work\\devnet", "state", "bitcoin-tip.json"));
  });

  it("defaults to a 15 s stuck window, 200 log lines and a 2016-block cap", () => {
    const { chainHeal } = loadDevnetSettings({});
    assert.deepEqual(chainHeal, { stuckMs: 15 * MS_PER_SECOND, logTailLines: 200, maxCatchUpBlocks: 2_016 });
  });

  it("reads the overrides in their units (seconds become ms)", () => {
    const { chainHeal } = loadDevnetSettings({ DEVNET_LND_STUCK_SECONDS: "30", DEVNET_LND_LOG_TAIL_LINES: "1", DEVNET_MAX_CATCH_UP_BLOCKS: "64" });
    assert.deepEqual(chainHeal, { stuckMs: 30 * MS_PER_SECOND, logTailLines: 1, maxCatchUpBlocks: 64 });
  });

  it("accepts the smallest stuck window above LND's 5 s retry and rejects LND's retry or less", () => {
    assert.equal(LND_WALLET_SYNC_RETRY_SECONDS, 5);
    const smallest = String(LND_WALLET_SYNC_RETRY_SECONDS + 1);
    assert.equal(loadDevnetSettings({ DEVNET_LND_STUCK_SECONDS: smallest }).chainHeal.stuckMs, (LND_WALLET_SYNC_RETRY_SECONDS + 1) * MS_PER_SECOND);
    for (const seconds of ["0", "1", String(LND_WALLET_SYNC_RETRY_SECONDS)]) {
      assert.throws(() => loadDevnetSettings({ DEVNET_LND_STUCK_SECONDS: seconds }), /DEVNET_LND_STUCK_SECONDS must exceed 5/);
    }
  });

  it("rejects malformed values with the variable's name instead of using the default", () => {
    for (const name of ["DEVNET_LND_STUCK_SECONDS", "DEVNET_LND_LOG_TAIL_LINES", "DEVNET_MAX_CATCH_UP_BLOCKS"]) {
      for (const value of ["-1", "1.5", "abc", "0x10"]) {
        assert.throws(() => loadDevnetSettings({ [name]: value }), new RegExp(`${name}=`), `${name}=${value}`);
      }
    }
    assert.throws(() => loadDevnetSettings({ DEVNET_LND_LOG_TAIL_LINES: "0" }), /DEVNET_LND_LOG_TAIL_LINES must be at least 1/);
  });

  it("lets the batches be turned off with 0", () => {
    assert.equal(loadDevnetSettings({ DEVNET_MAX_CATCH_UP_BLOCKS: "0" }).chainHeal.maxCatchUpBlocks, 0);
  });
});

describe("README.md: the self-heal is documented", () => {
  const devnetDir = resolveDevnetPaths().devnetDir;
  const readme = readFileSync(join(devnetDir, "README.md"), "utf8");
  const troubleshooting = readme.slice(readme.indexOf("## Troubleshooting"));

  it("has a Troubleshooting entry quoting LND's error and pointing to `npm run up`", () => {
    assert.ok(readme.includes("## Troubleshooting"));
    assert.ok(troubleshooting.includes(LND_WALLET_AHEAD_LOG.MESSAGE), "the LND log message");
    assert.ok(troubleshooting.includes(LND_WALLET_AHEAD_LOG.REASON), "bitcoind's -8 reason");
    assert.ok(troubleshooting.includes("npm run up"));
    assert.ok(troubleshooting.includes(DEVNET_FILE.BITCOIN_TIP));
    assert.match(troubleshooting, /npm run mine -- <n>/, "the manual fix");
    assert.match(troubleshooting, /npm run stop/, "how to avoid it");
  });

  it("names every chain-heal tunable with the default the settings use", () => {
    const { chainHeal } = loadDevnetSettings({});
    const defaults: Record<string, number> = {
      DEVNET_LND_STUCK_SECONDS: chainHeal.stuckMs / MS_PER_SECOND,
      DEVNET_LND_LOG_TAIL_LINES: chainHeal.logTailLines,
      DEVNET_MAX_CATCH_UP_BLOCKS: chainHeal.maxCatchUpBlocks,
    };
    for (const [name, value] of Object.entries(defaults)) {
      const documented = new RegExp(`\`${name}\`\\s*\\((\\d+)`).exec(readme);
      assert.ok(documented, `README does not give the default of ${name}`);
      assert.equal(Number(documented[1]), value, `README default of ${name}`);
    }
  });

  it("lists state/bitcoin-tip.json among the generated files", () => {
    assert.match(readme, /\|\s*`state\/bitcoin-tip\.json`\s*\|/);
  });
});
