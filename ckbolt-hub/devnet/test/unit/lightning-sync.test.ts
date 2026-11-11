/**
 * Independent tests of the "heal" half of the devnet self-heal (research section 6.3, step 2): `ensureLightningSynced`
 * (what `npm run up` and the hub's e2e setup call) on a simulated devnet. The real BitcoinNode, LndNode, DockerCompose
 * and FileTipStore run against a fake `docker` that behaves like regtest bitcoind and LND did in the 2026-10-23
 * incident:
 * - bitcoind keeps blocks in memory until a flush (`gettxoutsetinfo`); an unclean stop loses every unflushed block;
 * - an LND wallet synced above bitcoind's tip is not synced, logs "Unable to synchronize wallet to chain ... -8: Block
 *   height out of range" on every retry, and recovers (rolls back, logs "Chain backend is fully synced") once the tip
 *   reaches its height; `getinfo.block_height` is bitcoind's tip, not the wallet's;
 * - an LND node with an old tip is not synced until a new block arrives.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { FileTipStore, parseChainTip, type ChainTip } from "../../scripts/lib/bitcoin-tip";
import { BitcoinNode } from "../../scripts/lib/bitcoind";
import { DockerCompose } from "../../scripts/lib/compose";
import type { DevnetContext } from "../../scripts/lib/context";
import { BITCOIN_CLI, LNCLI, SERVICE } from "../../scripts/lib/devnet.constants";
import type { Env } from "../../scripts/lib/env";
import { LndNode } from "../../scripts/lib/lnd";
import { resolveDevnetPaths } from "../../scripts/lib/paths";
import type { Clock } from "../../scripts/lib/poll";
import { CommandError, type CommandResult, type CommandRunner } from "../../scripts/lib/process";
import { loadDevnetSettings } from "../../scripts/lib/settings";
import { ensureLightningSynced } from "../../scripts/steps/connectivity.step";
import { syncLightningToChain, type ChainMiner, type SyncingLnd } from "../../scripts/steps/lightning-sync.step";

/* ------------------------------------------------------------------------------------------- simulated devnet */

const LND_SERVICES = [SERVICE.LND_HUB, SERVICE.LND_USER] as const;
type LndService = (typeof LND_SERVICES)[number];

const STAMP = "2026-10-23 11:21:57.121";
const logLine = (service: string, text: string): string => `${service}-1  | ${STAMP} ${text}`;
const aheadLine = (service: string) => logLine(service, "[ERR] BTWL: Unable to synchronize wallet to chain, trying again in 5s: -8: Block height out of range");
const syncedLine = (service: string, height: number) => logLine(service, `[INF] LTND: Chain backend is fully synced! rev=390b2d end_height=${height}`);
const noiseLine = (service: string) => logLine(service, "[ERR] SRVR: Unable to retrieve initial bootstrap peers: no addresses found");
/** A line a privacy check looks for in the output: raw log text must never be printed. */
const PRIVATE_LOG_TEXT = "macaroon=0201036c6e6402f801030a10";

interface SimLnd {
  /** Height the wallet synced to. */
  walletHeight: number;
  synced: boolean;
  /** Not synced only because the tip is old; any new block clears it. */
  staleTip: boolean;
  stuck: boolean;
  log: string[];
  newAddresses: number;
}

interface Mine {
  at: number;
  blocks: number;
  address: string;
  byScripts: boolean;
}

interface SimOptions {
  /** bitcoind's height when the run starts. */
  height: number;
  /** Heights the LND wallets synced to (above `height` = ahead of the chain after lost blocks). */
  walletHeights?: Partial<Record<LndService, number>>;
  staleTip?: boolean;
  /** state/bitcoin-tip.json before the run: a tip, raw file text, or nothing. */
  record?: ChainTip | string | null;
  env?: Env;
}

