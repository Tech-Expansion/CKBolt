import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TESTNET_RUSD_TYPE_SCRIPT } from "../../src/common/constants/assets.constants";
import { CKB_GENESIS_HASH } from "../../src/common/constants/protocol.constants";
import type { HealthDto } from "../../src/interfaces/http/contract/responses";
import {
  evaluateAnnouncedAddresses,
  evaluateAssets,
  evaluateBitcoind,
  evaluateContainers,
  evaluateFiberChannel,
  evaluateFiberNodeView,
  evaluateFnnNode,
  evaluateFnnPeers,
  evaluateFnnWallet,
  evaluateHubBinding,
  evaluateHubHealth,
  evaluateHubSecrets,
  evaluateLnChannel,
  evaluateLndState,
  evaluateLndSync,
  evaluateLnPeer,
  failed,
  renderReport,
  type CheckResult,
  type LnChannelRule,
} from "../scripts/check/checks";
import { runCheck } from "../scripts/check/run-check";
import type { ComposeServiceState } from "../scripts/lib/compose-state";
import { MUTINYNET_LSP, type ServiceName } from "../scripts/lib/constants";
import type { FnnNodeInfo } from "../scripts/lib/fiber";
import type { LndInfo } from "../scripts/lib/lnd";
import { hubMacaroonPath } from "../scripts/lib/kit-paths";
import {
  ckbAsset,
  FakeDeployment,
  fiberNodeView,
  fnnChannel,
  healthyHealth,
  lndChannel,
  lockOf,
  PEER_ID,
  PUBKEY,
} from "./support/fake-deployment";
import { FakeNetwork } from "./support/fake-network";
import { testContext, testSettings } from "./support/fakes";

/** Every warning and failure must say what to do next: the spec's "each red item says the next action". */
function assertEveryRedLineHasNext(results: readonly CheckResult[]): void {
  for (const result of results) {
    if (result.status === "ok") continue;
    assert.ok(result.next && result.next.trim().length > 0, `"${result.area}: ${result.summary}" (${result.status}) has no next action`);
  }
}

const CKB = 100_000_000n;
const lndInfo = (overrides: Partial<LndInfo> = {}): LndInfo => ({
  identity_pubkey: PUBKEY.LND_HUB,
  alias: "ckbolt-hub",
  synced_to_chain: true,
  block_height: 2_000_000,
  num_peers: 3,
  num_active_channels: 1,
  num_pending_channels: 0,
  chains: [{ chain: "bitcoin", network: "signet" }],
  ...overrides,
});
const fnnInfo = (overrides: Partial<FnnNodeInfo> = {}): FnnNodeInfo => ({
  version: "0.9.1",
  pubkey: PUBKEY.FNN_HUB,
  addresses: [`/ip4/203.0.113.7/tcp/8228/p2p/${PEER_ID.FNN_HUB}`, `/ip4/203.0.113.7/tcp/8228/ws/p2p/${PEER_ID.FNN_HUB}`],
  chain_hash: CKB_GENESIS_HASH.testnet,
  default_funding_lock_script: lockOf(`0x${"11".repeat(20)}`),
  ...overrides,
});
const lspRule: LnChannelRule = {
  service: "lnd-hub",
  label: "channel to the Megalith LSP",
  peer: PUBKEY.LSP,
  minLocal: 20_000n,
  minRemote: 20_000n,
  nextWhenMissing: "fund, then channels",
  nextWhenLowLocal: "bigger channel",
  nextWhenLowRemote: "testnet balance",
};

