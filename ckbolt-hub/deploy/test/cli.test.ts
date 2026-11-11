import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { COMMANDS, lndServiceOf, parseCommandArgs, runTestnetCommand, usage } from "../scripts/cli/testnet-cli";
import type { DeployContext } from "../scripts/lib/context";
import { resolveDeployPaths } from "../scripts/lib/paths";
import { FakeDeployment } from "./support/fake-deployment";
import { testContext } from "./support/fakes";

const deployDir = resolveDeployPaths().deployDir;
const hubRoot = dirname(deployDir);

/** A context factory that counts how often it was asked: help and typos must need no settings or server. */
function contextFactory(server = new FakeDeployment()) {
  const made: DeployContext[] = [];
  const context = testContext({ runner: server.runner });
  return {
    server,
    context,
    made,
    make: (): DeployContext => {
      made.push(context.ctx);
      return context.ctx;
    },
  };
}

describe("testnet command line", () => {
  it("prints the usage for no command, help, --help and -h, without settings or a server", async () => {
    for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
      const { make, made } = contextFactory();
      const printed: string[] = [];
      assert.equal(await runTestnetCommand(argv, make, (text) => printed.push(text)), 0, argv.join(" "));
      assert.equal(made.length, 0, "no context for help");
      assert.match(printed.join("\n"), /^Usage: npm --prefix deploy run testnet -- <command> \[arguments\]/);
    }
  });

  it("answers an unknown command with exit 1 and the usage, without touching the server", async () => {
    const { make, made, server } = contextFactory();
    const printed: string[] = [];
    assert.equal(await runTestnetCommand(["deploy-everything"], make, (text) => printed.push(text)), 1);
    assert.match(printed.join("\n"), /Unknown command "deploy-everything"[\s\S]*Usage:/);
    assert.equal(made.length, 0);
    assert.equal(server.runner.calls.length, 0);
  });

  it("lists every command with its arguments, the compose pass-through and the check and smoke scripts", () => {
    const text = usage();
    for (const command of Object.values(COMMANDS)) {
      assert.ok(text.includes(command.usage), command.usage);
      assert.ok(text.includes(command.summary), command.summary);
    }
    assert.match(text, /compose -- <args>/);
    assert.match(text, /npm --prefix deploy run testnet:check/);
    assert.match(text, /npm --prefix deploy run testnet:smoke/);
    assert.match(text, /DEPLOY_SSH_HOST/);
  });

  it("offers every step the spec asks for", () => {
    for (const name of ["sync", "env", "build", "up", "down", "status", "logs", "wallet", "macaroons", "addresses", "fund", "channels", "balance", "steps"]) {
      assert.ok(COMMANDS[name], `missing command ${name}`);
    }
  });

  it("parses --fresh, --follow and --tail, and refuses a --tail that is not a whole number or an unknown flag", () => {
    assert.deepEqual(parseCommandArgs(["hub", "--tail", "200", "--follow"]), { positionals: ["hub"], fresh: false, follow: true, tail: 200 });
    assert.deepEqual(parseCommandArgs(["bitcoind", "--fresh"]), { positionals: ["bitcoind"], fresh: true, follow: false, tail: null });
    assert.deepEqual(parseCommandArgs([]), { positionals: [], fresh: false, follow: false, tail: null });
    assert.equal(parseCommandArgs(["--tail=0"]).tail, 0);
    for (const bad of ["--tail=-1", "--tail=1.5", "--tail=abc"]) assert.throws(() => parseCommandArgs([bad]), /--tail must be a whole number/, bad);
    assert.throws(() => parseCommandArgs(["--volumes"]), "an unknown flag (here one that would delete data) is refused");
  });

  it("names an LND node only as lnd-hub or lnd-demo", () => {
    assert.equal(lndServiceOf("lnd-hub"), "lnd-hub");
    assert.equal(lndServiceOf("lnd-demo"), "lnd-demo");
    for (const bad of [undefined, "", "bitcoind", "fnn-hub", "LND-HUB"]) assert.throws(() => lndServiceOf(bad), /Name the LND node: lnd-hub or lnd-demo/);
  });

  it("runs a command against the server named by the context", async () => {
    const { make, made, server } = contextFactory();
    assert.equal(await runTestnetCommand(["down", "hub"], make), 0);
    assert.equal(made.length, 1);
    assert.deepEqual(server.composeCommands, [["stop", "hub"]]);
    assert.equal(await runTestnetCommand(["logs", "hub", "--tail", "5"], make), 0);
    assert.deepEqual(server.composeCommands[1], ["logs", "--no-color", "--tail", "5", "hub"]);
  });

  it("passes compose arguments through, with or without the -- separator", async () => {
    const { make, server } = contextFactory();
    await runTestnetCommand(["compose", "--", "ps", "--all"], make);
    await runTestnetCommand(["compose", "restart", "hub"], make);
    assert.deepEqual(server.composeCommands, [
      ["ps", "--all"],
      ["restart", "hub"],
    ]);
  });

  it("refuses `wallet` without a valid node before asking the server anything", async () => {
    const { make, server } = contextFactory();
    await assert.rejects(runTestnetCommand(["wallet"], make), /Name the LND node/);
    await assert.rejects(runTestnetCommand(["wallet", "fnn-hub"], make), /Name the LND node/);
    assert.equal(server.runner.calls.length, 0);
  });

  it("prints the hand steps with `steps`", async () => {
    const { make, context } = contextFactory();
    await runTestnetCommand(["steps"], make);
    assert.match(context.logger.text(), /Hand steps \(a script may not do these\)/);
  });
});

