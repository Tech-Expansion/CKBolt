"use client";

import { useCallback, useEffect, useState } from "react";
import { usePolling } from "@/components/app/fiber-node/use-polling";
import { useHubClient } from "@/hooks/use-hub-client";
import { toHubApiError } from "@/lib/hub/client";
import { HUB_CLIENT_TIMING } from "@/lib/hub/constants";
import { API_ERROR_CODE, type FiberAssetId, type InboundChannelDto } from "@/lib/hub/contract";
import {
  FIBER_CHANNEL_MESSAGE,
  fiberChannelError,
  fiberChannelStatus,
  shownFiberChannel,
  type FiberChannelError,
  type FiberChannelStatus,
} from "@/lib/wallets/fiber-byo/hub-fiber-channel";

export interface HubFiberChannel {
  status: FiberChannelStatus;
  /** The channel in the chosen token the hub lists with this node, or null. */
  channel: InboundChannelDto | null;
  requesting: boolean;
  error: FiberChannelError | null;
  /** Asks the hub for a channel in `asset` to the node `nodeId`. */
  request: () => Promise<void>;
}

/**
 * An external node's Fiber channel from the hub (lib/wallets/fiber-byo/hub-fiber-channel.ts), for the node id pasted
 * and the token chosen on the guide's hub card: the channels the hub lists with `nodeId`, read once it is a valid id and
 * then every few seconds while one opens or closes, and the request. `nodeId` is the checked id, or null.
 */
export function useHubFiberChannel(nodeId: string | null, asset: FiberAssetId | null): HubFiberChannel {
  const client = useHubClient();
  const [read, setRead] = useState<{ nodeId: string; channels: InboundChannelDto[] } | null>(null);
  const [requested, setRequested] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<FiberChannelError | null>(null);

  const readChannels = useCallback(async (): Promise<InboundChannelDto[] | null> => {
    if (!nodeId) return null;
    try {
      const listed = await client.listInboundChannels(nodeId);
      setRead({ nodeId, channels: listed });
      return listed;
    } catch {
      return null;
    }
  }, [client, nodeId]);

  // A new node id or token starts over: its own channels, no error from another one.
  useEffect(() => {
    setError(null);
    if (nodeId) void readChannels();
  }, [nodeId, asset, readChannels]);

  const key = nodeId && asset ? `${nodeId}:${asset}` : null;
  const channel = asset && read && read.nodeId === nodeId ? shownFiberChannel(read.channels, asset) : null;
  const status = fiberChannelStatus(channel, key !== null && requested === key);
  usePolling(readChannels, HUB_CLIENT_TIMING.fiberChannelPollMs, nodeId !== null && (status === "opening" || status === "closing"));

  const request = useCallback(async () => {
    setError(null);
    if (!nodeId || !asset) {
      setError({ line: FIBER_CHANNEL_MESSAGE.NODE_ID_INVALID, detail: null });
      return;
    }
    setRequesting(true);
    try {
      await client.requestInboundChannel({ nodeId, asset });
      setRequested(`${nodeId}:${asset}`);
      await readChannels();
    } catch (e) {
      const refused = toHubApiError(e);
      const listed = refused.code === API_ERROR_CODE.CONFLICT ? await readChannels() : null;
      if (!listed || shownFiberChannel(listed, asset) === null) setError(fiberChannelError(refused));
    } finally {
      setRequesting(false);
    }
  }, [client, nodeId, asset, readChannels]);

  return { status, channel, requesting, error, request };
}
