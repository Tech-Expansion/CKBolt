import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import { createDevnetContext, createFiberNodes, type DevnetContext, type FiberNodes } from "../../scripts/lib/context";
import { resolveHostEndpoints, type HostEndpoints } from "../../scripts/lib/endpoints";
import { JsonRpcClient } from "../../scripts/lib/json-rpc";

/** Everything the live checks share: the devnet scripts' context, the published endpoints and the hub's view of hub.env. */
export interface LiveContext {
  devnet: DevnetContext;
  endpoints: HostEndpoints;
  fiber: FiberNodes;
  /** Raw JSON-RPC clients, for calls the devnet's FiberNode does not wrap. */
  rpc: { ckb: JsonRpcClient; fnnHub: JsonRpcClient; fnnUser: JsonRpcClient };
  /** The hub repository root: hub.env paths are relative to it. */
  hubRoot: string;
  /** hub.env as the hub would read it, or undefined when it is missing or invalid (a check reports why). */
  hubEnv?: { vars: Record<string, string>; config: HubConfig };
}

export async function createLiveContext(): Promise<LiveContext> {
  const devnet = createDevnetContext();
  const endpoints = await resolveHostEndpoints(devnet.compose);
  const client = (url: string) => new JsonRpcClient(url, devnet.settings.waits.rpcTimeoutMs);
  return {
    devnet,
    endpoints,
    fiber: createFiberNodes(endpoints, devnet.settings),
    rpc: { ckb: client(endpoints.ckbRpcUrl), fnnHub: client(endpoints.fnnHubRpcUrl), fnnUser: client(endpoints.fnnUserRpcUrl) },
    hubRoot: resolve(devnet.paths.devnetDir, ".."),
  };
}

/** Parses devnet/hub.env the way a .env loader would and validates it with the hub's own config loader. */
export function readHubEnv(live: LiveContext): NonNullable<LiveContext["hubEnv"]> {
  const vars = parseDotenv(readFileSync(live.devnet.paths.hubEnvFile, "utf8"));
  return { vars, config: loadHubConfig(vars) };
}

/** Reads a file named by a hub.env path (relative to the hub root). */
export const readHubFile = (live: LiveContext, path: string): Buffer => readFileSync(resolve(live.hubRoot, path));

export function requireHubEnv(live: LiveContext): NonNullable<LiveContext["hubEnv"]> {
  if (!live.hubEnv) throw new Error("hub.env is missing or invalid (see the hub.env check)");
  return live.hubEnv;
}
