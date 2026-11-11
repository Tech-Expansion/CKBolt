import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TESTNET_RUSD_TYPE_SCRIPT } from "../../src/common/constants/assets.constants";
import { ckbAddress } from "../scripts/lib/ckb-address";
import { CKB_FAUCET, MUTINYNET_FAUCET, RUSD_FAUCET_URL } from "../scripts/lib/constants";
import { resolveDeployPaths } from "../scripts/lib/paths";
import { readFundingAddresses, showAddresses } from "../scripts/steps/addresses.step";
import { balanceLightning, balancingInvoiceCount } from "../scripts/steps/balance.step";
import { openChannels } from "../scripts/steps/channels.step";
import { fund } from "../scripts/steps/fund.step";
import { handSteps, lndHubOnchainNeed } from "../scripts/steps/hand-steps";
import { FakeDeployment, fnnChannel, lndChannel, PEER_ID, PUBKEY } from "./support/fake-deployment";
import { FakeNetwork } from "./support/fake-network";
import { result, testContext, testSettings } from "./support/fakes";

const CKB = 100_000_000n;
const RUSD = 100_000_000n;
const sha256 = (hex: string): string => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");

function setup(options: { demo?: boolean; settings?: Record<string, string> } = {}) {
  const server = new FakeDeployment({ demo: options.demo ?? false });
  const settings = testSettings(options.settings);
  const network = new FakeNetwork(settings);
  const context = testContext({ settings, runner: server.runner, http: network.http });
  // The relay nodes answer fnn-hub's dial; fnn-hub answers fnn-demo's on the Docker network.
  for (const relay of settings.peers.fiberRelays) server.fnn["fnn-hub"].reachable.set(relay.address, relay.pubkey);
  server.fnn["fnn-demo"].reachable.set(`/dns4/fnn-hub/tcp/8228/p2p/${PEER_ID.FNN_HUB}`, PUBKEY.FNN_HUB);
  return { server, network, settings, ...context };
}

const hubLock = (server: FakeDeployment) => server.fnn["fnn-hub"].lock;
const demoLock = (server: FakeDeployment) => server.fnn["fnn-demo"].lock;
const lncliCalls = (server: FakeDeployment, service: "lnd-hub" | "lnd-demo", subcommand: string) =>
  server.lnd[service].calls.filter((call) => call[0] === subcommand);

/** fnn-hub's open_channel adds the channel (ready at once, all on fnn-hub's side), as fnn lists it once confirmed. */
function openChannelsReadyAtOnce(server: FakeDeployment): void {
  const hub = server.fnn["fnn-hub"];
  hub.overrides.open_channel = (params) => {
    const request = params[0] as { pubkey: string; funding_amount: string; funding_udt_type_script?: { code_hash: string; hash_type: string; args: string } };
    hub.channels.push(fnnChannel(request.pubkey, BigInt(request.funding_amount), 0n, { udt: request.funding_udt_type_script ?? null }));
    return { temporary_channel_id: `0x${"7".repeat(64)}` };
  };
}

describe("funding addresses", () => {
  it("gives a fresh Mutinynet address per LND and the CKB testnet address of each fnn wallet", async () => {
    const { ctx, server } = setup({ demo: true });
    const addresses = await readFundingAddresses(ctx);
    assert.deepEqual(
      addresses.lnd.map((node) => [node.service, node.pubkey, node.address]),
      [
        ["lnd-hub", PUBKEY.LND_HUB, "tb1plndhub1"],
        ["lnd-demo", PUBKEY.LND_DEMO, "tb1plnddemo1"],
      ],
    );
    assert.deepEqual(lncliCalls(server, "lnd-hub", "newaddress"), [["newaddress", "p2tr"]]);
    assert.deepEqual(
      addresses.fnn.map((node) => [node.service, node.address]),
      [
        ["fnn-hub", ckbAddress(hubLock(server), "testnet")],
        ["fnn-demo", ckbAddress(demoLock(server), "testnet")],
      ],
    );
    for (const node of addresses.fnn) assert.match(node.address, /^ckt1/, "testnet addresses only");
  });

  it("covers only the nodes the deployment runs, and leaves out (with a warning) a node that does not answer", async () => {
    const { ctx, server, logger } = setup();
    server.lnd["lnd-hub"].state = null;
    server.containers.set("lnd-hub", { State: "exited", Health: "", Publishers: [] });
    const addresses = await readFundingAddresses(ctx);
    assert.deepEqual(addresses.lnd, []);
    assert.deepEqual(addresses.fnn.map((node) => node.service), ["fnn-hub"]);
    assert.match(logger.warnings().join("\n"), /lnd-hub gave no address .*start it and create its wallet first/);
    await showAddresses(ctx);
    assert.match(logger.text(), /fnn-hub: CKB testnet ckt1/);
  });
});

