import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseEnv } from "node:util";
import { loadHubConfig } from "../../src/config/hub.config";
import { evaluateTunnelProxySecret, failed, renderReport, type CheckResult } from "../scripts/check/checks";
import { runCheck } from "../scripts/check/run-check";
import { HUB_ENV_KEY, KIT_FILE, TUNNEL_PROFILE } from "../scripts/lib/constants";
import { envProbeScript, listsTunnelProfile, parseEnvProbe, validateTunnelProxySecret, type EnvProbe } from "../scripts/lib/env-file";
import { hubMacaroonPath } from "../scripts/lib/kit-paths";
import { resolveDeployPaths } from "../scripts/lib/paths";
import { completeKitEnv } from "../scripts/steps/env.step";
import { FakeDeployment, PUBKEY, fnnChannel, lndChannel } from "./support/fake-deployment";
import { FakeNetwork } from "./support/fake-network";
import { FakeRunner, hasDockerCompose, hasPosixShell, result, runLocalSh, testContext, testSettings, TEST_REMOTE_DIR, withoutKitDir, type RecordedCall } from "./support/fakes";

/**
 * Security review D4: the tunnel profile puts the hub on the internet, so with COMPOSE_PROFILES listing `tunnel` the
 * server's hub.env must set HUB_PROXY_SECRET. `testnet env` stops once hub.env exists without it, and `testnet:check`
 * fails the same case. Neither reads the secret back: the probe of hub.env says only whether the key is set.
 */

const SHELL = !hasPosixShell() && "no local sh";
const NO_COMPOSE = !hasDockerCompose() && "Docker Compose is not installed";
const kitDir = resolveDeployPaths().kitDir;
/** A proxy secret as `openssl rand -hex 32` makes one: it must never leave hub.env. */
const PROXY_SECRET = "c0ffee".repeat(10) + "abcd";
/** The Cloudflare tunnel token, a hand secret of the kit's .env: never read back either. */
const TUNNEL_TOKEN = "cf-tunnel-token-eyJhIjoiYWJjIn0";
const SYNC_ENV = "BITCOIND_RPC_USER=syncuser\nBITCOIND_RPC_PASSWORD=syncpasswordsecret\n";
const NEEDS_SECRET = /COMPOSE_PROFILES lists tunnel, so the server's hub\.env must set HUB_PROXY_SECRET/;

const probeOf = (entries: Record<string, string>): EnvProbe =>
  new Map(Object.entries(entries).map(([key, value]) => [key, { set: value !== "", value: null }]));
const kitValues = (profiles: string): Map<string, string> => new Map([["COMPOSE_PROFILES", profiles]]);

describe("listsTunnelProfile (COMPOSE_PROFILES of the kit's .env)", () => {
  it("is true when the list names tunnel, alone or with other profiles, spaces around names allowed", () => {
    for (const profiles of ["tunnel", "demo,tunnel", "tunnel,demo", " demo , tunnel ", ",tunnel,"]) assert.equal(listsTunnelProfile(profiles), true, profiles);
  });

  it("is false without it: unset, empty, other profiles, or a name that only contains it", () => {
    for (const profiles of [undefined, "", "demo", "tunnels", "my-tunnel", "TUNNEL", "demo;tunnel"]) assert.equal(listsTunnelProfile(profiles), false, String(profiles));
  });

  it("uses the profile name the kit's compose file gives cloudflared and fiber-ws", () => {
    assert.equal(TUNNEL_PROFILE, "tunnel");
    assert.match(readFileSync(join(kitDir, "docker-compose.yml"), "utf8"), /^ {4}profiles: \[tunnel\]$/m);
  });
});

