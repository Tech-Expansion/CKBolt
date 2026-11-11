import { describeError } from "../../../src/common/utils/error.util";
import { activeServices, type DeployContext } from "../lib/context";
import { ckbAddress } from "../lib/ckb-address";
import { FNN_SERVICES, LND_SERVICES, type FnnService, type LndService, type ServiceName } from "../lib/constants";
import type { FnnScript } from "../lib/fiber";

export interface LndFunding {
  service: LndService;
  pubkey: string;
  /** A fresh on-chain address (lncli newaddress p2tr). */
  address: string;
  /** pubkey@host:port as the node announces it (lnd-hub on the public overlay). */
  uris: string[];
}

export interface FnnFunding {
  service: FnnService;
  pubkey: string;
  /** The node's CKB testnet wallet address (ckt1...), from its default funding lock script. */
  address: string;
  lock: FnnScript;
}

export interface FundingAddresses {
  lnd: LndFunding[];
  fnn: FnnFunding[];
}

/** Reads each node of the deployment; a node that does not answer (not started, no wallet) is logged and left out. */
async function readEach<S extends ServiceName, T>(
  ctx: DeployContext,
  services: readonly S[],
  active: ReadonlySet<ServiceName>,
  read: (service: S) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (const service of services.filter((candidate) => active.has(candidate))) {
    try {
      results.push(await read(service));
    } catch (error) {
      ctx.logger.warn(`${service} gave no address (${describeError(error)}); start it and create its wallet first`);
    }
  }
  return results;
}

/** Where each node of the deployment takes funds: on-chain Mutinynet addresses and CKB testnet addresses. */
export async function readFundingAddresses(ctx: DeployContext): Promise<FundingAddresses> {
  const active = await activeServices(ctx);
  const lnd = await readEach(ctx, LND_SERVICES, active, async (service): Promise<LndFunding> => {
    const node = ctx.lnd[service];
    const info = await node.info();
    return { service, pubkey: info.identity_pubkey, address: await node.newAddress(), uris: info.uris ?? [] };
  });
  const fnn = await readEach(ctx, FNN_SERVICES, active, async (service): Promise<FnnFunding> => {
    const info = await ctx.fiber[service].nodeInfo();
    const lock = info.default_funding_lock_script;
    return { service, pubkey: info.pubkey, address: ckbAddress(lock, "testnet"), lock };
  });
  return { lnd, fnn };
}

export function printFundingAddresses(ctx: DeployContext, addresses: FundingAddresses): void {
  ctx.logger.step("Funding addresses");
  for (const node of addresses.lnd) {
    ctx.logger.info(`${node.service}: Mutinynet on-chain ${node.address}`);
    ctx.logger.info(`${node.service}: node ${node.uris[0] ?? node.pubkey}`);
  }
  for (const node of addresses.fnn) ctx.logger.info(`${node.service}: CKB testnet ${node.address} (node ${node.pubkey})`);
}

export async function showAddresses(ctx: DeployContext): Promise<void> {
  printFundingAddresses(ctx, await readFundingAddresses(ctx));
}
