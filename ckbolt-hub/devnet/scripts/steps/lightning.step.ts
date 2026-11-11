import { waitOptions, type DevnetContext } from "../lib/context";
import { COINBASE_MATURITY_BLOCKS, LND_INITIATOR_LOCAL } from "../lib/devnet.constants";
import type { LndNode } from "../lib/lnd";
import { doneWhen, waitFor } from "../lib/poll";
import { connectLightningPeers, ensureLightningSynced, waitForLightningChannels } from "./connectivity.step";

/**
 * Funds both LND wallets from regtest coinbases and opens one channel each way (hub->user and user->hub), so each
 * node has outbound and inbound liquidity. Safe to re-run: funded wallets and existing channels are kept.
 */
export async function setUpLightning(ctx: DevnetContext): Promise<void> {
  ctx.logger.step("Lightning: funding the LND wallets");
  await fundWallets(ctx);
  ctx.logger.step("Lightning: channels hub -> user and user -> hub");
  await openChannels(ctx);
}

async function fundWallets(ctx: DevnetContext): Promise<void> {
  const { bitcoin, lnd, settings, logger } = ctx;
  const unfunded: LndNode[] = [];
  for (const node of [lnd.hub, lnd.user]) {
    if ((await node.confirmedBalanceSats()) < settings.lightning.minWalletSats) unfunded.push(node);
  }
  if (unfunded.length === 0) {
    logger.info("both wallets already hold funds");
    return;
  }
  for (const node of unfunded) {
    await bitcoin.mineTo(await node.newAddress(), settings.lightning.fundingBlocksPerWallet);
    logger.info(`mined ${settings.lightning.fundingBlocksPerWallet} blocks to ${node.service}`);
  }
  await bitcoin.mineTo(await lnd.hub.newAddress(), COINBASE_MATURITY_BLOCKS);
  logger.info(`mined ${COINBASE_MATURITY_BLOCKS} blocks so the coinbases mature`);
  for (const node of unfunded) {
    await waitFor(
      `${node.service} to see its funds`,
      async () => doneWhen((await node.confirmedBalanceSats()) >= settings.lightning.minWalletSats),
      waitOptions(ctx, true),
    );
  }
}

async function openChannels(ctx: DevnetContext): Promise<void> {
  const { bitcoin, lnd, settings, logger } = ctx;
  await ensureLightningSynced(ctx);
  const userPubkey = await connectLightningPeers(ctx);
  const hubPubkey = (await lnd.hub.info()).identity_pubkey;

  const openedFromHub = await ensureChannel(ctx, lnd.hub, userPubkey);
  const openedFromUser = await ensureChannel(ctx, lnd.user, hubPubkey);
  if (openedFromHub || openedFromUser) {
    await bitcoin.mineTo(await lnd.hub.newAddress(), settings.lightning.confirmationBlocks);
    logger.info(`mined ${settings.lightning.confirmationBlocks} blocks to confirm the channels`);
  }
  await waitForLightningChannels(ctx, userPubkey);
}

/** Opens a channel from `opener` to `peerPubkey` unless `opener` already opened one (pending or open). */
async function ensureChannel(ctx: DevnetContext, opener: LndNode, peerPubkey: string): Promise<boolean> {
  const [channels, pending] = await Promise.all([opener.channels(), opener.pendingOpenChannels()]);
  const exists =
    channels.some((channel) => channel.remote_pubkey === peerPubkey && channel.initiator) ||
    pending.some(({ channel }) => channel.remote_node_pub === peerPubkey && channel.initiator === LND_INITIATOR_LOCAL);
  if (exists) {
    ctx.logger.info(`${opener.service} already has its channel`);
    return false;
  }
  const fundingTxid = await opener.openChannel(peerPubkey, ctx.settings.lightning.channelSats);
  ctx.logger.info(`${opener.service} opened ${ctx.settings.lightning.channelSats} sats (funding ${fundingTxid})`);
  return true;
}
