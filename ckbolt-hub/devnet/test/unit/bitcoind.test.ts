/**
 * Independent tests of the "prevent" half of the devnet self-heal (research section 6.3, step 1): BitcoinNode.mineTo
 * makes bitcoind write every block it mines at once (`gettxoutsetinfo none`) and records that tip; blockHash tells
 * "no block at that height" (-8) apart from real failures; the LND log tail is read through `docker compose logs`.
 * Commands are recorded by a fake runner; nothing runs Docker.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChainTip, TipStore } from "../../scripts/lib/bitcoin-tip";
import { BitcoinNode } from "../../scripts/lib/bitcoind";
import { DockerCompose } from "../../scripts/lib/compose";
import { BITCOIN_CLI, BITCOIN_FLUSH_ARGS, SERVICE } from "../../scripts/lib/devnet.constants";
import { LndNode } from "../../scripts/lib/lnd";
import { CommandError, type CommandResult, type CommandRunner } from "../../scripts/lib/process";

const ADDRESS = "bcrt1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqx5j0q";
const BEST = "546d57044117eaf68868fcb2b9d32e34b569a2646c3f311d524f87afe0b77d60";
const UTXO_SET_INFO = JSON.stringify({ height: 183, bestblock: BEST, txouts: 185, bogosize: 15540, total_amount: 8300, transactions: 183, disk_size: 8291 }, null, 2);
/** What `docker compose exec bitcoind bitcoin-cli getblockhash <above tip>` writes to stderr. */
const OUT_OF_RANGE_OUTPUT = "error code: -8\nerror message:\nBlock height out of range\nexit status 8\n";

type Reply = string | Error;

/** Records every docker command; answers bitcoin-cli by RPC name (the first argument after BITCOIN_CLI). */
function fakeDocker(replies: Record<string, Reply | ((args: readonly string[]) => Reply)>) {
  const calls: (readonly string[])[] = [];
  const runner: CommandRunner = async (command, args): Promise<CommandResult> => {
    assert.equal(command, "docker");
    calls.push(args);
    const key = rpcName(args);
    const reply = replies[key];
    if (reply === undefined) throw new Error(`unexpected command: ${args.join(" ")}`);
    const value = typeof reply === "function" ? reply(args) : reply;
    if (value instanceof Error) throw value;
    return { stdout: value, stderr: "" };
  };
  return { compose: new DockerCompose("/devnet", runner), calls };
}

/** "generatetoaddress" for a bitcoin-cli exec, "logs" for docker compose logs, "lncli getinfo" for LND. */
function rpcName(args: readonly string[]): string {
  if (args[1] === "logs") return "logs";
  const cliAt = args.indexOf(BITCOIN_CLI[0]);
  if (cliAt >= 0) return args[cliAt + BITCOIN_CLI.length] ?? "";
  return args.slice(4).join(" ");
}

function recordingStore(initial: ChainTip | null = null): TipStore & { saved: ChainTip[] } {
  const saved: ChainTip[] = [];
  return {
    saved,
    load: async () => saved.at(-1) ?? initial,
    save: async (tip) => void saved.push(tip),
  };
}

const bitcoinCliArgs = (...rpc: string[]): string[] => ["compose", "exec", "-T", SERVICE.BITCOIND, ...BITCOIN_CLI, ...rpc];

