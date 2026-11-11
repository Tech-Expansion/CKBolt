import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseEnv } from "node:util";
import { CKB_FAUCET, CKB_TESTNET_RPC_URL, FIBER_TESTNET_RELAYS, MUTINYNET_FAUCET, MUTINYNET_LSP } from "../scripts/lib/constants";
import { resolveDeployPaths } from "../scripts/lib/paths";
import { DEPLOY_ENV_FILE, loadDeploySettings, readDeploySettings, requireSshHost } from "../scripts/lib/settings";
import { sshArguments } from "../scripts/lib/ssh";
import { smokeOptions } from "../scripts/smoke/smoke-options";

const paths = resolveDeployPaths();
const exampleText = readFileSync(join(paths.deployDir, "deploy.env.example"), "utf8");
const example = parseEnv(exampleText) as Record<string, string>;

/** Every DEPLOY_* name the scripts' sources mention. */
function deployVariablesInSources(dir: string): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
    for (const match of text.matchAll(/"(DEPLOY_[A-Z0-9_]+)"/g)) if (match[1]) names.add(match[1]);
  }
  return names;
}

describe("deploy settings", () => {
  it("reads the defaults that deploy.env.example documents, line by line", () => {
    const settings = readDeploySettings({ DEPLOY_SSH_HOST: "vps" });
    const fromExample = readDeploySettings({ ...example, DEPLOY_SSH_HOST: "vps" });
    assert.deepEqual(fromExample, settings, "deploy.env.example and the code's defaults disagree");
    assert.equal(settings.remoteDir, "/opt/ckbolt/testnet");
    assert.equal(settings.ssh.connectTimeoutSeconds, 15);
    assert.equal(settings.timeouts.commandMs, 300_000);
    assert.equal(settings.urls.mutinynetFaucet, MUTINYNET_FAUCET.URL);
    assert.equal(settings.urls.ckbFaucetApi, CKB_FAUCET.API_URL);
    assert.equal(settings.urls.ckbRpc, CKB_TESTNET_RPC_URL);
    assert.deepEqual(settings.peers.lnLspNode, { pubkey: MUTINYNET_LSP.NODE.split("@")[0], address: "64.23.192.68:9736" });
    assert.equal(settings.peers.fiberRelays.length, FIBER_TESTNET_RELAYS.length);
  });

  it("opens lnd-hub's channel to Megalith by default: 220,000 sats with 100,000 pushed, which is also the inbound target", () => {
    const { lightning, peers } = readDeploySettings({});
    assert.equal(peers.lnLspNode.pubkey, "03e30fda71887a916ef5548a4d02b06fe04aaa1a8de9e24134ce7f139cf79d7579");
    assert.equal(lightning.lspChannelSats, 220_000n);
    assert.equal(lightning.lspPushSats, 100_000n);
    assert.equal(lightning.inboundTargetSats, 100_000n, "a fresh channel needs no `testnet balance`");
  });

  it("refuses a push that is not below the channel, and an inbound target the channel cannot hold", () => {
    for (const push of ["220000", "220001"]) {
      assert.throws(() => readDeploySettings({ DEPLOY_LN_LSP_PUSH_SATS: push }), /DEPLOY_LN_LSP_PUSH_SATS must be below DEPLOY_LN_LSP_CHANNEL_SATS \(220000\)/, push);
    }
    assert.throws(() => readDeploySettings({ DEPLOY_LN_LSP_CHANNEL_SATS: "50000" }), /DEPLOY_LN_LSP_PUSH_SATS must be below/, "the default push no longer fits");
    assert.throws(() => readDeploySettings({ DEPLOY_LN_INBOUND_TARGET_SATS: "220000" }), /DEPLOY_LN_INBOUND_TARGET_SATS must be below DEPLOY_LN_LSP_CHANNEL_SATS/);
    const settings = readDeploySettings({ DEPLOY_LN_LSP_CHANNEL_SATS: "300000", DEPLOY_LN_LSP_PUSH_SATS: "299999", DEPLOY_LN_INBOUND_TARGET_SATS: "299999" });
    assert.equal(settings.lightning.lspPushSats, 299_999n);
    assert.equal(readDeploySettings({ DEPLOY_LN_LSP_PUSH_SATS: "0" }).lightning.lspPushSats, 0n, "no push at all");
  });

  it("documents every DEPLOY_* variable the scripts read in deploy.env.example, and nothing else", () => {
    const used = deployVariablesInSources(join(paths.deployDir, "scripts"));
    const documented = new Set(Object.keys(example));
    assert.deepEqual([...used].filter((name) => !documented.has(name)).sort(), [], "read by the scripts but missing from deploy.env.example");
    assert.deepEqual([...documented].filter((name) => !used.has(name)).sort(), [], "documented but never read");
  });

  it("has no SSH host by default: nothing is hard-coded, and a remote command stops with how to set it", () => {
    assert.equal(example.DEPLOY_SSH_HOST, "", "deploy.env.example must not name a server");
    const settings = readDeploySettings({});
    assert.equal(settings.ssh.host, null);
    assert.throws(() => requireSshHost(settings), /Set DEPLOY_SSH_HOST/);
    assert.equal(requireSshHost(readDeploySettings({ DEPLOY_SSH_HOST: "  testnet-vps  " })), "testnet-vps");
  });

  it("converts amounts exactly: whole CKB and RUSD to base units, sats as they are", () => {
    const settings = readDeploySettings({
      DEPLOY_FIBER_RELAY_CHANNEL_CKB: "1000",
      DEPLOY_FIBER_RELAY_CHANNEL_RUSD: "100",
      DEPLOY_FIBER_DEMO_CHANNEL_CKB: "20000",
      DEPLOY_CKB_MIN_HUB: "25000",
      DEPLOY_LN_LSP_CHANNEL_SATS: "600000",
      DEPLOY_LN_LSP_PUSH_SATS: "250000",
    });
    assert.equal(settings.fiber.relayChannelShannons, 100_000_000_000n);
    assert.equal(settings.fiber.relayChannelRusd, 10_000_000_000n);
    assert.equal(settings.fiber.demoChannelShannons, 2_000_000_000_000n);
    assert.equal(settings.ckbFaucet.minHubShannons, 2_500_000_000_000n);
    assert.equal(settings.lightning.lspChannelSats, 600_000n);
    assert.equal(settings.lightning.lspPushSats, 250_000n);
  });

  it("collects every bad value into one error", () => {
    const bad = {
      DEPLOY_SSH_CONNECT_TIMEOUT_SECONDS: "0",
      DEPLOY_LN_LSP_CHANNEL_SATS: "19999",
      DEPLOY_LN_LSP_PUSH_SATS: "-1",
      DEPLOY_LN_BALANCE_INVOICE_SATS: "0",
      DEPLOY_CKB_CLAIM_HUB: "50000",
      DEPLOY_SMOKE_DIRECTION: "sideways",
      DEPLOY_SMOKE_ASSET: "BTC",
      DEPLOY_FIBER_DEMO_SHARE_BPS: "10001",
      DEPLOY_PUBLIC_IP: "2001:db8::1",
      DEPLOY_FIBER_RELAYS: "02aa@bottle:8119",
      DEPLOY_LN_LSP_NODE: "64.23.192.68:9736",
      DEPLOY_SMOKE_SATS: "1.5",
    };
    assert.throws(
      () => readDeploySettings(bad),
      (error: Error) => {
        for (const key of Object.keys(bad)) assert.match(error.message, new RegExp(key), `${key} not reported`);
        return true;
      },
    );
  });

  it("accepts only the faucet's two claim sizes", () => {
    for (const amount of CKB_FAUCET.CLAIM_AMOUNTS) assert.equal(readDeploySettings({ DEPLOY_CKB_CLAIM_HUB: amount }).ckbFaucet.claimHub, amount);
    assert.throws(() => readDeploySettings({ DEPLOY_CKB_CLAIM_DEMO: "300000" }), /DEPLOY_CKB_CLAIM_DEMO/);
  });

  for (const dir of ["/", "/opt", "opt/ckbolt", "/opt/ckbolt/../etc", "/opt/ck bolt", "/opt/ckbolt;rm -rf", "/opt/$(id)/x", "~/testnet"]) {
    it(`refuses DEPLOY_REMOTE_DIR=${JSON.stringify(dir)} (the scripts rm -rf folders under it)`, () => {
      assert.throws(() => readDeploySettings({ DEPLOY_REMOTE_DIR: dir }), /DEPLOY_REMOTE_DIR/);
    });
  }

  it("accepts a plain absolute DEPLOY_REMOTE_DIR at least two levels deep", () => {
    assert.equal(readDeploySettings({ DEPLOY_REMOTE_DIR: "/srv/ckbolt-testnet" }).remoteDir, "/srv/ckbolt-testnet");
  });

  it("never lets ssh read DEPLOY_SSH_HOST as an option (-oProxyCommand=... would run a local program)", () => {
    // Either fix is fine: the settings refuse such a host, or the ssh arguments end the options ("--") before it.
    const host = "-oProxyCommand=calc.exe";
    let settings: ReturnType<typeof readDeploySettings>;
    try {
      settings = readDeploySettings({ DEPLOY_SSH_HOST: host });
    } catch (error) {
      assert.match((error as Error).message, /DEPLOY_SSH_HOST/);
      return;
    }
    const args = sshArguments({ host: requireSshHost(settings), connectTimeoutSeconds: 15 }, "true");
    const hostIndex = args.indexOf(host);
    assert.ok(hostIndex > 0 && args[hostIndex - 1] === "--", `ssh ${args.join(" ")} reads the host as an option`);
  });

  it("still accepts the ssh destinations operators write: an alias, user@host, a dotted name, an IPv4 or [IPv6] address", () => {
    for (const host of ["testnet-vps", "root@testnet-vps", "deploy-user@ckbolt.example.com", "root@203.0.113.5", "[2001:db8::1]"]) {
      assert.equal(readDeploySettings({ DEPLOY_SSH_HOST: host }).ssh.host, host);
    }
    for (const host of ["-oProxyCommand=calc.exe", "testnet-vps -oProxyCommand=x", "testnet-vps;id", "vps\t229"]) {
      assert.throws(() => readDeploySettings({ DEPLOY_SSH_HOST: host }), /DEPLOY_SSH_HOST/, host);
    }
  });

  it("loads deploy/deploy.env, and variables already in the environment win over it", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-env-"));
    try {
      writeFileSync(join(dir, DEPLOY_ENV_FILE), "DEPLOY_SSH_HOST=from-file\nDEPLOY_SMOKE_SATS=3000\nDEPLOY_LN_PAY_FEE_LIMIT_SATS=7\n");
      const env: NodeJS.ProcessEnv = { DEPLOY_SMOKE_SATS: "4000" };
      const settings = loadDeploySettings(dir, env);
      assert.equal(settings.ssh.host, "from-file");
      assert.equal(settings.smoke.sats, 4000n);
      assert.equal(settings.lightning.payFeeLimitSats, 7n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("works without a deploy.env (the environment alone)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-env-"));
    try {
      assert.equal(loadDeploySettings(dir, { DEPLOY_SSH_HOST: "env-host" }).ssh.host, "env-host");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("testnet:smoke options", () => {
  const settings = readDeploySettings({ DEPLOY_SMOKE_SATS: "2500", DEPLOY_SMOKE_ASSET: "CKB", DEPLOY_SMOKE_DIRECTION: "both" });

  it("defaults to the DEPLOY_SMOKE_* settings", () => {
    assert.deepEqual(smokeOptions(settings, []), { direction: "both", asset: "CKB", sats: 2500n });
  });

  it("lets --direction, --asset and --sats override them", () => {
    assert.deepEqual(smokeOptions(settings, ["--direction", "fiber_to_ln", "--asset", "RUSD", "--sats", "1234"]), {
      direction: "fiber_to_ln",
      asset: "RUSD",
      sats: 1234n,
    });
  });

  it("refuses an unknown direction or asset, and sats that are not a positive whole number", () => {
    assert.throws(() => smokeOptions(settings, ["--direction", "up"]), /direction|DIRECTION/);
    assert.throws(() => smokeOptions(settings, ["--asset", "BTC"]), /asset|ASSET/);
    for (const sats of ["0", "-5", "12.5", "1e3", "abc"]) assert.throws(() => smokeOptions(settings, ["--sats", sats]), /sats|SATS/, sats);
  });

  it("refuses unknown flags", () => {
    assert.throws(() => smokeOptions(settings, ["--mainnet"]));
  });
});
