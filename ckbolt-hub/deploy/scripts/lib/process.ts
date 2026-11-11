import { spawn } from "node:child_process";

export interface RunOptions {
  /** Written to the program's stdin, which is then closed. Without it stdin is closed at once. */
  input?: string | Buffer;
  /** The program is killed after this long and the result says `timedOut`. */
  timeoutMs?: number;
  /** "inherit" streams stdout and stderr to this terminal (long builds, logs) instead of collecting them. */
  output?: "capture" | "inherit";
}

export interface CommandResult {
  /** null when the program was killed (timeout or signal). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a program without a local shell (Git Bash, PowerShell and cmd behave the same) and reports how it ended. It never
 * throws for a non-zero exit: the caller decides what an exit code means (ssh uses 255 for its own failures).
 */
export type CommandRunner = (command: string, args: readonly string[], options?: RunOptions) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const inherit = options.output === "inherit";
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", inherit ? "inherit" : "pipe", inherit ? "inherit" : "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => ((timedOut = true), child.kill()), options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
    // A program that exits before reading all of its input closes the pipe; its exit code tells what happened.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);
  });