describe("testnet:check rules (pure)", () => {
  describe("containers and the hub's binding", () => {
    const state = (service: string, state: string, health: string): ComposeServiceState => ({ service, state, health, publishers: [] });

    it("fails a service without a container, warns while it starts, fails one that stopped or is unhealthy", () => {
      const active = new Set<ServiceName>(["bitcoind", "lnd-hub", "fnn-hub", "hub"]);
      const states = new Map([
        ["bitcoind", state("bitcoind", "running", "healthy")],
        ["lnd-hub", state("lnd-hub", "running", "starting")],
        ["fnn-hub", state("fnn-hub", "exited", "")],
      ]);
      const results = evaluateContainers(active, states);
      assert.deepEqual(
        results.map((r) => [r.area, r.status]),
        [
          ["bitcoind", "ok"],
          ["lnd-hub", "warn"],
          ["fnn-hub", "fail"],
          ["hub", "fail"],
        ],
      );
      assert.equal(results[3]?.next, "testnet up hub");
      assert.match(results[2]?.next ?? "", /testnet logs fnn-hub/);
      assertEveryRedLineHasNext(results);
      assert.equal(evaluateContainers(active, new Map([["hub", state("hub", "running", "unhealthy")]])).find((r) => r.area === "hub")?.status, "fail");
    });

    it("accepts the hub only on loopback: 0.0.0.0, :: or a public address fail (the operator uses the SSH tunnel)", () => {
      const pub = (url: string) => ({ url, targetPort: 8787, publishedPort: 18787 });
      assert.equal(evaluateHubBinding([pub("127.0.0.1")]).status, "ok");
      for (const exposed of ["0.0.0.0", "::", "198.51.100.20"]) {
        const result = evaluateHubBinding([pub(exposed)]);
        assert.equal(result.status, "fail", exposed);
        assert.match(result.summary, new RegExp(exposed.replace(/\./g, "\\.")));
        assert.match(result.next ?? "", /127\.0\.0\.1/);
      }
      assert.equal(evaluateHubBinding([pub("127.0.0.1"), pub("0.0.0.0")]).status, "fail", "one exposed binding is enough to fail");
      assert.equal(evaluateHubBinding([]).status, "warn");
    });
  });

  describe("bitcoind", () => {
    const info = { chain: "signet", blocks: 2_000_000, headers: 2_000_000, verificationprogress: 0.999999, initialblockdownload: false, size_on_disk: 9_812_345_678 };

    it("reports the sync percentage while syncing, with what to do", () => {
      const result = evaluateBitcoind({ ...info, blocks: 912_345, headers: 2_000_000, verificationprogress: 0.4567891, initialblockdownload: true });
      assert.equal(result.status, "warn");
      assert.match(result.summary, /45\.68% verified, block 912345 of 2000000/);
      assert.match(result.next ?? "", /wait/);
    });

    it("is ok when synced, with the height and the disk use", () => {
      const result = evaluateBitcoind(info);
      assert.equal(result.status, "ok");
      assert.match(result.summary, /block 2000000 \(9\.8 GB on disk\)/);
    });

    it("counts a node behind its headers as syncing even after the initial download", () => {
      assert.equal(evaluateBitcoind({ ...info, blocks: 1_999_990 }).status, "warn");
    });

    it("refuses any chain but signet (mainnet, testnet, regtest)", () => {
      for (const chain of ["main", "test", "testnet4", "regtest"]) {
        const result = evaluateBitcoind({ ...info, chain });
        assert.equal(result.status, "fail", chain);
        assert.match(result.summary, new RegExp(`"${chain}"`));
      }
    });
  });

  describe("LND", () => {
    it("says what to do for each wallet state", () => {
      assert.equal(evaluateLndState("lnd-hub", "SERVER_ACTIVE").status, "ok");
      const none = evaluateLndState("lnd-hub", "NON_EXISTING");
      assert.equal(none.status, "fail");
      assert.equal(none.next, "testnet wallet lnd-hub");
      assert.equal(evaluateLndState("lnd-demo", "NON_EXISTING").next, "testnet wallet lnd-demo");
      const locked = evaluateLndState("lnd-hub", "LOCKED");
      assert.equal(locked.status, "fail");
      assert.match(locked.next ?? "", /secrets\/wallet\/lnd-hub\.password/);
      assert.equal(evaluateLndState("lnd-hub", null).status, "fail");
      assert.equal(evaluateLndState("lnd-hub", "WAITING_TO_START").status, "warn");
      assert.equal(evaluateLndState("lnd-hub", "RPC_ACTIVE").status, "warn");
      assertEveryRedLineHasNext(["NON_EXISTING", "LOCKED", "WAITING_TO_START", "RPC_ACTIVE", null].map((s) => evaluateLndState("lnd-hub", s)));
    });

    it("reports sync, peers and channel counts", () => {
      const synced = evaluateLndSync("lnd-hub", lndInfo());
      assert.equal(synced.status, "ok");
      assert.match(synced.summary, /block 2000000, 3 peers, 1 active and 0 pending channels/);
      const behind = evaluateLndSync("lnd-hub", lndInfo({ synced_to_chain: false }));
      assert.equal(behind.status, "warn");
      assert.ok(behind.next);
    });

    it("shows a channel's outbound (local) and inbound (remote) balance, summed over active channels with the peer", () => {
      const channels = [
        lndChannel(PUBKEY.LSP, 300_000n, 100_000n),
        lndChannel(PUBKEY.LSP, 50_000n, 25_000n),
        lndChannel(PUBKEY.LSP, 999_999n, 999_999n, false),
        lndChannel(PUBKEY.LND_DEMO, 7n, 7n),
      ];
      const result = evaluateLnChannel(lspRule, channels, []);
      assert.equal(result.status, "ok");
      assert.match(result.summary, /350,000 sats outbound, 125,000 sats inbound/);
    });

    it("warns on low outbound, then on low inbound, each with its own next action", () => {
      const lowLocal = evaluateLnChannel(lspRule, [lndChannel(PUBKEY.LSP, 19_999n, 500_000n)], []);
      assert.equal(lowLocal.status, "warn");
      assert.match(lowLocal.summary, /outbound below 20,000 sats/);
      assert.equal(lowLocal.next, "bigger channel");
      const lowRemote = evaluateLnChannel(lspRule, [lndChannel(PUBKEY.LSP, 500_000n, 19_999n)], []);
      assert.equal(lowRemote.status, "warn");
      assert.match(lowRemote.summary, /inbound below 20,000 sats/);
      assert.equal(lowRemote.next, "testnet balance");
      assert.equal(evaluateLnChannel(lspRule, [lndChannel(PUBKEY.LSP, 20_000n, 20_000n)], []).status, "ok", "the minimum itself is enough");
    });

    it("fails a missing channel, warns while it opens or while the peer is offline", () => {
      const missing = evaluateLnChannel(lspRule, [lndChannel(PUBKEY.LND_DEMO, 1n, 1n)], []);
      assert.equal(missing.status, "fail");
      assert.equal(missing.next, "fund, then channels");
      const pending = [{ channel: { remote_node_pub: PUBKEY.LSP, capacity: "600000", local_balance: "600000", remote_balance: "0" } }];
      assert.equal(evaluateLnChannel(lspRule, [], pending).status, "warn");
      const inactive = evaluateLnChannel(lspRule, [lndChannel(PUBKEY.LSP, 1n, 1n, false)], []);
      assert.equal(inactive.status, "warn");
      assert.match(inactive.next ?? "", /testnet channels/);
    });

    it("reports the LSP peer and the hub's macaroon", () => {
      assert.equal(evaluateLnPeer("lnd-hub", [PUBKEY.LSP], PUBKEY.LSP, "the LSP").status, "ok");
      assert.equal(evaluateLnPeer("lnd-hub", [], PUBKEY.LSP, "the LSP").status, "warn");
      assert.equal(evaluateHubSecrets("lnd-hub", true).status, "ok");
      const missing = evaluateHubSecrets("lnd-hub", false);
      assert.equal(missing.status, "fail");
      assert.equal(missing.next, "testnet macaroons");
    });
  });

  describe("Fiber", () => {
    it("names the network from the genesis hash and refuses CKB mainnet or any other chain", () => {
      assert.equal(evaluateFnnNode("fnn-hub", fnnInfo()).status, "ok");
      const mainnet = evaluateFnnNode("fnn-hub", fnnInfo({ chain_hash: CKB_GENESIS_HASH.mainnet }));
      assert.equal(mainnet.status, "fail");
      assert.match(mainnet.summary, /mainnet/);
      assert.match(mainnet.next ?? "", /CKB_RPC_URL/);
      assert.equal(evaluateFnnNode("fnn-hub", fnnInfo({ chain_hash: `0x${"ab".repeat(32)}` })).status, "fail");
    });

    it("warns when the wallet holds less than the minimum, with the amount in whole CKB", () => {
      const low = evaluateFnnWallet("fnn-hub", 24_999n * CKB + 50_000_000n, 25_000n * CKB);
      assert.equal(low.status, "warn");
      assert.match(low.summary, /24,?999\.5 CKB/);
      assert.equal(low.next, "testnet fund");
      assert.equal(evaluateFnnWallet("fnn-hub", 25_000n * CKB, 25_000n * CKB).status, "ok");
    });

    it("lists each relay peer as connected or not", () => {
      const wanted = [
        { pubkey: PUBKEY.BOTTLE, address: "/dns4/bottle.fiber.channel/tcp/8119/p2p/QmA" },
        { pubkey: PUBKEY.BRACER, address: "/dns4/bracer.fiber.channel/tcp/8119/p2p/QmB" },
      ];
      const results = evaluateFnnPeers("fnn-hub", [{ pubkey: PUBKEY.BOTTLE, address: "x" }], wanted);
      assert.deepEqual(
        results.map((r) => r.status),
        ["ok", "warn"],
      );
      assertEveryRedLineHasNext(results);
    });

    it("reads a channel per asset: a CKB channel never counts as the RUSD one, and balances show in whole units", () => {
      const ckbRule = { service: "fnn-hub", label: "CKB channel", asset: "CKB" as const, udtTypeScript: null, nextWhenMissing: "testnet channels" };
      const rusdRule = { service: "fnn-hub", label: "RUSD channel", asset: "RUSD" as const, udtTypeScript: TESTNET_RUSD_TYPE_SCRIPT, nextWhenMissing: "RUSD by hand" };
      const ckbOnly = [fnnChannel(PUBKEY.BOTTLE, 750n * CKB, 250n * CKB)];
      const ready = evaluateFiberChannel(ckbRule, ckbOnly);
      assert.equal(ready.status, "ok");
      assert.match(ready.summary, /ready, 750 CKB outbound, 250 CKB inbound/);
      const noRusd = evaluateFiberChannel(rusdRule, ckbOnly);
      assert.equal(noRusd.status, "fail");
      assert.equal(noRusd.next, "RUSD by hand");
      const rusdScript = { code_hash: TESTNET_RUSD_TYPE_SCRIPT.codeHash, hash_type: TESTNET_RUSD_TYPE_SCRIPT.hashType, args: TESTNET_RUSD_TYPE_SCRIPT.args };
      assert.match(evaluateFiberChannel(rusdRule, [...ckbOnly, fnnChannel(PUBKEY.BOTTLE, 100n * CKB, 0n, { udt: rusdScript })]).summary, /100 RUSD outbound/);
      const opening = evaluateFiberChannel(ckbRule, [fnnChannel(PUBKEY.BOTTLE, 1n, 0n, { state: "AwaitingChannelReady" })]);
      assert.equal(opening.status, "warn");
      assert.match(opening.summary, /AwaitingChannelReady/);
    });

    it("warns when fnn announces no WebSocket address (browser Fiber nodes could not dial it)", () => {
      const none = evaluateAnnouncedAddresses("fnn-hub", fnnInfo({ addresses: ["/dns4/fnn-hub/tcp/8228/p2p/QmX"] }));
      assert.equal(none.status, "warn");
      assert.match(none.next ?? "", /docker-compose\.public\.yml/);
      assert.match(none.next ?? "", /PUBLIC_IP/);
      const announced = evaluateAnnouncedAddresses("fnn-hub", fnnInfo());
      assert.equal(announced.status, "ok");
      assert.match(announced.summary, /\/ip4\/203\.0\.113\.7\/tcp\/8228\/ws/);
    });
  });

  describe("the hub", () => {
    it("is ok only when healthy on signet and CKB testnet", () => {
      const result = evaluateHubHealth(200, healthyHealth());
      assert.equal(result.status, "ok");
      assert.match(result.summary, /Lightning signet synced at 2000000; Fiber testnet fnn 0\.9\.1; demo wallet off/);
    });

    it("refuses a hub whose nodes report mainnet (or any other network), even when it says ok", () => {
      const variants: [string, Partial<HealthDto>][] = [
        ["lightning mainnet", { lightning: { reachable: true, network: "mainnet", synced: true, blockHeight: 1 } }],
        ["lightning regtest", { lightning: { reachable: true, network: "regtest", synced: true, blockHeight: 1 } }],
        ["lightning unknown", { lightning: { reachable: false, network: null, synced: false, blockHeight: null } }],
        ["fiber mainnet", { fiber: { reachable: true, network: "mainnet", version: "0.9.1" } }],
        ["fiber devnet", { fiber: { reachable: true, network: "devnet", version: "0.9.1" } }],
      ];
      for (const [name, patch] of variants) {
        const result = evaluateHubHealth(200, { ...healthyHealth(), ...patch });
        assert.equal(result.status, "fail", name);
        assert.match(result.next ?? "", /signet and CKB testnet/, name);
      }
    });

    it("fails a degraded hub (503) and an answer without a health body", () => {
      const degraded = evaluateHubHealth(503, { ...healthyHealth(), status: "degraded", reason: "fnn down" });
      assert.equal(degraded.status, "fail");
      assert.match(degraded.summary, /degraded/);
      const empty = evaluateHubHealth(502, null);
      assert.equal(empty.status, "fail");
      assert.match(empty.summary, /502/);
      assert.equal(empty.next, "testnet logs hub");
    });

    it("reports each asset's directions and liquidity on both sides, exactly", () => {
      const [ok] = evaluateAssets([ckbAsset(300_000n, 5_000_000_000_000n)], 20_000n);
      assert.equal(ok?.status, "ok");
      assert.match(ok?.summary ?? "", /CKB: ln_to_fiber, fiber_to_ln; payouts up to 300,000 sats \(to Lightning\) and 50,?000 CKB \(to Fiber\)/);
      const [low] = evaluateAssets([ckbAsset(19_999n)], 20_000n);
      assert.equal(low?.status, "warn");
      assert.match(low?.next ?? "", /DEPLOY_LN_LSP_CHANNEL_SATS/);
      assert.doesNotMatch(low?.next ?? "", /testnet balance/, "testnet balance lowers lnd-hub's outbound, which Lightning payouts spend");
      const [off] = evaluateAssets([{ ...ckbAsset(), directions: [] }], 20_000n);
      assert.equal(off?.status, "warn");
      assert.match(off?.summary ?? "", /no direction/);
      const none = evaluateAssets([], 20_000n);
      assert.equal(none[0]?.status, "fail");
    });

    it("does not report an asset ok when it cannot pay out on Fiber at all (liquidity both ways; the hub always lists both directions)", () => {
      // RUSD with no RUSD channel (the kit's default) can still pay Lightning payouts, but no BTC to RUSD swap can succeed.
      const [rusd] = evaluateAssets([{ ...ckbAsset(300_000n, 0n), id: "RUSD", symbol: "RUSD", name: "RUSD" }], 20_000n);
      assert.notEqual(rusd?.status, "ok", rusd?.summary);
      assert.ok(rusd?.next, "says what to do (open the asset's channels)");
    });

    it("names the asset's own way to Fiber liquidity: CKB from the scripted claim, RUSD only by hand", () => {
      const [ckb] = evaluateAssets([ckbAsset(300_000n, 0n)], 20_000n);
      assert.equal(ckb?.status, "warn");
      assert.match(ckb?.summary ?? "", /no swap to CKB can pay out on Fiber/);
      assert.match(ckb?.next ?? "", /testnet fund, then testnet channels/);
      const [rusd] = evaluateAssets([{ ...ckbAsset(300_000n, 0n), id: "RUSD", symbol: "RUSD", name: "RUSD" }], 20_000n);
      assert.match(rusd?.next ?? "", /hand step 2/);
      assert.match(rusd?.next ?? "", /DEPLOY_FIBER_RELAY_CHANNEL_RUSD/);
    });

    it("checks what browsers are told to dial: a ws address with /p2p/<peer id>", () => {
      assert.equal(evaluateFiberNodeView(fiberNodeView([`/ip4/203.0.113.7/tcp/8228/ws/p2p/${PEER_ID.FNN_HUB}`])).status, "ok");
      const noPeerId = evaluateFiberNodeView(fiberNodeView(["/ip4/203.0.113.7/tcp/8228/ws"]));
      assert.equal(noPeerId.status, "warn");
      assert.match(noPeerId.next ?? "", /FIBER_PUBLIC_WS_ADDRS/);
      assert.equal(evaluateFiberNodeView(fiberNodeView([])).status, "warn");
      const oldHub = evaluateFiberNodeView(null);
      assert.equal(oldHub.status, "warn");
      assert.match(oldHub.next ?? "", /testnet sync/);
    });
  });

  describe("the report", () => {
    const results: CheckResult[] = [
      { area: "server", status: "ok", summary: "vps: Docker Compose 2.33.1" },
      { area: "lnd-hub", status: "fail", summary: "no wallet yet", next: "testnet wallet lnd-hub" },
      { area: "server", status: "warn", summary: "ss missing", next: "install it" },
      { area: "hub", status: "ok", summary: "healthy" },
    ];

    it("groups lines by area in first-seen order, prints next under each red line and counts every status", () => {
      const text = renderReport("CKBolt testnet readiness", results);
      const lines = text.split("\n");
      assert.equal(lines[0], "CKBolt testnet readiness");
      assert.match(text, /`testnet <command>` below means: npm --prefix deploy run testnet -- <command>/);
      const server = lines.indexOf("server");
      assert.ok(server > 0 && lines.indexOf("lnd-hub") > server && lines.indexOf("hub") > lines.indexOf("lnd-hub"));
      assert.equal(lines[server + 1], "  [ OK ] vps: Docker Compose 2.33.1");
      assert.equal(lines[server + 2], "  [WARN] ss missing");
      assert.equal(lines[server + 3], "         next: install it");
      assert.ok(lines.includes("  [FAIL] no wallet yet"));
      assert.ok(lines.includes("         next: testnet wallet lnd-hub"));
      assert.equal(lines[lines.length - 1], "Summary: 2 ok, 1 warnings, 1 failing");
    });

    it("fails (exit 1) only on a failing line; warnings alone pass", () => {
      assert.equal(failed(results), true);
      assert.equal(failed(results.filter((r) => r.status !== "fail")), false);
      assert.equal(failed([]), false);
    });
  });
});

