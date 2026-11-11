import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOLDEN } from "./fnn-whitelist.fixtures";

/**
 * The real CLI as a process (main.ts through ts-node, as `npm run fnn-whitelist` runs it) on files in a temporary folder:
 * the node io, exit codes, and what a person sees when a file cannot be read or written.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const MAIN = join(REPO_ROOT, "src", "interfaces", "cli", "fnn-whitelist", "main.ts");
const FIXTURES = join(__dirname, "fixtures");
const PROCESS_TIMEOUT_MS = 60_000;
/** A line of a Node stack trace. */
const STACK_FRAME = /^\s+at /m;

jest.setTimeout(PROCESS_TIMEOUT_MS);

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: readonly string[]): CliRun {
  const { FIBER_ASSETS: _ignored, ...env } = process.env;
  const run = spawnSync(process.execPath, ["-r", "ts-node/register/transpile-only", MAIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
    timeout: PROCESS_TIMEOUT_MS,
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const lf = (text: string): string => text.replace(/\r\n/g, "\n");

describe("fnn-whitelist as a process", () => {
  let dir: string;
  let assets: string;
  let hubYml: string;
  let demoYml: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fnn-whitelist-"));
    assets = join(dir, "fiber-assets.json");
    hubYml = join(dir, "hub.yml");
    demoYml = join(dir, "demo.yml");
    copyFileSync(join(FIXTURES, "fiber-assets.json"), assets);
    writeFileSync(hubYml, lf(readFileSync(join(FIXTURES, "hub.yml"), "utf8")));
    writeFileSync(demoYml, lf(readFileSync(join(FIXTURES, "demo.yml"), "utf8")));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the golden files into --out-dir and exits 0", () => {
    const out = join(dir, "out");
    mkdirSync(out);
    const run = runCli(["--assets-file", assets, "--hub-yml", hubYml, "--demo-yml", demoYml, "--out-dir", out]);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(readFileSync(join(out, "hub.yml"), "utf8")).toBe(GOLDEN.hubYml);
    expect(readFileSync(join(out, "demo.yml"), "utf8")).toBe(GOLDEN.demoYml);
  });

  it("writes in place with --write, then finds nothing to change", () => {
    expect(runCli(["--assets-file", assets, "--hub-yml", hubYml, "--demo-yml", demoYml, "--write"]).status).toBe(0);
    expect(readFileSync(hubYml, "utf8")).toBe(GOLDEN.hubYml);
    const again = runCli(["--assets-file", assets, "--hub-yml", hubYml, "--demo-yml", demoYml, "--write"]);
    expect(again.status).toBe(0);
    expect(again.stdout).toBe(`${hubYml}: unchanged\n${demoYml}: unchanged\n`);
  });

  it("refuses a missing FIBER_ASSETS file with exit 1 and its path, not a stack trace", () => {
    const missing = join(dir, "nope.json");
    const run = runCli(["--assets-file", missing, "--hub-yml", hubYml]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(new RegExp(`^fnn-whitelist: cannot read ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(run.stderr).not.toMatch(STACK_FRAME);
  });

  it("reads FIBER_ASSETS from an env file", () => {
    const hubEnv = join(dir, "hub.env");
    writeFileSync(hubEnv, `CKB_NETWORK=testnet\nFIBER_ASSETS='${JSON.stringify(JSON.parse(readFileSync(assets, "utf8")))}'\n`);
    const run = runCli(["--hub-env", hubEnv, "--check-config"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^hub configuration ok: assets CKB, RUSD, CWBTC;/);
  });

  it("refuses a missing env file, naming it, without a stack trace", () => {
    // Node itself (v24) checks `--hub-env <path>` anywhere on its command line, after the script too, and exits 9 with
    // "node: <path>: not found" before main.ts runs; the CLI's own "cannot read" (exit 1) shows where Node lets it through.
    const missing = join(dir, "hub.env");
    const run = runCli(["--hub-env", missing, "--check-config"]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(missing);
    expect(run.stderr).not.toMatch(STACK_FRAME);
  });

  it("refuses a missing config file before writing anything, even the file it could edit", () => {
    const before = readFileSync(hubYml, "utf8");
    const missing = join(dir, "missing.yml");
    const run = runCli(["--assets-file", assets, "--hub-yml", hubYml, "--demo-yml", missing, "--write"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`cannot read ${missing}`);
    expect(run.stderr).not.toMatch(STACK_FRAME);
    expect(readFileSync(hubYml, "utf8")).toBe(before);
  });

  it("refuses an --out-dir it cannot write into with exit 1 and the path, not a stack trace", () => {
    const out = join(dir, "no-such-folder");
    const run = runCli(["--assets-file", assets, "--hub-yml", hubYml, "--out-dir", out]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^fnn-whitelist: /);
    expect(run.stderr).toContain(`cannot write ${join(out, "hub.yml")}`);
    expect(run.stderr).not.toMatch(STACK_FRAME);
  });

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  (isRoot ? it.skip : it)("refuses a config file it cannot write, and says which files it did write", () => {
    const before = readFileSync(hubYml, "utf8");
    chmodSync(demoYml, 0o444);
    const run = runCli(["--assets-file", assets, "--hub-yml", hubYml, "--demo-yml", demoYml, "--write"]);
    chmodSync(demoYml, 0o644);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`cannot write ${demoYml}`);
    expect(run.stderr).not.toMatch(STACK_FRAME);
    expect(readFileSync(demoYml, "utf8")).not.toBe(GOLDEN.demoYml);
    const hubWritten = readFileSync(hubYml, "utf8") !== before;
    expect(run.stdout.includes(`${hubYml}: written`)).toBe(hubWritten);
  });
});
