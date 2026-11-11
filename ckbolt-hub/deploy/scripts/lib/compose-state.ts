import { BITCOIND_DATA_DIR, BITCOIND_VOLUME } from "./constants";

/** Parsers and rules for what Docker and the server report: containers, published ports, listening sockets, volumes. */

export interface ComposePublisher {
  url: string;
  targetPort: number;
  publishedPort: number;
}

export interface ComposeServiceState {
  service: string;
  /** "running", "exited", "restarting", ... */
  state: string;
  /** "healthy", "starting", "unhealthy", or "" without a health check. */
  health: string;
  publishers: ComposePublisher[];
}

interface RawPsEntry {
  Service?: string;
  State?: string;
  Health?: string;
  Publishers?: { URL?: string; TargetPort?: number; PublishedPort?: number }[] | null;
}

/** `docker compose ps --format json`: one JSON object per line (Compose 2.21+) or one JSON array (older). */
export function parseComposePs(output: string): ComposeServiceState[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const raw: RawPsEntry[] = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as RawPsEntry[])
    : trimmed.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as RawPsEntry);
  return raw.map((entry) => ({
    service: entry.Service ?? "",
    state: entry.State ?? "",
    health: entry.Health ?? "",
    publishers: (entry.Publishers ?? [])
      .filter((publisher) => (publisher.PublishedPort ?? 0) > 0)
      .map((publisher) => ({ url: publisher.URL ?? "", targetPort: publisher.TargetPort ?? 0, publishedPort: publisher.PublishedPort ?? 0 })),
  }));
}

export const RUNNING_STATE = "running";
export const HEALTHY = "healthy";

/** Running, and healthy when it has a health check. */
export const isServiceUp = (state: ComposeServiceState | undefined): boolean =>
  state !== undefined && state.state === RUNNING_STATE && (state.health === "" || state.health === HEALTHY);

/** `docker compose port <service> <port>`: "127.0.0.1:18787" -> host and port; null for anything else. */
export function parsePublishedAddress(output: string): { host: string; port: number } | null {
  const match = /^(.*):(\d+)$/.exec(output.trim());
  if (!match?.[1] || !match[2]) return null;
  return { host: match[1], port: Number(match[2]) };
}

/**
 * The image a compose service runs, from `docker compose config --format json`; null when the config names none or
 * cannot be read. The config is never echoed: Compose puts hub.env's values in it.
 */
export function serviceImageOfConfig(configJson: string, service: string): string | null {
  let config: { services?: Record<string, { image?: unknown } | null> } | null;
  try {
    config = JSON.parse(configJson) as typeof config;
  } catch {
    return null;
  }
  const image = typeof config === "object" ? config?.services?.[service]?.image : undefined;
  return typeof image === "string" && image.trim() !== "" ? image : null;
}

/** Host ports a compose service publishes, from `docker compose config --format json`. */
export function publishedPortsOfConfig(configJson: string): Map<number, string> {
  const config = JSON.parse(configJson) as { services?: Record<string, { ports?: { published?: string | number }[] }> };
  const ports = new Map<number, string>();
  for (const [service, definition] of Object.entries(config.services ?? {})) {
    for (const port of definition.ports ?? []) {
      const published = Number(port.published);
      if (Number.isInteger(published) && published > 0) ports.set(published, service);
    }
  }
  return ports;
}

/** TCP ports listening on the server, from `ss -ltnH` (the local address is the fourth column). */
export function listeningPorts(ssOutput: string): Set<number> {
  const ports = new Set<number>();
  for (const line of ssOutput.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    const port = Number(local?.slice(local.lastIndexOf(":") + 1));
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return ports;
}

/**
 * Ports the kit wants that something else on the server already holds (another project's container, nginx): a sentence
 * each. Ports the kit's own running containers hold are fine.
 */
export function portConflicts(wanted: ReadonlyMap<number, string>, listening: ReadonlySet<number>, ours: ReadonlySet<number>): string[] {
  return [...wanted]
    .filter(([port]) => listening.has(port) && !ours.has(port))
    .map(([port, service]) => `port ${port} (${service}) is already used by something else on the server: change it in the kit's .env`);
}

/** A container that mounts the bitcoind volume, from takeoverProbeScript's output. */
export interface VolumeUser {
  container: string;
  /** Its compose service ("" when it is not a compose container). */
  service: string;
  running: boolean;
  /** Where it mounts the volume. */
  destination: string;
}

export interface TakeoverFacts {
  volumeExists: boolean;
  users: VolumeUser[];
}

const PROBE_SEPARATOR = "|";
const LINE_BREAK = "\n";
const VOLUME_PRESENT = "volume-present";
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

/** Prints whether the bitcoind volume exists, then `name|service|running|destination` per container that mounts it. */
export function takeoverProbeScript(): string {
  const format = [
    "{{.Name}}",
    `{{index .Config.Labels "${COMPOSE_SERVICE_LABEL}"}}`,
    "{{.State.Running}}",
    `{{range .Mounts}}{{if eq .Name "${BITCOIND_VOLUME}"}}{{.Destination}}{{end}}{{end}}`,
  ].join(PROBE_SEPARATOR);
  return [
    `if docker volume inspect ${BITCOIND_VOLUME} >/dev/null 2>&1; then echo ${VOLUME_PRESENT}; fi`,
    `ids=$(docker ps -aq --filter volume=${BITCOIND_VOLUME})`,
    `if [ -n "$ids" ]; then docker inspect --format '${format}' $ids; fi`,
  ].join(LINE_BREAK);
}

export function parseTakeoverProbe(output: string): TakeoverFacts {
  const lines = output.split(LINE_BREAK).map((line) => line.trim()).filter(Boolean);
  const users = lines
    .filter((line) => line.includes(PROBE_SEPARATOR))
    .map((line) => {
      const [container = "", service = "", running = "", destination = ""] = line.split(PROBE_SEPARATOR);
      return { container: container.replace(/^\//, ""), service, running: running === "true", destination };
    });
  return { volumeExists: lines.includes(VOLUME_PRESENT), users };
}

/**
 * Whether `up` may start bitcoind: it must take over the data volume of the Mutinynet sync (no resync from block 0), at
 * the path the image reads, with no other container still using it. `ok: false` says what to do.
 */
export function assessBitcoindTakeover({ volumeExists, users }: TakeoverFacts, bitcoindService: string): { ok: boolean; message: string } {
  if (!volumeExists) {
    return {
      ok: false,
      message:
        `volume ${BITCOIND_VOLUME} does not exist: bitcoind would sync Mutinynet from block 0 (hours). ` +
        "Check the server (docker volume ls); pass --fresh to start a new chain on purpose",
    };
  }
  const other = users.find((user) => user.running && user.service !== bitcoindService);
  if (other) {
    return {
      ok: false,
      message:
        `container ${other.container} (service "${other.service}") still runs on ${BITCOIND_VOLUME}: ` +
        `stop it first (e.g. docker compose -f sync.compose.yml stop; never "down -v")`,
    };
  }
  const misplaced = users.find((user) => user.service === bitcoindService && user.destination !== BITCOIND_DATA_DIR);
  if (misplaced) {
    return {
      ok: false,
      message:
        `${misplaced.container} mounts ${BITCOIND_VOLUME} at ${misplaced.destination}, the kit at ${BITCOIND_DATA_DIR}: ` +
        "bitcoind would not find its chain",
    };
  }
  return { ok: true, message: `bitcoind takes over volume ${BITCOIND_VOLUME} at ${BITCOIND_DATA_DIR}: no resync` };
}
