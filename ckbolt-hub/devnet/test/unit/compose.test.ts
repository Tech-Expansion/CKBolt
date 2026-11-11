import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DockerCompose } from "../../scripts/lib/compose";
import { SERVICE } from "../../scripts/lib/devnet.constants";
import { resolveDevnetPaths, secretFileLocation } from "../../scripts/lib/paths";
import { CommandError, type CommandOptions, type CommandRunner } from "../../scripts/lib/process";

interface Call {
  command: string;
  args: readonly string[];
  options: CommandOptions;
}

function recordingRunner(stdout = ""): { runner: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout, stderr: "" };
  };
  return { runner, calls };
}

describe("DockerCompose", () => {
  it("runs every command as `docker compose` in the project directory, without a shell", async () => {
    const { runner, calls } = recordingRunner("{}");
    const compose = new DockerCompose("/project", runner);
    await compose.exec(SERVICE.LND_HUB, ["lncli", "getinfo"]);
    assert.equal(calls[0]?.command, "docker");
    assert.deepEqual(calls[0]?.args.slice(0, 1), ["compose"]);
    assert.equal(calls[0]?.options.cwd, "/project");
  });

  it("up waits for health with a timeout and can target and recreate services", async () => {
    const { runner, calls } = recordingRunner();
    const compose = new DockerCompose("/p", runner);
    await compose.up({ waitTimeoutSeconds: 300 });
    await compose.up({ services: [SERVICE.FNN_HUB, SERVICE.FNN_USER], waitTimeoutSeconds: 60, forceRecreate: true });
    assert.deepEqual(calls[0]?.args, ["compose", "up", "--detach", "--wait", "--wait-timeout", "300"]);
    assert.deepEqual(calls[1]?.args, ["compose", "up", "--detach", "--wait", "--wait-timeout", "60", "--force-recreate", "fnn-hub", "fnn-user"]);
  });

  it("down removes volumes only for a reset", async () => {
    const { runner, calls } = recordingRunner();
    const compose = new DockerCompose("/p", runner);
    await compose.down({ volumes: false });
    await compose.down({ volumes: true });
    assert.deepEqual(calls[0]?.args, ["compose", "down", "--remove-orphans"]);
    assert.deepEqual(calls[1]?.args, ["compose", "down", "--remove-orphans", "--volumes"]);
  });

  it("exec disables the TTY so output can be parsed, and execJson parses it", async () => {
    const { runner, calls } = recordingRunner('{"a":1}');
    const compose = new DockerCompose("/p", runner);
    assert.deepEqual(await compose.execJson(SERVICE.BITCOIND, ["x"]), { a: 1 });
    assert.deepEqual(calls[0]?.args, ["compose", "exec", "-T", "bitcoind", "x"]);
  });

  it("execJson fails on output that is not JSON", async () => {
    const { runner } = recordingRunner("not json");
    await assert.rejects(new DockerCompose("/p", runner).execJson(SERVICE.LND_HUB, ["x"]), SyntaxError);
  });

  it("copyFrom names the container file as service:path", async () => {
    const { runner, calls } = recordingRunner();
    await new DockerCompose("/p", runner).copyFrom(SERVICE.LND_HUB, "/root/.lnd/tls.cert", ".secrets/lnd-hub/tls.cert");
    assert.deepEqual(calls[0]?.args, ["compose", "cp", "lnd-hub:/root/.lnd/tls.cert", ".secrets/lnd-hub/tls.cert"]);
  });

  it("hostAddress trims the published address and explains an unpublished port", async () => {
    assert.equal(await new DockerCompose("/p", recordingRunner("127.0.0.1:8227\r\n").runner).hostAddress(SERVICE.FNN_HUB, 8227), "127.0.0.1:8227");
    await assert.rejects(new DockerCompose("/p", recordingRunner("  \n").runner).hostAddress(SERVICE.FNN_HUB, 9999), /does not publish port 9999; is the devnet running\?/);
  });

  it("passes command failures through as CommandError", async () => {
    const failing: CommandRunner = async (command, args) => Promise.reject(new CommandError(command, args, 1, "service is not running"));
    await assert.rejects(new DockerCompose("/p", failing).exec(SERVICE.CKB, ["true"]), (error) => error instanceof CommandError && error.exitCode === 1);
  });
});

describe("CommandError", () => {
  it("names the command, the exit code and the output", () => {
    const error = new CommandError("docker", ["compose", "ps"], 2, " boom \n");
    assert.equal(error.message, "docker compose ps failed (exit 2): boom");
    assert.equal(new CommandError("x", [], null, "").message, "x failed (exit signal): ");
  });
});

describe("devnet paths", () => {
  it("resolves the compose project directory from the scripts, whatever the working directory", () => {
    const paths = resolveDevnetPaths();
    assert.ok(existsSync(join(paths.devnetDir, "docker-compose.yml")), paths.devnetDir);
    assert.equal(paths.hubEnvFile, join(paths.devnetDir, "hub.env"));
    assert.equal(paths.fnnUdtEnvFile, join(paths.devnetDir, "state", "fnn-udt.env"));
  });

  it("names a secret relative to devnet/ for docker cp and relative to the hub root for hub.env", () => {
    const location = secretFileLocation(resolveDevnetPaths("C:\\work\\hub\\devnet"), SERVICE.LND_HUB, "hub.macaroon");
    assert.equal(location.devnetRelative, ".secrets/lnd-hub/hub.macaroon");
    assert.equal(location.hubRelative, "./devnet/.secrets/lnd-hub/hub.macaroon");
    assert.ok(!location.devnetRelative.includes(":"), "no drive letter for docker compose cp");
    assert.equal(location.hostDir, join("C:\\work\\hub\\devnet", ".secrets", "lnd-hub"));
  });
});
