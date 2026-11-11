import { ASSET_METADATA } from "../../../src/common/constants/assets.constants";
import { formatBaseUnits } from "../../../src/common/utils/pricing.util";
import type { DeployContext } from "../lib/context";
import { SERVICE } from "../lib/constants";
import { isSuccess } from "../lib/http";
import { readFundingAddresses, printFundingAddresses, type FnnFunding, type FundingAddresses } from "./addresses.step";
import { handSteps } from "./hand-steps";

const CKB_DECIMALS = ASSET_METADATA.CKB.decimals;
/** How much of a faucet's answer the log shows. */
const ANSWER_PREVIEW_CHARS = 200;

export const formatCkb = (shannons: bigint): string => `${formatBaseUnits(shannons, CKB_DECIMALS)} CKB`;

/**
 * Everything funding a script may do, then the hand steps: claims testnet CKB for each fnn wallet that holds less than
 * its minimum, sends lnd-demo its on-chain sats from lnd-hub (demo profile), and prints what the operator must do by hand.
 */
export async function fund(ctx: DeployContext): Promise<void> {
  const addresses = await readFundingAddresses(ctx);
  printFundingAddresses(ctx, addresses);

  ctx.logger.step("CKB testnet faucet claims");
  for (const node of addresses.fnn) await claimCkbIfLow(ctx, node);

  await fundDemoLightning(ctx, addresses);

  ctx.logger.step("Hand steps");
  ctx.logger.raw(handSteps(ctx.settings, addresses).join("\n"));
}

async function claimCkbIfLow(ctx: DeployContext, node: FnnFunding): Promise<void> {
  const { ckbFaucet: settings } = ctx.settings;
  const [minimum, claim] = node.service === SERVICE.FNN_HUB ? [settings.minHubShannons, settings.claimHub] : [settings.minDemoShannons, settings.claimDemo];
  const held = await ctx.ckbRpc.capacityOf(node.lock);
  if (held >= minimum) {
    ctx.logger.info(`${node.service} holds ${formatCkb(held)} (at least ${formatCkb(minimum)}): no claim`);
    return;
  }
  const answer = await ctx.ckbFaucet.claim(node.address, claim);
  const preview = answer.text.trim().slice(0, ANSWER_PREVIEW_CHARS);
  if (isSuccess(answer.status)) {
    ctx.logger.info(`${node.service} holds ${formatCkb(held)}: claimed ${claim} CKB (faucet HTTP ${answer.status}); it arrives within minutes`);
  } else {
    ctx.logger.warn(`${node.service}: the CKB faucet answered HTTP ${answer.status} ${preview}; claim by hand (hand step 3)`);
  }
}

/** lnd-demo pays the hub's hold invoices in testnet:smoke: lnd-hub sends it on-chain sats for its channel. */
async function fundDemoLightning(ctx: DeployContext, addresses: FundingAddresses): Promise<void> {
  const demo = addresses.lnd.find((node) => node.service === SERVICE.LND_DEMO);
  const hub = addresses.lnd.find((node) => node.service === SERVICE.LND_HUB);
  if (!demo || !hub) return;
  ctx.logger.step("Mutinynet sats for lnd-demo (from lnd-hub)");
  const { demoWalletSats, demoChannelSats, onchainReserveSats } = ctx.settings.lightning;
  const demoNode = ctx.lnd[SERVICE.LND_DEMO];
  const [channels, pending, balance] = await Promise.all([demoNode.channels(), demoNode.pendingOpenChannels(), demoNode.walletBalance()]);
  const hasChannel =
    channels.some((channel) => channel.remote_pubkey === hub.pubkey) || pending.some((entry) => entry.channel.remote_node_pub === hub.pubkey);
  const demoHolds = BigInt(balance.confirmed_balance) + BigInt(balance.unconfirmed_balance);
  if (hasChannel || demoHolds >= demoChannelSats + onchainReserveSats) {
    ctx.logger.info(`lnd-demo needs nothing (${hasChannel ? "its channel to lnd-hub exists" : `it holds ${demoHolds} sats`})`);
    return;
  }
  const hubConfirmed = BigInt((await ctx.lnd[SERVICE.LND_HUB].walletBalance()).confirmed_balance);
  const needed = demoWalletSats + onchainReserveSats;
  if (hubConfirmed < needed) {
    ctx.logger.warn(`lnd-hub has ${hubConfirmed} confirmed sats, less than the ${needed} needed: do hand step 1, then run fund again`);
    return;
  }
  const txid = await ctx.lnd[SERVICE.LND_HUB].sendCoins(demo.address, demoWalletSats);
  ctx.logger.info(`lnd-hub sent ${demoWalletSats} sats to lnd-demo (tx ${txid})`);
}