describe("testnet fund", () => {
  it("claims testnet CKB for fnn-hub's address with the claim size of the settings when it holds less than its minimum", async () => {
    const { ctx, server, network, logger } = setup();
    network.capacities.set(hubLock(server).args, 24_999n * CKB);
    await fund(ctx);
    assert.deepEqual(network.claims(), [{ address: ckbAddress(hubLock(server), "testnet"), amount: "100000" }]);
    assert.ok((CKB_FAUCET.CLAIM_AMOUNTS as readonly string[]).includes(network.claims()[0]?.amount ?? ""), "one of the faucet's two claim sizes");
    assert.match(logger.text(), /fnn-hub holds 24,?999 CKB: claimed 100000 CKB/);
  });

  it("claims nothing for a wallet that holds its minimum (a re-run does not spend the monthly faucet cap)", async () => {
    const { ctx, server, network, logger } = setup();
    network.capacities.set(hubLock(server).args, 25_000n * CKB);
    await fund(ctx);
    assert.deepEqual(network.claims(), []);
    assert.match(logger.text(), /fnn-hub holds 25,?000 CKB \(at least 25,?000 CKB\): no claim/);
  });

  it("warns with the hand step when the CKB faucet refuses, and goes on with the other node", async () => {
    const { ctx, network, logger } = setup({ demo: true });
    network.claimStatus = 429;
    await fund(ctx);
    assert.equal(network.claims().length, 2, "both wallets are tried");
    assert.match(logger.warnings().join("\n"), /fnn-hub: the CKB faucet answered HTTP 429 .*claim by hand \(hand step 3\)/);
  });

  it("sends lnd-demo exactly DEPLOY_LN_DEMO_WALLET_SATS from lnd-hub, to lnd-demo's own address, and claims for fnn-demo", async () => {
    const { ctx, server, network } = setup({ demo: true });
    server.lnd["lnd-hub"].confirmed = 1_000_000n;
    network.capacities.set(hubLock(server).args, 50_000n * CKB);
    await fund(ctx);
    assert.deepEqual(lncliCalls(server, "lnd-hub", "sendcoins"), [["sendcoins", "--addr=tb1plnddemo1", "--amt=200000"]]);
    assert.deepEqual(network.claims(), [{ address: ckbAddress(demoLock(server), "testnet"), amount: "10000" }]);
    assert.deepEqual(lncliCalls(server, "lnd-demo", "sendcoins"), [], "the demo wallet never sends");
  });

  it("does not fund lnd-demo again once it has its channel or holds enough on chain", async () => {
    const hasChannel = setup({ demo: true });
    hasChannel.server.lnd["lnd-hub"].confirmed = 1_000_000n;
    hasChannel.server.lnd["lnd-demo"].channels = [lndChannel(PUBKEY.LND_HUB, 150_000n, 0n)];
    await fund(hasChannel.ctx);
    assert.deepEqual(lncliCalls(hasChannel.server, "lnd-hub", "sendcoins"), []);

    const holds = setup({ demo: true });
    holds.server.lnd["lnd-hub"].confirmed = 1_000_000n;
    holds.server.lnd["lnd-demo"].unconfirmed = 170_000n;
    await fund(holds.ctx);
    assert.deepEqual(lncliCalls(holds.server, "lnd-hub", "sendcoins"), [], "unconfirmed coins on their way count");
  });

  it("asks for hand step 1 instead of sending when lnd-hub lacks the sats", async () => {
    const { ctx, server, logger } = setup({ demo: true });
    server.lnd["lnd-hub"].confirmed = 219_999n;
    await fund(ctx);
    assert.deepEqual(lncliCalls(server, "lnd-hub", "sendcoins"), []);
    assert.match(logger.warnings().join("\n"), /lnd-hub has 219999 confirmed sats, less than the 220000 needed: do hand step 1/);
  });

  it("never touches the Lightning wallets without the demo profile (no sendcoins, no channel)", async () => {
    const { ctx, server } = setup();
    server.lnd["lnd-hub"].confirmed = 1_000_000n;
    await fund(ctx);
    assert.deepEqual(
      server.lnd["lnd-hub"].mutatingCalls().map((call) => call[0]),
      ["newaddress"],
    );
  });

  it("ends with the hand steps, addresses filled in", async () => {
    const { ctx, server, logger } = setup();
    await fund(ctx);
    const text = logger.text();
    assert.match(text, /Hand steps \(a script may not do these\):/);
    assert.match(text, new RegExp(`On-chain": send 240,000 sats to tb1plndhub\\d`));
    assert.ok(text.includes(ckbAddress(hubLock(server), "testnet")));
  });
});

