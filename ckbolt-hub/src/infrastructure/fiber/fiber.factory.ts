import type { FiberConnection, HubConfig } from "../../config/hub.config";
import type { CkbNetwork } from "../../domain/types";
import { FiberRpcAdapter } from "./fiber-rpc.adapter";
import { FiberRpcClient } from "./fiber-rpc.client";
import { toWebSocketUrl } from "./fiber-rpc.protocol";
import { FiberStoreChangesSubscriber } from "./fiber-store-changes.subscriber";

/** A FiberPort for one fnn node; push hints over WebSocket only when the connection enables pubsub. */
export function createFiberRpcAdapter(connection: FiberConnection, network: CkbNetwork): FiberRpcAdapter {
  const client = new FiberRpcClient({ url: connection.rpcUrl, authToken: connection.authToken, timeoutMs: connection.rpcTimeoutMs });
  const updates = connection.pubsub
    ? new FiberStoreChangesSubscriber({
        url: toWebSocketUrl(connection.rpcUrl),
        authToken: connection.authToken,
        reconnectDelayMs: connection.pubsubReconnectMs,
      })
    : null;
  return new FiberRpcAdapter(client, network, updates);
}

/** The hub's own Fiber node. */
export const createHubFiber = (config: HubConfig): FiberRpcAdapter => createFiberRpcAdapter(config.fiber, config.ckb.network);

/** The demo wallet's Fiber node, or null when the demo is off. */
export const createDemoFiber = (config: HubConfig): FiberRpcAdapter | null =>
  config.demo.enabled && config.demo.fiber ? createFiberRpcAdapter(config.demo.fiber, config.ckb.network) : null;
