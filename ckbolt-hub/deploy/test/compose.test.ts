import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessBitcoindTakeover,
  isServiceUp,
  listeningPorts,
  parseComposePs,
  parsePublishedAddress,
  parseTakeoverProbe,
  portConflicts,
  publishedPortsOfConfig,
  serviceImageOfConfig,
  takeoverProbeScript,
} from "../scripts/lib/compose-state";
import { BITCOIND_VOLUME } from "../scripts/lib/constants";
import { buildImages, downServices, passThroughCompose, showLogs, showStatus, upServices } from "../scripts/steps/compose.step";
import { FakeDeployment } from "./support/fake-deployment";
import { testContext } from "./support/fakes";

describe("docker compose output", () => {
  it("reads `ps --format json` as one object per line (Compose 2.21+) or one array (older)", () => {
    const line = JSON.stringify({ Service: "hub", State: "running", Health: "healthy", Publishers: [{ URL: "127.0.0.1", TargetPort: 8787, PublishedPort: 18787 }] });
    const unpublished = JSON.stringify({ Service: "fnn-hub", State: "running", Health: "", Publishers: [{ URL: "", TargetPort: 8227, PublishedPort: 0 }] });
    const expected = [
      { service: "hub", state: "running", health: "healthy", publishers: [{ url: "127.0.0.1", targetPort: 8787, publishedPort: 18787 }] },
      { service: "fnn-hub", state: "running", health: "", publishers: [] },
    ];
    assert.deepEqual(parseComposePs(`${line}\n${unpublished}\n`), expected);
    assert.deepEqual(parseComposePs(`[${line},${unpublished}]`), expected);
    assert.deepEqual(parseComposePs("  \n"), []);
  });

  it("counts a service as up when running and healthy, or running without a health check", () => {
    assert.equal(isServiceUp({ service: "x", state: "running", health: "healthy", publishers: [] }), true);
    assert.equal(isServiceUp({ service: "x", state: "running", health: "", publishers: [] }), true);
    assert.equal(isServiceUp({ service: "x", state: "running", health: "starting", publishers: [] }), false);
    assert.equal(isServiceUp({ service: "x", state: "exited", health: "", publishers: [] }), false);
    assert.equal(isServiceUp(undefined), false);
  });

  it("reads `docker compose port`", () => {
    assert.deepEqual(parsePublishedAddress("127.0.0.1:18787\n"), { host: "127.0.0.1", port: 18787 });
    assert.deepEqual(parsePublishedAddress("[::1]:18787"), { host: "[::1]", port: 18787 });
    assert.equal(parsePublishedAddress(""), null);
    assert.equal(parsePublishedAddress("no port"), null);
  });

  it("lists the host ports the compose config publishes, per service", () => {
    const config = JSON.stringify({
      services: { hub: { ports: [{ published: "18787", target: 8787 }] }, "lnd-hub": { ports: [{ published: 9735 }] }, bitcoind: {}, x: { ports: [{ target: 1 }] } },
    });
    assert.deepEqual([...publishedPortsOfConfig(config)], [
      [18787, "hub"],
      [9735, "lnd-hub"],
    ]);
  });

  describe("the image a service runs, from the compose config (serviceImageOfConfig)", () => {
    const config = JSON.stringify({
      name: "ckbolt-testnet",
      services: {
        hub: { image: "ckbolt/hub:local", build: { context: "src" }, environment: { HUB_PROXY_SECRET: "s3cret" }, ports: [{ published: "18787" }] },
        "fnn-hub": { image: "ckbolt/fnn:v0.9.1" },
        bitcoind: { build: { context: "bitcoind" } },
        "no-image": { image: "" },
        blank: { image: "   " },
        numeric: { image: 7 },
        listed: { image: ["ckbolt/hub:local"] },
        "null-image": { image: null },
        "null-service": null,
      },
    });

    it("returns the image the service names", () => {
      assert.equal(serviceImageOfConfig(config, "hub"), "ckbolt/hub:local");
      assert.equal(serviceImageOfConfig(config, "fnn-hub"), "ckbolt/fnn:v0.9.1");
    });

    it("returns null for a service the config does not have, or a config without services", () => {
      assert.equal(serviceImageOfConfig(config, "lnd-demo"), null);
      assert.equal(serviceImageOfConfig(config, "null-service"), null);
      assert.equal(serviceImageOfConfig("{}", "hub"), null);
      assert.equal(serviceImageOfConfig('{"services":null}', "hub"), null);
      assert.equal(serviceImageOfConfig('{"services":{}}', "hub"), null);
    });

    it("returns null for a service without an image, or with an empty or non-text one", () => {
      for (const service of ["bitcoind", "no-image", "blank", "numeric", "listed", "null-image"]) {
        assert.equal(serviceImageOfConfig(config, service), null, service);
      }
    });

    it("returns null, never throws, for output that is not JSON", () => {
      for (const output of ["", "  \n", "{", "not json", 'WARN[0000] The "X" variable is not set\n{"services":{}}', '{"services":{"hub":{"image":"ckbolt/hub:local"}}']) {
        assert.doesNotThrow(() => serviceImageOfConfig(output, "hub"), output);
        assert.equal(serviceImageOfConfig(output, "hub"), null, output);
      }
    });

    it("returns null, never throws, for JSON that is not an object", () => {
      for (const output of ["42", '"ckbolt/hub:local"', "[]", '[{"services":{"hub":{"image":"x"}}}]', "true"]) {
        assert.doesNotThrow(() => serviceImageOfConfig(output, "hub"), output);
        assert.equal(serviceImageOfConfig(output, "hub"), null, output);
      }
    });

    it(
      "returns null, never throws, for the JSON literal null",
      () => {
        assert.doesNotThrow(() => serviceImageOfConfig("null", "hub"));
        assert.equal(serviceImageOfConfig("null", "hub"), null);
      },
    );
  });

  it("reads listening TCP ports from `ss -ltnH`, IPv4 and IPv6", () => {
    const ss = [
      "LISTEN 0      511          0.0.0.0:80        0.0.0.0:*",
      "LISTEN 0      4096       127.0.0.1:8787      0.0.0.0:*",
      "LISTEN 0      4096            [::]:5432         [::]:*",
      "LISTEN 0      4096               *:9735            *:*",
      "",
    ].join("\n");
    assert.deepEqual([...listeningPorts(ss)].sort((a, b) => a - b), [80, 5432, 8787, 9735]);
  });

  it("flags a wanted port held by another project, never one the kit's own containers hold", () => {
    const wanted = new Map([
      [18787, "hub"],
      [9735, "lnd-hub"],
      [8228, "fnn-hub"],
    ]);
    const conflicts = portConflicts(wanted, new Set([80, 443, 8787, 18787, 9735]), new Set([9735]));
    assert.deepEqual(conflicts.length, 1);
    assert.match(conflicts[0] ?? "", /port 18787 \(hub\) is already used by something else/);
  });
});

