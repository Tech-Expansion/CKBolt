import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
}

/** Runs a program without a shell (so Git Bash, PowerShell and cmd behave the same) and collects its output. */
export type CommandRunner = (command: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly output: string,
  ) {
    super(`${[command, ...args].join(" ")} failed (exit ${exitCode ?? "signal"}): ${output.trim()}`);
  }
}

export const runCommand: CommandRunner = (command, args, { cwd }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve({ stdout, stderr });
      else reject(new CommandError(command, args, exitCode, stderr || stdout));
    });
  });
