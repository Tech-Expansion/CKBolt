import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseEnv } from "node:util";
import { KIT_SECRET_BYTES, LND_WALLET_PASSWORD_BYTES } from "../scripts/lib/constants";
import {
  envCompletionScript,
  envEntries,
  envProbeScript,
  missingEnvLines,
  parseEnvProbe,
  planEnvCompletion,
  randomHexCommand,
  secretFileScript,
  validateKitEnv,
  type EnvProbe,
} from "../scripts/lib/env-file";
import { resolveDeployPaths } from "../scripts/lib/paths";
import { publicIpOfSshHost, sshConfigHostname } from "../scripts/lib/public-ip";
import { completeKitEnv, readableEnvKeys } from "../scripts/steps/env.step";
import { FakeRunner, hasPosixShell, result, runLocalSh, testContext, testSettings, withoutKitDir } from "./support/fakes";

const kitDir = resolveDeployPaths().kitDir;
const exampleText = readFileSync(join(kitDir, ".env.example"), "utf8");
const hubExampleText = readFileSync(join(kitDir, "hub.env.example"), "utf8");
const readable = readableEnvKeys(exampleText);
const SHELL = !hasPosixShell() && "no local sh";

const probeOf = (entries: Record<string, string>, readableKeys = readable): EnvProbe =>
  new Map(Object.entries(entries).map(([key, value]) => [key, { set: value !== "", value: readableKeys.includes(key) ? value : null }]));

/** The .env of the running Mutinynet sync on the server: only the bitcoind RPC credentials. */
const SYNC_ENV = "BITCOIND_RPC_USER=syncuser\nBITCOIND_RPC_PASSWORD=syncpasswordsecret\n";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deploy-envfile-"));
}

describe("the kit's .env.example", () => {
  it("commits no secret: every generated secret is empty", () => {
    const example = parseEnv(exampleText);
    for (const key of Object.keys(KIT_SECRET_BYTES)) assert.equal(example[key], "", `${key} must be empty in .env.example`);
  });

  it("generates the quote signing key as 32 bytes (64 hex characters, what the hub requires)", () => {
    assert.equal(KIT_SECRET_BYTES.QUOTE_SIGNING_KEY, 32);
    assert.ok(LND_WALLET_PASSWORD_BYTES * 2 > 8, "LND wants a password longer than 8 characters");
  });

  it("lets the scripts read every non-secret key and none of the secrets", () => {
    for (const key of Object.keys(KIT_SECRET_BYTES)) assert.ok(!readable.includes(key), `${key} must never be read back`);
    for (const key of ["PUBLIC_IP", "COMPOSE_FILE", "COMPOSE_PROFILES", "DEMO_ENABLED", "BITCOIND_RPC_USER", "HUB_HOST_PORT"]) assert.ok(readable.includes(key), key);
  });

  it("puts the hub on 127.0.0.1:18787's port and the public overlay in COMPOSE_FILE, with the demo off", () => {
    const example = parseEnv(exampleText);
    assert.equal(example.HUB_HOST_PORT, "18787");
    assert.equal(example.COMPOSE_FILE, "docker-compose.yml:docker-compose.public.yml");
    assert.equal(example.COMPOSE_PROFILES, "");
    assert.equal(example.DEMO_ENABLED, "false");
    assert.equal(example.LND_HOLD_EXPIRY_DELTA_BLOCKS, "18");
  });
});

