import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ccc } from "@ckb-ccc/core";
import { fromHexQuantity } from "../../../src/common/utils/amount.util";
import { BITCOIN_CLI, LNCLI, SERVICE } from "../../scripts/lib/devnet.constants";
import { waitFor } from "../../scripts/lib/poll";
import { runCommand } from "../../scripts/lib/process";
import {
  CKB_MINER_SERVICE,
  CKB_TIP_WAIT_MS,
  CONTAINER_HEALTHY,
  CONTAINER_RUNNING,
  EXPECTED_VERSION,
  GENESIS_CONTRACT_FILES,
  LOOPBACK,
} from "./check.constants";
import type { LiveContext } from "./live-context";
import type { CheckRunner } from "./runner";

interface PsRow {
  Service: string;
  State: string;
  Health: string;
  Publishers: { URL: string; TargetPort: number; PublishedPort: number }[] | null;
}

interface CkbGenesis {
  header: { hash: string };
  transactions: { outputs_data: string[] }[];
}

const ALL_SERVICES = [...Object.values(SERVICE), CKB_MINER_SERVICE];

async function composePs(live: LiveContext): Promise<PsRow[]> {
  const { stdout } = await runCommand("docker", ["compose", "ps", "--all", "--format", "json"], { cwd: live.devnet.paths.devnetDir });
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as PsRow);
}

const genesis = (live: LiveContext) => live.rpc.ckb.call<CkbGenesis>("get_block_by_number", ["0x0"]);

export async function checkStack(live: LiveContext, runner: CheckRunner): Promise<void> {
  runner.section("Stack: services, ports, versions, chain");
  const { compose } = live.devnet;

  await runner.check("every service is running and every node is healthy", async () => {
    const rows = await composePs(live);
    for (const service of ALL_SERVICES) {
      const row = rows.find((candidate) => candidate.Service === service);
      assert.ok(row, `${service} has no container`);
      assert.equal(row.State, CONTAINER_RUNNING, `${service} is ${row.State}`);
      if (service !== CKB_MINER_SERVICE) assert.equal(row.Health, CONTAINER_HEALTHY, `${service} is ${row.Health || "without health"}`);
    }
    return `${ALL_SERVICES.length} services`;
  });

  await runner.check(`every published port binds to ${LOOPBACK} only`, async () => {
    const published = (await composePs(live)).flatMap((row) => (row.Publishers ?? []).filter((port) => port.PublishedPort > 0).map((port) => ({ ...port, service: row.Service })));
    for (const port of published) assert.equal(port.URL, LOOPBACK, `${port.service}:${port.TargetPort} is published on ${port.URL}`);
    return `${published.length} ports`;
  });

  await runner.check(`bitcoind is Bitcoin Core ${EXPECTED_VERSION.BITCOIN_CORE} on regtest`, async () => {
    const network = JSON.parse(await compose.exec(SERVICE.BITCOIND, [...BITCOIN_CLI, "getnetworkinfo"])) as { subversion: string };
    const chain = JSON.parse(await compose.exec(SERVICE.BITCOIND, [...BITCOIN_CLI, "getblockchaininfo"])) as { chain: string };
    assert.ok(network.subversion.includes(`:${EXPECTED_VERSION.BITCOIN_CORE}`), network.subversion);
    assert.equal(chain.chain, "regtest");
    return network.subversion;
  });

  for (const service of [SERVICE.LND_HUB, SERVICE.LND_USER]) {
    await runner.check(`${service} is LND ${EXPECTED_VERSION.LND}`, async () => {
      const { version } = await compose.execJson<{ version: string }>(service, [...LNCLI, "getinfo"]);
      assert.ok(version.startsWith(EXPECTED_VERSION.LND), version);
    });
  }

  await runner.check(`ckb is CKB ${EXPECTED_VERSION.CKB}`, async () => {
    const { version } = await live.rpc.ckb.call<{ version: string }>("local_node_info");
    assert.ok(version.startsWith(EXPECTED_VERSION.CKB), version);
    return version;
  });

  for (const [name, rpc] of [[SERVICE.FNN_HUB, live.rpc.fnnHub], [SERVICE.FNN_USER, live.rpc.fnnUser]] as const) {
    await runner.check(`${name} is fnn ${EXPECTED_VERSION.FNN}`, async () => {
      const { version } = await rpc.call<{ version: string }>("node_info");
      assert.equal(version, EXPECTED_VERSION.FNN);
    });
  }

  await runner.check("ckb-miner produces CKB blocks", async () => {
    const tip = async () => fromHexQuantity(await live.rpc.ckb.call<string>("get_tip_block_number"));
    const start = await tip();
    const next = await waitFor("the CKB tip to move", async () => {
      const current = await tip();
      return current > start ? current : undefined;
    }, { timeoutMs: CKB_TIP_WAIT_MS, intervalMs: live.devnet.settings.waits.pollIntervalMs, clock: live.devnet.clock });
    return `tip ${start} -> ${next}`;
  });

  await runner.check("the CKB genesis holds the Fiber v0.9.1 contracts from devnet/ckb/contracts", async () => {
    const block = await genesis(live);
    const cellbase = block.transactions[0];
    assert.ok(cellbase, "no genesis cellbase");
    const genesisHashes = new Set(cellbase.outputs_data.map((data) => ccc.hashCkb(data)));
    for (const file of GENESIS_CONTRACT_FILES) {
      const binary = readFileSync(join(live.devnet.paths.devnetDir, "ckb", "contracts", file));
      assert.ok(genesisHashes.has(ccc.hashCkb(binary)), `${file} is not a genesis cell`);
    }
    return GENESIS_CONTRACT_FILES.join(", ");
  });

  await runner.check("both fnn nodes follow this CKB chain (chain_hash = genesis hash)", async () => {
    const { header } = await genesis(live);
    for (const node of [live.fiber.hub, live.fiber.user]) {
      assert.equal((await node.nodeInfo()).chain_hash, header.hash, `${node.name} is on another chain`);
    }
  });
}