describe("BitcoinNode.mineTo: every mine is flushed and recorded", () => {
  it("mines to the address, then flushes with gettxoutsetinfo none, in that order and in the bitcoind service", async () => {
    const { compose, calls } = fakeDocker({ generatetoaddress: "[]", gettxoutsetinfo: UTXO_SET_INFO });
    await new BitcoinNode(compose, recordingStore()).mineTo(ADDRESS, 18);
    assert.deepEqual(calls, [bitcoinCliArgs("generatetoaddress", "18", ADDRESS), bitcoinCliArgs(...BITCOIN_FLUSH_ARGS)]);
  });

  it("records the height and best block the flush reports, as written to disk", async () => {
    const store = recordingStore();
    const { compose, calls } = fakeDocker({ generatetoaddress: "[]", gettxoutsetinfo: UTXO_SET_INFO });
    await new BitcoinNode(compose, store).mineTo(ADDRESS, 1);
    assert.deepEqual(store.saved, [{ height: 183, hash: BEST }]);
    assert.ok(!calls.some((args) => args.includes("getblockcount") || args.includes("getbestblockhash")), "the tip comes from the flush itself");
  });

  it("flushes and records after each mine, not once per run", async () => {
    let height = 100;
    const store = recordingStore();
    const { compose, calls } = fakeDocker({
      generatetoaddress: (args) => {
        height += Number(args.at(-2));
        return "[]";
      },
      gettxoutsetinfo: () => JSON.stringify({ height, bestblock: height.toString(16).padStart(64, "0") }),
    });
    const bitcoin = new BitcoinNode(compose, store);
    for (const blocks of [5, 100, 6]) await bitcoin.mineTo(ADDRESS, blocks);
    assert.deepEqual(
      calls.map((args) => rpcName(args)),
      ["generatetoaddress", "gettxoutsetinfo", "generatetoaddress", "gettxoutsetinfo", "generatetoaddress", "gettxoutsetinfo"],
    );
    assert.deepEqual(store.saved.map((tip) => tip.height), [105, 205, 211]);
  });

  it("does nothing for 0 or fewer blocks: no mine, no flush, no record", async () => {
    const store = recordingStore();
    const { compose, calls } = fakeDocker({});
    const bitcoin = new BitcoinNode(compose, store);
    await bitcoin.mineTo(ADDRESS, 0);
    await bitcoin.mineTo(ADDRESS, -3);
    assert.deepEqual(calls, []);
    assert.deepEqual(store.saved, []);
  });

  it("does not flush or record when mining fails, and passes the failure on", async () => {
    const store = recordingStore();
    const failure = new CommandError("docker", [], 1, "service \"bitcoind\" is not running");
    const { compose, calls } = fakeDocker({ generatetoaddress: failure, gettxoutsetinfo: UTXO_SET_INFO });
    await assert.rejects(new BitcoinNode(compose, store).mineTo(ADDRESS, 1), (error) => error === failure);
    assert.equal(calls.length, 1);
    assert.deepEqual(store.saved, []);
  });

  it("does not record a tip when the flush fails or prints something else, and passes the failure on", async () => {
    for (const reply of [new CommandError("docker", [], 1, "error code: -28\nerror message:\nLoading block index…"), "not json"]) {
      const store = recordingStore();
      const { compose } = fakeDocker({ generatetoaddress: "[]", gettxoutsetinfo: reply });
      await assert.rejects(new BitcoinNode(compose, store).mineTo(ADDRESS, 1));
      assert.deepEqual(store.saved, [], String(reply));
    }
  });
});

describe("BitcoinNode reads", () => {
  it("blockCount reads getblockcount, trimming bitcoin-cli's newline", async () => {
    const { compose, calls } = fakeDocker({ getblockcount: "183\r\n" });
    assert.equal(await new BitcoinNode(compose, recordingStore()).blockCount(), 183);
    assert.deepEqual(calls, [bitcoinCliArgs("getblockcount")]);
  });

  it("blockHash returns the active chain's hash at a height", async () => {
    const { compose, calls } = fakeDocker({ getblockhash: `${BEST}\n` });
    assert.equal(await new BitcoinNode(compose, recordingStore()).blockHash(183), BEST);
    assert.deepEqual(calls, [bitcoinCliArgs("getblockhash", "183")]);
  });

  it("blockHash is null when bitcoind answers -8 Block height out of range (its chain is shorter)", async () => {
    const outOfRange = new CommandError("docker", bitcoinCliArgs("getblockhash", "177"), 8, OUT_OF_RANGE_OUTPUT);
    const { compose } = fakeDocker({ getblockhash: outOfRange });
    assert.equal(await new BitcoinNode(compose, recordingStore()).blockHash(177), null);
  });

  it("blockHash passes on every other failure, so `npm run up` does not mistake a stopped bitcoind for lost blocks", async () => {
    const failures = [
      new CommandError("docker", [], 1, "service \"bitcoind\" is not running"),
      new CommandError("docker", [], 1, "error code: -28\nerror message:\nVerifying blocks…"),
      new Error("Block height out of range"),
    ];
    for (const failure of failures) {
      const { compose } = fakeDocker({ getblockhash: failure });
      await assert.rejects(new BitcoinNode(compose, recordingStore()).blockHash(177), (error) => error === failure, failure.message);
    }
  });

  it("recordedTip reads the tip store and runs no command", async () => {
    const recorded = { height: 177, hash: "a".repeat(64) };
    const { compose, calls } = fakeDocker({});
    assert.deepEqual(await new BitcoinNode(compose, recordingStore(recorded)).recordedTip(), recorded);
    assert.equal(await new BitcoinNode(compose, recordingStore(null)).recordedTip(), null);
    assert.deepEqual(calls, []);
  });
});

describe("LND log tail", () => {
  const LOG = "lnd-user-1  | 2026-10-23 11:21:57.121 [ERR] BTWL: Unable to synchronize wallet to chain, trying again in 5s: -8: Block height out of range\n";

  it("DockerCompose.logs reads the last lines of one service without colours", async () => {
    const { compose, calls } = fakeDocker({ logs: LOG });
    assert.equal(await compose.logs(SERVICE.LND_USER, 200), LOG);
    assert.deepEqual(calls, [["compose", "logs", "--no-color", "--tail", "200", "lnd-user"]]);
  });

  it("LndNode.recentLog reads its own service's log with the line count asked for", async () => {
    const { compose, calls } = fakeDocker({ logs: LOG });
    assert.equal(await new LndNode(SERVICE.LND_HUB, compose).recentLog(37), LOG);
    assert.deepEqual(calls, [["compose", "logs", "--no-color", "--tail", "37", "lnd-hub"]]);
  });
});
