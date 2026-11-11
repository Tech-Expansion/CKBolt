import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { parseChainTip, type ChainTip } from "../../scripts/lib/bitcoin-tip";
import {
  CATCH_UP_BLOCKS,
  CATCH_UP_REASON,
  describeCatchUp,
  lostBlocks,
  nextCatchUpBatch,
  planCatchUp,
  walletAheadOfChain,
  type ChainCheck,
} from "../../scripts/lib/chain-heal";
import { LND_WALLET_SYNC_RETRY_SECONDS } from "../../scripts/lib/devnet.constants";
import type { Clock } from "../../scripts/lib/poll";
import { loadDevnetSettings } from "../../scripts/lib/settings";
import { syncLightningToChain, type ChainMiner, type SyncingLnd } from "../../scripts/steps/lightning-sync.step";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const RECORDED: ChainTip = { height: 177, hash: HASH_A };

const STUCK_LINE = "lnd-hub-1  | 2026-10-23 11:21:57.121 [ERR] BTWL: Unable to synchronize wallet to chain, trying again in 5s: -8: Block height out of range";
const SYNCED_LINE = "lnd-hub-1  | 2026-10-23 11:50:41.594 [INF] LTND: Chain backend is fully synced! rev=390b2d end_height=182";
const OTHER_LINE = "lnd-hub-1  | 2026-10-23 14:51:10.124 [ERR] SRVR: Unable to retrieve initial bootstrap peers: no addresses found";

describe("lostBlocks", () => {
  it("is 0 while the recorded block is still in bitcoind's chain", () => {
    assert.equal(lostBlocks(RECORDED, 177, HASH_A), 0);
    assert.equal(lostBlocks(RECORDED, 190, HASH_A), 0);
  });

  it("is the gap plus one when bitcoind came back below the recorded height", () => {
    assert.equal(lostBlocks(RECORDED, 160, null), 18);
    assert.equal(lostBlocks(RECORDED, 176, null), 2);
  });

  it("is 1 when the recorded height now holds another block", () => {
    assert.equal(lostBlocks(RECORDED, 177, HASH_B), 1);
    assert.equal(lostBlocks(RECORDED, 185, HASH_B), 1);
  });
});

describe("walletAheadOfChain", () => {
  it("is true while LND keeps logging that bitcoind has no block at its wallet's height", () => {
    assert.equal(walletAheadOfChain([SYNCED_LINE, OTHER_LINE, STUCK_LINE, STUCK_LINE].join("\n")), true);
    assert.equal(walletAheadOfChain([STUCK_LINE, OTHER_LINE].join("\r\n")), true);
  });

  it("is false once LND logged that it synced after the error", () => {
    assert.equal(walletAheadOfChain([STUCK_LINE, STUCK_LINE, SYNCED_LINE, OTHER_LINE].join("\n")), false);
  });

  it("is false for an empty log or one without the error", () => {
    assert.equal(walletAheadOfChain(""), false);
    assert.equal(walletAheadOfChain([OTHER_LINE, SYNCED_LINE].join("\n")), false);
  });

  it("ignores the same sync error with another reason (bitcoind restarting)", () => {
    const refused = "BTWL: Unable to synchronize wallet to chain, trying again in 5s: dial tcp: connection refused";
    assert.equal(walletAheadOfChain(refused), false);
  });
});

describe("planCatchUp", () => {
  const check = (overrides: Partial<ChainCheck>): ChainCheck => ({
    recorded: null,
    height: 160,
    hashAtRecordedHeight: null,
    unsynced: ["lnd-hub", "lnd-user"],
    walletAhead: [],
    ...overrides,
  });

  it("mines exactly past the recorded tip when bitcoind lost recorded blocks, whatever the logs say", () => {
    const plan = planCatchUp(check({ recorded: RECORDED, walletAhead: ["lnd-hub"] }));
    assert.deepEqual(plan, { reason: CATCH_UP_REASON.LOST_BLOCKS, blocks: 18, recorded: RECORDED, height: 160 });
  });

  it("mines one block first when a wallet is ahead of bitcoind by blocks nobody recorded", () => {
    assert.deepEqual(planCatchUp(check({ walletAhead: ["lnd-user"] })), {
      reason: CATCH_UP_REASON.WALLET_AHEAD,
      blocks: CATCH_UP_BLOCKS,
      services: ["lnd-user"],
    });
    assert.equal(planCatchUp(check({ recorded: RECORDED, height: 177, hashAtRecordedHeight: HASH_A, walletAhead: ["lnd-hub"] })).reason, CATCH_UP_REASON.WALLET_AHEAD);
  });

  it("mines one block for an old tip when nothing was lost", () => {
    assert.deepEqual(planCatchUp(check({ recorded: RECORDED, height: 177, hashAtRecordedHeight: HASH_A, unsynced: ["lnd-hub"] })), {
      reason: CATCH_UP_REASON.STALE_TIP,
      blocks: CATCH_UP_BLOCKS,
      services: ["lnd-hub"],
    });
  });
});

