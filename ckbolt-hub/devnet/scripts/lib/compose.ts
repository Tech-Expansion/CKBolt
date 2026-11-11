import { runCommand, type CommandRunner } from "./process";
import type { ServiceName } from "./devnet.constants";

const DOCKER = "docker";

/** The devnet's docker compose project: lifecycle, commands inside services, files and published ports. */
export class DockerCompose {
  constructor(
    private readonly projectDir: string,
    private readonly run: CommandRunner = runCommand,
  ) {}

  /** Starts (or recreates) services and waits until their healthchecks pass. No services = the whole stack. */
  async up(options: { services?: readonly ServiceName[]; waitTimeoutSeconds: number; forceRecreate?: boolean }): Promise<void> {
    const recreate = options.forceRecreate ? ["--force-recreate"] : [];
    await this.compose([
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      String(options.waitTimeoutSeconds),
      ...recreate,
      ...(options.services ?? []),
    ]);
  }

  /** Removes the containers and network; with `volumes`, also every node's data (a full reset). */
  async down(options: { volumes: boolean }): Promise<void> {
    await this.compose(["down", "--remove-orphans", ...(options.volumes ? ["--volumes"] : [])]);
  }

  /** Runs a command in a running service and returns its stdout. */
  async exec(service: ServiceName, args: readonly string[]): Promise<string> {
    const { stdout } = await this.compose(["exec", "-T", service, ...args]);
    return stdout;
  }

  async execJson<T>(service: ServiceName, args: readonly string[]): Promise<T> {
    return JSON.parse(await this.exec(service, args)) as T;
  }

  /** The last `tailLines` lines a service logged, across its container's restarts, without colours. */
  async logs(service: ServiceName, tailLines: number): Promise<string> {
    const { stdout } = await this.compose(["logs", "--no-color", "--tail", String(tailLines), service]);
    return stdout;
  }

  /** Copies a file out of a service. `hostPath` is relative to the project directory (no drive letter to confuse `cp`). */
  async copyFrom(service: ServiceName, containerPath: string, hostPath: string): Promise<void> {
    await this.compose(["cp", `${service}:${containerPath}`, hostPath]);
  }

  /** The host address ("127.0.0.1:8227") a container port is published on. */
  async hostAddress(service: ServiceName, containerPort: number): Promise<string> {
    const { stdout } = await this.compose(["port", service, String(containerPort)]);
    const address = stdout.trim();
    if (!address) throw new Error(`${service} does not publish port ${containerPort}; is the devnet running?`);
    return address;
  }

  private compose(args: readonly string[]) {
    return this.run(DOCKER, ["compose", ...args], { cwd: this.projectDir });
  }
}
