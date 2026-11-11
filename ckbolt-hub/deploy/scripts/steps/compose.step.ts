import { activeServices, serviceStates, type DeployContext } from "../lib/context";
import {
  assessBitcoindTakeover,
  isServiceUp,
  listeningPorts,
  parseTakeoverProbe,
  portConflicts,
  publishedPortsOfConfig,
  takeoverProbeScript,
} from "../lib/compose-state";
import { KIT_FILE, LND_SERVICES, SERVICE, type ServiceName } from "../lib/constants";
import { hubMacaroonPath } from "../lib/kit-paths";

/** `docker compose` and the checks around it: build, up (with the bitcoind takeover guard), down, status, logs. */

const LISTENING_SOCKETS_COMMAND = "ss -ltnH";
const DEFAULT_LOG_LINES = 100;

export interface UpOptions {
  /** Services to start; empty: every service of the server's .env (its profiles). */
  services: readonly string[];
  /** Allows starting bitcoind without the existing chain volume (a new sync from block 0). */
  fresh: boolean;
}

/** Builds the images on the server (bitcoind, fnn, hub), streaming Docker's output. */
export async function buildImages(ctx: DeployContext, services: readonly string[]): Promise<void> {
  ctx.logger.step("Building the images on the server");
  await requireKitEnv(ctx);
  await ctx.kit.compose(["build", ...services], { output: "inherit", timeoutMs: ctx.settings.timeouts.buildMs });
}

/**
 * Starts services after three guards: bitcoind keeps the chain volume of the running sync, no wanted host port is held
 * by another project, and the hub starts only once its macaroons exist and its LND nodes are healthy (otherwise Compose
 * would wait on their health checks and fail).
 */
export async function upServices(ctx: DeployContext, options: UpOptions): Promise<void> {
  ctx.logger.step("Starting services");
  await requireKitEnv(ctx);
  const active = await activeServices(ctx);
  const unknown = options.services.filter((service) => !active.has(service as ServiceName));
  if (unknown.length > 0) {
    throw new Error(`Not services of this deployment: ${unknown.join(", ")} (the demo nodes need COMPOSE_PROFILES=demo in the server's .env)`);
  }
  const requested = options.services.length > 0 ? (options.services as ServiceName[]) : [...active];

  await guardBitcoindTakeover(ctx, options.fresh);
  await guardPorts(ctx, requested);
  const targets = await withoutHubUntilReady(ctx, requested, active, options.services.length > 0);
  if (targets.length === 0) return;

  await ctx.kit.compose(["up", "--detach", ...targets], { output: "inherit", timeoutMs: ctx.settings.timeouts.buildMs });
  ctx.logger.info(`started: ${targets.join(", ")}. Follow with \`testnet status\` and \`testnet:check\``);
}

async function requireKitEnv(ctx: DeployContext): Promise<void> {
  for (const file of [KIT_FILE.COMPOSE, KIT_FILE.ENV, KIT_FILE.HUB_ENV]) {
    if (!(await ctx.kit.fileExists(file))) throw new Error(`${file} is missing on the server: run \`testnet sync\` and \`testnet env\` first`);
  }
}

async function guardBitcoindTakeover(ctx: DeployContext, fresh: boolean): Promise<void> {
  const facts = parseTakeoverProbe(await ctx.kit.run(takeoverProbeScript(), { description: "inspect the bitcoind volume" }));
  const verdict = assessBitcoindTakeover(facts, SERVICE.BITCOIND);
  if (verdict.ok || (fresh && !facts.volumeExists)) {
    ctx.logger.info(verdict.ok ? verdict.message : "--fresh: bitcoind starts a new Mutinynet sync");
    return;
  }
  throw new Error(`Not starting: ${verdict.message}`);
}

