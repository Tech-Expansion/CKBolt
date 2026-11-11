import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCheck } from "../scripts/check/run-check";
import { balanceLightning } from "../scripts/steps/balance.step";
import { openChannels } from "../scripts/steps/channels.step";
import { downServices, passThroughCompose, showLogs, showStatus, upServices } from "../scripts/steps/compose.step";
import { fund } from "../scripts/steps/fund.step";
import { installMacaroons } from "../scripts/steps/macaroons.step";
import { hubMacaroonPath } from "../scripts/lib/kit-paths";
import { FakeDeployment, fnnChannel, lndChannel, PEER_ID, PUBKEY } from "./support/fake-deployment";
import { FakeNetwork } from "./support/fake-network";
import { TEST_HOST, TEST_REMOTE_DIR, testContext, testSettings, type RecordedCall } from "./support/fakes";

/**
 * The VPS is shared (nginx and other projects' containers and ports): whatever the scripts do there, they stay inside
 * the kit's own Compose project. This runs the everyday commands against one fake server and checks every command that
 * reached it.
 */

/** A demo deployment ready for every step, with the calls each step made. */
async function runEverything(): Promise<{ calls: RecordedCall[]; server: FakeDeployment }> {
  const server = new FakeDeployment({ demo: true });
  const settings = testSettings();
  const network = new FakeNetwork(settings);
  server.files.add(hubMacaroonPath("lnd-hub"));
  server.files.add(hubMacaroonPath("lnd-demo"));
  server.lnd["lnd-hub"].confirmed = 1_000_000n;
  server.lnd["lnd-demo"].confirmed = 200_000n;
  server.lnd["lnd-hub"].channels = [lndChannel(settings.peers.lnLspNode.pubkey, 220_000n, 0n)];
  for (const relay of settings.peers.fiberRelays) server.fnn["fnn-hub"].reachable.set(relay.address, relay.pubkey);
  server.fnn["fnn-demo"].reachable.set(`/dns4/fnn-hub/tcp/8228/p2p/${PEER_ID.FNN_HUB}`, PUBKEY.FNN_HUB);
  server.fnn["fnn-hub"].channels = [fnnChannel(PUBKEY.FNN_DEMO, 10_000n * 100_000_000n, 10_000n * 100_000_000n)];
  const { ctx } = testContext({ settings, runner: server.runner, http: network.http });

  await showStatus(ctx);
  await upServices(ctx, { services: [], fresh: false });
  await installMacaroons(ctx);
  await fund(ctx);
  await openChannels(ctx);
  await balanceLightning(ctx);
  await runCheck(ctx);
  await showLogs(ctx, { services: ["hub"], lines: 10, follow: false });
  await passThroughCompose(ctx, ["ps"]);
  await downServices(ctx, ["hub"]);
  await downServices(ctx, []);
  return { calls: server.runner.calls, server };
}

describe("on the shared VPS the scripts stay inside the kit's Compose project", () => {
  it("never touch nginx, system services or the firewall", async () => {
    const { calls } = await runEverything();
    for (const call of calls) {
      assert.doesNotMatch(call.script ?? "", /\bnginx\b|systemctl|\bservice\s+\w+\s+(start|stop|restart|reload)|iptables|\bufw\b|\/etc\/nginx/, call.script ?? "");
    }
  });

  it("never remove volumes, prune, or stop, kill or remove containers outside docker compose", async () => {
    const { calls, server } = await runEverything();
    for (const call of calls) {
      const script = call.script ?? "";
      assert.doesNotMatch(script, /docker\s+(rm|stop|kill|restart|rmi|system\s+prune|volume\s+(rm|prune)|container\s+(rm|stop|kill|prune)|network\s+(rm|prune))\b/, script);
      assert.doesNotMatch(script, /docker compose[^\n]*\s(-v|--volumes|--rmi)\b/, script);
    }
    assert.ok(server.composeCommands.every((args) => !args.includes("-v") && !args.includes("--volumes")));
  });

  it("run docker only as `docker compose` in the kit folder, apart from the read-only volume probe", async () => {
    const { calls } = await runEverything();
    for (const call of calls) {
      const script = call.script ?? "";
      // testnet:check's first probe asks the version from wherever ssh lands (the kit folder may not exist yet).
      if (!/\bdocker\b/.test(script) || script === "docker compose version --short") continue;
      assert.ok(script.startsWith(`cd ${TEST_REMOTE_DIR} && `), `a docker command outside the kit folder: ${script}`);
      const plainDocker = [...script.matchAll(/\bdocker\s+(\w+)/g)].map((match) => match[1]).filter((word) => word !== "compose");
      for (const word of plainDocker) assert.ok(["volume", "ps", "inspect"].includes(word ?? ""), `docker ${word} in: ${script}`);
      if (plainDocker.length > 0) assert.doesNotMatch(script, /docker volume (create|rm|prune)/);
    }
  });

  it("reach the server only through ssh without prompts or a terminal, to the configured host", async () => {
    const { calls } = await runEverything();
    const ssh = calls.filter((call) => call.command === "ssh");
    assert.ok(ssh.length > 20);
    for (const call of ssh) {
      assert.deepEqual(call.args.slice(0, 5), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-T"]);
      assert.equal(call.host, TEST_HOST);
    }
    assert.deepEqual(
      calls.filter((call) => call.command !== "ssh"),
      [],
      "no other program runs on this machine during these steps",
    );
  });

  it("never print a secret: no wallet password, seed or macaroon content goes through the logger", async () => {
    const server = new FakeDeployment({ demo: true });
    const settings = testSettings();
    const network = new FakeNetwork(settings);
    const { ctx, logger } = testContext({ settings, runner: server.runner, http: network.http });
    await installMacaroons(ctx);
    await fund(ctx);
    await runCheck(ctx);
    const log = logger.text();
    assert.doesNotMatch(log, /password=|PASSWORD=|QUOTE_SIGNING_KEY=|cipher_seed|macaroon [0-9a-f]{40,}/);
    for (const call of server.runner.calls) assert.doesNotMatch(call.script ?? "", /cat [^|>]*\.(seed|password)\b/, "no script prints a seed or password file");
  });
});
