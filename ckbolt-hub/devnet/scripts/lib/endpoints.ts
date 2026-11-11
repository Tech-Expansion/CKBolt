import type { DockerCompose } from "./compose";
import { CONTAINER_PORT, SERVICE } from "./devnet.constants";

const HTTP_SCHEME = "http://";

/** Where the host (the hub, the scripts) reaches each node, as docker compose published it. */
export interface HostEndpoints {
  /** host:port of LND gRPC. */
  lndHubGrpc: string;
  lndUserGrpc: string;
  ckbRpcUrl: string;
  fnnHubRpcUrl: string;
  fnnUserRpcUrl: string;
}

export async function resolveHostEndpoints(compose: DockerCompose): Promise<HostEndpoints> {
  const [lndHubGrpc, lndUserGrpc, ckbRpc, fnnHubRpc, fnnUserRpc] = await Promise.all([
    compose.hostAddress(SERVICE.LND_HUB, CONTAINER_PORT.LND_GRPC),
    compose.hostAddress(SERVICE.LND_USER, CONTAINER_PORT.LND_GRPC),
    compose.hostAddress(SERVICE.CKB, CONTAINER_PORT.CKB_RPC),
    compose.hostAddress(SERVICE.FNN_HUB, CONTAINER_PORT.FNN_RPC),
    compose.hostAddress(SERVICE.FNN_USER, CONTAINER_PORT.FNN_RPC),
  ]);
  return {
    lndHubGrpc,
    lndUserGrpc,
    ckbRpcUrl: `${HTTP_SCHEME}${ckbRpc}`,
    fnnHubRpcUrl: `${HTTP_SCHEME}${fnnHubRpc}`,
    fnnUserRpcUrl: `${HTTP_SCHEME}${fnnUserRpc}`,
  };
}
