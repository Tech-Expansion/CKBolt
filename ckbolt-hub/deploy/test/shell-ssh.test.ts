import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { RemoteKit } from "../scripts/lib/kit";
import { runCommand } from "../scripts/lib/process";
import { inDirectory, remoteShCommand, shellJoin, shellQuote } from "../scripts/lib/shell";
import { RemoteCommandError, RemoteShell, SSH_FAILURE_EXIT_CODE, sshArguments } from "../scripts/lib/ssh";
import { decodeRemoteScript, FakeRunner, hasPosixShell, result, runLocalSh, shellWords } from "./support/fakes";

const TRICKY = ["plain", "with space", "it's", "'", "''", "$HOME", "`id`", "$(id)", "a;b", "a&&b", "x\ny", "*", "~", "-n", "", "é", '"q"', "\\"];

describe("shellQuote and shellJoin", () => {
  it("leaves safe words unchanged and quotes everything else", () => {
    assert.equal(shellQuote("docker"), "docker");
    assert.equal(shellQuote("/opt/ckbolt/testnet"), "/opt/ckbolt/testnet");
    assert.equal(shellQuote("--save_to=/root/.lnd/hub.macaroon"), "--save_to=/root/.lnd/hub.macaroon");
    assert.equal(shellQuote("a b"), "'a b'");
    assert.equal(shellQuote("it's"), "'it'\\''s'");
    assert.equal(shellQuote(""), "''");
  });

  it("gives back the exact words (checked with this file's own parser)", () => {
    assert.deepEqual(shellWords(shellJoin(TRICKY)), TRICKY);
  });

  it("gives back the exact words in a real POSIX sh", { skip: !hasPosixShell() && "no local sh" }, () => {
    const script = `for word in ${shellJoin(TRICKY)}; do printf '<%s>' "$word"; done`;
    const run = runLocalSh(script, tmpdir());
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, TRICKY.map((word) => `<${word}>`).join(""));
  });
});

describe("remoteShCommand", () => {
  it("carries the script base64-encoded, so no quoting has to survive ssh and the Windows command line", () => {
    const script = `cd '/opt/x' && echo "$HOME" | sed 's/a/b/'\nprintf '%s' "it's"`;
    const command = remoteShCommand(script);
    assert.match(command, /^sh -c "\$\(printf %s [A-Za-z0-9+/=]+ \| base64 -d\)"$/);
    assert.equal(decodeRemoteScript(command), script);
  });

  it("runs the script as written in a real sh", { skip: !hasPosixShell() && "no local sh" }, () => {
    const run = runLocalSh(remoteShCommand(`printf '%s|' "it's" '$(id)' "a b"`), tmpdir());
    assert.equal(run.stdout, "it's|$(id)|a b|");
  });

  it("inDirectory stops when the folder is missing", () => {
    assert.equal(inDirectory("/opt/ckbolt/testnet", "ls"), "cd /opt/ckbolt/testnet && ls");
    assert.equal(inDirectory("/opt/a b", "ls"), "cd '/opt/a b' && ls");
  });
});