describe("hand steps", () => {
  const settings = testSettings();
  const addresses = {
    lnd: [
      { service: "lnd-hub" as const, pubkey: PUBKEY.LND_HUB, address: "tb1phub", uris: [] },
      { service: "lnd-demo" as const, pubkey: PUBKEY.LND_DEMO, address: "tb1pdemo", uris: [] },
    ],
    fnn: [
      { service: "fnn-hub" as const, pubkey: PUBKEY.FNN_HUB, address: "ckt1qhub", lock: { code_hash: "0x", hash_type: "type", args: "0x" } },
      { service: "fnn-demo" as const, pubkey: PUBKEY.FNN_DEMO, address: "ckt1qdemo", lock: { code_hash: "0x", hash_type: "type", args: "0x" } },
    ],
  };

  it("plans lnd-hub's funding within one day of the Mutinynet faucet (LSP channel, push included, + demo wallet + reserve)", () => {
    assert.equal(lndHubOnchainNeed(settings, false), 240_000n);
    assert.equal(lndHubOnchainNeed(settings, true), 440_000n);
    assert.ok(lndHubOnchainNeed(settings, true) <= MUTINYNET_FAUCET.DAILY_BUDGET_SATS, "the plan's one-day budget");
  });

  it("names the GitHub login on the Mutinynet faucet, the RUSD claim with JoyID and the CKB faucet fallback, with the addresses", () => {
    const text = handSteps(settings, addresses).join("\n");
    assert.ok(text.includes(MUTINYNET_FAUCET.URL));
    assert.match(text, /log in with GitHub/);
    assert.match(text, /send 440,000 sats to tb1phub/);
    assert.match(text, /1,000,000 sats per 24 h/);
    assert.ok(text.includes(RUSD_FAUCET_URL));
    assert.match(text, /connect JoyID/);
    assert.match(text, /send the RUSD to fnn-hub: ckt1qhub/);
    assert.match(text, /to fnn-demo: ckt1qdemo/);
    assert.ok(text.includes(`${CKB_FAUCET.WEB_URL} for ckt1qhub`));
    assert.match(text, /npm --prefix deploy run testnet -- channels/);
  });

  it("leaves the demo out without the demo nodes, and says how to get a missing address", () => {
    const text = handSteps(settings, { lnd: [], fnn: [] }).join("\n");
    assert.match(text, /send 240,000 sats to \(start the node and run `testnet addresses`\)/);
    assert.doesNotMatch(text, /fnn-demo/);
  });

  it("matches the runbook's numbers", () => {
    const readme = readFileSync(join(resolveDeployPaths().deployDir, "README.md"), "utf8");
    assert.match(readme, /440,000 sats with the demo profile, 240,000 without/);
  });
});