describe("taking over the running Mutinynet sync", () => {
  it("probes the kit's bitcoind volume by name", () => {
    assert.equal(BITCOIND_VOLUME, "ckbolt-testnet_bitcoind");
    const script = takeoverProbeScript();
    assert.match(script, /docker volume inspect ckbolt-testnet_bitcoind/);
    assert.match(script, /--filter volume=ckbolt-testnet_bitcoind/);
    assert.doesNotMatch(script, /\b(rm|stop|down|kill)\b/, "the probe only reads");
  });

  it("parses the probe", () => {
    const facts = parseTakeoverProbe("volume-present\n/ckbolt-testnet-bitcoind-1|bitcoind|true|/data\nother|bitcoind-sync|false|/home/bitcoin/.bitcoin\n");
    assert.deepEqual(facts, {
      volumeExists: true,
      users: [
        { container: "ckbolt-testnet-bitcoind-1", service: "bitcoind", running: true, destination: "/data" },
        { container: "other", service: "bitcoind-sync", running: false, destination: "/home/bitcoin/.bitcoin" },
      ],
    });
  });

  it("allows the takeover when the sync's own bitcoind service uses the volume at /data", () => {
    const verdict = assessBitcoindTakeover({ volumeExists: true, users: [{ container: "c", service: "bitcoind", running: true, destination: "/data" }] }, "bitcoind");
    assert.equal(verdict.ok, true);
    assert.match(verdict.message, /no resync/);
  });

  it("allows it when the volume exists and nothing uses it", () => {
    assert.equal(assessBitcoindTakeover({ volumeExists: true, users: [] }, "bitcoind").ok, true);
  });

  it("refuses when the volume is missing: bitcoind would sync Mutinynet from block 0", () => {
    const verdict = assessBitcoindTakeover({ volumeExists: false, users: [] }, "bitcoind");
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /from block 0/);
    assert.match(verdict.message, /--fresh/);
  });

  it("refuses while another running container (another service) uses the volume, and never suggests down -v", () => {
    const verdict = assessBitcoindTakeover({ volumeExists: true, users: [{ container: "sync-1", service: "sync", running: true, destination: "/data" }] }, "bitcoind");
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /sync-1/);
    assert.match(verdict.message, /never "down -v"/);
  });

  it("refuses when the sync mounts the volume somewhere the kit's image does not read", () => {
    const verdict = assessBitcoindTakeover({ volumeExists: true, users: [{ container: "c", service: "bitcoind", running: false, destination: "/root/.bitcoin" }] }, "bitcoind");
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /would not find its chain/);
  });
});