/** Regtest bitcoind, two LND nodes and `docker compose`, behind one CommandRunner. */
class SimDevnet {
  chain: string[] = [];
  flushedHeight = 0;
  now = 0;
  readonly mines: Mine[] = [];
  readonly bitcoinRpcs: string[] = [];
  readonly logReads: { service: string; lines: number }[] = [];
  readonly output: string[] = [];
  /** Throws once for a matching command key ("logs lnd-hub", "lncli getinfo lnd-user", "generatetoaddress", ...). */
  readonly failOnce = new Map<string, Error>();
  readonly lnd: Record<LndService, SimLnd>;
  private blockSeq = 0;

  constructor(height: number, walletHeights: Partial<Record<LndService, number>>, staleTip: boolean) {
    this.chain = [this.newHash()];
    this.appendBlocks(height);
    this.flushedHeight = height;
    const node = (service: LndService): SimLnd => ({
      walletHeight: walletHeights[service] ?? height,
      synced: true,
      staleTip,
      stuck: false,
      log: [syncedLine(service, height), noiseLine(service)],
      newAddresses: 0,
    });
    this.lnd = { [SERVICE.LND_HUB]: node(SERVICE.LND_HUB), [SERVICE.LND_USER]: node(SERVICE.LND_USER) } as Record<LndService, SimLnd>;
  }

  get height(): number {
    return this.chain.length - 1;
  }

  get tip(): ChainTip {
    return { height: this.height, hash: this.chain[this.height] as string };
  }

  readonly clock: Clock = { now: () => this.now, sleep: async (ms) => void (this.now += ms) };

  /** Blocks mined outside the scripts (`bitcoin-cli generatetoaddress` by hand): not flushed, not recorded. */
  mineByHand(blocks: number): void {
    this.mine(blocks, "bcrt1-by-hand", false);
  }

  /** Docker Desktop's VM killed: bitcoind restarts with what it wrote to disk; LND wallets keep their heights. */
  uncleanStop(): void {
    this.chain = this.chain.slice(0, this.flushedHeight + 1);
  }

  readonly runner: CommandRunner = async (command, args): Promise<CommandResult> => {
    assert.equal(command, "docker");
    assert.equal(args[0], "compose");
    const [verb] = args.slice(1);
    if (verb === "logs") return this.logs(args);
    if (verb === "exec") return { stdout: this.exec(args), stderr: "" };
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };

  private logs(args: readonly string[]): CommandResult {
    // compose logs --no-color --tail N <service>
    assert.deepEqual(args.slice(1, 4), ["logs", "--no-color", "--tail"]);
    const lines = Number(args[4]);
    const service = args[5] as LndService;
    this.throwIfFailing(`logs ${service}`);
    this.logReads.push({ service, lines });
    this.refresh(service);
    return { stdout: `${this.lnd[service].log.slice(-lines).join("\n")}\n`, stderr: "" };
  }

  private exec(args: readonly string[]): string {
    assert.deepEqual(args.slice(1, 3), ["exec", "-T"]);
    const service = args[3];
    const rest = args.slice(4);
    if (service === SERVICE.BITCOIND) {
      assert.deepEqual(rest.slice(0, BITCOIN_CLI.length), [...BITCOIN_CLI]);
      return this.bitcoinCli(rest.slice(BITCOIN_CLI.length), args);
    }
    assert.deepEqual(rest.slice(0, LNCLI.length), [...LNCLI]);
    return this.lncli(service as LndService, rest.slice(LNCLI.length));
  }

  private bitcoinCli(rpc: readonly string[], args: readonly string[]): string {
    const [method, ...params] = rpc;
    this.bitcoinRpcs.push(rpc.join(" "));
    this.throwIfFailing(method ?? "");
    switch (method) {
      case "getblockcount":
        return `${this.height}\n`;
      case "getblockhash": {
        const at = Number(params[0]);
        if (at > this.height) throw new CommandError("docker", args, 8, "error code: -8\nerror message:\nBlock height out of range\nexit status 8\n");
        return `${this.chain[at]}\n`;
      }
      case "generatetoaddress":
        return JSON.stringify(this.mine(Number(params[0]), params[1] as string, true));
      case "gettxoutsetinfo":
        assert.deepEqual(params, ["none"]);
        this.flushedHeight = this.height;
        return JSON.stringify({ height: this.height, bestblock: this.chain[this.height], txouts: this.height + 2, total_amount: 1 });
      default:
        throw new Error(`unexpected bitcoin-cli ${rpc.join(" ")}`);
    }
  }