describe("validateTunnelProxySecret", () => {
  it("asks nothing without the tunnel, whatever hub.env holds", () => {
    assert.deepEqual(validateTunnelProxySecret(kitValues(""), probeOf({})), []);
    assert.deepEqual(validateTunnelProxySecret(kitValues("demo"), probeOf({ HUB_PROXY_SECRET: "" })), []);
    assert.deepEqual(validateTunnelProxySecret(new Map(), probeOf({})), []);
  });

  it("accepts the tunnel when hub.env sets HUB_PROXY_SECRET", () => {
    assert.deepEqual(validateTunnelProxySecret(kitValues("tunnel"), probeOf({ HUB_PROXY_SECRET: "set" })), []);
    assert.deepEqual(validateTunnelProxySecret(kitValues("demo,tunnel"), probeOf({ HUB_PROXY_SECRET: "set" })), []);
  });

  it("refuses the tunnel when hub.env leaves HUB_PROXY_SECRET empty or has no such line, saying what to do", () => {
    for (const hubEnv of [probeOf({ HUB_PROXY_SECRET: "" }), probeOf({}), probeOf({ HUB_PROXY_SECRET_OLD: "x" })]) {
      const problems = validateTunnelProxySecret(kitValues("tunnel"), hubEnv);
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? "", NEEDS_SECRET);
      assert.match(problems[0] ?? "", /openssl rand -hex 32/);
      assert.match(problems[0] ?? "", /run `testnet env` again/);
    }
  });

  it("never needs the secret's value: a probe that carries one gives the same answer and the sentence does not repeat it", () => {
    const withValue: EnvProbe = new Map([[HUB_ENV_KEY.PROXY_SECRET, { set: true, value: PROXY_SECRET }]]);
    assert.deepEqual(validateTunnelProxySecret(kitValues("tunnel"), withValue), []);
    const problems = validateTunnelProxySecret(kitValues("tunnel"), probeOf({ HUB_PROXY_SECRET: "" }));
    assert.doesNotMatch(problems.join(), new RegExp(PROXY_SECRET));
  });
});

describe("the hub.env probe (real sh and awk)", { skip: SHELL }, () => {
  it("says whether HUB_PROXY_SECRET is set and prints no value of hub.env at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-tunnel-probe-"));
    try {
      writeFileSync(join(dir, "hub.env"), `# hub.env\nHUB_HOST=0.0.0.0\nHUB_PROXY_SECRET=${PROXY_SECRET}\nSWAP_MAX_SATS=20000\n`);
      const run = runLocalSh(envProbeScript(KIT_FILE.HUB_ENV, []), dir);
      assert.equal(run.status, 0, run.stderr);
      assert.ok(!run.stdout.includes(PROXY_SECRET), "the secret is not printed");
      assert.ok(!run.stdout.includes("0.0.0.0"), "no value is printed");
      assert.deepEqual(parseEnvProbe(run.stdout, []).get(HUB_ENV_KEY.PROXY_SECRET), { set: true, value: null });
      writeFileSync(join(dir, "hub.env"), "HUB_PROXY_SECRET=\n# HUB_PROXY_SECRET=commented-out\n");
      assert.deepEqual(parseEnvProbe(runLocalSh(envProbeScript(KIT_FILE.HUB_ENV, []), dir).stdout, []).get(HUB_ENV_KEY.PROXY_SECRET), { set: false, value: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a quoted empty or blank HUB_PROXY_SECRET as not set, as Compose does", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-tunnel-probe-"));
    try {
      for (const line of ['HUB_PROXY_SECRET=""', "HUB_PROXY_SECRET=''", "HUB_PROXY_SECRET=  "]) {
        writeFileSync(join(dir, "hub.env"), `${line}\n`);
        const probe = parseEnvProbe(runLocalSh(envProbeScript(KIT_FILE.HUB_ENV, []), dir).stdout, []);
        assert.deepEqual(validateTunnelProxySecret(kitValues("tunnel"), probe).length, 1, line);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies each value as set or empty: blank once spaces and one pair of quotes are removed is empty", () => {
    const states = probeStates(PROBE_CASES.map(([value]) => value));
    assert.deepEqual(states, PROBE_CASES.map(([, state]) => state));
  });

  it("agrees with what the hub ends up with through Docker Compose (env_file), on every one of those values", { skip: NO_COMPOSE }, () => {
    const values = PROBE_CASES.map(([value]) => value);
    const compose = composeReads(values);
    // Compose passes `" "` on as a space; the hub's loader counts a blank HUB_PROXY_SECRET as unset (unsetWhenBlank).
    const hubSees = compose.map((value) => (value.trim() === "" ? "empty" : "set"));
    assert.deepEqual(probeStates(values), hubSees, `Compose read ${JSON.stringify(compose)}`);
    assert.equal(loadHubConfig({ HUB_PROXY_SECRET: " " }).server.proxySecret, null, "a blank secret is no secret for the hub");
  });

  // Compose reads a quoted value up to its closing quote, so a comment after it does not make the value set.
  it("counts a quoted empty value followed by a comment as empty, as Compose does", () => {
    assert.deepEqual(probeStates(['"" # set me', "'' # c"]), ["empty", "empty"]);
  });
});