/* ------------------------------------------------------------------------------------------- runCheck */

/** A deployment where everything is ready: funded, channels open both ways, the hub healthy and serving. */
function readyDeployment(options: { demo?: boolean } = {}) {
  const server = new FakeDeployment(options);
  const settings = testSettings();
  const network = new FakeNetwork(settings);
  server.files.add(hubMacaroonPath("lnd-hub"));
  const lndHub = server.lnd["lnd-hub"];
  lndHub.confirmed = 50_000n;
  lndHub.peers = [PUBKEY.LSP];
  lndHub.channels = [lndChannel(PUBKEY.LSP, 120_000n, 100_000n)];
  const fnnHub = server.fnn["fnn-hub"];
  fnnHub.peers = settings.peers.fiberRelays.map((relay) => ({ pubkey: relay.pubkey, address: relay.address }));
  fnnHub.channels = settings.peers.fiberRelays.map((relay) => fnnChannel(relay.pubkey, 1_000n * CKB, 0n));
  network.capacities.set(fnnHub.lock.args, 30_000n * CKB);
  if (options.demo) {
    server.files.add(hubMacaroonPath("lnd-demo"));
    const lndDemo = server.lnd["lnd-demo"];
    lndDemo.channels = [lndChannel(PUBKEY.LND_HUB, 150_000n, 0n)];
    const fnnDemo = server.fnn["fnn-demo"];
    fnnDemo.channels = [fnnChannel(PUBKEY.FNN_HUB, 10_000n * CKB, 10_000n * CKB)];
    fnnHub.channels.push(fnnChannel(PUBKEY.FNN_DEMO, 10_000n * CKB, 10_000n * CKB));
    network.capacities.set(fnnDemo.lock.args, 2_000n * CKB);
    server.hub.health = { ...healthyHealth(), demo: { enabled: true } };
  }
  const { ctx, logger } = testContext({ settings, runner: server.runner, http: network.http });
  return { server, network, ctx, logger, settings };
}

