"use client";

import { useEffect, useState } from "react";
import { useHubClient } from "@/hooks/use-hub-client";
import { useHubStatus, type HubStatus } from "@/hooks/use-hub-status";
import { toHubApiError, type HubClient } from "@/lib/hub/client";
import type { FiberNodeDto, LightningNodeDto } from "@/lib/hub/contract";

/** One read of the hub: pending, its answer, or the hub's error message. */
export type HubRead<T> = { status: "loading" } | { status: "ok"; value: T } | { status: "error"; message: string };

export interface HubConnection {
  /** GET /v1/health and /v1/assets, as the app reads them (Live, Degraded, Unavailable). */
  status: HubStatus;
  /** GET /v1/lightning/node. */
  lightning: HubRead<LightningNodeDto>;
  /** GET /v1/fiber/node. */
  fiber: HubRead<FiberNodeDto>;
}

/** Reads one hub resource once per client; a failure keeps the hub's message. */
function useHubRead<T>(client: HubClient, read: (client: HubClient) => Promise<T>): HubRead<T> {
  const [state, setState] = useState<HubRead<T>>({ status: "loading" });
  useEffect(() => {
    let current = true;
    read(client).then(
      (value) => {
        if (current) setState({ status: "ok", value });
      },
      (e) => {
        if (current) setState({ status: "error", message: toHubApiError(e).message });
      },
    );
    return () => {
      current = false;
    };
  }, [client, read]);
  return state;
}

const readLightningNode = (client: HubClient) => client.getLightningNode();
const readFiberNode = (client: HubClient) => client.getFiberNode();

/**
 * What a tester needs to connect to the hub, live through the same-origin proxy: its status and limits, its Lightning
 * node (the URIs a wallet adds as a peer, the channels it opens) and its Fiber node (node id, addresses, inbound
 * channels). Each part is read on its own, so one unavailable part leaves the others.
 */
export function useHubConnection(): HubConnection {
  const client = useHubClient();
  const status = useHubStatus();
  const lightning = useHubRead(client, readLightningNode);
  const fiber = useHubRead(client, readFiberNode);
  return { status, lightning, fiber };
}