/** Values of hub.env lines and how the probe must classify them (as Compose reads them). */
const PROBE_CASES: [value: string, state: "set" | "empty"][] = [
  ['""', "empty"],
  ["''", "empty"],
  ["  ", "empty"],
  ["", "empty"],
  ['" "', "empty"],
  ["' '", "empty"],
  ['"x"', "set"],
  ["'x'", "set"],
  ["x", "set"],
  ['" x "', "set"],
  [PROXY_SECRET, "set"],
];

/** The probe's set or empty for each value, written to hub.env as KEYn=<value> and probed with the real sh. */
function probeStates(values: readonly string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "deploy-tunnel-probe-"));
  try {
    writeFileSync(join(dir, KIT_FILE.HUB_ENV), values.map((value, index) => `KEY${index}=${value}\n`).join(""));
    const run = runLocalSh(envProbeScript(KIT_FILE.HUB_ENV, []), dir);
    assert.equal(run.status, 0, run.stderr);
    for (const value of values) if (value.trim().length > 3) assert.ok(!run.stdout.includes(value), "no value is printed");
    const probe = parseEnvProbe(run.stdout, []);
    return values.map((_, index) => {
      const state = probe.get(`KEY${index}`);
      return state === undefined ? "missing" : state.set ? "set" : "empty";
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What Docker Compose passes a service for each value of an env_file (`docker compose config`). */
function composeReads(values: readonly string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "deploy-tunnel-compose-"));
  try {
    writeFileSync(join(dir, KIT_FILE.HUB_ENV), values.map((value, index) => `KEY${index}=${value}\n`).join(""));
    writeFileSync(join(dir, "docker-compose.yml"), "services:\n  probe:\n    image: alpine\n    env_file: [hub.env]\n");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COMPOSE_") && !/^KEY\d+$/.test(key)));
    const run = spawnSync("docker", ["compose", "-p", "probe-check", "config", "--format", "json"], { cwd: dir, encoding: "utf8", env, timeout: 60_000, windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    const environment = (JSON.parse(run.stdout) as { services: { probe: { environment?: Record<string, string | null> } } }).services.probe.environment ?? {};
    return values.map((_, index) => environment[`KEY${index}`] ?? "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------------------------------------ testnet env */

/**
 * A server whose kit folder is a local temporary folder: every script `testnet env` sends runs there in the real sh
 * (as it would over ssh in /opt/ckbolt/testnet). Records what each script printed.
 */
function localKitServer(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-tunnel-kit-"));
  for (const name of [KIT_FILE.ENV_EXAMPLE, KIT_FILE.HUB_ENV_EXAMPLE]) copyFileSync(join(kitDir, name), join(dir, name));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const printed: { script: string; output: string }[] = [];
  const runner = new FakeRunner((call: RecordedCall) => {
    const script = call.script === null ? null : withoutKitDir(call.script, TEST_REMOTE_DIR);
    if (script === null) return result("", 127, `the fake server runs kit scripts only: ${call.command} ${call.args.join(" ")}`);
    const run = runLocalSh(script, dir, call.input);
    printed.push({ script, output: `${run.stdout}${run.stderr}` });
    return result(run.stdout, run.status, run.stderr);
  });
  const read = (name: string): string => readFileSync(join(dir, name), "utf8");
  return { dir, runner, printed, read, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("testnet env with the tunnel profile (real sh)", { skip: SHELL }, () => {
  const servers: { remove(): void }[] = [];
  after(() => servers.forEach((server) => server.remove()));

  const run = async (files: Record<string, string>) => {
    const server = localKitServer(files);
    servers.push(server);
    const { ctx, logger } = testContext({ runner: server.runner, settings: testSettings({ DEPLOY_PUBLIC_IP: "203.0.113.7" }) });
    const outcome = await completeKitEnv(ctx).then(
      () => null,
      (error: unknown) => error as Error,
    );
    return { server, logger, outcome };
  };
  const tunnelEnv = `${SYNC_ENV}COMPOSE_PROFILES=tunnel\nCLOUDFLARED_TUNNEL_TOKEN=${TUNNEL_TOKEN}\n`;

  it("stops on a new server: hub.env is created from the example (secret empty), then the step stops saying what to set", async () => {
    const { server, outcome } = await run({ ".env": tunnelEnv });
    assert.ok(outcome, "testnet env stopped");
    assert.match(outcome.message, /^hub\.env needs a change: /);
    assert.match(outcome.message, NEEDS_SECRET);
    assert.ok(existsSync(join(server.dir, KIT_FILE.HUB_ENV)), "hub.env exists, for the operator to fill");
    assert.equal(parseEnv(server.read(KIT_FILE.HUB_ENV)).HUB_PROXY_SECRET, "");
    if (process.platform !== "win32") assert.equal(statSync(join(server.dir, KIT_FILE.HUB_ENV)).mode & 0o777, 0o600);
    assert.match(parseEnv(server.read(KIT_FILE.ENV)).QUOTE_SIGNING_KEY ?? "", /^[0-9a-f]{64}$/, "the .env was completed before the stop");
  });

  it("stops when an existing hub.env leaves HUB_PROXY_SECRET empty", async () => {
    const { outcome } = await run({ ".env": tunnelEnv, "hub.env": "HUB_HOST=0.0.0.0\nHUB_PROXY_SECRET=\n" });
    assert.match(outcome?.message ?? "no error", NEEDS_SECRET);
  });

  it("stops when hub.env has the key only commented out", async () => {
    const { outcome } = await run({ ".env": tunnelEnv, "hub.env": `HUB_HOST=0.0.0.0\n# HUB_PROXY_SECRET=${PROXY_SECRET}\n` });
    assert.match(outcome?.message ?? "no error", NEEDS_SECRET);
  });

  it("stops with the demo profile listed too", async () => {
    const { outcome } = await run({ ".env": `${SYNC_ENV}COMPOSE_PROFILES=demo,tunnel\nDEMO_ENABLED=true\nCLOUDFLARED_TUNNEL_TOKEN=${TUNNEL_TOKEN}\n` });
    assert.match(outcome?.message ?? "no error", NEEDS_SECRET);
  });

  it("completes when hub.env sets the secret, and never logs, sends or prints the secret or the tunnel token", async () => {
    const { server, logger, outcome } = await run({ ".env": tunnelEnv, "hub.env": `HUB_HOST=0.0.0.0\nHUB_PROXY_SECRET=${PROXY_SECRET}\n` });
    assert.equal(outcome, null, outcome?.message);
    assert.equal(parseEnv(server.read(KIT_FILE.HUB_ENV)).HUB_PROXY_SECRET, PROXY_SECRET, "the secret is kept as it was");
    for (const secret of [PROXY_SECRET, TUNNEL_TOKEN]) {
      assert.ok(!logger.text().includes(secret), "not in the log");
      for (const call of server.runner.calls) {
        assert.ok(!(call.script ?? "").includes(secret), "not in a script sent to the server");
        assert.ok(!call.input.includes(secret), "not in what is piped to the server");
      }
      const readBack = server.printed.filter(({ output }) => output.includes(secret));
      assert.deepEqual(readBack.map(({ script }) => script), [], "not in what any script printed back");
    }
    assert.ok(
      server.runner.scripts().some((script) => script.endsWith(envProbeScript(KIT_FILE.HUB_ENV, []))),
      "hub.env was probed, with no readable key",
    );
  });

  it("never reads HUB_PROXY_SECRET back from the server, not even to complete hub.env", async () => {
    const { server, outcome } = await run({ ".env": tunnelEnv, "hub.env": `HUB_HOST=0.0.0.0\nHUB_PROXY_SECRET=${PROXY_SECRET}\n` });
    assert.equal(outcome, null, outcome?.message);
    assert.deepEqual(server.printed.filter(({ output }) => output.includes(PROXY_SECRET)).map(({ script }) => script), []);
    // The keys hub.env lacked were appended all the same, and the ones it had (the secret) left as they were.
    const written = parseEnv(server.read(KIT_FILE.HUB_ENV));
    assert.equal(written.HUB_PROXY_SECRET, PROXY_SECRET);
    assert.equal(server.read(KIT_FILE.HUB_ENV).match(/^HUB_PROXY_SECRET=/gm)?.length, 1);
    assert.equal(written.FIBER_INBOUND_ENABLED, "true", "a key of hub.env.example was added");
    assert.ok(!server.printed.some(({ script }) => /^cat hub\.env$/.test(script)), "no `cat hub.env`");
  });

  it("does not ask for the secret without the tunnel", async () => {
    const { outcome } = await run({ ".env": `${SYNC_ENV}COMPOSE_PROFILES=\n`, "hub.env": "HUB_HOST=0.0.0.0\nHUB_PROXY_SECRET=\n" });
    assert.equal(outcome, null, outcome?.message);
  });

  it("still refuses a missing tunnel token first, before writing anything", async () => {
    const { server, outcome } = await run({ ".env": `${SYNC_ENV}COMPOSE_PROFILES=tunnel\nCLOUDFLARED_TUNNEL_TOKEN=\n` });
    assert.match(outcome?.message ?? "no error", /CLOUDFLARED_TUNNEL_TOKEN/);
    assert.ok(!existsSync(join(server.dir, KIT_FILE.HUB_ENV)), "hub.env was not created");
  });
});

/* -------------------------------------------------------------------------------------------- testnet:check */

describe("evaluateTunnelProxySecret (testnet:check rule)", () => {
  it("reports nothing without the tunnel", () => {
    assert.deepEqual(evaluateTunnelProxySecret(false, false), []);
    assert.deepEqual(evaluateTunnelProxySecret(false, true), []);
  });

  it("fails the tunnel without the secret, with the next action; ok with it", () => {
    const [missing] = evaluateTunnelProxySecret(true, false);
    assert.equal(missing?.status, "fail");
    assert.equal(missing?.area, TUNNEL_PROFILE);
    assert.match(missing?.summary ?? "", /the tunnel profile is on but hub\.env has no HUB_PROXY_SECRET/);
    assert.match(missing?.next ?? "", /set HUB_PROXY_SECRET in the server's hub\.env/);
    assert.match(missing?.next ?? "", /testnet up hub/);
    assert.deepEqual(evaluateTunnelProxySecret(true, true), [{ area: TUNNEL_PROFILE, status: "ok", summary: "hub.env sets HUB_PROXY_SECRET" }]);
  });
});

describe("testnet:check on a deployment with the tunnel (fake server, real probes)", { skip: SHELL }, () => {
  const CKB = 100_000_000n;
  const dirs: string[] = [];
  after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  /** A ready deployment whose kit .env and hub.env are real files the probes run against with the local sh. */
  function deployment(envText: string, hubEnvText: string, options: { probeFails?: boolean } = {}) {
    const server = new FakeDeployment();
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

    const dir = mkdtempSync(join(tmpdir(), "deploy-tunnel-check-"));
    dirs.push(dir);
    writeFileSync(join(dir, KIT_FILE.ENV), envText);
    writeFileSync(join(dir, KIT_FILE.HUB_ENV), hubEnvText);
    const printed: string[] = [];
    server.runner.on((call) => {
      const script = call.script === null ? null : withoutKitDir(call.script, TEST_REMOTE_DIR);
      if (script === null || !script.includes("awk -v readable=")) return undefined;
      if (options.probeFails) return result("", 127, "sh: 1: awk: not found");
      const run = runLocalSh(script, dir);
      printed.push(run.stdout);
      return result(run.stdout, run.status, run.stderr);
    });
    const { ctx, logger } = testContext({ settings, runner: server.runner, http: network.http });
    return { ctx, logger, printed };
  }
  const tunnelLines = (results: readonly CheckResult[]) => results.filter((line) => line.area === TUNNEL_PROFILE);

  it("fails with the next action when the tunnel is on and hub.env has no HUB_PROXY_SECRET", async () => {
    const { ctx } = deployment(`COMPOSE_PROFILES=tunnel\nCLOUDFLARED_TUNNEL_TOKEN=${TUNNEL_TOKEN}\n`, "HUB_HOST=0.0.0.0\nHUB_PROXY_SECRET=\n");
    const results = await runCheck(ctx);
    const [line] = tunnelLines(results);
    assert.equal(line?.status, "fail");
    assert.match(line?.summary ?? "", /hub\.env has no HUB_PROXY_SECRET/);
    assert.ok(line?.next);
    assert.equal(failed(results), true, "testnet:check exits 1");
    assert.match(renderReport("testnet:check", results), /FAIL/);
  });

  it("is ok when hub.env sets it, and the secret never appears in the results, the report, the log or the probe output", async () => {
    const { ctx, logger, printed } = deployment(`COMPOSE_PROFILES=tunnel\nCLOUDFLARED_TUNNEL_TOKEN=${TUNNEL_TOKEN}\n`, `HUB_HOST=0.0.0.0\nHUB_PROXY_SECRET=${PROXY_SECRET}\n`);
    const results = await runCheck(ctx);
    assert.deepEqual(tunnelLines(results), [{ area: TUNNEL_PROFILE, status: "ok", summary: "hub.env sets HUB_PROXY_SECRET" }]);
    for (const text of [JSON.stringify(results), renderReport("testnet:check", results), logger.text(), printed.join("\n")]) {
      assert.ok(!text.includes(PROXY_SECRET), "the proxy secret");
      assert.ok(!text.includes(TUNNEL_TOKEN), "the tunnel token");
    }
    assert.ok(printed.length >= 2, "both probes ran");
  });

  it("says nothing about the secret without the tunnel", async () => {
    const { ctx } = deployment("COMPOSE_PROFILES=demo\n", "HUB_PROXY_SECRET=\n");
    assert.deepEqual(tunnelLines(await runCheck(ctx)), []);
  });

  it("fails the line, and goes on with the other checks, when the probe cannot run on the server", async () => {
    const { ctx } = deployment("COMPOSE_PROFILES=tunnel\n", "HUB_PROXY_SECRET=\n", { probeFails: true });
    const results = await runCheck(ctx);
    const [line] = tunnelLines(results);
    assert.equal(line?.status, "fail");
    assert.match(line?.summary ?? "", /^could not read: /);
    assert.equal(line?.next, "check the kit's .env and hub.env on the server");
    assert.ok(results.some((result) => result.area === "hub" && result.status === "ok"), "the hub was still checked");
  });
});