describe("nextCatchUpBatch", () => {
  it("doubles from the first blind block: 2, 4, 8, ...", () => {
    const batches: number[] = [];
    let last = CATCH_UP_BLOCKS;
    let mined = 0;
    for (let round = 0; round < 4; round++) {
      last = nextCatchUpBatch(last, mined, 2_016);
      mined += last;
      batches.push(last);
    }
    assert.deepEqual(batches, [2, 4, 8, 16]);
  });

  it("stops at the cap for all batches: a partial last batch, then 0", () => {
    assert.equal(nextCatchUpBatch(8, 14, 20), 6);
    assert.equal(nextCatchUpBatch(6, 20, 20), 0);
    assert.equal(nextCatchUpBatch(CATCH_UP_BLOCKS, 0, 0), 0);
  });
});

describe("describeCatchUp", () => {
  it("names both heights and the blocks mined for lost blocks", () => {
    const text = describeCatchUp({ reason: CATCH_UP_REASON.LOST_BLOCKS, blocks: 18, recorded: RECORDED, height: 160 });
    assert.match(text, /height 160, below the 177/);
    assert.match(text, /Mining 18 blocks/);
    assert.match(describeCatchUp({ reason: CATCH_UP_REASON.LOST_BLOCKS, blocks: 1, recorded: RECORDED, height: 177 }), /block 177 is not the one .* Mining 1 block /);
  });

  it("quotes LND's error for a wallet ahead and names the nodes", () => {
    const text = describeCatchUp({ reason: CATCH_UP_REASON.WALLET_AHEAD, blocks: 1, services: ["lnd-hub", "lnd-user"] });
    assert.match(text, /^lnd-hub, lnd-user: .*Unable to synchronize wallet to chain \.\.\. Block height out of range.*doubling batches/);
  });
});

describe("parseChainTip", () => {
  it("reads a recorded tip", () => {
    assert.deepEqual(parseChainTip(`{\n  "height": 177,\n  "hash": "${HASH_A}"\n}\n`), RECORDED);
  });

  it("returns null for a record cut short or malformed, instead of failing", () => {
    for (const text of ["", "{", "null", "[]", `{"height":-1,"hash":"${HASH_A}"}`, `{"height":1.5,"hash":"${HASH_A}"}`, '{"height":1,"hash":"xyz"}', `{"hash":"${HASH_A}"}`]) {
      assert.equal(parseChainTip(text), null, text);
    }
  });
});

describe("chainHeal settings", () => {
  it("reads the log after more than LND's wallet sync retry, and caps the batches at a difficulty period", () => {
    const { chainHeal } = loadDevnetSettings({});
    assert.ok(chainHeal.stuckMs > LND_WALLET_SYNC_RETRY_SECONDS * MS_PER_SECOND);
    assert.equal(chainHeal.maxCatchUpBlocks, 2_016);
    assert.ok(chainHeal.logTailLines >= 1);
  });

  it("rejects a stuck window LND's retry does not fit in, and an empty log tail", () => {
    assert.throws(() => loadDevnetSettings({ DEVNET_LND_STUCK_SECONDS: String(LND_WALLET_SYNC_RETRY_SECONDS) }), /DEVNET_LND_STUCK_SECONDS must exceed/);
    assert.throws(() => loadDevnetSettings({ DEVNET_LND_LOG_TAIL_LINES: "0" }), /DEVNET_LND_LOG_TAIL_LINES must be at least 1/);
    assert.equal(loadDevnetSettings({ DEVNET_MAX_CATCH_UP_BLOCKS: "0" }).chainHeal.maxCatchUpBlocks, 0);
  });
});

