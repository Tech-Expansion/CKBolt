import { HUB_CONTAINER_UID, SECRET_DIR_MODE, SECRET_FILE_MODE, type ServiceName } from "./constants";
import { inDirectory, shellJoin, shellQuote } from "./shell";
import type { RemoteRunOptions, RemoteShell } from "./ssh";
import type { CommandResult } from "./process";

const DOCKER_COMPOSE = ["docker", "compose"] as const;

/**
 * The kit directory on the server: every command runs there, so `docker compose` reads the kit's .env (COMPOSE_FILE,
 * COMPOSE_PROFILES and the variables) exactly as it does for an operator logged in on the server.
 */
export class RemoteKit {
  constructor(
    readonly dir: string,
    private readonly shell: RemoteShell,
  ) {}

  /** Runs a script in the kit directory; returns its stdout or throws RemoteCommandError. */
  run(script: string, options: RemoteRunOptions = {}): Promise<string> {
    return this.shell.exec(inDirectory(this.dir, script), options);
  }

  /** Runs a script in the kit directory and reports how it ended, whatever the exit code. */
  tryRun(script: string, options: RemoteRunOptions = {}): Promise<CommandResult> {
    return this.shell.tryExec(inDirectory(this.dir, script), options);
  }

  /** `docker compose <args>` in the kit directory. */
  compose(args: readonly string[], options: RemoteRunOptions = {}): Promise<string> {
    return this.run(shellJoin([...DOCKER_COMPOSE, ...args]), { description: `docker compose ${args.join(" ")}`, ...options });
  }

  tryCompose(args: readonly string[], options: RemoteRunOptions = {}): Promise<CommandResult> {
    return this.tryRun(shellJoin([...DOCKER_COMPOSE, ...args]), options);
  }

  /** Runs a program inside a running service's container, without a terminal so its output can be parsed. */
  exec(service: ServiceName, argv: readonly string[], options: RemoteRunOptions = {}): Promise<string> {
    return this.compose(["exec", "-T", service, ...argv], { description: `${service}: ${argv.slice(0, 2).join(" ")}`, ...options });
  }

  async execJson<T>(service: ServiceName, argv: readonly string[], options: RemoteRunOptions = {}): Promise<T> {
    return parseJsonOutput<T>(await this.exec(service, argv, options), `${service}: ${argv.slice(0, 2).join(" ")}`);
  }

  async fileExists(path: string): Promise<boolean> {
    return (await this.tryRun(`test -e ${shellQuote(path)}`)).exitCode === 0;
  }

  readText(path: string): Promise<string> {
    return this.run(`cat ${shellQuote(path)}`, { description: `read ${path}` });
  }

  /** Writes a non-secret text file (replacing it) from stdin. */
  async writeText(path: string, content: string): Promise<void> {
    await this.run(`cat > ${shellQuote(path)}`, { input: content, description: `write ${path}` });
  }

  /** Creates owner-only directories (mode 700). */
  async makeSecretDirs(paths: readonly string[]): Promise<void> {
    const quoted = paths.map(shellQuote).join(" ");
    await this.run(`mkdir -p ${quoted} && chmod ${SECRET_DIR_MODE} ${quoted}`, { description: "create secret folders" });
  }

  /**
   * Hands a folder to the hub container's user (uid 1000), owner-only. Needs root, or passwordless sudo, on the server;
   * otherwise the error says what to run.
   */
  async handToHubUser(path: string): Promise<void> {
    const target = shellQuote(path);
    const owner = `${HUB_CONTAINER_UID}:${HUB_CONTAINER_UID}`;
    const commands = `chown -R ${owner} ${target} && chmod -R go-rwx ${target} && find ${target} -type f -exec chmod ${SECRET_FILE_MODE} {} +`;
    const script = `if [ "$(id -u)" -eq 0 ]; then ${commands}; else sudo -n sh -c ${shellQuote(commands)}; fi`;
    await this.run(script, { description: `give ${path} to uid ${HUB_CONTAINER_UID} (the hub container's user; needs root or sudo)` });
  }
}

/** Parses a command's JSON output; the error names the command and shows the start of what it printed. */
export function parseJsonOutput<T>(output: string, description: string): T {
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error(`${description} did not print JSON: ${output.trim().slice(0, 200) || "(nothing)"}`);
  }
}
