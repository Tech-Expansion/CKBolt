import { FileTipStore } from "./bitcoin-tip";
import { BitcoinNode } from "./bitcoind";
import { DockerCompose } from "./compose";
import { SERVICE } from "./devnet.constants";
import type { HostEndpoints } from "./endpoints";
import type { Env } from "./env";
import { FiberNode } from "./fiber";
import { JsonRpcClient } from "./json-rpc";
import { LndNode } from "./lnd";
import { consoleLogger, type Logger } from "./logger";
import { resolveDevnetPaths, type DevnetPaths } from "./paths";
import { systemClock, type Clock, type WaitOptions } from "./poll";
import { loadDevnetSettings, type DevnetSettings } from "./settings";

/** Everything a devnet step needs, built once by the entry script and passed in (no module-level state). */
export interface DevnetContext {
  settings: DevnetSettings;
  paths: DevnetPaths;
  logger: Logger;
  clock: Clock;
  compose: DockerCompose;
  bitcoin: BitcoinNode;
  lnd: { hub: LndNode; user: LndNode };
}

export interface FiberNodes {
  hub: FiberNode;
  user: FiberNode;
}

export function createDevnetContext(env: Env = process.env): DevnetContext {
  const paths = resolveDevnetPaths();
  const compose = new DockerCompose(paths.devnetDir);
  return {
    settings: loadDevnetSettings(env),
    paths,
    logger: consoleLogger,
    clock: systemClock,
    compose,
    bitcoin: new BitcoinNode(compose, new FileTipStore(paths.bitcoinTipFile)),
    lnd: { hub: new LndNode(SERVICE.LND_HUB, compose), user: new LndNode(SERVICE.LND_USER, compose) },
  };
}

export function createFiberNodes(endpoints: HostEndpoints, settings: DevnetSettings): FiberNodes {
  const rpc = (url: string) => new JsonRpcClient(url, settings.waits.rpcTimeoutMs);
  return {
    hub: new FiberNode(SERVICE.FNN_HUB, rpc(endpoints.fnnHubRpcUrl)),
    user: new FiberNode(SERVICE.FNN_USER, rpc(endpoints.fnnUserRpcUrl)),
  };
}

/** Wait options from the settings; `retryErrors` for nodes that may still be starting. */
export const waitOptions = (
  { settings, clock }: { settings: Pick<DevnetSettings, "waits">; clock: Clock },
  retryErrors = false,
): WaitOptions => ({
  timeoutMs: settings.waits.timeoutMs,
  intervalMs: settings.waits.pollIntervalMs,
  retryErrors,
  clock,
});
