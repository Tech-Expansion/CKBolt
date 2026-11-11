import { spawnSync } from "node:child_process";
import { createDeployContext, type DeployContext } from "../../scripts/lib/context";
import type { HttpClient, HttpRequest, HttpResponse } from "../../scripts/lib/http";
import type { Logger } from "../../scripts/lib/logger";
import { resolveDeployPaths } from "../../scripts/lib/paths";
import type { Clock } from "../../scripts/lib/poll";
import type { CommandResult, CommandRunner, RunOptions } from "../../scripts/lib/process";
import { readDeploySettings, type DeploySettings } from "../../scripts/lib/settings";

/**
 * Test doubles for the deploy scripts: a recording command runner that stands in for ssh (it decodes the sh script each
 * call carries), a fake HTTP client, a clock that only moves when slept on, and a logger that keeps every line.
 */

/** The remote command remoteShCommand builds: the script travels base64-encoded. */
const REMOTE_COMMAND = /^sh -c "\$\(printf %s ([A-Za-z0-9+/=]+) \| base64 -d\)"$/;

/** The sh script inside an ssh remote command; throws when the command has another shape. */
export function decodeRemoteScript(remoteCommand: string): string {
  const match = REMOTE_COMMAND.exec(remoteCommand);
  if (!match?.[1]) throw new Error(`not a remoteShCommand: ${remoteCommand}`);
  return Buffer.from(match[1], "base64").toString("utf8");
}

/** Splits a POSIX command line as shellJoin writes it (plain words, single quotes, backslash escapes) into words. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  for (let index = 0; index < line.length; ) {
    const char = line[index] ?? "";
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end < 0) throw new Error(`unterminated quote in: ${line}`);
      current += line.slice(index + 1, end);
      index = end + 1;
      inWord = true;
    } else if (char === "\\") {
      current += line[index + 1] ?? "";
      index += 2;
      inWord = true;
    } else if (char === " " || char === "\t" || char === "\n") {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
      index += 1;
    } else {
      current += char;
      inWord = true;
      index += 1;
    }
  }
  if (inWord) words.push(current);
  return words;
}

export interface RecordedCall {
  command: string;
  args: readonly string[];
  options: RunOptions;
  /** The decoded sh script of an ssh call; null for other programs (ssh -G). */
  script: string | null;
  /** The ssh destination (the argument before the remote command); null for other calls. */
  host: string | null;
  /** stdin as text (archives as base64). */
  input: string;
}

export const result = (stdout = "", exitCode: number | null = 0, stderr = ""): CommandResult => ({ exitCode, stdout, stderr, timedOut: false });

export type CallHandler = (call: RecordedCall) => CommandResult | Promise<CommandResult> | undefined;

const inputText = (input: RunOptions["input"]): string => (input === undefined ? "" : Buffer.isBuffer(input) ? input.toString("base64") : input);

/** A CommandRunner that records every call and answers with the first handler that returns a result. */
export class FakeRunner {
  readonly calls: RecordedCall[] = [];
  private readonly handlers: CallHandler[] = [];

  constructor(private readonly fallback: CallHandler = () => result()) {}

  /** Handlers added later win over earlier ones. */
  on(handler: CallHandler): this {
    this.handlers.unshift(handler);
    return this;
  }

  readonly runner: CommandRunner = async (command, args, options = {}) => {
    const isRemote = command === "ssh" && args.length >= 2 && REMOTE_COMMAND.test(args[args.length - 1] ?? "");
    const call: RecordedCall = {
      command,
      args,
      options,
      script: isRemote ? decodeRemoteScript(args[args.length - 1] ?? "") : null,
      host: isRemote ? (args[args.length - 2] ?? null) : null,
      input: inputText(options.input),
    };
    this.calls.push(call);
    for (const handler of this.handlers) {
      const answer = await handler(call);
      if (answer) return answer;
    }
    return (await this.fallback(call)) ?? result();
  };

  /** Every decoded remote script, in order. */
  scripts(): string[] {
    return this.calls.flatMap((call) => (call.script === null ? [] : [call.script]));
  }
}