describe("testnet channels", () => {
  it("opens lnd-hub -> the Megalith LSP (private, part pushed) and fnn-hub -> bottle and bracer, with the exact amounts of the settings", async () => {
    const { ctx, server, settings, logger } = setup();
    server.lnd["lnd-hub"].confirmed = 1_000_000n;
    await openChannels(ctx);

    const lsp = settings.peers.lnLspNode;
    assert.equal(lsp.address, "64.23.192.68:9736");
    assert.deepEqual(lncliCalls(server, "lnd-hub", "connect"), [["connect", `${lsp.pubkey}@${lsp.address}`]]);
    assert.deepEqual(lncliCalls(server, "lnd-hub", "openchannel"), [
      ["openchannel", `--node_key=${lsp.pubkey}`, "--local_amt=220000", "--push_amt=100000", "--private"],
    ]);
    assert.deepEqual(
      server.lnd["lnd-hub"].pending.map((entry) => entry.channel),
      [{ remote_node_pub: lsp.pubkey, capacity: "220000", local_balance: "120000", remote_balance: "100000" }],
    );
    assert.match(logger.text(), /lnd-hub -> the Megalith LSP: opening a private channel of 220000 sats, 100000 pushed to the peer/);

    const fnnHub = server.fnn["fnn-hub"];
    assert.deepEqual(
      fnnHub.callsOf("connect_peer").map((call) => call.params[0]),
      settings.peers.fiberRelays.map((relay) => ({ address: relay.address, save: true })),
      "dials each relay and saves it for restarts",
    );
    const opens = fnnHub.callsOf("open_channel").map((call) => call.params[0] as Record<string, unknown>);
    assert.deepEqual(
      opens.map((open) => open.pubkey),
      [PUBKEY.BOTTLE, PUBKEY.BRACER],
    );
    for (const open of opens) {
      assert.equal(BigInt(open.funding_amount as string), 1_000n * CKB);
      assert.equal(open.public, true, "public channels, so the hub's node is reachable through the relays");
      assert.equal(open.funding_udt_type_script, undefined);
    }
  });

  it("opens the LSP channel with the size and push of the settings, and pushes nothing when the push is 0", async () => {
    const { ctx, server, settings } = setup({ settings: { DEPLOY_LN_LSP_CHANNEL_SATS: "300000", DEPLOY_LN_LSP_PUSH_SATS: "0" } });
    server.lnd["lnd-hub"].confirmed = 1_000_000n;
    await openChannels(ctx);
    assert.deepEqual(lncliCalls(server, "lnd-hub", "openchannel"), [["openchannel", `--node_key=${settings.peers.lnLspNode.pubkey}`, "--local_amt=300000", "--private"]]);
  });

  it("counts an open channel with the LSP as open, whatever its size: nothing is opened twice", async () => {
    const { ctx, server, settings, logger } = setup();
    server.lnd["lnd-hub"].confirmed = 1_000_000n;
    server.lnd["lnd-hub"].channels = [lndChannel(settings.peers.lnLspNode.pubkey, 500_000n, 0n)];
    await openChannels(ctx);
    assert.deepEqual(lncliCalls(server, "lnd-hub", "openchannel"), []);
    assert.match(logger.text(), /lnd-hub -> the Megalith LSP: open$/m);
  });

  it("opens nothing that exists or is opening: a second run changes nothing", async () => {
    const { ctx, server, settings, logger } = setup();
    server.lnd["lnd-hub"].confirmed = 1_000_000n;
    const lsp = settings.peers.lnLspNode.pubkey;
    server.lnd["lnd-hub"].pending = [{ channel: { remote_node_pub: lsp, capacity: "220000", local_balance: "120000", remote_balance: "100000" } }];
    const fnnHub = server.fnn["fnn-hub"];
    fnnHub.peers = settings.peers.fiberRelays.map((relay) => ({ pubkey: relay.pubkey, address: relay.address }));
    fnnHub.channels = settings.peers.fiberRelays.map((relay) => fnnChannel(relay.pubkey, 1_000n * CKB, 0n, { state: "AwaitingChannelReady" }));
    await openChannels(ctx);
    assert.deepEqual(lncliCalls(server, "lnd-hub", "openchannel"), []);
    assert.deepEqual(fnnHub.callsOf("open_channel"), []);
    assert.deepEqual(fnnHub.callsOf("connect_peer"), [], "connected peers are not dialled again");
    assert.match(logger.text(), /lnd-hub -> the Megalith LSP: opening \(waiting for confirmations\)/);
    assert.match(logger.text(), /fnn-hub -> bottle\.fiber\.channel \(CKB\): AwaitingChannelReady/);
  });

  it("does not open a Lightning channel lnd-hub cannot fund with its reserve, and says to fund it", async () => {
    const { ctx, server, logger } = setup();
    server.lnd["lnd-hub"].confirmed = 239_999n;
    await openChannels(ctx);
    assert.deepEqual(lncliCalls(server, "lnd-hub", "openchannel"), []);
    assert.match(logger.warnings().join("\n"), /lnd-hub has 239999 confirmed sats, needs 240000\. Fund it \(testnet fund\)/);
  });

  it("opens the RUSD relay channel only when configured, to the first relay only, with the RUSD type script", async () => {
    const { ctx, server } = setup({ settings: { DEPLOY_FIBER_RELAY_CHANNEL_RUSD: "100" } });
    await openChannels(ctx);
    const opens = server.fnn["fnn-hub"].callsOf("open_channel").map((call) => call.params[0] as Record<string, unknown>);
    const rusd = opens.filter((open) => open.funding_udt_type_script !== undefined);
    assert.equal(rusd.length, 1);
    assert.equal(rusd[0]?.pubkey, PUBKEY.BOTTLE);
    assert.equal(BigInt(rusd[0]?.funding_amount as string), 100n * RUSD);
    assert.deepEqual(rusd[0]?.funding_udt_type_script, {
      code_hash: TESTNET_RUSD_TYPE_SCRIPT.codeHash,
      hash_type: TESTNET_RUSD_TYPE_SCRIPT.hashType,
      args: TESTNET_RUSD_TYPE_SCRIPT.args,
    });
  });

  it("warns and goes on when fnn cannot open a channel (wallet not funded yet)", async () => {
    const { ctx, server, logger } = setup();
    server.fnn["fnn-hub"].overrides.open_channel = () => new Error("Not enough CKB capacity");
    await openChannels(ctx);
    const warnings = logger.warnings().join("\n");
    assert.match(warnings, /fnn-hub -> bottle\.fiber\.channel \(CKB\): not opened \(.*Not enough CKB capacity\)\. Fund fnn-hub/);
    assert.match(warnings, /fnn-hub -> bracer\.fiber\.channel \(CKB\): not opened/);
  });

  it("stops with a timeout when a relay never answers the dial", async () => {
    const { ctx, server } = setup();
    server.fnn["fnn-hub"].reachable.clear();
    await assert.rejects(openChannels(ctx), /Timed out after 10 s waiting for fnn-hub to connect to \/dns4\/bottle\.fiber\.channel/);
  });

  describe("with the demo wallet", () => {
    function demoSetup(settings: Record<string, string> = {}) {
      const context = setup({ demo: true, settings });
      const { server } = context;
      server.lnd["lnd-hub"].confirmed = 1_000_000n;
      server.lnd["lnd-demo"].confirmed = 200_000n;
      openChannelsReadyAtOnce(server);
      return context;
    }

    it("opens lnd-demo -> lnd-hub over the Docker network, and fnn-hub -> fnn-demo dialled by the hub's announced peer id", async () => {
      const { ctx, server } = demoSetup();
      await openChannels(ctx);
      assert.deepEqual(lncliCalls(server, "lnd-demo", "connect"), [["connect", `${PUBKEY.LND_HUB}@lnd-hub:9735`]]);
      assert.deepEqual(lncliCalls(server, "lnd-demo", "openchannel"), [["openchannel", `--node_key=${PUBKEY.LND_HUB}`, "--local_amt=150000"]]);
      assert.deepEqual(
        server.fnn["fnn-demo"].callsOf("connect_peer").map((call) => call.params[0]),
        [{ address: `/dns4/fnn-hub/tcp/8228/p2p/${PEER_ID.FNN_HUB}`, save: true }],
      );
      const toDemo = server.fnn["fnn-hub"].callsOf("open_channel").map((call) => call.params[0] as Record<string, unknown>).filter((open) => open.pubkey === PUBKEY.FNN_DEMO);
      assert.equal(toDemo.length, 1, "the hub opens the demo channel (it would refund payments over a channel the peer opened)");
      assert.equal(BigInt(toDemo[0]?.funding_amount as string), 20_000n * CKB);
      assert.deepEqual(server.fnn["fnn-demo"].callsOf("open_channel"), [], "fnn-demo never opens a channel to the hub");
    });

    it("moves exactly DEPLOY_FIBER_DEMO_SHARE_BPS of the demo channel to fnn-demo with one invoice fnn-demo makes", async () => {
      const { ctx, server } = demoSetup();
      await openChannels(ctx);
      const invoices = server.fnn["fnn-demo"].callsOf("new_invoice").map((call) => call.params[0] as Record<string, string>);
      assert.equal(invoices.length, 1);
      assert.equal(BigInt(invoices[0]?.amount ?? "0"), 10_000n * CKB, "half of 20,000 CKB");
      const preimage = (invoices[0]?.payment_preimage ?? "").replace(/^0x/, "");
      assert.deepEqual(
        server.fnn["fnn-hub"].callsOf("send_payment").map((call) => call.params[0]),
        [{ invoice: `fibt1${sha256(preimage)}` }],
      );
      assert.ok(server.fnn["fnn-hub"].callsOf("get_payment").every((call) => (call.params[0] as { payment_hash: string }).payment_hash === `0x${sha256(preimage)}`));
    });

    it("tops fnn-demo up only to its share, and not at all when it holds it", async () => {
      const partly = demoSetup({ DEPLOY_FIBER_DEMO_SHARE_BPS: "2500" });
      partly.server.fnn["fnn-hub"].channels.push(fnnChannel(PUBKEY.FNN_DEMO, 18_000n * CKB, 2_000n * CKB));
      await openChannels(partly.ctx);
      const [invoice] = partly.server.fnn["fnn-demo"].callsOf("new_invoice").map((call) => call.params[0] as Record<string, string>);
      assert.equal(BigInt(invoice?.amount ?? "0"), 3_000n * CKB, "25% of 20,000 CKB is 5,000; fnn-demo already holds 2,000");

      const balanced = demoSetup();
      balanced.server.fnn["fnn-hub"].channels.push(fnnChannel(PUBKEY.FNN_DEMO, 10_000n * CKB, 10_000n * CKB));
      await openChannels(balanced.ctx);
      assert.deepEqual(balanced.server.fnn["fnn-demo"].callsOf("new_invoice"), []);
      assert.deepEqual(balanced.server.fnn["fnn-hub"].callsOf("send_payment"), []);
    });

    it("retries the balancing payment while the new channel reaches fnn's graph, then gives up after DEPLOY_FIBER_PAYMENT_ATTEMPTS", async () => {
      const { ctx, server, clock } = demoSetup();
      let failures = 2;
      server.fnn["fnn-hub"].overrides.send_payment = (params) => {
        if (failures-- > 0) return new Error("Failed to build route");
        return { payment_hash: `0x${String((params[0] as { invoice: string }).invoice).replace(/^fibt1/, "")}`, status: "Created" };
      };
      await openChannels(ctx);
      assert.equal(server.fnn["fnn-demo"].callsOf("new_invoice").length, 3, "a fresh invoice per attempt");
      assert.ok(clock.sleeps.filter((ms) => ms === ctx.settings.timeouts.pollIntervalMs).length >= 2);

      const stuck = demoSetup({ DEPLOY_FIBER_PAYMENT_ATTEMPTS: "2" });
      stuck.server.fnn["fnn-hub"].overrides.send_payment = () => new Error("Failed to build route");
      await assert.rejects(openChannels(stuck.ctx), /fnn-hub could not pay fnn-demo: .*Failed to build route/);
      assert.equal(stuck.server.fnn["fnn-demo"].callsOf("new_invoice").length, 2);
    });

    it("counts a payment that ends Failed as a failed attempt", async () => {
      const { ctx, server } = demoSetup({ DEPLOY_FIBER_PAYMENT_ATTEMPTS: "1" });
      server.fnn["fnn-hub"].overrides.get_payment = () => ({ payment_hash: "0x", status: "Failed", failed_error: "no path found" });
      await assert.rejects(openChannels(ctx), /fnn-hub could not pay fnn-demo: no path found/);
    });

    it("does not balance a demo channel that could not be opened", async () => {
      const { ctx, server } = demoSetup();
      server.fnn["fnn-hub"].overrides.open_channel = () => new Error("Not enough CKB capacity");
      await openChannels(ctx);
      assert.deepEqual(server.fnn["fnn-demo"].callsOf("new_invoice"), []);
    });

    it("stops when fnn-hub announces no address with a peer id (fnn-demo could not dial it)", async () => {
      const { ctx, server } = demoSetup();
      server.fnn["fnn-hub"].addresses = ["/ip4/203.0.113.7/tcp/8228"];
      await assert.rejects(openChannels(ctx), /fnn-hub announces no address with a peer id/);
    });
  });
});

