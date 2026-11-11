import type { AuthenticatedLnd } from "lightning";
import type { Clock } from "../../application/ports/clock.port";
import type { LightningChannelsPort, LnChannel, LnChannelOpening, OpenLnChannelArgs } from "../../application/ports/lightning-channels.port";
import { LND_OPEN_CHANNEL, LND_RPC } from "../../common/constants/lnd.constants";
import { disconnectLnd } from "./lnd-connection";
import { lndChannelsRpc, type LndChannelsRpc } from "./lnd-channels.rpc";
import { toChannelOpening, toOpenChannelRequest, toOpenLnChannel, toPendingLnChannel } from "./lnd-channels.mappers";
import { toLndError } from "./lnd.errors";

/**
 * LightningChannelsPort on LND v0.21.4 through the channel-only macaroon (GetInfo, ListPeers, ListChannels,
 * PendingChannels, WalletBalance, OpenChannelSync). Errors as the LND adapter maps them (toLndError): an unreachable
 * node or a lost answer is a 503 HubError, anything else LND answers is a plain LndRpcError.
 */
export class LndChannelsAdapter implements LightningChannelsPort {
  constructor(
    private readonly lnd: AuthenticatedLnd,
    private readonly clock: Clock,
    private readonly rpc: LndChannelsRpc = lndChannelsRpc,
  ) {}

  async isConnected(pubkey: string): Promise<boolean> {
    const { peers } = await this.call(LND_RPC.LIST_PEERS, () => this.rpc.getPeers({ lnd: this.lnd }));
    return peers.some((peer) => peer.public_key === pubkey);
  }

  /** ListChannels has the open channels, PendingChannels the opening and closing ones. */
  async listChannels(peer?: string): Promise<LnChannel[]> {
    const [open, pending] = await Promise.all([
      this.call(LND_RPC.LIST_CHANNELS, () => this.rpc.getChannels({ lnd: this.lnd, ...(peer === undefined ? {} : { partner_public_key: peer }) })),
      this.call(LND_RPC.PENDING_CHANNELS, () => this.rpc.getPendingChannels({ lnd: this.lnd })),
    ]);
    const channels = [...open.channels.map(toOpenLnChannel), ...pending.pending_channels.map(toPendingLnChannel)];
    return peer === undefined ? channels : channels.filter((channel) => channel.peer === peer);
  }

  async confirmedOnchainSats(): Promise<bigint> {
    const { chain_balance: sats } = await this.call(LND_RPC.WALLET_BALANCE, () => this.rpc.getChainBalance({ lnd: this.lnd }));
    return BigInt(sats);
  }

  async openChannel(args: OpenLnChannelArgs): Promise<LnChannelOpening> {
    const deadline = this.clock.now() + LND_OPEN_CHANNEL.DEADLINE_MS;
    const point = await this.call(LND_RPC.OPEN_CHANNEL_SYNC, () => this.rpc.openChannelSync({ lnd: this.lnd, request: toOpenChannelRequest(args), deadline }));
    return toChannelOpening(point);
  }

  /** Closes the gRPC channels so the process can exit. */
  close(): void {
    disconnectLnd(this.lnd);
  }

  private async call<T>(rpc: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw toLndError(rpc, error);
    }
  }
}