const linesOf = (results: readonly CheckResult[], area: string) => results.filter((result) => result.area === area);
const find = (results: readonly CheckResult[], area: string, pattern: RegExp) =>
  results.find((result) => result.area === area && pattern.test(result.summary));

describe("testnet:check on a deployment (fake server)", () => {
  it("is all green on a ready deployment and covers every part the spec lists", async () => {
    const { ctx } = readyDeployment();
    const results = await runCheck(ctx);
    const red = results.filter((result) => result.status !== "ok");
    assert.deepEqual(red, [], "a ready deployment has no warning or failure");
    assert.ok(find(results, "server", /Docker Compose 2\.33\.1/));
    assert.ok(find(results, "bitcoind", /synced at block 2000000/));
    assert.ok(find(results, "lnd-hub", /wallet unlocked/));
    assert.ok(find(results, "lnd-hub", /synced: block 2000000/));
    assert.ok(find(results, "lnd-hub", /connected to the Megalith LSP/));
    assert.ok(find(results, "lnd-hub", /channel to the Megalith LSP: 120,000 sats outbound, 100,000 sats inbound/), "LND channel local/remote balances");
    assert.ok(find(results, "fnn-hub", /fnn 0\.9\.1 on CKB testnet/));
    assert.ok(find(results, "fnn-hub", /peer \/dns4\/bottle\.fiber\.channel/), "fnn peers");
    assert.ok(find(results, "fnn-hub", /CKB channel to \/dns4\/bracer\.fiber\.channel.*ready, 1,?000 CKB outbound/), "fnn channels");
    assert.ok(find(results, "fnn-hub", /wallet holds 30,?000 CKB on chain/));
    assert.ok(find(results, "hub", /hub 0\.3\.0 ok/), "/v1/health");
    assert.ok(find(results, "hub", /CKB: ln_to_fiber, fiber_to_ln/), "/v1/assets");
    assert.ok(find(results, "hub", /listens on 127\.0\.0\.1:18787/));
    assert.ok(find(results, "faucets", /Mutinynet faucet https:\/\/faucet\.mutinynet\.com answers/));
    assert.equal(failed(results), false);
  });

  it("only reads: no wallet, address, invoice, claim, channel, payment or container change", async () => {
    const { ctx, server, network } = readyDeployment({ demo: true });
    await runCheck(ctx);
    assert.deepEqual(server.composeCommands, [], "no up, stop, restart, build or cp");
    for (const node of Object.values(server.lnd)) assert.deepEqual(node.mutatingCalls(), [], `${node.service}: lncli calls that change the node`);
    for (const node of Object.values(server.fnn)) assert.deepEqual(node.mutatingCalls(), [], `${node.service}: fnn calls that change the node`);
    assert.ok(server.hub.requests.every((request) => request.method === "GET"), "the hub is only asked with GET");
    assert.deepEqual(network.claims(), [], "no CKB faucet claim");
    assert.deepEqual(network.faucetInvoiceAmounts(), [], "no faucet invoice");
    for (const script of server.runner.scripts()) {
      assert.doesNotMatch(script, /\b(rm|mkdir|chmod|chown|mv)\b|cat >|docker compose (up|down|stop|start|restart|build|cp|rm)\b/, script);
    }
  });

  it("checks the demo nodes only when the demo profile runs them", async () => {
    const without = readyDeployment();
    const plain = await runCheck(without.ctx);
    assert.deepEqual(linesOf(plain, "lnd-demo"), []);
    assert.deepEqual(linesOf(plain, "fnn-demo"), []);
    const withDemo = readyDeployment({ demo: true });
    const results = await runCheck(withDemo.ctx);
    assert.ok(find(results, "lnd-demo", /channel to lnd-hub: 150,000 sats outbound/));
    assert.ok(find(results, "fnn-demo", /CKB channel with fnn-hub: ready, 10,?000 CKB outbound, 10,?000 CKB inbound/));
    assert.ok(find(results, "hub", /demo wallet on/));
    assert.deepEqual(results.filter((r) => r.status !== "ok"), []);
  });

  it("stops after one failing line when ssh or Docker Compose does not answer, and says what to check", async () => {
    const { ctx, server } = readyDeployment();
    server.composeVersion = null;
    const results = await runCheck(ctx);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.status, "fail");
    assert.equal(results[0]?.area, "server");
    assert.match(results[0]?.next ?? "", /DEPLOY_SSH_HOST/);
    assert.equal(server.runner.calls.length, 1, "nothing else is tried");
  });

  it("stops when the kit is not on the server yet, pointing at sync and env", async () => {
    const { ctx, server } = readyDeployment();
    server.files.delete("hub.env");
    const results = await runCheck(ctx);
    const last = results[results.length - 1];
    assert.equal(last?.status, "fail");
    assert.match(last?.summary ?? "", /\/opt\/ckbolt\/testnet\/hub\.env missing/);
    assert.equal(last?.next, "testnet sync, then testnet env");
    assert.ok(!results.some((result) => result.area === "hub"));
  });

  it("warns about missing server tools with the package to install", async () => {
    const { ctx, server } = readyDeployment();
    server.tools.delete("ss");
    server.tools.delete("curl");
    const results = await runCheck(ctx);
    assert.match(find(results, "server", /ss missing/)?.next ?? "", /apt-get install iproute2/);
    assert.match(find(results, "server", /curl missing/)?.next ?? "", /apt-get install curl/);
  });

  it("reports the bitcoind sync percentage during the first sync", async () => {
    const { ctx, server } = readyDeployment();
    server.bitcoind = { ...server.bitcoind, blocks: 1_234_567, headers: 2_000_000, verificationprogress: 0.61729, initialblockdownload: true };
    const results = await runCheck(ctx);
    const line = find(results, "bitcoind", /syncing Mutinynet/);
    assert.equal(line?.status, "warn");
    assert.match(line?.summary ?? "", /61\.73% verified, block 1234567 of 2000000/);
  });

  it("asks for `testnet wallet` when LND has no wallet, and asks it nothing else", async () => {
    const { ctx, server } = readyDeployment();
    server.lnd["lnd-hub"].state = "NON_EXISTING";
    const results = await runCheck(ctx);
    const lnd = linesOf(results, "lnd-hub").filter((line) => !/^running/.test(line.summary));
    assert.equal(lnd.length, 1, "only the wallet line, besides the container's");
    assert.equal(lnd[0]?.next, "testnet wallet lnd-hub");
    assert.deepEqual(server.lnd["lnd-hub"].calls, [["state"]]);
  });

  it("names the next step for an LND without its channel to the LSP, the LSP as a peer or a macaroon", async () => {
    const { ctx, server } = readyDeployment();
    server.lnd["lnd-hub"].channels = [];
    server.lnd["lnd-hub"].peers = [];
    server.files.delete(hubMacaroonPath("lnd-hub"));
    const results = await runCheck(ctx);
    assert.match(find(results, "lnd-hub", /channel to the Megalith LSP: none/)?.next ?? "", /testnet channels/);
    assert.match(find(results, "lnd-hub", /not connected to the Megalith LSP/)?.next ?? "", /testnet channels/);
    assert.equal(find(results, "lnd-hub", /no macaroon for the hub/)?.next, "testnet macaroons");
    assert.equal(failed(results), true);
    assertEveryRedLineHasNext(results);
  });

  it("warns about low inbound liquidity with `testnet balance`, and low outbound with a larger channel", async () => {
    const { ctx, server } = readyDeployment();
    server.lnd["lnd-hub"].channels = [lndChannel(PUBKEY.LSP, 220_000n, 0n)];
    const line = find(await runCheck(ctx), "lnd-hub", /inbound below/);
    assert.equal(line?.status, "warn");
    assert.equal(line?.next, "testnet balance");
    server.lnd["lnd-hub"].channels = [lndChannel(PUBKEY.LSP, 0n, 220_000n)];
    const low = find(await runCheck(ctx), "lnd-hub", /outbound below/);
    assert.equal(low?.status, "warn");
    assert.match(low?.next ?? "", /DEPLOY_LN_LSP_CHANNEL_SATS/);
  });

  it("fails an fnn on CKB mainnet", async () => {
    const { ctx, server } = readyDeployment();
    server.fnn["fnn-hub"].chainHash = CKB_GENESIS_HASH.mainnet;
    const results = await runCheck(ctx);
    assert.equal(find(results, "fnn-hub", /runs on CKB mainnet/)?.status, "fail");
    assert.equal(failed(results), true);
  });

  it("fails a hub published on every interface, and a hub that reports mainnet", async () => {
    const exposed = readyDeployment();
    exposed.server.containers.set("hub", { State: "running", Health: "healthy", Publishers: [{ URL: "0.0.0.0", TargetPort: 8787, PublishedPort: 18787 }] });
    assert.equal(find(await runCheck(exposed.ctx), "hub", /published on 0\.0\.0\.0:18787/)?.status, "fail");
    const mainnet = readyDeployment();
    mainnet.server.hub.health = { ...healthyHealth(), lightning: { reachable: true, network: "mainnet", synced: true, blockHeight: 900_000 } };
    assert.equal(linesOf(await runCheck(mainnet.ctx), "hub").find((r) => /Lightning mainnet/.test(r.summary))?.status, "fail");
  });

  it("does not stop at a part that cannot be read: the line fails with the error and the next parts are still checked", async () => {
    const { ctx, server } = readyDeployment();
    server.fnn["fnn-hub"].overrides.node_info = () => new Error("connection reset");
    const results = await runCheck(ctx);
    const broken = linesOf(results, "fnn-hub").filter((line) => !/^running/.test(line.summary));
    assert.equal(broken.length, 1, "one failing line for the part, besides the container's");
    assert.equal(broken[0]?.status, "fail");
    assert.match(broken[0]?.summary ?? "", /could not read: .*connection reset/);
    assert.equal(broken[0]?.next, "testnet logs fnn-hub");
    assert.ok(find(results, "hub", /hub 0\.3\.0 ok/), "the hub is still checked");
    assert.ok(find(results, "faucets", /answers/), "the faucet is still checked");
  });

  it("skips a stopped node's probes and fails its container line", async () => {
    const { ctx, server } = readyDeployment();
    server.containers.set("hub", { State: "exited", Health: "", Publishers: [] });
    const results = await runCheck(ctx);
    const hubLines = linesOf(results, "hub");
    assert.equal(hubLines.length, 1);
    assert.equal(hubLines[0]?.status, "fail");
    assert.equal(server.hub.requests.length, 0, "the hub API is not called while the hub is down");
  });

  it("warns when the faucet does not answer, and when the hub gives browsers no peer id", async () => {
    const { ctx, server, network } = readyDeployment();
    network.faucetHomeStatus = 503;
    server.hub.fiberNode = fiberNodeView(["/ip4/203.0.113.7/tcp/8228/ws"]);
    const results = await runCheck(ctx);
    assert.equal(find(results, "faucets", /HTTP 503/)?.status, "warn");
    assert.equal(find(results, "hub", /no \/p2p\/<peer id>/)?.status, "warn");
    assert.equal(failed(results), false, "warnings alone do not fail the check");
  });

  it("asks the RUSD channel only when RUSD channels are configured", async () => {
    const settings = testSettings({ DEPLOY_FIBER_RELAY_CHANNEL_RUSD: "100" });
    const server = new FakeDeployment();
    const network = new FakeNetwork(settings);
    const { ctx } = testContext({ settings, runner: server.runner, http: network.http });
    const results = await runCheck(ctx);
    const rusd = find(results, "fnn-hub", /RUSD channel to \/dns4\/bottle/);
    assert.equal(rusd?.status, "fail");
    assert.match(rusd?.next ?? "", /hand step 2/);
    assert.ok(!(await runCheck(readyDeployment().ctx)).some((r) => /RUSD channel/.test(r.summary)));
  });

  it("gives every warning and failure a next action, whatever is broken", async () => {
    const { ctx, server, network } = readyDeployment({ demo: true });
    server.tools.clear();
    server.bitcoind = { ...server.bitcoind, initialblockdownload: true, blocks: 5, verificationprogress: 0.001 };
    server.lnd["lnd-hub"].synced = false;
    server.lnd["lnd-hub"].channels = [];
    server.lnd["lnd-hub"].peers = [];
    server.lnd["lnd-demo"].state = "LOCKED";
    server.fnn["fnn-hub"].peers = [];
    server.fnn["fnn-hub"].channels = [];
    server.fnn["fnn-hub"].addresses = [];
    server.fnn["fnn-demo"].channels = [fnnChannel(PUBKEY.FNN_HUB, 1n, 0n, { state: "NegotiatingFunding" })];
    server.containers.set("fnn-demo", { State: "running", Health: "starting", Publishers: [] });
    server.hub.health = { ...healthyHealth(), status: "degraded" };
    server.hub.assets = [{ ...ckbAsset(0n, 0n), directions: [] }];
    server.hub.fiberNode = null;
    network.capacities.clear();
    network.faucetHomeStatus = 500;
    const results = await runCheck(ctx);
    assert.ok(results.filter((r) => r.status !== "ok").length >= 12, "many parts are red");
    assertEveryRedLineHasNext(results);
  });

  it("finds the LSP from the settings, not a hard-coded key", async () => {
    const other = `03${"ef".repeat(32)}`;
    const settings = testSettings({ DEPLOY_LN_LSP_NODE: `${other}@198.51.100.9:9735` });
    const server = new FakeDeployment();
    server.lnd["lnd-hub"].peers = [other];
    server.lnd["lnd-hub"].channels = [lndChannel(other, 100_000n, 100_000n)];
    const network = new FakeNetwork(settings);
    const { ctx } = testContext({ settings, runner: server.runner, http: network.http });
    const results = await runCheck(ctx);
    assert.equal(find(results, "lnd-hub", /channel to the Megalith LSP/)?.status, "ok");
    assert.notEqual(other, MUTINYNET_LSP.NODE.split("@")[0]);
  });
});
