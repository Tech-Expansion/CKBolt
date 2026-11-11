import { MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { BitcoindCli } from "./bitcoind";
import { CkbRpc } from "./ckb-rpc";
import { parseComposePs, type ComposeServiceState } from "./compose-state";
import { SERVICE, type FnnService, type LndService, type ServiceName } from "./constants";
import { CkbFaucet, MutinynetFaucet } from "./faucets";
import { FiberRpc } from "./fiber";
import { fetchHttpClient, type HttpClient } from "./http";
import { HubApi } from "./hub-api";
import { RemoteKit } from "./kit";
import { LndCli } from "./lnd";
import { consoleLogger, type Logger } from "./logger";
import { resolveDeployPaths, type DeployPaths } from "./paths";
import { systemClock, type Clock, type WaitOptions } from "./poll";
import { runCommand, type CommandRunner } from "./process";
import { loadDeploySettings, requireSshHost, type DeploySettings } from "./settings";
import { RemoteShell } from "./ssh";

/** Everything a step needs, built once per run. Tests build one with fakes (a recording runner, a fake HTTP client). */
export interface DeployContext {
  settings: DeploySettings;
  paths: DeployPaths;
  logger: Logger;
  clock: Clock;
  /** Programs on this machine (ssh -G). */
  runLocal: CommandRunner;
  http: HttpClient;
  /** Scripts on the server, from no particular folder (the kit folder may not exist yet). */
  shell: RemoteShell;
  /** Scripts and docker compose in the kit folder on the server. */
  kit: RemoteKit;
  bitcoind: BitcoindCli;
  lnd: Record<LndService, LndCli>;
  fiber: Record<FnnService, FiberRpc>;
  mutinynetFaucet: MutinynetFaucet;
  ckbFaucet: CkbFaucet;
  ckbRpc: CkbRpc;
  /** The hub's API through its published port (found on first use). */
  hubApi(): Promise<HubApi>;
}

export interface ContextDependencies {
  runner?: CommandRunner;
  http?: HttpClient;
  logger?: Logger;
  clock?: Clock;
}

export function createDeployContext(settings: DeploySettings, paths: DeployPaths, dependencies: ContextDependencies = {}): DeployContext {
  const runner = dependencies.runner ?? runCommand;
  const http = dependencies.http ?? fetchHttpClient;
  const target = { host: requireSshHost(settings), connectTimeoutSeconds: settings.ssh.connectTimeoutSeconds };
  const shell = new RemoteShell(target, runner, settings.timeouts.commandMs);
  const kit = new RemoteKit(settings.remoteDir, shell);
  const httpMs = settings.timeouts.httpMs;
  let hubApi: Promise<HubApi> | undefined;
  return {
    settings,
    paths,
    logger: dependencies.logger ?? consoleLogger,
    clock: dependencies.clock ?? systemClock,
    runLocal: runner,
    http,
    shell,
    kit,
    bitcoind: new BitcoindCli(kit),
    lnd: { [SERVICE.LND_HUB]: new LndCli(SERVICE.LND_HUB, kit), [SERVICE.LND_DEMO]: new LndCli(SERVICE.LND_DEMO, kit) },
    fiber: { [SERVICE.FNN_HUB]: new FiberRpc(SERVICE.FNN_HUB, kit), [SERVICE.FNN_DEMO]: new FiberRpc(SERVICE.FNN_DEMO, kit) },
    mutinynetFaucet: new MutinynetFaucet(http, settings.urls.mutinynetFaucet, httpMs),
    ckbFaucet: new CkbFaucet(http, settings.urls.ckbFaucetApi, httpMs),
    ckbRpc: new CkbRpc(http, settings.urls.ckbRpc, httpMs),
    hubApi: () => {
      hubApi ??= HubApi.connect(kit, httpMs / MS_PER_SECOND).catch((error: unknown) => {
        hubApi = undefined;
        throw error;
      });
      return hubApi;
    },
  };
}

/** The context of a real run: this checkout's folders, deploy/deploy.env and the environment, ssh and fetch. */
export function createDefaultContext(): DeployContext {
  const paths = resolveDeployPaths();
  return createDeployContext(loadDeploySettings(paths.deployDir), paths);
}

/** Waits of the steps: the settings' timeout and poll interval, the context's clock. */
export const waitOptions = (ctx: DeployContext, retryErrors = false, timeoutMs = ctx.settings.timeouts.waitMs): WaitOptions => ({
  timeoutMs,
  intervalMs: ctx.settings.timeouts.pollIntervalMs,
  retryErrors,
  clock: ctx.clock,
});

/** The services Compose would run with the server's .env (its COMPOSE_PROFILES), in the compose file's order. */
export async function activeServices(ctx: DeployContext): Promise<Set<ServiceName>> {
  const output = await ctx.kit.compose(["config", "--services"]);
  return new Set(output.split("\n").map((line) => line.trim()).filter(Boolean) as ServiceName[]);
}

/** Every container of the project, running or not. */
export async function serviceStates(ctx: DeployContext): Promise<Map<string, ComposeServiceState>> {
  const states = parseComposePs(await ctx.kit.compose(["ps", "--all", "--format", "json"]));
  return new Map(states.map((state) => [state.service, state]));
}