describe("sshArguments", () => {
  it("never prompts (BatchMode), bounds the connect time, asks for no terminal, and names the host from the settings", () => {
    const args = sshArguments({ host: "testnet-vps", connectTimeoutSeconds: 15 }, "uptime");
    assert.deepEqual(args, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-T", "testnet-vps", "uptime"]);
  });
});

describe("RemoteShell", () => {
  const target = { host: "test-server", connectTimeoutSeconds: 9 };

  it("runs ssh with the encoded script, the default timeout, and stdin when given", async () => {
    const fake = new FakeRunner(() => result("out\n"));
    const shell = new RemoteShell(target, fake.runner, 1234);
    assert.equal(await shell.exec("echo hi", { input: "data" }), "out\n");
    const [call] = fake.calls;
    assert.equal(call?.command, "ssh");
    assert.equal(call?.host, "test-server");
    assert.equal(call?.script, "echo hi");
    assert.equal(call?.options.timeoutMs, 1234);
    assert.equal(call?.input, "data");
    assert.ok(call?.args.includes("BatchMode=yes"));
  });

  it("lets a call override the timeout (long builds)", async () => {
    const fake = new FakeRunner();
    await new RemoteShell(target, fake.runner, 1000).exec("true", { timeoutMs: 99_000 });
    assert.equal(fake.calls[0]?.options.timeoutMs, 99_000);
  });

  it("throws RemoteCommandError naming the command, never showing the script (it may carry secrets)", async () => {
    const secretScript = "printf %s supersecretvalue > .env";
    const fake = new FakeRunner(() => result("", 2, "permission denied"));
    const shell = new RemoteShell(target, fake.runner, 1000);
    await assert.rejects(shell.exec(secretScript, { description: "complete .env" }), (error: unknown) => {
      assert.ok(error instanceof RemoteCommandError);
      assert.equal(error.message, "complete .env failed (exit 2): permission denied");
      assert.doesNotMatch(error.message, /supersecretvalue/);
      assert.equal(error.result.exitCode, 2);
      return true;
    });
  });

  it("says when ssh itself failed (exit 255) and when a command timed out", async () => {
    const unreachable = new RemoteShell(target, new FakeRunner(() => result("", SSH_FAILURE_EXIT_CODE, "Permission denied (publickey).")).runner, 1000);
    await assert.rejects(unreachable.exec("true", { description: "probe" }), /probe: ssh could not run it \(Permission denied \(publickey\)\.\)/);
    const slow = new RemoteShell(target, new FakeRunner(() => ({ exitCode: null, stdout: "", stderr: "", timedOut: true })).runner, 1000);
    await assert.rejects(slow.exec("sleep 1000", { description: "build" }), /build: timed out/);
  });

  it("tryExec reports failures instead of throwing", async () => {
    const shell = new RemoteShell(target, new FakeRunner(() => result("", 1)).runner, 1000);
    assert.equal((await shell.tryExec("test -e x")).exitCode, 1);
  });
});

describe("RemoteKit", () => {
  const kitWith = (fake: FakeRunner) => new RemoteKit("/opt/ckbolt/testnet", new RemoteShell({ host: "h", connectTimeoutSeconds: 5 }, fake.runner, 1000));

  it("runs docker compose in the kit folder so Compose reads the kit's .env", async () => {
    const fake = new FakeRunner(() => result("{}"));
    await kitWith(fake).compose(["ps", "--all", "--format", "json"]);
    assert.equal(fake.calls[0]?.script, "cd /opt/ckbolt/testnet && docker compose ps --all --format json");
  });

  it("execs inside a service without a terminal (-T) so the output can be parsed", async () => {
    const fake = new FakeRunner(() => result('{"a":1}'));
    assert.deepEqual(await kitWith(fake).execJson("lnd-hub", ["lncli", "--network=signet", "getinfo"]), { a: 1 });
    assert.equal(fake.calls[0]?.script, "cd /opt/ckbolt/testnet && docker compose exec -T lnd-hub lncli --network=signet getinfo");
  });

  it("names the command when its output is not JSON", async () => {
    const fake = new FakeRunner(() => result("[lncli] oops"));
    await assert.rejects(kitWith(fake).execJson("lnd-hub", ["lncli", "--network=signet", "getinfo"]), /lnd-hub: lncli --network=signet did not print JSON: \[lncli\] oops/);
  });

  it("creates secret folders owner-only (700)", async () => {
    const fake = new FakeRunner();
    await kitWith(fake).makeSecretDirs(["secrets", "secrets/wallet"]);
    assert.match(fake.calls[0]?.script ?? "", /mkdir -p secrets secrets\/wallet && chmod 700 secrets secrets\/wallet$/);
  });

  it("hands secrets/hub to uid 1000 owner-only, with sudo -n (never a password prompt) when not root", async () => {
    const fake = new FakeRunner();
    await kitWith(fake).handToHubUser("secrets/hub");
    const script = fake.calls[0]?.script ?? "";
    assert.match(script, /chown -R 1000:1000 secrets\/hub/);
    assert.match(script, /chmod -R go-rwx secrets\/hub/);
    assert.match(script, /-type f -exec chmod 600/);
    assert.match(script, /sudo -n sh -c/);
  });
});

describe("runCommand (the real process runner)", () => {
  it("captures stdout and the exit code without a local shell, and never throws for a non-zero exit", async () => {
    const ok = await runCommand(process.execPath, ["-e", "process.stdout.write('hi'); process.exitCode = 3"]);
    assert.deepEqual({ exitCode: ok.exitCode, stdout: ok.stdout, timedOut: ok.timedOut }, { exitCode: 3, stdout: "hi", timedOut: false });
  });

  it("writes the input to stdin", async () => {
    const echoed = await runCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "piped data" });
    assert.equal(echoed.stdout, "piped data");
  });

  it("kills a program that runs past its timeout", async () => {
    const slow = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 300 });
    assert.equal(slow.timedOut, true);
  });

  it("rejects when the program does not exist", async () => {
    await assert.rejects(runCommand("ckbolt-no-such-program-xyz", []));
  });
});