  private lncli(service: LndService, rpc: readonly string[]): string {
    const node = this.lnd[service];
    this.throwIfFailing(`lncli ${rpc[0]} ${service}`);
    if (rpc[0] === "getinfo") {
      this.refresh(service);
      return JSON.stringify({ identity_pubkey: `02${service}`, synced_to_chain: node.synced, block_height: this.height, synced_to_graph: true });
    }
    if (rpc[0] === "newaddress") {
      node.newAddresses++;
      return JSON.stringify({ address: `bcrt1p-${service}-${node.newAddresses}` });
    }
    throw new Error(`unexpected lncli ${rpc.join(" ")}`);
  }

  /** LND's wallet sync loop, run whenever the node is asked something (it retries every 5 s in reality). */
  private refresh(service: LndService): void {
    const node = this.lnd[service];
    if (node.walletHeight > this.height) {
      node.synced = false;
      node.stuck = true;
      node.log.push(aheadLine(service), `${PRIVATE_LOG_TEXT} ${noiseLine(service)}`);
      return;
    }
    if (node.staleTip) {
      node.synced = false;
      return;
    }
    if (node.stuck) {
      node.log.push(logLine(service, `[INF] BTWL: Rolling back 1 transactions from block ... height ${node.walletHeight}`), syncedLine(service, this.height));
      node.stuck = false;
    }
    node.walletHeight = this.height;
    node.synced = true;
  }

  private mine(blocks: number, address: string, byScripts: boolean): string[] {
    this.mines.push({ at: this.now, blocks, address, byScripts });
    for (const node of Object.values(this.lnd)) node.staleTip = false;
    return this.appendBlocks(blocks);
  }

  private appendBlocks(blocks: number): string[] {
    const added = Array.from({ length: blocks }, () => this.newHash());
    this.chain.push(...added);
    return added;
  }

  private newHash(): string {
    return createHash("sha256").update(`block ${this.blockSeq++}`).digest("hex");
  }

  private throwIfFailing(key: string): void {
    const failure = this.failOnce.get(key);
    if (failure === undefined) return;
    this.failOnce.delete(key);
    throw failure;
  }
}

interface Harness {
  sim: SimDevnet;
  ctx: DevnetContext;
  tipFile: string;
  readTip(): Promise<ChainTip | null>;
}