/** The kit-directory prefix RemoteKit puts before each script. */
export function withoutKitDir(script: string, dir: string): string | null {
  const prefix = `cd ${dir} && `;
  return script.startsWith(prefix) ? script.slice(prefix.length) : null;
}

export type RecordedRequest = HttpRequest;

export type HttpHandler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse> | undefined;

/** An HttpClient that records requests and answers with the first matching handler (404 otherwise). */
export class FakeHttp {
  readonly requests: RecordedRequest[] = [];
  private readonly handlers: HttpHandler[] = [];

  on(handler: HttpHandler): this {
    this.handlers.unshift(handler);
    return this;
  }

  readonly client: HttpClient = async (request) => {
    this.requests.push(request);
    for (const handler of this.handlers) {
      const answer = await handler(request);
      if (answer) return answer;
    }
    return { status: 404, text: "not found" };
  };
}

export const json = (status: number, body: unknown): HttpResponse => ({ status, text: JSON.stringify(body) });

/** A clock that starts at `start` and moves only when slept on. */
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  constructor(private time = Date.UTC(2026, 9, 23)) {}
  now(): number {
    return this.time;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.time += ms;
  }
}

export class RecordingLogger implements Logger {
  readonly lines: { level: "step" | "info" | "warn" | "raw"; text: string }[] = [];
  step(title: string): void {
    this.lines.push({ level: "step", text: title });
  }
  info(message: string): void {
    this.lines.push({ level: "info", text: message });
  }
  warn(message: string): void {
    this.lines.push({ level: "warn", text: message });
  }
  raw(text: string): void {
    this.lines.push({ level: "raw", text });
  }
  text(): string {
    return this.lines.map((line) => line.text).join("\n");
  }
  warnings(): string[] {
    return this.lines.filter((line) => line.level === "warn").map((line) => line.text);
  }
}

export const TEST_HOST = "test-server";
export const TEST_REMOTE_DIR = "/opt/ckbolt/testnet";

/** Settings as a run reads them, with a fake host and short polls; `overrides` are DEPLOY_* variables. */
export function testSettings(overrides: Record<string, string> = {}): DeploySettings {
  return readDeploySettings({
    DEPLOY_SSH_HOST: TEST_HOST,
    DEPLOY_POLL_INTERVAL_SECONDS: "1",
    DEPLOY_WAIT_TIMEOUT_SECONDS: "30",
    DEPLOY_PEER_CONNECT_TIMEOUT_SECONDS: "10",
    DEPLOY_SMOKE_TIMEOUT_SECONDS: "60",
    ...overrides,
  });
}

export interface TestContext {
  ctx: DeployContext;
  runner: FakeRunner;
  http: FakeHttp;
  logger: RecordingLogger;
  clock: FakeClock;
}

export function testContext(options: { settings?: DeploySettings; runner?: FakeRunner; http?: FakeHttp } = {}): TestContext {
  const runner = options.runner ?? new FakeRunner();
  const http = options.http ?? new FakeHttp();
  const logger = new RecordingLogger();
  const clock = new FakeClock();
  const ctx = createDeployContext(options.settings ?? testSettings(), resolveDeployPaths(), {
    runner: runner.runner,
    http: http.client,
    logger,
    clock,
  });
  return { ctx, runner, http, logger, clock };
}

/** True when a POSIX sh (Git Bash on Windows) with the usual tools can run scripts locally. */
export function hasPosixShell(): boolean {
  const probe = spawnSync("sh", ["-c", "command -v awk >/dev/null && command -v od >/dev/null && command -v sed >/dev/null && echo ok"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return probe.status === 0 && probe.stdout.trim() === "ok";
}

/** Runs a script with the local sh in `cwd`; stdout, stderr and the exit code. */
export function runLocalSh(script: string, cwd: string, input?: string): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync("sh", ["-c", script], { cwd, encoding: "utf8", input, windowsHide: true });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** True when the Docker CLI with Compose v2 answers. */
export function hasDockerCompose(): boolean {
  const probe = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return probe.status === 0;
}
