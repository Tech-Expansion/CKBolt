import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { HUB_SOURCE_PATHS } from "../scripts/lib/constants";
import type { CommandResult } from "../scripts/lib/process";
import { RemoteCommandError } from "../scripts/lib/ssh";
import { asWhitelistTemplates, installTemplatesScript, regenerateWhitelists, REGENERATE_WHITELISTS_COMMAND, syncKit } from "../scripts/steps/sync.step";
import type { TarEntry } from "../scripts/lib/tar";
import { FakeDeployment, HUB_IMAGE } from "./support/fake-deployment";
import { result, TEST_REMOTE_DIR, testContext, withoutKitDir, type FakeRunner, type RecordingLogger } from "./support/fakes";

/**
 * `testnet sync` runs `python3 add_token.py --regenerate --apply` in the kit folder on the server once both uploads are
 * done (docs/add-token.md, "After every `testnet sync`"), so fnn's whitelists follow the server's hub.env again. It skips
 * with a note or a warning while the server cannot run it, and fails the sync for any other failure.
 */

/** The command the runbook and the sync's notes tell the operator to type in the kit folder. */
const BY_HAND = "python3 add_token.py --regenerate --apply --template-dir .sync-templates";
const REGENERATE_ARGS = ["--regenerate", "--apply", "--template-dir", ".sync-templates"];
/** The script that copies the uploaded templates into place (a file the server lacks; every file with overwrite). */
const isTemplateInstall = (script: string): boolean => script.includes(".sync-templates/fnn/hub.yml") && !script.includes("add_token.py");
const KIT_COMMAND = `cd ${TEST_REMOTE_DIR} && ${BY_HAND}`;
/** A value only hub.env holds: Compose puts it into `docker compose config`'s output. */
const HUB_ENV_SECRET = "hubenv-proxy-secret-7f3a9c1e5b";

const timedOut = (stdout = ""): CommandResult => ({ exitCode: null, stdout, stderr: "", timedOut: true });

function setup() {
  const server = new FakeDeployment();
  return { server, ...testContext({ runner: server.runner }) };
}

/** The scripts run in the kit folder, without RemoteKit's `cd <kit> && ` prefix. */
const kitScripts = (runner: FakeRunner): string[] =>
  runner.scripts().flatMap((script) => {
    const inKit = withoutKitDir(script, TEST_REMOTE_DIR);
    return inKit === null ? [] : [inKit];
  });

const infoLines = (logger: RecordingLogger): string[] => logger.lines.filter((line) => line.level === "info").map((line) => line.text);