describe("the runbook and the command line agree", () => {
  const readme = readFileSync(join(deployDir, "README.md"), "utf8");

  it("documents every command, and every `testnet <command>` it shows exists", () => {
    const mentioned = new Set([...readme.matchAll(/`testnet ([a-z]+)/g)].map((match) => match[1] ?? ""));
    for (const name of mentioned) assert.ok(name === "compose" || COMMANDS[name], `README shows "testnet ${name}", which is no command`);
    for (const name of Object.keys(COMMANDS)) assert.ok(mentioned.has(name), `README never shows "testnet ${name}"`);
  });

  it("gives the operator the SSH tunnel to the hub's loopback port and points the web app at it", () => {
    assert.match(readme, /ssh (-N )?-L 18787:127\.0\.0\.1:18787 testnet-vps/);
    assert.match(readme, /HUB_URL="?http:\/\/127\.0\.0\.1:18787/);
  });

  it("lists the hand steps: GitHub login on the Mutinynet faucet and the RUSD claim with JoyID", () => {
    assert.match(readme, /faucet\.mutinynet\.com[^\n]*GitHub/);
    assert.match(readme, /JoyID/);
  });

  it("states the shared-server rules: nginx and the other projects' ports are never touched", () => {
    assert.match(readme, /never touches nginx/);
    for (const port of ["127.0.0.1:3000", "127.0.0.1:8787", "127.0.0.1:6300", "5432"]) assert.ok(readme.includes(port), port);
  });

  it("says how to run the kit's own tests and type-check (the test command the tester is told to take from it)", () => {
    assert.match(readme, /npm --prefix deploy (run )?test\b|cd deploy && npm (run )?test\b/, "no test command in deploy/README.md");
    assert.match(readme, /npm --prefix deploy run typecheck|cd deploy && npm run typecheck/, "no type-check command in deploy/README.md");
  });
});

/* ------------------------------------------------------------------------------- the entry scripts, for real */

/** Settings that cannot be read (a relative DEPLOY_REMOTE_DIR): every entry script stops before any ssh call. */
const UNREADABLE_SETTINGS = { DEPLOY_REMOTE_DIR: "relative/dir", DEPLOY_SSH_HOST: "never-dialled.invalid" };
const TS_NODE = ["--require", "ts-node/register/transpile-only"];

function runScript(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const run = spawnSync(process.execPath, [...TS_NODE, script, ...args], {
    cwd: deployDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
    windowsHide: true,
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("entry scripts (node and ts-node, as npm runs them)", () => {
  it("testnet without a command prints the usage and exits 0", () => {
    const run = runScript("scripts/testnet.ts");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Usage: npm --prefix deploy run testnet -- <command>/);
  });

  it("testnet with an unknown command exits 1", () => {
    const run = runScript("scripts/testnet.ts", ["nope"]);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /Unknown command "nope"/);
  });

  for (const [script, name, args] of [
    ["scripts/testnet.ts", "testnet", ["status"]],
    ["scripts/check.ts", "testnet:check", []],
    ["scripts/smoke.ts", "testnet:smoke", []],
  ] as const) {
    it(`${name} stops with one readable line and exit 1 on bad settings, before any ssh`, () => {
      const run = runScript(script, [...args], UNREADABLE_SETTINGS);
      assert.equal(run.status, 1);
      assert.match(run.stderr, new RegExp(`${name} failed: Invalid deploy settings: DEPLOY_REMOTE_DIR`));
      assert.doesNotMatch(run.stderr, /\n\s+at /, "no stack trace");
    });
  }
});

describe("npm scripts (Windows cmd or a POSIX shell)", () => {
  const npm = (args: string[], env: Record<string, string> = {}) => {
    const run = spawnSync("npm", args, { cwd: hubRoot, encoding: "utf8", env: { ...process.env, ...env }, shell: true, timeout: 180_000, windowsHide: true });
    return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
  };

  it("npm --prefix deploy run testnet prints the usage from the hub's root", () => {
    const run = npm(["--prefix", "deploy", "run", "testnet"]);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /Usage: npm --prefix deploy run testnet -- <command>/);
  });

  it("npm --prefix deploy run testnet:check exits non-zero with the reason on bad settings", () => {
    const run = npm(["--prefix", "deploy", "run", "testnet:check"], UNREADABLE_SETTINGS);
    assert.notEqual(run.status, 0);
    assert.match(run.output, /testnet:check failed: Invalid deploy settings/);
  });
});