describe("testnet up", () => {
  it("starts every service of the .env's profiles after the takeover and port guards", async () => {
    const server = new FakeDeployment();
    server.files.add("secrets/hub/lnd-hub/hub.macaroon");
    const { ctx, logger } = testContext({ runner: server.runner });
    await upServices(ctx, { services: [], fresh: false });
    assert.deepEqual(server.composeCommands, [["up", "--detach", "bitcoind", "lnd-hub", "fnn-hub", "hub"]]);
    assert.match(logger.text(), /takes over volume ckbolt-testnet_bitcoind/);
  });

  it("refuses services the deployment does not run (the demo nodes without COMPOSE_PROFILES=demo)", async () => {
    const server = new FakeDeployment();
    const { ctx } = testContext({ runner: server.runner });
    await assert.rejects(upServices(ctx, { services: ["lnd-demo"], fresh: false }), /COMPOSE_PROFILES=demo/);
    assert.deepEqual(server.composeCommands, []);
  });

  it("refuses to start without the chain volume, unless --fresh", async () => {
    const server = new FakeDeployment();
    server.takeoverOutput = "";
    const { ctx } = testContext({ runner: server.runner });
    await assert.rejects(upServices(ctx, { services: ["bitcoind"], fresh: false }), /from block 0/);
    assert.deepEqual(server.composeCommands, []);
    await upServices(ctx, { services: ["bitcoind"], fresh: true });
    assert.deepEqual(server.composeCommands, [["up", "--detach", "bitcoind"]]);
  });

  it("does not let --fresh override another container still using the volume", async () => {
    const server = new FakeDeployment();
    server.takeoverOutput = "volume-present\nsync-1|sync|true|/data\n";
    const { ctx } = testContext({ runner: server.runner });
    await assert.rejects(upServices(ctx, { services: ["bitcoind"], fresh: true }), /still runs on ckbolt-testnet_bitcoind/);
    assert.deepEqual(server.composeCommands, []);
  });

  it("refuses when another project holds a port the kit publishes (the other projects' 8787 does not matter)", async () => {
    const server = new FakeDeployment();
    server.containers.clear();
    server.listening = "LISTEN 0 511 127.0.0.1:8787 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:9735 0.0.0.0:*\n";
    const { ctx } = testContext({ runner: server.runner });
    await assert.rejects(upServices(ctx, { services: ["lnd-hub"], fresh: false }), /port 9735 \(lnd-hub\) is already used/);
    await upServices(ctx, { services: ["fnn-hub"], fresh: false });
    assert.deepEqual(server.composeCommands, [["up", "--detach", "fnn-hub"]]);
  });

  it("leaves the hub out until its macaroon exists and its LND is healthy, and says why", async () => {
    const server = new FakeDeployment();
    const { ctx, logger } = testContext({ runner: server.runner });
    await upServices(ctx, { services: [], fresh: false });
    assert.deepEqual(server.composeCommands, [["up", "--detach", "bitcoind", "lnd-hub", "fnn-hub"]]);
    assert.match(logger.text(), /leaving the hub out for now: no macaroon for lnd-hub/);
    await assert.rejects(upServices(ctx, { services: ["hub"], fresh: false }), /The hub cannot start yet: no macaroon for lnd-hub/);
  });

  it("waits for the demo LND too when the demo profile runs", async () => {
    const server = new FakeDeployment({ demo: true });
    server.files.add("secrets/hub/lnd-hub/hub.macaroon");
    server.files.add("secrets/hub/lnd-demo/demo.macaroon");
    server.containers.set("lnd-demo", { State: "running", Health: "starting", Publishers: [] });
    const { ctx } = testContext({ runner: server.runner });
    await assert.rejects(upServices(ctx, { services: ["hub"], fresh: false }), /lnd-demo is not healthy yet/);
  });

  it("stops before anything when the kit's .env or hub.env is missing", async () => {
    const server = new FakeDeployment();
    server.files.delete("hub.env");
    const { ctx } = testContext({ runner: server.runner });
    await assert.rejects(upServices(ctx, { services: [], fresh: false }), /hub\.env is missing on the server: run `testnet sync` and `testnet env` first/);
    await assert.rejects(buildImages(ctx, []), /hub\.env is missing/);
  });
});