async function withSimDevnet(options: SimOptions, run: (harness: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "devnet-heal-"));
  try {
    const sim = new SimDevnet(options.height, options.walletHeights ?? {}, options.staleTip ?? false);
    const paths = resolveDevnetPaths(dir);
    if (options.record !== undefined && options.record !== null) {
      await mkdir(dirname(paths.bitcoinTipFile), { recursive: true });
      const text = typeof options.record === "string" ? options.record : JSON.stringify(options.record);
      await writeFile(paths.bitcoinTipFile, text, "utf8");
    }
    const compose = new DockerCompose(dir, sim.runner);
    const ctx: DevnetContext = {
      settings: loadDevnetSettings(options.env ?? {}),
      paths,
      logger: { step: (title) => sim.output.push(`==> ${title}`), info: (message) => sim.output.push(message) },
      clock: sim.clock,
      compose,
      bitcoin: new BitcoinNode(compose, new FileTipStore(paths.bitcoinTipFile)),
      lnd: { hub: new LndNode(SERVICE.LND_HUB, compose), user: new LndNode(SERVICE.LND_USER, compose) },
    };
    const readTip = async () => {
      const text = await readFile(paths.bitcoinTipFile, "utf8").catch(() => undefined);
      return text === undefined ? null : parseChainTip(text);
    };
    await run({ sim, ctx, tipFile: paths.bitcoinTipFile, readTip });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const minedBlocks = (sim: SimDevnet): number[] => sim.mines.filter((mine) => mine.byScripts).map((mine) => mine.blocks);
const bothSynced = (sim: SimDevnet): boolean => LND_SERVICES.every((service) => sim.lnd[service].synced && sim.lnd[service].walletHeight === sim.height);
/** The 2026-10-23 incident: wallets synced to 177, bitcoind back at 160 (161 to 177 lost). */
const INCIDENT = { height: 160, walletHeights: { [SERVICE.LND_HUB]: 177, [SERVICE.LND_USER]: 177 } };

/* ---------------------------------------------------------------------------------------------------- prevent */

describe("prevent: blocks the scripts mine survive an unclean stop", () => {
  it("bitcoind keeps every block mined through BitcoinNode.mineTo, and the record is the live tip", async () => {
    await withSimDevnet({ height: 160 }, async ({ sim, ctx, readTip }) => {
      await ctx.bitcoin.mineTo(await ctx.lnd.hub.newAddress(), 17);
      assert.equal(sim.flushedHeight, 177);
      assert.deepEqual(await readTip(), sim.tip);
      sim.uncleanStop();
      assert.equal(sim.height, 177, "nothing was lost");
      await ensureLightningSynced(ctx);
      assert.deepEqual(minedBlocks(sim), [17], "no catch-up needed after the stop");
      assert.deepEqual(sim.output, []);
    });
  });

  it("the model loses unflushed blocks, as Bitcoin Core does (sanity check of the simulation)", async () => {
    await withSimDevnet({ height: 160 }, async ({ sim }) => {
      sim.mineByHand(17);
      sim.uncleanStop();
      assert.equal(sim.height, 160);
    });
  });
});

/* --------------------------------------------------------------------------------------------------------- heal */

describe("heal with a record: bitcoind below the recorded tip", () => {
  it("mines exactly recorded - current + 1 blocks to lnd-hub in one mine, and both LND nodes sync", async () => {
    await withSimDevnet({ ...INCIDENT, record: null }, async ({ sim, ctx, readTip }) => {
      // The record the scripts wrote at 177, before the blocks above 160 were lost.
      const lostTip: ChainTip = { height: 177, hash: "c".repeat(64) };
      await new FileTipStore(ctx.paths.bitcoinTipFile).save(lostTip);
      await ensureLightningSynced(ctx);
      assert.deepEqual(minedBlocks(sim), [18]);
      assert.equal(sim.height, 178);
      assert.ok(bothSynced(sim));
      assert.equal(sim.mines[0]?.address, "bcrt1p-lnd-hub-1", "coinbases go to lnd-hub");
      assert.equal(sim.lnd[SERVICE.LND_USER].newAddresses, 0);
      assert.deepEqual(await readTip(), sim.tip, "the heal's own mine is flushed and recorded");
      assert.equal(sim.flushedHeight, sim.height);
    });
  });

  it("says what it found and mined, then that LND synced", async () => {
    await withSimDevnet({ ...INCIDENT, record: { height: 177, hash: "c".repeat(64) } }, async ({ sim, ctx }) => {
      await ensureLightningSynced(ctx);
      assert.equal(sim.output.length, 2, sim.output.join("\n"));
      assert.match(sim.output[0] ?? "", /^bitcoind is at height 160, below the 177 .*unclean Docker stop.*Mining 18 blocks so LND rolls back to the fork and syncs$/);
      assert.equal(sim.output[1], "LND synced at height 178 after mining 18 blocks");
    });
  });

  it("mines 1 when the recorded height holds another block now (nothing above it was recorded)", async () => {
    await withSimDevnet({ height: 177, walletHeights: { [SERVICE.LND_HUB]: 177 }, staleTip: true, record: { height: 177, hash: "c".repeat(64) } }, async ({ sim, ctx }) => {
      await ensureLightningSynced(ctx);
      assert.deepEqual(minedBlocks(sim), [1]);
      assert.match(sim.output[0] ?? "", /block 177 is not the one the devnet scripts mined.*Mining 1 block /);
    });
  });

  it("goes on with doubling batches when a wallet was even further ahead than the record (blocks mined by hand after it)", async () => {
    await withSimDevnet({ height: 160, walletHeights: { [SERVICE.LND_HUB]: 190, [SERVICE.LND_USER]: 177 }, record: { height: 177, hash: "c".repeat(64) } }, async ({ sim, ctx }) => {
      await ensureLightningSynced(ctx);
      assert.deepEqual(minedBlocks(sim), [18, 2, 4, 8]);
      assert.ok(bothSynced(sim));
      assert.match(sim.output[1] ?? "", /^lnd-hub: wallet still ahead of bitcoind at height 178\. Mining 2 blocks more$/);
      assert.equal(sim.output.at(-1), "LND synced at height 192 after mining 32 blocks");
    });
  });
});

describe("heal without a usable record: LND's log says its wallet is ahead", () => {
  it("replays the incident with no record: 1 block, then 2, 4, 8, 16 every DEVNET_LND_STUCK_SECONDS until both sync", async () => {
    await withSimDevnet({ ...INCIDENT, record: null }, async ({ sim, ctx, readTip }) => {
      await ensureLightningSynced(ctx);
      assert.deepEqual(minedBlocks(sim), [1, 2, 4, 8, 16]);
      assert.ok(bothSynced(sim));
      assert.match(sim.output[0] ?? "", /^lnd-hub, lnd-user: LND logs "Unable to synchronize wallet to chain \.\.\. Block height out of range"/);
      assert.deepEqual(
        sim.output.slice(1, -1),
        [161, 163, 167, 175].map((height, round) => `lnd-hub, lnd-user: wallet still ahead of bitcoind at height ${height}. Mining ${2 ** (round + 1)} blocks more`),
      );
      assert.equal(sim.output.at(-1), "LND synced at height 191 after mining 31 blocks");
      assert.deepEqual(await readTip(), sim.tip, "the recorded tip is created by the heal");
      assert.ok(sim.mines.every((mine) => mine.address === "bcrt1p-lnd-hub-1"), "every coinbase goes to one lnd-hub address");
      assert.equal(sim.lnd[SERVICE.LND_HUB].newAddresses, 1);
      assert.equal(sim.lnd[SERVICE.LND_USER].newAddresses, 0);
    });
  });

  it("waits DEVNET_LND_STUCK_SECONDS between batches, so LND sees each one before more are mined", async () => {
    await withSimDevnet({ ...INCIDENT, record: null }, async ({ sim, ctx }) => {
      await ensureLightningSynced(ctx);
      const times = sim.mines.map((mine) => mine.at);
      for (let i = 1; i < times.length; i++) {
        assert.ok((times[i] as number) - (times[i - 1] as number) >= ctx.settings.chainHeal.stuckMs, `mines at ${times.join(", ")}`);
      }
    });
  });

  it("heals the incident's 17-block gap within the default wait timeout, in about a minute", async () => {
    await withSimDevnet({ ...INCIDENT, record: null }, async ({ sim, ctx }) => {
      await ensureLightningSynced(ctx);
      assert.ok(sim.now < ctx.settings.waits.timeoutMs, `took ${sim.now} ms`);
      assert.ok(sim.now <= 90 * MS_PER_SECOND, `took ${sim.now} ms`);
    });
  });

  it("uses a shorter stuck window when DEVNET_LND_STUCK_SECONDS says so", async () => {
    await withSimDevnet({ ...INCIDENT, record: null, env: { DEVNET_LND_STUCK_SECONDS: "6" } }, async ({ sim, ctx }) => {
      await ensureLightningSynced(ctx);
      const gaps = sim.mines.slice(1).map((mine, i) => mine.at - (sim.mines[i] as Mine).at);
      assert.ok(gaps.every((gap) => gap >= 6 * MS_PER_SECOND && gap < 15 * MS_PER_SECOND), gaps.join(", "));
    });
  });

  it("treats a record a crash cut short like no record: the log fallback heals, `up` does not fail", async () => {
    await withSimDevnet({ ...INCIDENT, record: '{\n  "height": 17' }, async ({ sim, ctx, readTip }) => {
      await ensureLightningSynced(ctx);
      assert.deepEqual(minedBlocks(sim), [1, 2, 4, 8, 16]);
      assert.deepEqual(await readTip(), sim.tip, "the damaged record is replaced");
    });
  });

  it("uses the log when the record is intact but blocks mined by hand after it were lost", async () => {
    await withSimDevnet({ height: 160 }, async ({ sim, ctx }) => {
      await new FileTipStore(ctx.paths.bitcoinTipFile).save(sim.tip); // the scripts' last mine ended at 160
      sim.mineByHand(17);
      await ensureLightningSynced(ctx); // LND follows the hand-mined blocks to 177
      sim.uncleanStop();
      sim.mines.length = 0;
      await ensureLightningSynced(ctx);
      assert.equal(sim.height >= 177, true);
      assert.deepEqual(minedBlocks(sim), [1, 2, 4, 8, 16]);
      assert.ok(bothSynced(sim));
    });
  });

  it("names only the node whose wallet is ahead; the other syncs from the first block", async () => {
    await withSimDevnet({ height: 160, walletHeights: { [SERVICE.LND_USER]: 170 }, staleTip: false }, async ({ sim, ctx }) => {
      await ensureLightningSynced(ctx);
      assert.match(sim.output[0] ?? "", /^lnd-user: LND logs/);
      assert.ok(sim.output.slice(1, -1).every((line) => line.startsWith("lnd-user: wallet still ahead")), sim.output.join("\n"));
      assert.deepEqual(minedBlocks(sim), [1, 2, 4, 8]);
    });
  });
});

describe("no heal needed", () => {
  it("mines nothing, prints nothing, reads no log and asks no address when both nodes are synced", async () => {
    await withSimDevnet({ height: 183, record: null }, async ({ sim, ctx, readTip }) => {
      await ensureLightningSynced(ctx);
      assert.deepEqual(sim.mines, []);
      assert.deepEqual(sim.output, []);
      assert.deepEqual(sim.logReads, []);
      assert.equal(sim.lnd[SERVICE.LND_HUB].newAddresses + sim.lnd[SERVICE.LND_USER].newAddresses, 0);
      assert.equal(await readTip(), null, "no mine, no record");
      assert.ok(!sim.bitcoinRpcs.some((rpc) => rpc.startsWith("getblockhash")), "the record is not even checked");
    });
  });

  it("mines one block for an old tip and says so, without doubling batches", async () => {
    await withSimDevnet({ height: 183, staleTip: true, record: null }, async ({ sim, ctx, readTip }) => {
      await ensureLightningSynced(ctx);
      assert.deepEqual(minedBlocks(sim), [1]);
      assert.match(sim.output[0] ?? "", /^lnd-hub, lnd-user: not synced, the chain tip is old after a pause\. Mining 1 block /);
      assert.equal(sim.output.at(-1), "LND synced at height 184 after mining 1 block");
      assert.deepEqual(await readTip(), sim.tip);
    });
  });

  it("an old tip with an intact record is still a stale tip, not lost blocks", async () => {
    await withSimDevnet({ height: 183, staleTip: true, record: null }, async ({ sim, ctx }) => {
      await new FileTipStore(ctx.paths.bitcoinTipFile).save(sim.tip);
      await ensureLightningSynced(ctx);
      assert.deepEqual(minedBlocks(sim), [1]);
      assert.match(sim.output[0] ?? "", /old after a pause/);
    });
  });
});

describe("limits and errors", () => {
  it("stops mining at DEVNET_MAX_CATCH_UP_BLOCKS, says so once, and times out naming both nodes", async () => {
    await withSimDevnet({ height: 160, walletHeights: { [SERVICE.LND_HUB]: 5_000 }, record: null, env: { DEVNET_MAX_CATCH_UP_BLOCKS: "30" } }, async ({ sim, ctx }) => {
      await assert.rejects(ensureLightningSynced(ctx), /Timed out after 180000 ms waiting for lnd-hub and lnd-user to sync to the chain tip/);
      assert.deepEqual(minedBlocks(sim), [1, 2, 4, 8, 16]);
      assert.equal(minedBlocks(sim).slice(1).reduce((sum, blocks) => sum + blocks, 0), 30);
      const capped = sim.output.filter((line) => line.includes("DEVNET_MAX_CATCH_UP_BLOCKS=30"));
      assert.equal(capped.length, 1, sim.output.join("\n"));
      assert.match(capped[0] ?? "", /^lnd-hub: wallet still ahead of bitcoind after the doubling batches added 30 blocks .*waiting without mining more$/);
    });
  });

  it("mines only the first block when the batches are off (DEVNET_MAX_CATCH_UP_BLOCKS=0)", async () => {
    await withSimDevnet({ ...INCIDENT, record: null, env: { DEVNET_MAX_CATCH_UP_BLOCKS: "0", DEVNET_WAIT_TIMEOUT_MS: "60000" } }, async ({ sim, ctx }) => {
      await assert.rejects(ensureLightningSynced(ctx), /Timed out after 60000 ms/);
      assert.deepEqual(minedBlocks(sim), [1]);
      assert.ok(sim.output.some((line) => line.includes("added 0 blocks (DEVNET_MAX_CATCH_UP_BLOCKS=0)")));
    });
  });

  it("reads DEVNET_LND_LOG_TAIL_LINES lines of each log", async () => {
    await withSimDevnet({ ...INCIDENT, record: null, env: { DEVNET_LND_LOG_TAIL_LINES: "37" } }, async ({ sim, ctx }) => {
      await ensureLightningSynced(ctx);
      assert.ok(sim.logReads.length > 0);
      assert.ok(sim.logReads.every((read) => read.lines === 37));
      assert.ok(sim.logReads.every((read) => LND_SERVICES.includes(read.service as LndService)), "only LND logs are read");
    });
  });

  it("finds the error in a two-line tail, since LND logs it on every retry", async () => {
    await withSimDevnet({ ...INCIDENT, record: null, env: { DEVNET_LND_LOG_TAIL_LINES: "2" } }, async ({ sim, ctx }) => {
      await ensureLightningSynced(ctx);
      assert.deepEqual(minedBlocks(sim), [1, 2, 4, 8, 16]);
    });
  });

  it("retries a failed log read or getinfo while waiting, instead of failing `up`", async () => {
    await withSimDevnet({ ...INCIDENT, record: null }, async ({ sim, ctx }) => {
      const originalNow = sim.clock.now;
      let armed = false;
      sim.clock.now = () => {
        if (!armed && sim.mines.length === 1 && sim.now > 0) {
          armed = true;
          sim.failOnce.set(`logs ${SERVICE.LND_HUB}`, new CommandError("docker", [], 1, "Error response from daemon: i/o timeout"));
          sim.failOnce.set(`lncli getinfo ${SERVICE.LND_USER}`, new CommandError("docker", [], 1, "rpc error: code = Unavailable"));
        }
        return originalNow();
      };
      await ensureLightningSynced(ctx);
      assert.ok(armed);
      assert.ok(bothSynced(sim));
      assert.deepEqual(minedBlocks(sim), [1, 2, 4, 8, 16]);
    });
  });

  it("fails `up` when bitcoind cannot mine the first catch-up, without writing a record", async () => {
    await withSimDevnet({ ...INCIDENT, record: null }, async ({ sim, ctx, readTip }) => {
      const failure = new CommandError("docker", [], 1, "service \"bitcoind\" is not running");
      sim.failOnce.set("generatetoaddress", failure);
      await assert.rejects(ensureLightningSynced(ctx), (error) => error === failure);
      assert.equal(await readTip(), null);
    });
  });

  it("never prints raw LND log text: only service names, heights and counts", async () => {
    await withSimDevnet({ ...INCIDENT, record: null }, async ({ sim, ctx }) => {
      await ensureLightningSynced(ctx);
      assert.ok(sim.lnd[SERVICE.LND_HUB].log.some((line) => line.includes(PRIVATE_LOG_TEXT)), "the log did hold it");
      assert.ok(sim.output.every((line) => !line.includes(PRIVATE_LOG_TEXT) && !line.includes(" | ")), sim.output.join("\n"));
    });
  });
});

/* ------------------------------------------------------------------------- syncLightningToChain, narrow fakes */

describe("syncLightningToChain on narrow fakes", () => {
  interface FakeOptions {
    unsynced?: string[];
    walletAhead?: string[];
    /** getinfo answers synced_to_chain with a block_height this far behind bitcoind for this many calls. */
    lagCalls?: number;
  }

  function fake(options: FakeOptions) {
    let height = 200;
    let now = 0;
    let infoCalls = 0;
    const events: string[] = [];
    const unsynced = new Set(options.unsynced ?? []);
    const bitcoin: ChainMiner = {
      mineTo: async (address, blocks) => {
        events.push(`mine ${blocks} to ${address}`);
        height += blocks;
        unsynced.clear();
      },
      blockCount: async () => height,
      blockHash: async (at) => (at > height ? null : "d".repeat(64)),
      recordedTip: async () => null,
    };
    const nodes: SyncingLnd[] = ["lnd-hub", "lnd-user"].map((service) => ({
      service,
      info: async () => {
        infoCalls++;
        const lagging = infoCalls <= (options.lagCalls ?? 0);
        return { synced_to_chain: !unsynced.has(service), block_height: lagging ? height - 1 : height };
      },
      recentLog: async (lines) => {
        events.push(`log ${service} ${lines}`);
        return options.walletAhead?.includes(service) ? aheadLine(service) : syncedLine(service, height);
      },
    }));
    const settings = loadDevnetSettings({});
    const sync = {
      bitcoin,
      nodes,
      rewardAddress: async () => {
        events.push("address");
        return "bcrt1p-reward";
      },
      settings,
      clock: { now: () => now, sleep: async (ms: number) => void (now += ms) },
      logger: { step: () => undefined, info: (message: string) => void events.push(`say ${message}`) },
    };
    return { sync, events, now: () => now };
  }

  it("says what it is about to mine before it mines", async () => {
    const { sync, events } = fake({ unsynced: ["lnd-hub"] });
    await syncLightningToChain(sync);
    const said = events.findIndex((event) => event.startsWith("say lnd-hub: not synced"));
    const mined = events.findIndex((event) => event.startsWith("mine "));
    assert.ok(said >= 0 && mined > said, events.join("\n"));
  });

  it("reads the logs of the unsynced nodes only, at the configured tail length", async () => {
    const { sync, events } = fake({ unsynced: ["lnd-user"] });
    await syncLightningToChain(sync);
    assert.deepEqual(events.filter((event) => event.startsWith("log ")), ["log lnd-user 200"]);
  });

  it("asks for one reward address per run, only once something is mined", async () => {
    const { sync, events } = fake({ unsynced: ["lnd-hub", "lnd-user"] });
    await syncLightningToChain(sync);
    assert.equal(events.filter((event) => event === "address").length, 1);
    assert.ok(events.indexOf("address") < events.findIndex((event) => event.startsWith("mine ")));
  });

  it("waits, without mining, for a node that is synced but has not seen the latest block yet", async () => {
    const { sync, events, now } = fake({ lagCalls: 6 });
    await syncLightningToChain(sync);
    assert.ok(!events.some((event) => event.startsWith("mine ") || event.startsWith("say ")), events.join("\n"));
    assert.ok(now() > 0, "it polled until block_height reached bitcoind's tip");
  });
});