describe("testnet balance", () => {
  it("counts the faucet invoices to reach the inbound target, within the run's cap and the faucet's 60 a day", () => {
    assert.equal(balancingInvoiceCount(0n, 250_000n, 50_000n, 10), 5);
    assert.equal(balancingInvoiceCount(240_000n, 250_000n, 50_000n, 10), 1, "rounds up");
    assert.equal(balancingInvoiceCount(250_000n, 250_000n, 50_000n, 10), 0);
    assert.equal(balancingInvoiceCount(300_000n, 250_000n, 50_000n, 10), 0);
    assert.equal(balancingInvoiceCount(0n, 10_000_000n, 50_000n, 10), 10, "the run's cap");
    assert.equal(balancingInvoiceCount(0n, 100_000_000n, 1_000n, 1_000), MUTINYNET_FAUCET.INVOICES_PER_DAY, "the faucet's daily limit");
  });

  function balanceSetup(local: bigint, remote: bigint, settings: Record<string, string> = {}) {
    const context = setup({ settings });
    context.server.lnd["lnd-hub"].channels = [lndChannel(context.settings.peers.lnLspNode.pubkey, local, remote)];
    return context;
  }

  it("pays faucet invoices of the exact size from lnd-hub until its channel to the LSP holds the target inbound", async () => {
    const { ctx, server, network } = balanceSetup(200_000n, 20_000n);
    await balanceLightning(ctx);
    assert.deepEqual(network.faucetInvoiceAmounts(), [50_000, 50_000], "80,000 short of the 100,000 target");
    const pays = lncliCalls(server, "lnd-hub", "payinvoice");
    assert.deepEqual(
      pays.map((call) => call[call.length - 1]),
      ["lntbs50000faucet1", "lntbs50000faucet2"],
    );
    for (const call of pays) {
      assert.ok(call.includes("--fee_limit=100"));
      assert.ok(call.includes("--timeout=120s"));
      assert.ok(call.includes("--force"));
    }
  });

  it("uses the fee limit and invoice size of the settings, and the run's cap", async () => {
    const { ctx, server, network } = balanceSetup(500_000n, 0n, { DEPLOY_LN_PAY_FEE_LIMIT_SATS: "7", DEPLOY_LN_BALANCE_INVOICE_SATS: "25000", DEPLOY_LN_BALANCE_MAX_INVOICES: "2" });
    await balanceLightning(ctx);
    assert.deepEqual(network.faucetInvoiceAmounts(), [25_000, 25_000]);
    assert.ok(lncliCalls(server, "lnd-hub", "payinvoice").every((call) => call.includes("--fee_limit=7")));
  });

  it("does nothing once the target is reached, as on a fresh LSP channel with the default push", async () => {
    const { ctx, server, network } = balanceSetup(120_000n, 100_000n);
    await balanceLightning(ctx);
    assert.deepEqual(network.faucetInvoiceAmounts(), []);
    assert.deepEqual(lncliCalls(server, "lnd-hub", "payinvoice"), []);
  });

  it("stops at the first payment that does not succeed", async () => {
    const { ctx, server, network, logger } = balanceSetup(500_000n, 0n);
    server.lnd["lnd-hub"].pay = () => result(JSON.stringify({ payment_hash: "x", status: "FAILED", payment_preimage: "", failure_reason: "FAILURE_REASON_NO_ROUTE", fee_sat: "0" }));
    await balanceLightning(ctx);
    assert.equal(network.faucetInvoiceAmounts().length, 1);
    assert.match(logger.warnings().join("\n"), /payment 1 of 2 ended FAILED \(FAILURE_REASON_NO_ROUTE\); stopping/);
  });

  it("refuses without an active channel to the LSP, before asking the faucet for anything", async () => {
    const none = setup();
    await assert.rejects(balanceLightning(none.ctx), /no active channel with the Megalith LSP: run `testnet channels`/);
    assert.deepEqual(none.network.faucetInvoiceAmounts(), []);
    const inactive = setup();
    inactive.server.lnd["lnd-hub"].channels = [lndChannel(inactive.settings.peers.lnLspNode.pubkey, 220_000n, 0n, false)];
    await assert.rejects(balanceLightning(inactive.ctx), /no active channel/);
  });

  it("stops when the faucet gives no invoice (its 60 a day are used up)", async () => {
    const { ctx, server, network } = balanceSetup(500_000n, 0n);
    network.bolt11Status = 429;
    await assert.rejects(balanceLightning(ctx), /Mutinynet faucet invoice for 50000 sats: HTTP 429/);
    assert.deepEqual(lncliCalls(server, "lnd-hub", "payinvoice"), []);
  });
});