describe("the other compose commands", () => {
  it("build streams Docker's output with the build timeout", async () => {
    const server = new FakeDeployment();
    const { ctx, runner } = testContext({ runner: server.runner });
    await buildImages(ctx, ["hub"]);
    assert.deepEqual(server.composeCommands, [["build", "hub"]]);
    const call = runner.calls.find((candidate) => candidate.script?.endsWith("docker compose build hub"));
    assert.equal(call?.options.output, "inherit");
    assert.equal(call?.options.timeoutMs, ctx.settings.timeouts.buildMs);
  });

  it("down stops one service, or the whole project, and never removes volumes", async () => {
    const server = new FakeDeployment();
    const { ctx } = testContext({ runner: server.runner });
    await downServices(ctx, ["hub"]);
    await downServices(ctx, []);
    assert.deepEqual(server.composeCommands, [["stop", "hub"], ["down"]]);
    assert.ok(server.composeCommands.flat().every((arg) => arg !== "-v" && arg !== "--volumes"));
  });

  it("status prints state, health and ports, and services without a container", async () => {
    const server = new FakeDeployment();
    server.containers.delete("fnn-hub");
    const { ctx, logger } = testContext({ runner: server.runner });
    await showStatus(ctx);
    const log = logger.text();
    assert.match(log, /hub: running \(healthy\)  127\.0\.0\.1:18787->8787/);
    assert.match(log, /fnn-hub: not created/);
  });

  it("logs default to 100 lines without colours; --follow has no timeout", async () => {
    const server = new FakeDeployment();
    const { ctx, runner } = testContext({ runner: server.runner });
    await showLogs(ctx, { services: ["hub"], lines: null, follow: false });
    await showLogs(ctx, { services: [], lines: 5, follow: true });
    assert.deepEqual(server.composeCommands, [
      ["logs", "--no-color", "--tail", "100", "hub"],
      ["logs", "--no-color", "--tail", "5", "--follow"],
    ]);
    const follow = runner.calls.find((call) => call.script?.includes("--follow"));
    assert.equal(follow?.options.timeoutMs, undefined);
  });

  it("passes any other compose command through, in the kit folder", async () => {
    const server = new FakeDeployment();
    const { ctx } = testContext({ runner: server.runner });
    await passThroughCompose(ctx, ["restart", "hub"]);
    assert.deepEqual(server.composeCommands, [["restart", "hub"]]);
  });
});