async function guardPorts(ctx: DeployContext, targets: readonly ServiceName[]): Promise<void> {
  const wanted = publishedPortsOfConfig(await ctx.kit.compose(["config", "--format", "json"]));
  for (const [port, service] of wanted) if (!targets.includes(service as ServiceName)) wanted.delete(port);
  const listening = listeningPorts(await ctx.kit.run(LISTENING_SOCKETS_COMMAND, { description: "list listening ports" }));
  const ours = new Set([...(await serviceStates(ctx)).values()].flatMap((state) => state.publishers.map((publisher) => publisher.publishedPort)));
  const conflicts = portConflicts(wanted, listening, ours);
  if (conflicts.length > 0) throw new Error(`Not starting: ${conflicts.join("; ")}`);
}

/** Leaves the hub out until it can start; an explicit request for it fails with the reason instead. */
async function withoutHubUntilReady(
  ctx: DeployContext,
  targets: readonly ServiceName[],
  active: ReadonlySet<ServiceName>,
  explicit: boolean,
): Promise<ServiceName[]> {
  if (!targets.includes(SERVICE.HUB)) return [...targets];
  const reason = await hubNotReadyReason(ctx, active);
  if (!reason) return [...targets];
  if (explicit) throw new Error(`The hub cannot start yet: ${reason}`);
  ctx.logger.info(`leaving the hub out for now: ${reason}`);
  return targets.filter((service) => service !== SERVICE.HUB);
}

/**
 * The hub waits on every LND node of the deployment (the demo's too, when its profile runs) being healthy, and reads a
 * macaroon of each: null when all is there, else what is missing.
 */
async function hubNotReadyReason(ctx: DeployContext, active: ReadonlySet<ServiceName>): Promise<string | null> {
  const states = await serviceStates(ctx);
  for (const service of LND_SERVICES.filter((candidate) => active.has(candidate))) {
    if (!(await ctx.kit.fileExists(hubMacaroonPath(service)))) return `no macaroon for ${service} yet (testnet wallet ${service}, then testnet macaroons)`;
    if (!isServiceUp(states.get(service))) return `${service} is not healthy yet (LND waits for bitcoind to sync); run \`testnet up hub\` once it is`;
  }
  return null;
}

/** Stops services; without any, stops and removes the project's containers. Volumes always stay. */
export async function downServices(ctx: DeployContext, services: readonly string[]): Promise<void> {
  ctx.logger.step(services.length > 0 ? `Stopping ${services.join(", ")}` : "Stopping every service (volumes are kept)");
  const args = services.length > 0 ? ["stop", ...services] : ["down"];
  await ctx.kit.compose(args, { output: "inherit", timeoutMs: ctx.settings.timeouts.waitMs });
}

/** One line per service: state, health and published ports; services of the .env without a container say so. */
export async function showStatus(ctx: DeployContext): Promise<void> {
  ctx.logger.step(`Services on ${ctx.shell.target.host}:${ctx.settings.remoteDir}`);
  const [active, states] = await Promise.all([activeServices(ctx), serviceStates(ctx)]);
  for (const service of active) {
    const state = states.get(service);
    if (!state) {
      ctx.logger.info(`${service}: not created`);
      continue;
    }
    const ports = state.publishers.map((publisher) => `${publisher.url}:${publisher.publishedPort}->${publisher.targetPort}`).join(", ");
    ctx.logger.info(`${service}: ${state.state}${state.health ? ` (${state.health})` : ""}${ports ? `  ${ports}` : ""}`);
  }
}

export interface LogOptions {
  services: readonly string[];
  lines: number | null;
  follow: boolean;
}

/** Streams the services' logs to this terminal (Ctrl+C stops following). */
export async function showLogs(ctx: DeployContext, options: LogOptions): Promise<void> {
  const args = ["logs", "--no-color", "--tail", String(options.lines ?? DEFAULT_LOG_LINES), ...(options.follow ? ["--follow"] : []), ...options.services];
  await ctx.kit.compose(args, { output: "inherit", ...(options.follow ? { timeoutMs: undefined } : {}) });
}

/** Any other docker compose command, in the kit folder on the server. */
export async function passThroughCompose(ctx: DeployContext, args: readonly string[]): Promise<void> {
  await ctx.kit.compose(args, { output: "inherit", timeoutMs: ctx.settings.timeouts.buildMs });
}