describe("the .env probe", () => {
  it("parses key, set or empty, and the value of readable keys only", () => {
    const output = "PUBLIC_IP\tset\t203.0.113.7\nQUOTE_SIGNING_KEY\tset\t\nCOMPOSE_PROFILES\tempty\t\r\nnoise line\n";
    const probe = parseEnvProbe(output, ["PUBLIC_IP", "COMPOSE_PROFILES"]);
    assert.deepEqual(probe.get("PUBLIC_IP"), { set: true, value: "203.0.113.7" });
    assert.deepEqual(probe.get("QUOTE_SIGNING_KEY"), { set: true, value: null });
    assert.deepEqual(probe.get("COMPOSE_PROFILES"), { set: false, value: "" });
    assert.equal(probe.size, 3);
  });

  it("prints secrets' names but never their values (real sh and awk)", { skip: SHELL }, () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, ".env"), `# comment\n${SYNC_ENV}QUOTE_SIGNING_KEY=${"ab".repeat(32)}\nPUBLIC_IP=203.0.113.7\nCOMPOSE_PROFILES=\nVALUE_WITH_EQUALS=a=b\n`);
      const run = runLocalSh(envProbeScript(".env", readable), dir);
      assert.equal(run.status, 0, run.stderr);
      assert.doesNotMatch(run.stdout, /syncpasswordsecret/);
      assert.doesNotMatch(run.stdout, /abab/);
      const probe = parseEnvProbe(run.stdout, readable);
      assert.deepEqual(probe.get("BITCOIND_RPC_PASSWORD"), { set: true, value: null });
      assert.deepEqual(probe.get("BITCOIND_RPC_USER"), { set: true, value: "syncuser" });
      assert.deepEqual(probe.get("PUBLIC_IP"), { set: true, value: "203.0.113.7" });
      assert.deepEqual(probe.get("COMPOSE_PROFILES"), { set: false, value: "" });
      assert.equal(probe.get("VALUE_WITH_EQUALS")?.set, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints nothing when there is no .env yet", { skip: SHELL }, () => {
    const dir = tempDir();
    try {
      const run = runLocalSh(envProbeScript(".env", readable), dir);
      assert.equal(run.status, 0);
      assert.equal(run.stdout, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("planning the .env completion", () => {
  it("keeps the running sync's bitcoind credentials and generates every other secret on the server", () => {
    const plan = planEnvCompletion({ exampleText, probe: probeOf({ BITCOIND_RPC_USER: "syncuser", BITCOIND_RPC_PASSWORD: "x" }), secretBytes: KIT_SECRET_BYTES, publicIp: "203.0.113.7" });
    const byKey = new Map(plan.fills.map((fill) => [fill.key, fill]));
    assert.equal(byKey.has("BITCOIND_RPC_PASSWORD"), false, "the sync's password is kept");
    assert.equal(byKey.has("BITCOIND_RPC_USER"), false, "the sync's user is kept");
    assert.equal(plan.values.get("BITCOIND_RPC_USER"), "syncuser");
    for (const key of ["QUOTE_SIGNING_KEY", "FNN_HUB_KEY_PASSWORD", "FNN_DEMO_KEY_PASSWORD"]) {
      assert.deepEqual(byKey.get(key), { key, kind: "secret", bytes: KIT_SECRET_BYTES[key] });
    }
    assert.deepEqual(byKey.get("PUBLIC_IP"), { key: "PUBLIC_IP", kind: "value", value: "203.0.113.7" });
    assert.deepEqual(byKey.get("COMPOSE_FILE"), { key: "COMPOSE_FILE", kind: "value", value: "docker-compose.yml:docker-compose.public.yml" });
    assert.ok(plan.fills.every((fill) => fill.kind === "secret" || !Object.hasOwn(KIT_SECRET_BYTES, fill.key)), "no secret is ever a plain value");
  });

  it("changes nothing in a complete .env", () => {
    const complete = Object.fromEntries([...envEntries(exampleText)].map(([key, value]) => [key, value || "filled"]));
    const plan = planEnvCompletion({ exampleText, probe: probeOf(complete), secretBytes: KIT_SECRET_BYTES, publicIp: "198.51.100.1" });
    assert.deepEqual(plan.fills, []);
  });

  it("never replaces an existing PUBLIC_IP or any other set value", () => {
    const plan = planEnvCompletion({
      exampleText,
      probe: probeOf({ PUBLIC_IP: "203.0.113.9", HUB_HOST_PORT: "28787", DEMO_ENABLED: "true", COMPOSE_PROFILES: "demo" }),
      secretBytes: KIT_SECRET_BYTES,
      publicIp: "198.51.100.1",
    });
    const keys = plan.fills.map((fill) => fill.key);
    for (const key of ["PUBLIC_IP", "HUB_HOST_PORT", "DEMO_ENABLED", "COMPOSE_PROFILES"]) assert.ok(!keys.includes(key), key);
    assert.equal(plan.values.get("PUBLIC_IP"), "203.0.113.9");
  });

  it("adds a missing key even when its example value is empty, so the .env lists every setting", () => {
    const plan = planEnvCompletion({ exampleText, probe: new Map(), secretBytes: KIT_SECRET_BYTES, publicIp: null });
    const keys = plan.fills.map((fill) => fill.key);
    for (const key of envEntries(exampleText).keys()) assert.ok(keys.includes(key), key);
  });
});

describe("validating the kit's .env", () => {
  const base = new Map([
    ["COMPOSE_FILE", "docker-compose.yml:docker-compose.public.yml"],
    ["COMPOSE_PROFILES", ""],
    ["DEMO_ENABLED", "false"],
    ["PUBLIC_IP", "203.0.113.7"],
    ["LND_HOLD_EXPIRY_DELTA_BLOCKS", "18"],
  ]);
  const withValue = (key: string, value: string) => new Map([...base, [key, value]]);

  it("accepts the VPS settings", () => assert.deepEqual(validateKitEnv(base), []));

  it("refuses DEMO_ENABLED=true without the demo profile, and accepts it with the profile", () => {
    assert.match(validateKitEnv(withValue("DEMO_ENABLED", "true")).join(), /COMPOSE_PROFILES=demo/);
    assert.match(validateKitEnv(withValue("DEMO_ENABLED", "1")).join(), /COMPOSE_PROFILES=demo/);
    assert.deepEqual(validateKitEnv(new Map([...base, ["DEMO_ENABLED", "true"], ["COMPOSE_PROFILES", "demo"]])), []);
  });

  it("refuses the public overlay without an IPv4 PUBLIC_IP, and needs none without the overlay", () => {
    for (const ip of ["", "testnet-vps", "2001:db8::1", "203.0.113"]) assert.match(validateKitEnv(withValue("PUBLIC_IP", ip)).join(), /PUBLIC_IP/, ip);
    assert.deepEqual(validateKitEnv(new Map([...base, ["COMPOSE_FILE", "docker-compose.yml"], ["PUBLIC_IP", ""]])), []);
  });

  it("refuses the tunnel profile while the .env leaves CLOUDFLARED_TUNNEL_TOKEN empty; a set token is never read", () => {
    assert.match(validateKitEnv(new Map([...base, ["COMPOSE_PROFILES", "tunnel"], ["CLOUDFLARED_TUNNEL_TOKEN", ""]])).join(), /CLOUDFLARED_TUNNEL_TOKEN/);
    // Set on the server: its value is not read back, so it is absent from the values.
    assert.deepEqual(validateKitEnv(new Map([...base, ["COMPOSE_PROFILES", "demo,tunnel"], ["DEMO_ENABLED", "true"]])), []);
    assert.deepEqual(validateKitEnv(new Map([...base, ["CLOUDFLARED_TUNNEL_TOKEN", ""]])), [], "no tunnel, no token needed");
  });

  it("never reads the tunnel token back from the server", () => {
    assert.ok(!readableEnvKeys(readFileSync(join(resolveDeployPaths().kitDir, ".env.example"), "utf8")).includes("CLOUDFLARED_TUNNEL_TOKEN"));
  });

  it("refuses an LND hold expiry delta below LND's 18 blocks", () => {
    for (const blocks of ["17", "0", "x", "18.5"]) assert.match(validateKitEnv(withValue("LND_HOLD_EXPIRY_DELTA_BLOCKS", blocks)).join(), /LND_HOLD_EXPIRY_DELTA_BLOCKS/, blocks);
    assert.deepEqual(validateKitEnv(withValue("LND_HOLD_EXPIRY_DELTA_BLOCKS", "40")), []);
  });
});

describe("writing the .env on the server (real sh)", () => {
  it("generates each secret on the server, keeps every other line and makes the file owner-only", { skip: SHELL }, () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, ".env"), `${SYNC_ENV}QUOTE_SIGNING_KEY=\n`);
      const fills = [
        { key: "QUOTE_SIGNING_KEY", kind: "secret" as const, bytes: 32 },
        { key: "FNN_HUB_KEY_PASSWORD", kind: "secret" as const, bytes: 24 },
        { key: "PUBLIC_IP", kind: "value" as const, value: "203.0.113.7" },
        { key: "COMPOSE_FILE", kind: "value" as const, value: "docker-compose.yml:docker-compose.public.yml" },
      ];
      const script = envCompletionScript(".env", fills);
      assert.doesNotMatch(script, /[0-9a-f]{32}/, "the script carries no secret value");
      const run = runLocalSh(script, dir);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, "", "nothing is printed");
      const written = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
      assert.equal(written.BITCOIND_RPC_USER, "syncuser");
      assert.equal(written.BITCOIND_RPC_PASSWORD, "syncpasswordsecret");
      assert.match(written.QUOTE_SIGNING_KEY ?? "", /^[0-9a-f]{64}$/);
      assert.match(written.FNN_HUB_KEY_PASSWORD ?? "", /^[0-9a-f]{48}$/);
      assert.equal(written.PUBLIC_IP, "203.0.113.7");
      assert.equal(written.COMPOSE_FILE, "docker-compose.yml:docker-compose.public.yml");
      assert.equal(readFileSync(join(dir, ".env"), "utf8").match(/^QUOTE_SIGNING_KEY=/gm)?.length, 1, "the empty line was replaced");
      if (process.platform !== "win32") assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a missing .env", { skip: SHELL }, () => {
    const dir = tempDir();
    try {
      const run = runLocalSh(envCompletionScript(".env", [{ key: "DEMO_ENABLED", kind: "value", value: "false" }]), dir);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(readFileSync(join(dir, ".env"), "utf8"), "DEMO_ENABLED=false\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("random hex has the asked length and differs between runs", { skip: SHELL }, () => {
    const first = runLocalSh(randomHexCommand(16), tmpdir()).stdout;
    const second = runLocalSh(randomHexCommand(16), tmpdir()).stdout;
    assert.match(first, /^[0-9a-f]{32}$/);
    assert.notEqual(first, second);
  });

  it("writes a wallet password without a newline (LND trims none of InitWallet's) and never overwrites one", { skip: SHELL }, () => {
    const dir = tempDir();
    try {
      const run = runLocalSh(secretFileScript("lnd-hub.password", 24), dir);
      assert.equal(run.status, 0, run.stderr);
      const password = readFileSync(join(dir, "lnd-hub.password"), "utf8");
      assert.match(password, /^[0-9a-f]{48}$/);
      runLocalSh(secretFileScript("lnd-hub.password", 24), dir);
      assert.equal(readFileSync(join(dir, "lnd-hub.password"), "utf8"), password);
      if (process.platform !== "win32") assert.equal(statSync(join(dir, "lnd-hub.password")).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists the hub.env.example keys a server's hub.env lacks, never touching set values", () => {
    const current = "HUB_HOST=0.0.0.0\nSWAP_MAX_SATS=15000\n";
    const missing = missingEnvLines(hubExampleText, current);
    assert.ok(missing.includes("FIBER_INBOUND_ENABLED=true"));
    assert.ok(!missing.some((line) => line.startsWith("SWAP_MAX_SATS=")));
    assert.ok(!missing.some((line) => line.startsWith("HUB_HOST=")));
    assert.deepEqual(missingEnvLines(hubExampleText, hubExampleText), []);
  });
});

describe("PUBLIC_IP from the SSH host", () => {
  it("reads the hostname line of ssh -G", () => {
    assert.equal(sshConfigHostname("user root\nhostname 203.0.113.10\nport 22\n"), "203.0.113.10");
    assert.equal(sshConfigHostname("user root\nport 22\n"), null);
  });

  it("uses the address an ~/.ssh/config alias names", async () => {
    const fake = new FakeRunner((call) => (call.args[0] === "-G" ? result("hostname 203.0.113.50\nuser root\n") : undefined));
    assert.equal(await publicIpOfSshHost("testnet-vps", fake.runner), "203.0.113.50");
    assert.deepEqual(fake.calls[0]?.args, ["-G", "testnet-vps"]);
  });

  it("resolves a host name to IPv4, and gives null when nothing resolves", async () => {
    const fake = new FakeRunner(() => result("", 255));
    assert.equal(await publicIpOfSshHost("203.0.113.8", fake.runner), "203.0.113.8");
    assert.equal(await publicIpOfSshHost("no-such-host.invalid", fake.runner), null);
  });
});

/** A fake server for `testnet env`: the kit folder holds `files` (name -> text); probes run against them. */
function envServer(files: Record<string, string>) {
  const runner = new FakeRunner();
  runner.on((call) => {
    if (call.command === "ssh" && call.args[0] === "-G") return result("hostname 203.0.113.77\n");
    const script = call.script === null ? null : withoutKitDir(call.script, "/opt/ckbolt/testnet");
    if (script === null) return undefined;
    const test = /^test -e (\S+)$/.exec(script);
    if (test?.[1]) return result("", test[1] in files ? 0 : 1);
    if (script.startsWith("if [ -f .env ]; then awk")) {
      const lines = Object.entries(parseEnv(files[".env"] ?? "")).map(([key, value]) => `${key}\t${value ? "set" : "empty"}\t${readable.includes(key) ? value : ""}`);
      return result(lines.join("\n"));
    }
    if (script === "cat hub.env") return result(files["hub.env"] ?? "");
    return undefined;
  });
  return runner;
}

describe("testnet env", () => {
  it("stops when the kit is not on the server yet", async () => {
    const { ctx } = testContext({ runner: envServer({}) });
    await assert.rejects(completeKitEnv(ctx), /run `testnet sync` first/);
  });

  it("keeps the sync's .env values, generates the rest on the server, creates hub.env and both wallet passwords, and logs no secret", async () => {
    const runner = envServer({ ".env.example": exampleText, ".env": SYNC_ENV });
    const { ctx, logger } = testContext({ runner, settings: testSettings({ DEPLOY_PUBLIC_IP: "203.0.113.7" }) });
    await completeKitEnv(ctx);
    const scripts = runner.scripts();
    const completion = scripts.find((script) => script.includes("umask 077") && script.includes(".env"));
    assert.ok(completion, "the .env completion ran");
    assert.doesNotMatch(completion, /BITCOIND_RPC_PASSWORD|BITCOIND_RPC_USER/, "the sync's credentials are not touched");
    assert.match(completion, /QUOTE_SIGNING_KEY .*\/dev\/urandom/);
    assert.match(completion, /PUBLIC_IP 203\.0\.113\.7/);
    assert.ok(scripts.some((script) => script.endsWith("cp hub.env.example hub.env")), "hub.env created from the example");
    for (const node of ["lnd-hub", "lnd-demo"]) {
      assert.ok(scripts.some((script) => script.includes(`secrets/wallet/${node}.password`) && script.includes("/dev/urandom")), `${node} password`);
    }
    assert.ok(scripts.some((script) => /mkdir -p secrets secrets\/wallet && chmod 700/.test(script)));
    const log = logger.text();
    assert.match(log, /QUOTE_SIGNING_KEY generated on the server/);
    assert.doesNotMatch(log, /syncpasswordsecret/);
    assert.ok(runner.calls.every((call) => !call.input.includes("syncpasswordsecret") && !(call.script ?? "").includes("syncpasswordsecret")));
  });

  it("takes PUBLIC_IP from the SSH host when DEPLOY_PUBLIC_IP is not set", async () => {
    const runner = envServer({ ".env.example": exampleText, ".env": SYNC_ENV });
    const { ctx } = testContext({ runner });
    await completeKitEnv(ctx);
    assert.ok(runner.calls.some((call) => call.command === "ssh" && call.args[0] === "-G"));
    assert.ok(runner.scripts().some((script) => script.includes("PUBLIC_IP 203.0.113.77")));
  });

  it("refuses DEMO_ENABLED=true without the demo profile before writing anything", async () => {
    const runner = envServer({ ".env.example": exampleText, ".env": `${SYNC_ENV}DEMO_ENABLED=true\nCOMPOSE_PROFILES=\n` });
    const { ctx } = testContext({ runner, settings: testSettings({ DEPLOY_PUBLIC_IP: "203.0.113.7" }) });
    await assert.rejects(completeKitEnv(ctx), /DEMO_ENABLED=true needs COMPOSE_PROFILES=demo/);
    assert.ok(!runner.scripts().some((script) => script.includes("umask 077")), "nothing was written");
  });

  it("refuses the public overlay when no public IPv4 address can be found", async () => {
    const runner = envServer({ ".env.example": exampleText, ".env": SYNC_ENV });
    runner.on((call) => (call.command === "ssh" && call.args[0] === "-G" ? result("hostname no-such-host.invalid\n") : undefined));
    const { ctx } = testContext({ runner });
    await assert.rejects(completeKitEnv(ctx), /PUBLIC_IP must be the server's IPv4 address/);
  });

  it("is idempotent: a complete .env and hub.env are left alone", async () => {
    const complete = [...envEntries(exampleText)].map(([key, value]) => `${key}=${value || "x"}`).join("\n");
    const runner = envServer({ ".env.example": exampleText, ".env": complete.replace("PUBLIC_IP=x", "PUBLIC_IP=203.0.113.7"), "hub.env": hubExampleText });
    const { ctx, logger } = testContext({ runner });
    await completeKitEnv(ctx);
    assert.match(logger.text(), /\.env already complete; nothing changed/);
    assert.match(logger.text(), /hub\.env already has every key/);
    assert.ok(!runner.scripts().some((script) => script.includes("sed -i") || script.startsWith("cat >>")));
  });

  it("appends only the keys a newer hub.env.example added", async () => {
    const runner = envServer({ ".env.example": exampleText, ".env": SYNC_ENV, "hub.env": "SWAP_MAX_SATS=15000\n" });
    const { ctx } = testContext({ runner, settings: testSettings({ DEPLOY_PUBLIC_IP: "203.0.113.7" }) });
    await completeKitEnv(ctx);
    const append = runner.calls.find((call) => call.script?.endsWith("cat >> hub.env"));
    assert.ok(append, "hub.env was appended to");
    assert.match(append.input, /FIBER_INBOUND_ENABLED=true/);
    assert.doesNotMatch(append.input, /SWAP_MAX_SATS=/);
  });
});
