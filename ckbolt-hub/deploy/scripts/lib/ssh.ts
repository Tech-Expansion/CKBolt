import type { CommandResult, CommandRunner, RunOptions } from "./process";
import { remoteShCommand } from "./shell";

/** OpenSSH's exit code for its own failures (connection, authentication), as opposed to the remote command's. */
export const SSH_FAILURE_EXIT_CODE = 255;
const SSH_PROGRAM = "ssh";
/** How many characters of a failed command's output an error message keeps. */
const ERROR_OUTPUT_LIMIT = 2_000;

export interface SshTarget {
  host: string;
  connectTimeoutSeconds: number;
}

export interface RemoteRunOptions extends RunOptions {
  /** Names the command in errors (the script itself is never shown). */
  description?: string;
}

/** A remote command that ended badly. `result` keeps the full output for callers that recognise known failures. */
export class RemoteCommandError extends Error {
  constructor(
    readonly description: string,
    readonly result: CommandResult,
  ) {
    super(RemoteCommandError.explain(description, result));
  }

  private static explain(description: string, result: CommandResult): string {
    if (result.timedOut) return `${description}: timed out`;
    const output = (result.stderr.trim() || result.stdout.trim()).slice(-ERROR_OUTPUT_LIMIT);
    if (result.exitCode === SSH_FAILURE_EXIT_CODE) return `${description}: ssh could not run it (${output || "no output"})`;
    return `${description} failed (exit ${result.exitCode ?? "signal"})${output ? `: ${output}` : ""}`;
  }
}

/** The arguments of one ssh call: no password prompts, no terminal, a bounded connect time. */
export function sshArguments(target: SshTarget, remoteCommand: string): string[] {
  return ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${target.connectTimeoutSeconds}`, "-T", target.host, remoteCommand];
}

/** Runs sh scripts on the server over ssh (the system's OpenSSH: Windows, Git Bash or Linux). */
export class RemoteShell {
  constructor(
    readonly target: SshTarget,
    private readonly run: CommandRunner,
    private readonly defaultTimeoutMs: number,
  ) {}

  /** Runs the script and reports how it ended, whatever the exit code. */
  tryExec(script: string, options: RemoteRunOptions = {}): Promise<CommandResult> {
    const { description: _description, ...runOptions } = options;
    return this.run(SSH_PROGRAM, sshArguments(this.target, remoteShCommand(script)), {
      timeoutMs: this.defaultTimeoutMs,
      ...runOptions,
    });
  }

  /** Runs the script and returns its stdout; throws RemoteCommandError unless it exits 0. */
  async exec(script: string, options: RemoteRunOptions = {}): Promise<string> {
    const result = await this.tryExec(script, options);
    if (result.exitCode !== 0 || result.timedOut) throw new RemoteCommandError(options.description ?? "remote command", result);
    return result.stdout;
  }
}