/** Runs `testnet sync` against `server` with a small local kit and hub source (never this checkout's src/). */
async function runSync(ctx: ReturnType<typeof setup>["ctx"]): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "deploy-sync-whitelists-"));
  try {
    const kit = join(root, "kit");
    mkdirSync(join(kit, "fnn"), { recursive: true });
    writeFileSync(join(kit, "docker-compose.yml"), "name: ckbolt-testnet\n");
    writeFileSync(join(kit, "add_token.py"), "print('stand-in')\n");
    writeFileSync(join(kit, "fnn", "hub.yml"), "ckb: {}\n");
    const hub = join(root, "hub");
    for (const path of HUB_SOURCE_PATHS) {
      const isFile = basename(path).includes(".");
      const file = isFile ? join(hub, path) : join(hub, path, "keep.txt");
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "{}\n");
    }
    ctx.paths.kitDir = kit;
    ctx.paths.hubRoot = hub;
    await syncKit(ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Asserts that `text` names `words` in that order. */
function assertInOrder(text: string, words: readonly string[]): void {
  let from = 0;
  for (const word of words) {
    const at = text.indexOf(word, from);
    assert.ok(at >= 0, `"${word}" missing (in order) from: ${text}`);
    from = at + word.length;
  }
}

describe("testnet sync regenerates fnn's whitelists from the server's hub.env", () => {
  it("runs `python3 add_token.py --regenerate --apply` in the kit folder after both uploads, with the wait timeout, and prints its output", async () => {
    const { server, ctx, runner, logger } = setup();
    const output = [
      "FIBER_ASSETS: RUSD, CWBTC  ->  RUSD, CWBTC",
      "hub configuration ok: assets CKB, RUSD, CWBTC; peer channels: CWBTC from 1000000 base units",
      "backed up into /opt/ckbolt/testnet/backups/add-token-20261107T010203Z",
      "fnn/hub.yml: written",
      "fnn-hub: restarting (fnn reads its whitelist only at start)",
    ];
    server.addToken = () => result(`${output[0]}\n${output[1]}\n\n${output.slice(2).join("\n")}\n`);

    await runSync(ctx);

    assert.equal(REGENERATE_WHITELISTS_COMMAND, BY_HAND);
    assert.deepEqual(server.addTokenRuns, [REGENERATE_ARGS], "run once, with exactly these arguments");
    const uploads = runner.calls.flatMap((call, index) => (call.input !== "" ? [index] : []));
    assert.equal(uploads.length, 2, "the kit and the hub source");
    const runs = runner.calls.flatMap((call, index) => (call.script === KIT_COMMAND ? [index] : []));
    assert.equal(runs.length, 1, `the command runs in ${TEST_REMOTE_DIR}`);
    const [run] = runs as [number];
    assert.ok(run > Math.max(...uploads), "it runs after both uploads");
    const call = runner.calls[run];
    assert.equal(call?.input, "", "nothing on its stdin");
    assert.equal(call?.options.timeoutMs, ctx.settings.timeouts.waitMs, "it may take as long as the other waits (fnn restarts, health)");
    assert.equal(call?.options.timeoutMs, 30_000, "DEPLOY_WAIT_TIMEOUT_SECONDS of the test settings");
    assert.notEqual(ctx.settings.timeouts.waitMs, ctx.settings.timeouts.commandMs, "the test tells the two timeouts apart");

    const printed = infoLines(logger);
    const at = output.map((line) => printed.indexOf(line));
    assert.ok(at.every((index) => index >= 0), `every output line is printed: ${printed.join(" | ")}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, "in the script's order");
    assert.ok(!printed.slice(Math.min(...at)).some((line) => line.trim() === ""), "blank lines are left out");
    assert.deepEqual(logger.warnings(), []);
  });

  it("looks for the hub image before it runs the script, and runs nothing after it", async () => {
    const { server, ctx, runner } = setup();
    await regenerateWhitelists(ctx);
    const scripts = kitScripts(runner);
    const python = scripts.indexOf(BY_HAND);
    assert.ok(python >= 0);
    assert.equal(python, scripts.length - 1, "the script runs last");
    assert.ok(scripts.slice(0, python).some((script) => script.startsWith(`docker image inspect ${HUB_IMAGE}`)), scripts.join(" | "));
    assert.equal(server.addTokenRuns.length, 1);
  });

  describe("skips with a note, and runs nothing else, while the server has no .env or hub.env", () => {
    for (const missing of [[".env"], ["hub.env"], [".env", "hub.env"]]) {
      it(`without ${missing.join(" and ")}`, async () => {
        const { server, ctx, runner, logger } = setup();
        for (const name of missing) server.files.delete(name);

        await regenerateWhitelists(ctx);

        const scripts = kitScripts(runner);
        assert.ok(
          scripts.length > 0 && scripts.every((script) => script.startsWith("test -e ") || isTemplateInstall(script)),
          `only file checks and putting missing whitelists in place: ${scripts.join(" | ")}`,
        );
        assert.deepEqual(scripts.filter(isTemplateInstall), [installTemplatesScript(false)], "copies only files the server lacks");
        assert.deepEqual(server.addTokenRuns, []);
        assert.deepEqual(logger.warnings(), [], "a note, not a warning: a new server has no hub.env before `testnet env`");
        const note = infoLines(logger).find((line) => /skipped/.test(line));
        assert.ok(note, `a note that it skipped: ${logger.text()}`);
        for (const name of missing) assert.ok(note.includes(name), `the note names ${name}: ${note}`);
        assert.ok(note.includes(BY_HAND) && note.includes(TEST_REMOTE_DIR), `the note says what to run, and where: ${note}`);
      });
    }

    it("lets the sync of a new server succeed", async () => {
      const { server, ctx, runner } = setup();
      server.files.delete(".env");
      server.files.delete("hub.env");
      await runSync(ctx);
      assert.equal(runner.calls.filter((call) => call.input !== "").length, 2, "both uploads done");
      assert.deepEqual(server.addTokenRuns, []);
    });
  });

  describe("warns, and does not run Python, while the hub image is not built", () => {
    const cases: [string, (server: FakeDeployment, runner: FakeRunner) => void][] = [
      ["the compose config names no image for the hub", (server) => delete server.config.services.hub?.image],
      ["the compose config gives the hub an empty image", (server) => Object.assign(server.config.services.hub ?? {}, { image: "" })],
      ["the hub's image is not on the server", (server) => server.images.clear()],
      [
        "`docker image inspect` times out",
        (_, runner) => runner.on((call) => (call.script?.includes("docker image inspect") ? timedOut() : undefined)),
      ],
    ];
    for (const [name, arrange] of cases) {
      it(name, async () => {
        const { server, ctx, runner, logger } = setup();
        arrange(server, runner);

        await regenerateWhitelists(ctx);

        assert.deepEqual(server.addTokenRuns, []);
        assert.ok(!kitScripts(runner).some((script) => script.includes("add_token.py")));
        const warnings = logger.warnings();
        assert.equal(warnings.length, 1, logger.text());
        assertInOrder(warnings[0] ?? "", ["testnet build hub", BY_HAND]);
        assert.ok(warnings[0]?.includes(TEST_REMOTE_DIR), warnings[0]);
      });
    }

    it("looks for the image the compose config names (HUB_IMAGE_TAG), not a fixed one", async () => {
      const tagged = "ckbolt/hub:2026-11-07";
      const missing = setup();
      missing.server.config.services.hub = { ...missing.server.config.services.hub, image: tagged };
      await regenerateWhitelists(missing.ctx);
      assert.deepEqual(missing.server.addTokenRuns, [], `${HUB_IMAGE} is on the server, ${tagged} is not`);
      assert.equal(missing.logger.warnings().length, 1);

      const present = setup();
      present.server.config.services.hub = { ...present.server.config.services.hub, image: tagged };
      present.server.images = new Set([tagged]);
      await regenerateWhitelists(present.ctx);
      assert.deepEqual(present.server.addTokenRuns, [REGENERATE_ARGS]);
      assert.deepEqual(present.logger.warnings(), []);
    });
  });

  it("never prints the compose config, which holds hub.env's values", async () => {
    const outcomes: [string, (server: FakeDeployment) => void][] = [
      ["regenerated", () => undefined],
      ["no image", (server) => server.images.clear()],
      ["failed", (server) => (server.addToken = () => result("", 1, "add_token: fnn-hub is not healthy after 300 s"))],
    ];
    for (const [name, arrange] of outcomes) {
      const { server, ctx, logger } = setup();
      server.config.services.hub = { ...server.config.services.hub, environment: { HUB_PROXY_SECRET: HUB_ENV_SECRET } };
      arrange(server);
      const error = await regenerateWhitelists(ctx).then(
        () => null,
        (thrown: unknown) => thrown as Error,
      );
      assert.ok(!logger.text().includes(HUB_ENV_SECRET), `${name}: the log shows the config`);
      assert.ok(!(error?.message ?? "").includes(HUB_ENV_SECRET), `${name}: the error shows the config`);
    }
  });

  describe("warns, and the sync still succeeds, when the hub image predates the whitelist generator", () => {
    const nodeError = [
      "node:internal/modules/cjs/loader:1228",
      "  throw err;",
      "  ^",
      "",
      "Error: Cannot find module '/app/dist/interfaces/cli/fnn-whitelist/main.js'",
      "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
      "  code: 'MODULE_NOT_FOUND',",
    ].join("\n");
    for (const stream of ["stderr", "stdout"] as const) {
      it(`with node's error on ${stream}`, async () => {
        const { server, ctx, runner, logger } = setup();
        const refusal = `add_token: the hub image refused the new configuration (nothing was changed):\n${nodeError}\n`;
        server.addToken = () =>
          stream === "stderr" ? result("FIBER_ASSETS: RUSD  ->  RUSD\n", 1, refusal) : result(`FIBER_ASSETS: RUSD  ->  RUSD\n${refusal}`, 1, "");

        await runSync(ctx);

        assert.equal(runner.calls.filter((call) => call.input !== "").length, 2, "both uploads done");
        assert.ok(infoLines(logger).includes("FIBER_ASSETS: RUSD  ->  RUSD"), "the script's output is printed");
        const warnings = logger.warnings();
        assert.equal(warnings.length, 1, logger.text());
        assertInOrder(warnings[0] ?? "", ["testnet build hub", BY_HAND, "testnet up hub"]);
      });
    }
  });

  it("notes, without a warning, that a hub.env on the legacy asset variables keeps the uploaded whitelists", async () => {
    const { server, ctx, logger } = setup();
    server.addToken = () =>
      result("", 1, "add_token: hub.env has no FIBER_ASSETS: move the hub to it first (docs/testing-testnet.md, section 6), then add tokens with this script\n");

    await regenerateWhitelists(ctx);

    assert.deepEqual(logger.warnings(), []);
    const note = infoLines(logger).find((line) => /skipped/.test(line));
    assert.ok(note?.includes("FIBER_ASSETS"), logger.text());
  });

  it("warns when python3 is not installed on the server (the shell's exit code 127)", async () => {
    const { server, ctx, logger } = setup();
    server.addToken = () => result("", 127, "sh: 1: python3: not found\n");

    await regenerateWhitelists(ctx);

    const warnings = logger.warnings();
    assert.equal(warnings.length, 1, logger.text());
    assert.match(warnings[0] ?? "", /python3/);
    assert.ok(warnings[0]?.includes(BY_HAND) && warnings[0].includes(TEST_REMOTE_DIR), warnings[0]);
  });

  describe("fails the sync with a RemoteCommandError naming the command for any other failure", () => {
    const failures: [string, CommandResult, RegExp][] = [
      [
        "fnn-hub not healthy after its restart",
        result("fnn/hub.yml: written\nfnn-hub: restarting (fnn reads its whitelist only at start)\n", 1, "add_token: fnn-hub is not healthy after 300 s: check `docker compose logs fnn-hub`\n"),
        /fnn-hub is not healthy after 300 s/,
      ],
      [
        "the hub image refusing hub.env",
        result("", 1, "add_token: the hub image refused the new configuration (nothing was changed):\nfnn-whitelist: FIBER_ASSETS is refused\n"),
        /FIBER_ASSETS is refused/,
      ],
      ["python3 cannot open the script", result("", 2, "python3: can't open file '/opt/ckbolt/testnet/add_token.py': [Errno 2] No such file or directory\n"), /can't open file/],
      ["ssh dropping the connection", result("", 255, "Connection to test-server closed by remote host.\n"), /closed by remote host/],
    ];
    for (const [name, answer, reason] of failures) {
      it(name, async () => {
        const { server, ctx, runner, logger } = setup();
        server.addToken = () => answer;

        await assert.rejects(runSync(ctx), (error: unknown) => {
          assert.ok(error instanceof RemoteCommandError, String(error));
          assert.ok(error.message.includes(BY_HAND), error.message);
          assert.ok(error.message.includes(TEST_REMOTE_DIR), error.message);
          assert.match(error.message, reason, "with the script's reason");
          assert.equal(error.result.exitCode, answer.exitCode);
          return true;
        });
        assert.equal(runner.calls.filter((call) => call.input !== "").length, 2, "the upload itself is done");
        for (const line of answer.stdout.split("\n").filter(Boolean)) assert.ok(infoLines(logger).includes(line), `printed: ${line}`);
        assert.deepEqual(logger.warnings(), []);
      });
    }

    it("a run that does not finish within the wait timeout", async () => {
      const { server, ctx, logger } = setup();
      server.addToken = () => timedOut("fnn-hub: restarting (fnn reads its whitelist only at start)\n");

      await assert.rejects(regenerateWhitelists(ctx), (error: unknown) => {
        assert.ok(error instanceof RemoteCommandError, String(error));
        assert.ok(error.message.includes(BY_HAND), error.message);
        assert.match(error.message, /timed out/);
        assert.equal(error.result.timedOut, true);
        return true;
      });
      assert.ok(infoLines(logger).includes("fnn-hub: restarting (fnn reads its whitelist only at start)"));
    });

    it("a run that exits 0 but timed out", async () => {
      const { server, ctx } = setup();
      server.addToken = () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: true });
      await assert.rejects(regenerateWhitelists(ctx), RemoteCommandError);
    });
  });

  describe("never replaces the whitelists fnn runs with the repo's copies", () => {
    const entry = (path: string): TarEntry => ({ path, content: Buffer.from(path), mode: 0o644, mtimeSeconds: 0 });

    it("uploads fnn/hub.yml and fnn/demo.yml as templates under .sync-templates, every other file where it was", () => {
      const moved = asWhitelistTemplates([entry("fnn/hub.yml"), entry("fnn/demo.yml"), entry("fnn/other.yml"), entry("add_token.py")]);
      assert.deepEqual(
        moved.map((item) => item.path),
        [".sync-templates/fnn/hub.yml", ".sync-templates/fnn/demo.yml", "fnn/other.yml", "add_token.py"],
      );
      assert.equal(moved[0]?.content.toString(), "fnn/hub.yml", "the content is the repo's copy");
    });

    it("runs add_token.py with the templates, and copies nothing into place itself, when it can run", async () => {
      const { server, ctx, runner } = setup();
      await regenerateWhitelists(ctx);
      assert.deepEqual(server.addTokenRuns, [REGENERATE_ARGS]);
      assert.deepEqual(kitScripts(runner).filter(isTemplateInstall), []);
    });

    const skips: [string, (server: FakeDeployment) => void][] = [
      ["no hub image", (server) => server.images.clear()],
      ["python3 missing", (server) => (server.addToken = () => result("", 127, "sh: 1: python3: not found\n"))],
      [
        "an image without the generator",
        (server) =>
          (server.addToken = () => result("", 1, "Error: Cannot find module '/app/dist/interfaces/cli/fnn-whitelist/main.js'\n")),
      ],
    ];
    for (const [name, arrange] of skips) {
      it(`keeps the server's files and copies only the missing ones when skipped (${name})`, async () => {
        const { server, ctx, runner } = setup();
        arrange(server);
        await regenerateWhitelists(ctx);
        assert.deepEqual(kitScripts(runner).filter(isTemplateInstall), [installTemplatesScript(false)]);
      });
    }

    it("puts the repo's whitelists in place for a hub.env on the legacy asset variables", async () => {
      const { server, ctx, runner } = setup();
      server.addToken = () => result("", 1, "add_token: hub.env has no FIBER_ASSETS: move the hub to it first\n");
      await regenerateWhitelists(ctx);
      assert.deepEqual(kitScripts(runner).filter(isTemplateInstall), [installTemplatesScript(true)]);
    });

    it("copies templates in a real shell: a missing file always, an existing one only with overwrite", () => {
      const dir = mkdtempSync(join(tmpdir(), "deploy-templates-"));
      try {
        mkdirSync(join(dir, ".sync-templates", "fnn"), { recursive: true });
        mkdirSync(join(dir, "fnn"));
        writeFileSync(join(dir, ".sync-templates", "fnn", "hub.yml"), "repo hub\n");
        writeFileSync(join(dir, ".sync-templates", "fnn", "demo.yml"), "repo demo\n");
        writeFileSync(join(dir, "fnn", "hub.yml"), "server hub\n");

        execFileSync("sh", ["-c", installTemplatesScript(false)], { cwd: dir });
        assert.equal(readFileSync(join(dir, "fnn", "hub.yml"), "utf8"), "server hub\n", "the server's own file stays");
        assert.equal(readFileSync(join(dir, "fnn", "demo.yml"), "utf8"), "repo demo\n", "a missing file is copied");

        execFileSync("sh", ["-c", installTemplatesScript(true)], { cwd: dir });
        assert.equal(readFileSync(join(dir, "fnn", "hub.yml"), "utf8"), "repo hub\n", "overwrite replaces it");

        rmSync(join(dir, ".sync-templates"), { recursive: true });
        execFileSync("sh", ["-c", installTemplatesScript(true)], { cwd: dir });
        assert.equal(readFileSync(join(dir, "fnn", "hub.yml"), "utf8"), "repo hub\n", "no template: nothing changes, no error");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
