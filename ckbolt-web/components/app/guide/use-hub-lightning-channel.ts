"use client";

import { useCallback, useEffect, useState } from "react";
import { usePolling } from "@/components/app/fiber-node/use-polling";
import { useHubClient } from "@/hooks/use-hub-client";
import { toHubApiError } from "@/lib/hub/client";
import { HUB_CLIENT_TIMING } from "@/lib/hub/constants";
import { API_ERROR_CODE, type LightningInboundChannelDto } from "@/lib/hub/contract";
import { hubChannelError, hubChannelStatus, shownHubChannel, type HubChannelError, type HubChannelStatus } from "@/lib/wallets/lightning/hub-channel";
import { LN_WALLET_MESSAGE } from "@/lib/wallets/lightning/messages";

export interface HubLightningChannel {
  status: HubChannelStatus;
  /** The channel the hub lists with this node, or null. */
  channel: LightningInboundChannelDto | null;
  requesting: boolean;
  error: HubChannelError | null;
  /** Asks the hub for a channel to the node `pubkey`. */
  request: () => Promise<void>;
}

/**
 * The visitor's channel from the hub (lib/wallets/lightning/hub-channel.ts), for the node id pasted on the guide's hub
 * card: the channels the hub lists with `pubkey`, read once it is a valid key and then every few seconds while one
 * opens or closes, and the request (POST /v1/lightning/inbound-channels). `pubkey` is the checked key, or null.
 */
export function useHubLightningChannel(pubkey: string | null): HubLightningChannel {
  const client = useHubClient();
  const [read, setRead] = useState<{ pubkey: string; channels: LightningInboundChannelDto[] } | null>(null);
  const [requested, setRequested] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<HubChannelError | null>(null);

  /** The hub's list of channels with the node, or null when it could not be read. */
  const readChannels = useCallback(async (): Promise<LightningInboundChannelDto[] | null> => {
    if (!pubkey) return null;
    try {
      const listed = await client.listLightningInboundChannels(pubkey);
      setRead({ pubkey, channels: listed });
      return listed;
    } catch {
      return null;
    }
  }, [client, pubkey]);

  // A new node id starts over: its own channels, no error from another one.
  useEffect(() => {
    setError(null);
    if (pubkey) void readChannels();
  }, [pubkey, readChannels]);

  const channel = shownHubChannel(read && read.pubkey === pubkey ? read.channels : []);
  const status = hubChannelStatus(channel, pubkey !== null && requested === pubkey);
  usePolling(readChannels, HUB_CLIENT_TIMING.lightningChannelPollMs, pubkey !== null && (status === "opening" || status === "closing"));

  const request = useCallback(async () => {
    setError(null);
    if (!pubkey) {
      setError({ line: LN_WALLET_MESSAGE.CHANNEL_NODE_ID_INVALID, detail: null });
      return;
    }
    setRequesting(true);
    try {
      await client.requestLightningInboundChannel({ pubkey });
      setRequested(pubkey);
      await readChannels();
    } catch (e) {
      const refused = toHubApiError(e);
      // 409: the node has a channel already (shown once read), or is not the hub's peer yet.
      const listed = refused.code === API_ERROR_CODE.CONFLICT ? await readChannels() : null;
      if (!listed || shownHubChannel(listed) === null) setError(hubChannelError(refused));
    } finally {
      setRequesting(false);
    }
  }, [client, pubkey, readChannels]);

  return { status, channel, requesting, error, request };
}
