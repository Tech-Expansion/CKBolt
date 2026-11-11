import { waitOptions, type DevnetContext, type FiberNodes } from "../lib/context";
import { FNN_DIALABLE_ADDRESS_PREFIX, SERVICE } from "../lib/devnet.constants";
import type { LndNode } from "../lib/lnd";
import { doneWhen, waitFor } from "../lib/poll";
import { syncLightningToChain } from "./lightning-sync.step";

/**
 * Containers can get new IP addresses when they restart, and the nodes remember their peers by IP, so after
 * `docker compose stop` / `start` they do not find each other. This reconnects them by compose hostname and waits until
 * the channels can carry payments again. Cheap when everything is already connected.
 */
export async function ensureConnected(ctx: DevnetContext, fiber: FiberNodes): Promise<void> {
  ctx.logger.step("Reconnecting the nodes and waiting for their channels");
  await ensureLightningSynced(ctx);
  const userPubkey = await connectLightningPeers(ctx);
  await waitForLightningChannels(ctx, userPubkey);
  await connectFiberPeers(ctx, fiber);
}

/**
 * Waits until lnd-hub and lnd-user are synced to bitcoind's tip, mining to lnd-hub when they need blocks: an old tip,
 * or blocks bitcoind lost in an unclean Docker stop (steps/lightning-sync.step.ts).
 */
export function ensureLightningSynced(ctx: DevnetContext): Promise<void> {
  const { lnd } = ctx;
  return syncLightningToChain({ ...ctx, nodes: [lnd.hub, lnd.user], rewardAddress: () => lnd.hub.newAddress() });
}

/** Connects lnd-hub to lnd-user by hostname; returns lnd-user's pubkey. */
export async function connectLightningPeers(ctx: DevnetContext): Promise<string> {
  const { lnd } = ctx;
  const [hubPubkey, userPubkey] = await Promise.all([pubkeyOf(lnd.hub), pubkeyOf(lnd.user)]);
  await lnd.hub.connect(userPubkey, SERVICE.LND_USER);
  await waitFor("the LND nodes to be peers", async () => doneWhen((await lnd.user.peerPubkeys()).includes(hubPubkey)), waitOptions(ctx));
  return userPubkey;
}

/** Waits until both channels between lnd-hub and lnd-user (one opened by each) are active. */
export async function waitForLightningChannels(ctx: DevnetContext, userPubkey: string): Promise<void> {
  await waitFor(
    "both Lightning channels to be active",
    async () => {
      const active = (await ctx.lnd.hub.channels()).filter((channel) => channel.remote_pubkey === userPubkey && channel.active);
      return doneWhen(active.some((channel) => channel.initiator) && active.some((channel) => !channel.initiator));
    },
    waitOptions(ctx),
  );
  ctx.logger.info("Lightning: both channels active");
}

/** Connects fnn-hub to fnn-user by the address it announces on the compose network, unless they are peers. */
export async function connectFiberPeers(ctx: DevnetContext, fiber: FiberNodes): Promise<void> {
  const [hubInfo, userInfo] = await Promise.all([fiber.hub.nodeInfo(), fiber.user.nodeInfo()]);
  if (!(await fiber.hub.peerPubkeys()).includes(userInfo.pubkey)) {
    const address = userInfo.addresses.find((candidate) => candidate.startsWith(FNN_DIALABLE_ADDRESS_PREFIX));
    if (!address) throw new Error(`fnn-user announces no ${FNN_DIALABLE_ADDRESS_PREFIX} address (FIBER_ANNOUNCED_ADDRS in docker-compose.yml)`);
    await fiber.hub.connectPeer(address);
    ctx.logger.info(`Fiber: connected to ${address}`);
  }
  await waitFor("the fnn nodes to be peers", async () => doneWhen((await fiber.user.peerPubkeys()).includes(hubInfo.pubkey)), waitOptions(ctx));
  ctx.logger.info("Fiber: fnn-hub and fnn-user are peers");
}

const pubkeyOf = async (node: LndNode): Promise<string> => (await node.info()).identity_pubkey;
