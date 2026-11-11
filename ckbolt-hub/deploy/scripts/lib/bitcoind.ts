import { BITCOIN_CLI, SERVICE } from "./constants";
import type { RemoteKit } from "./kit";

/** bitcoin-cli getblockchaininfo, only the fields the scripts read. */
export interface BlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  /** 0 to 1, bitcoind's estimate of how much of the chain it has verified. */
  verificationprogress: number;
  initialblockdownload: boolean;
  size_on_disk: number;
}

/** The kit's Mutinynet bitcoind, through bitcoin-cli inside its container. */
export class BitcoindCli {
  constructor(private readonly kit: RemoteKit) {}

  blockchainInfo(): Promise<BlockchainInfo> {
    return this.kit.execJson<BlockchainInfo>(SERVICE.BITCOIND, [...BITCOIN_CLI, "getblockchaininfo"]);
  }
}
