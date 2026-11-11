import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HUB_MACAROON_PERMISSIONS } from "../scripts/lib/constants";
import { resolveDeployPaths } from "../scripts/lib/paths";
import { installMacaroons } from "../scripts/steps/macaroons.step";
import { createWallet, createWalletScript } from "../scripts/steps/wallet.step";
import { FakeDeployment } from "./support/fake-deployment";
import { hasPosixShell, runLocalSh, testContext } from "./support/fakes";

const SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";
const SHELL = !hasPosixShell() && "no local sh";

/** A kit folder with the wallet script and secrets/wallet, as `testnet sync` and `testnet env` leave it. */
function kitFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "deploy-wallet-"));
  mkdirSync(join(dir, "lnd"));
  mkdirSync(join(dir, "secrets", "wallet"), { recursive: true });
  writeFileSync(join(dir, "lnd", "init-wallet.sh"), readFileSync(join(resolveDeployPaths().kitDir, "lnd", "init-wallet.sh")));
  return dir;
}

/** Runs the wallet script with `docker` replaced by a shell function (what `docker compose exec` would print). */
const withFakeDocker = (dockerBody: string, script: string): string => `docker() { ${dockerBody}; }\n${script}`;

describe("the wallet creation script (run on the server)", () => {
  it("saves the 24 words to secrets/wallet/<node>.seed, mode 600, and prints nothing", { skip: SHELL }, () => {
    const dir = kitFolder();
    try {
      const run = runLocalSh(withFakeDocker(`cat > /dev/null; echo "${SEED}"`, createWalletScript("lnd-hub")), dir);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, "", "the seed never reaches ssh's output");
      assert.equal(readFileSync(join(dir, "secrets", "wallet", "lnd-hub.seed"), "utf8").trim(), SEED);
      assert.equal(existsSync(join(dir, "secrets", "wallet", "lnd-hub.seed.pending")), false);
      if (process.platform !== "win32") assert.equal(statSync(join(dir, "secrets", "wallet", "lnd-hub.seed")).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("feeds lnd/init-wallet.sh to sh inside the node's container, without a terminal", { skip: SHELL }, () => {
    const dir = kitFolder();
    try {
      const run = runLocalSh(withFakeDocker(`echo "$*" > args.txt; cat > stdin.txt; echo "${SEED}"`, createWalletScript("lnd-demo")), dir);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(readFileSync(join(dir, "args.txt"), "utf8").trim(), "compose exec -T lnd-demo sh -s");
      assert.equal(readFileSync(join(dir, "stdin.txt"), "utf8"), readFileSync(join(dir, "lnd", "init-wallet.sh"), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never overwrites a seed file (exit 3) and leaves it as it was", { skip: SHELL }, () => {
    const dir = kitFolder();
    try {
      writeFileSync(join(dir, "secrets", "wallet", "lnd-hub.seed"), "the old seed\n");
      const run = runLocalSh(withFakeDocker(`echo called > called.txt; echo "${SEED}"`, createWalletScript("lnd-hub")), dir);
      assert.equal(run.status, 3);
      assert.match(run.stderr, /already exists/);
      assert.equal(readFileSync(join(dir, "secrets", "wallet", "lnd-hub.seed"), "utf8"), "the old seed\n");
      assert.equal(existsSync(join(dir, "called.txt")), false, "LND is not asked for a wallet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves no seed or partial file when LND refuses", { skip: SHELL }, () => {
    const dir = kitFolder();
    try {
      const run = runLocalSh(withFakeDocker(`cat > /dev/null; echo partial; echo "LND REST /v1/initwallet failed" >&2; return 1`, createWalletScript("lnd-hub")), dir);
      assert.notEqual(run.status, 0);
      assert.equal(existsSync(join(dir, "secrets", "wallet", "lnd-hub.seed")), false);
      assert.equal(existsSync(join(dir, "secrets", "wallet", "lnd-hub.seed.pending")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lnd/init-wallet.sh", () => {
  const script = readFileSync(join(resolveDeployPaths().kitDir, "lnd", "init-wallet.sh"), "utf8");

  it("uses only LND's container-local REST listener and the unlock password LND already reads", () => {
    assert.match(script, /https:\/\/localhost:8080/);
    assert.match(script, /\/run\/secrets\/lnd-wallet-password/);
    assert.match(script, /\/v1\/genseed/);
    assert.match(script, /\/v1\/initwallet/);
    assert.match(script, /set -eu/);
    assert.match(script, /umask 077/);
  });

  it("prints only the seed: LND's answers go to stderr or /dev/null, the password is never echoed", () => {
    assert.match(script, /rest \/v1\/initwallet [^\n]*> \/dev\/null/);
    assert.match(script, />&2/);
    assert.doesNotMatch(script, /echo[^\n]*\$password/);
    assert.doesNotMatch(script, /set -x/);
  });

  it("parses in sh (syntax check)", { skip: SHELL }, () => {
    const check = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  });
});

describe("testnet wallet", () => {
  it("refuses a node the deployment does not run, or one that is not running", async () => {
    const server = new FakeDeployment();
    const { ctx } = testContext({ runner: server.runner });
    await assert.rejects(createWallet(ctx, "lnd-demo"), /not part of this deployment/);
    server.containers.set("lnd-hub", { State: "exited", Health: "", Publishers: [] });
    await assert.rejects(createWallet(ctx, "lnd-hub"), /start it with `testnet up lnd-hub`/);
  });

  it("leaves a node that already has a wallet alone", async () => {
    const server = new FakeDeployment();
    server.lnd["lnd-hub"].state = "SERVER_ACTIVE";
    const { ctx, runner, logger } = testContext({ runner: server.runner });
    await createWallet(ctx, "lnd-hub");
    assert.ok(!runner.scripts().some((script) => script.includes("init-wallet.sh")));
    assert.match(logger.text(), /already has a wallet/);
  });

  it("creates the wallet once LND answers, waits for the unlock, and says where the seed is without printing it", async () => {
    const server = new FakeDeployment();
    const lnd = server.lnd["lnd-hub"];
    lnd.state = null;
    let polls = 0;
    const original = lnd.handle.bind(lnd);
    lnd.handle = (args) => {
      if (args[0] === "state") {
        polls += 1;
        if (polls === 2) lnd.state = "WAITING_TO_START";
        if (polls === 3) lnd.state = "NON_EXISTING";
      }
      return original(args);
    };
    server.runner.on((call) => {
      if (call.script?.includes("init-wallet.sh")) {
        lnd.state = "RPC_ACTIVE";
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
      return undefined;
    });
    const { ctx, runner, logger } = testContext({ runner: server.runner });
    await createWallet(ctx, "lnd-hub");
    const created = runner.scripts().filter((script) => script.includes("init-wallet.sh"));
    assert.equal(created.length, 1);
    assert.equal(created[0], `cd /opt/ckbolt/testnet && ${createWalletScript("lnd-hub")}`);
    const log = logger.text();
    assert.match(log, /\/opt\/ckbolt\/testnet\/secrets\/wallet\/lnd-hub\.seed \(mode 600\)/);
    assert.match(log, /scp test-server:\/opt\/ckbolt\/testnet\/secrets\/wallet\/lnd-hub\.seed/);
    assert.doesNotMatch(log, /abandon/);
  });

  it("refuses a node in an unexpected state", async () => {
    const server = new FakeDeployment();
    server.lnd["lnd-hub"].state = "SOMETHING_ELSE";
    const { ctx } = testContext({ runner: server.runner });
    await assert.rejects(createWallet(ctx, "lnd-hub"), /state SOMETHING_ELSE; expected NON_EXISTING/);
  });
});

describe("testnet macaroons", () => {
  it("bakes exactly the hub's least-privilege permissions (no admin, no on-chain or channel writes)", () => {
    assert.deepEqual([...HUB_MACAROON_PERMISSIONS].sort(), ["info:read", "invoices:read", "invoices:write", "offchain:read", "offchain:write", "onchain:read"]);
    for (const forbidden of ["onchain:write", "address:write", "peers:write", "macaroon:generate", "signer:generate", "message:write"]) {
      assert.ok(!HUB_MACAROON_PERMISSIONS.includes(forbidden), forbidden);
    }
  });

  it("copies the macaroon and TLS certificate of each running LND into secrets/hub/<node>, gives them to uid 1000 and restarts a running hub", async () => {
    const server = new FakeDeployment({ demo: true });
    const { ctx, runner } = testContext({ runner: server.runner });
    await installMacaroons(ctx);
    assert.deepEqual(server.lnd["lnd-hub"].calls.find((call) => call[0] === "bakemacaroon"), ["bakemacaroon", "--save_to=/root/.lnd/hub.macaroon", ...HUB_MACAROON_PERMISSIONS]);
    assert.deepEqual(server.lnd["lnd-demo"].calls.find((call) => call[0] === "bakemacaroon"), ["bakemacaroon", "--save_to=/root/.lnd/demo.macaroon", ...HUB_MACAROON_PERMISSIONS]);
    assert.deepEqual(server.composeCommands, [
      ["cp", "lnd-hub:/root/.lnd/hub.macaroon", "secrets/hub/lnd-hub/hub.macaroon"],
      ["cp", "lnd-hub:/root/.lnd/tls.cert", "secrets/hub/lnd-hub/tls.cert"],
      ["cp", "lnd-demo:/root/.lnd/demo.macaroon", "secrets/hub/lnd-demo/demo.macaroon"],
      ["cp", "lnd-demo:/root/.lnd/tls.cert", "secrets/hub/lnd-demo/tls.cert"],
      ["restart", "hub"],
    ]);
    const scripts = runner.scripts();
    assert.ok(scripts.some((script) => /mkdir -p secrets secrets\/hub secrets\/hub\/lnd-hub secrets\/hub\/lnd-demo && chmod 700/.test(script)));
    assert.ok(scripts.some((script) => script.includes("chown -R 1000:1000 secrets/hub")));
    assert.ok(!scripts.some((script) => script.includes("chown") && script.includes("secrets/wallet")), "wallet passwords and seeds stay root's");
    assert.ok(!server.composeCommands.some((command) => command.join(" ").includes("admin.macaroon")), "the admin macaroon is never copied");
  });

  it("bakes only for the LND nodes the deployment runs, and leaves a stopped hub stopped", async () => {
    const server = new FakeDeployment();
    server.containers.delete("hub");
    const { ctx } = testContext({ runner: server.runner });
    await installMacaroons(ctx);
    assert.equal(server.lnd["lnd-demo"].calls.length, 0);
    assert.ok(!server.composeCommands.some((command) => command[0] === "restart"));
  });
});

describe("LND wallet creation in a real LND container (opt-in: DEPLOY_TEST_LND_IMAGE)", () => {
  const image = process.env.DEPLOY_TEST_LND_IMAGE;

  it("creates a wallet without a prompt, prints only 24 words, and LND unlocks it again after a restart", { skip: !image && "set DEPLOY_TEST_LND_IMAGE=lightninglabs/lnd:v0.21.4-beta to run it" }, () => {
    const name = `ckbolt-deploytest-lnd-${process.pid}`;
    const dir = mkdtempSync(join(tmpdir(), "deploy-lnd-"));
    const docker = (args: string[], input?: string) => spawnSync("docker", args, { encoding: "utf8", input, timeout: 120_000 });
    const lncliState = (): string => (JSON.parse(docker(["exec", name, "lncli", "--network=signet", "state"]).stdout || "{}") as { state?: string }).state ?? "";
    const waitForState = (wanted: (state: string) => boolean): string => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const state = lncliState();
        if (wanted(state)) return state;
        spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 1000)"]);
      }
      return lncliState();
    };
    try {
      writeFileSync(join(dir, "pw"), "0123456789abcdef0123456789abcdef0123456789abcdef");
      const started = docker([
        "run", "-d", "--name", name, "-v", `${join(dir, "pw")}:/run/secrets/lnd-wallet-password:ro`, image ?? "",
        "--bitcoin.signet", "--bitcoin.node=nochainbackend", "--restlisten=127.0.0.1:8080",
        "--wallet-unlock-password-file=/run/secrets/lnd-wallet-password", "--wallet-unlock-allow-create",
      ]);
      assert.equal(started.status, 0, started.stderr);
      assert.equal(waitForState((state) => state === "NON_EXISTING"), "NON_EXISTING");
      const created = docker(["exec", "-i", name, "sh", "-s"], readFileSync(join(resolveDeployPaths().kitDir, "lnd", "init-wallet.sh"), "utf8"));
      assert.equal(created.status, 0, created.stderr);
      assert.match(created.stdout, /^([a-z]+ ){23}[a-z]+\n$/);
      assert.equal(waitForState((state) => state === "SERVER_ACTIVE"), "SERVER_ACTIVE");
      assert.equal(docker(["restart", name]).status, 0);
      assert.equal(waitForState((state) => state === "SERVER_ACTIVE"), "SERVER_ACTIVE", "the password file unlocks the wallet");
      const again = docker(["exec", "-i", name, "sh", "-s"], readFileSync(join(resolveDeployPaths().kitDir, "lnd", "init-wallet.sh"), "utf8"));
      assert.notEqual(again.status, 0, "a second creation fails");
      assert.equal(again.stdout, "", "and prints nothing");
    } finally {
      docker(["rm", "-f", "-v", name]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