/* ------------------------------------------------------------------------------- syncLightningToChain on fakes */

/** A regtest chain and LND wallets: a wallet syncs once bitcoind's tip passes its height, and logs like LND meanwhile. */
function fakeDevnet(options: { height: number; recorded: ChainTip | null; walletHeights: Record<string, number>; hashes?: Record<number, string> }) {
  let height = options.height;
  let now = 0;
  const mined: number[] = [];
  const messages: string[] = [];
  const synced = (service: string): boolean => height > (options.walletHeights[service] ?? 0);
  const bitcoin: ChainMiner = {
    mineTo: async (_address, blocks) => {
      mined.push(blocks);
      height += blocks;
    },
    blockCount: async () => height,
    blockHash: async (at) => (at > height ? null : (options.hashes?.[at] ?? HASH_B)),
    recordedTip: async () => options.recorded,
  };
  const nodes: SyncingLnd[] = Object.keys(options.walletHeights).map((service) => ({
    service,
    info: async () => ({ synced_to_chain: synced(service), block_height: height }),
    recentLog: async () => (synced(service) ? `${STUCK_LINE}\n${SYNCED_LINE}` : `${SYNCED_LINE}\n${STUCK_LINE}`),
  }));
  const clock: Clock = { now: () => now, sleep: async (ms) => void (now += ms) };
  const settings = loadDevnetSettings({});
  const sync = { bitcoin, nodes, rewardAddress: async () => "bcrt1q", settings, clock, logger: { step: () => {}, info: (message: string) => messages.push(message) } };
  return { sync, mined, messages, height: () => height };
}

describe("syncLightningToChain", () => {
  it("mines nothing when both nodes are synced at the tip", async () => {
    const devnet = fakeDevnet({ height: 182, recorded: { height: 182, hash: HASH_B }, walletHeights: { "lnd-hub": 100, "lnd-user": 100 } });
    await syncLightningToChain(devnet.sync);
    assert.deepEqual(devnet.mined, []);
    assert.deepEqual(devnet.messages, []);
  });

  it("heals recorded lost blocks in one mine and says so", async () => {
    const devnet = fakeDevnet({ height: 160, recorded: RECORDED, walletHeights: { "lnd-hub": 177, "lnd-user": 177 } });
    await syncLightningToChain(devnet.sync);
    assert.deepEqual(devnet.mined, [18]);
    assert.match(devnet.messages[0] ?? "", /height 160, below the 177/);
    assert.equal(devnet.messages.at(-1), "LND synced at height 178 after mining 18 blocks");
  });

  it("without a record, mines one block and then doubling batches while a wallet stays ahead", async () => {
    const devnet = fakeDevnet({ height: 160, recorded: null, walletHeights: { "lnd-hub": 177, "lnd-user": 170 } });
    await syncLightningToChain(devnet.sync);
    assert.deepEqual(devnet.mined, [1, 2, 4, 8, 16]);
    assert.equal(devnet.height(), 191);
    assert.match(devnet.messages[1] ?? "", /^lnd-hub, lnd-user: wallet still ahead of bitcoind at height 161\. Mining 2 blocks more$/);
  });

  it("stops the batches at DEVNET_MAX_CATCH_UP_BLOCKS, says so once, and times out", async () => {
    const devnet = fakeDevnet({ height: 160, recorded: null, walletHeights: { "lnd-hub": 5_000 } });
    devnet.sync.settings = loadDevnetSettings({ DEVNET_MAX_CATCH_UP_BLOCKS: "10" });
    await assert.rejects(syncLightningToChain(devnet.sync), /Timed out .* waiting for lnd-hub to sync to the chain tip/);
    assert.deepEqual(devnet.mined, [1, 2, 4, 4]);
    assert.equal(devnet.messages.filter((message) => message.includes("DEVNET_MAX_CATCH_UP_BLOCKS=10")).length, 1);
  });
});
