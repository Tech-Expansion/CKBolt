import { ASSET_METADATA, TESTNET_RUSD_TYPE_SCRIPT, type KnownAssetId } from "../../../src/common/constants/assets.constants";
import { FIBER_CHANNEL_READY_STATE } from "../../../src/common/constants/fiber-rpc.constants";
import { BASIS_POINTS_PER_WHOLE } from "../../../src/common/constants/pricing.constants";
import { FIBER_MIN_FINAL_EXPIRY_DELTA_MS } from "../../../src/common/constants/protocol.constants";
import { fromHexQuantity } from "../../../src/common/utils/amount.util";
import { describeError } from "../../../src/common/utils/error.util";
import { randomPreimage, sha256Hex } from "../../../src/common/utils/hex.util";
import { formatBaseUnits } from "../../../src/common/utils/pricing.util";
import type { Script } from "../../../src/domain/types";
import { activeServices, waitOptions, type DeployContext } from "../lib/context";
import { FNN_FINAL_PAYMENT_STATES, FNN_P2P_PORT, FNN_PAYMENT_STATUS, LND_P2P_PORT, MUTINYNET_LSP, SERVICE, type ServiceName } from "../lib/constants";
import { announcedPeerId, dockerNetworkMultiaddr, hostOfMultiaddr, isChannelOfAsset, type FiberRpc, type FnnChannel } from "../lib/fiber";
import type { LndCli, OpenChannelOptions } from "../lib/lnd";
import { waitFor } from "../lib/poll";
import type { FiberPeer } from "../lib/settings";

/** Description of the invoices that move half of a demo channel to fnn-demo. */
const BALANCING_DESCRIPTION = "ckbolt testnet: channel balancing";

interface FiberChannelSpec {
  asset: KnownAssetId;
  udtTypeScript: Script | null;
  amount: bigint;
}

const display = (asset: KnownAssetId, amount: bigint): string => `${formatBaseUnits(amount, ASSET_METADATA[asset].decimals)} ${asset}`;
const relayLabel = (relay: FiberPeer, asset: KnownAssetId): string => `fnn-hub -> ${hostOfMultiaddr(relay.address) ?? relay.pubkey} (${asset})`;
const describeOpening = (sats: bigint, options: OpenChannelOptions): string =>
  `${options.private ? "a private channel of " : ""}${sats} sats${options.pushSats ? `, ${options.pushSats} pushed to the peer` : ""}`;

/**
 * Opens what the hub needs and is missing, and can be run again at any time (nothing is opened twice):
 * - Lightning: lnd-hub -> the Megalith LSP, private, with DEPLOY_LN_LSP_PUSH_SATS pushed to Megalith's side as the
 *   hub's inbound (Alby Hub wallets get their channels from Megalith, so they are one hop from the hub; the hub's hold
 *   invoices carry a route hint for the private channel); lnd-demo -> lnd-hub (demo profile).
 * - Fiber: fnn-hub -> each relay node (bottle, bracer) in CKB, optionally RUSD to the first one; fnn-hub -> fnn-demo in
 *   CKB (and RUSD), each then balanced so the demo node can pay as well as receive. The hub opens every channel it uses:
 *   it assumes the longest commitment delay for a channel a peer opened, and refunds payments over one.
 */
export async function openChannels(ctx: DeployContext): Promise<void> {
  const active = await activeServices(ctx);
  await openLightningChannels(ctx, active);
  await openFiberChannels(ctx, active);
}

async function openLightningChannels(ctx: DeployContext, active: ReadonlySet<ServiceName>): Promise<void> {
  const { lnLspNode } = ctx.settings.peers;
  const { lspChannelSats, lspPushSats, demoChannelSats } = ctx.settings.lightning;
  ctx.logger.step("Lightning channels");
  const hub = ctx.lnd[SERVICE.LND_HUB];
  await hub.connect(lnLspNode.pubkey, lnLspNode.address);
  const toLsp = { pushSats: lspPushSats, private: true };
  await ensureLightningChannel(ctx, hub, lnLspNode.pubkey, lspChannelSats, `lnd-hub -> ${MUTINYNET_LSP.LABEL}`, toLsp);
  if (!active.has(SERVICE.LND_DEMO)) return;
  const demo = ctx.lnd[SERVICE.LND_DEMO];
  const hubPubkey = (await hub.info()).identity_pubkey;
  await demo.connect(hubPubkey, `${SERVICE.LND_HUB}:${LND_P2P_PORT}`);
  await ensureLightningChannel(ctx, demo, hubPubkey, demoChannelSats, "lnd-demo -> lnd-hub");
}

/** An open or opening channel with the peer counts, whatever its size, push or privacy. */
async function ensureLightningChannel(
  ctx: DeployContext,
  node: LndCli,
  peer: string,
  sats: bigint,
  label: string,
  options: OpenChannelOptions = {},
): Promise<void> {
  const [channels, pending] = await Promise.all([node.channels(), node.pendingOpenChannels()]);
  if (channels.some((channel) => channel.remote_pubkey === peer)) {
    ctx.logger.info(`${label}: open`);
    return;
  }
  if (pending.some((entry) => entry.channel.remote_node_pub === peer)) {
    ctx.logger.info(`${label}: opening (waiting for confirmations)`);
    return;
  }
  const confirmed = BigInt((await node.walletBalance()).confirmed_balance);
  const needed = sats + ctx.settings.lightning.onchainReserveSats;
  if (confirmed < needed) {
    ctx.logger.warn(`${label}: ${node.service} has ${confirmed} confirmed sats, needs ${needed}. Fund it (testnet fund), then run channels again`);
    return;
  }
  const txid = await node.openChannel(peer, sats, options);
  ctx.logger.info(`${label}: opening ${describeOpening(sats, options)} (funding tx ${txid}); usable after a few confirmations`);
}

async function openFiberChannels(ctx: DeployContext, active: ReadonlySet<ServiceName>): Promise<void> {
  const { fiberRelays } = ctx.settings.peers;
  const { relayChannelShannons, relayChannelRusd, demoChannelShannons, demoChannelRusd } = ctx.settings.fiber;
  ctx.logger.step("Fiber channels");
  const hub = ctx.fiber[SERVICE.FNN_HUB];
  for (const relay of fiberRelays) {
    await connectFiberPeer(ctx, hub, relay.pubkey, relay.address);
    await ensureFiberChannel(ctx, hub, relay.pubkey, { asset: "CKB", udtTypeScript: null, amount: relayChannelShannons }, relayLabel(relay, "CKB"));
  }
  const [firstRelay] = fiberRelays;
  if (firstRelay && relayChannelRusd > 0n) {
    const rusd = { asset: "RUSD" as const, udtTypeScript: TESTNET_RUSD_TYPE_SCRIPT, amount: relayChannelRusd };
    await ensureFiberChannel(ctx, hub, firstRelay.pubkey, rusd, relayLabel(firstRelay, "RUSD"));
  }
  if (!active.has(SERVICE.FNN_DEMO)) return;

  const demo = ctx.fiber[SERVICE.FNN_DEMO];
  const hubInfo = await hub.nodeInfo();
  const peerId = announcedPeerId(hubInfo);
  if (!peerId) throw new Error("fnn-hub announces no address with a peer id (FIBER_ANNOUNCED_ADDRS in docker-compose.yml)");
  await connectFiberPeer(ctx, demo, hubInfo.pubkey, dockerNetworkMultiaddr(SERVICE.FNN_HUB, FNN_P2P_PORT, peerId));
  const demoPubkey = (await demo.nodeInfo()).pubkey;
  const specs: FiberChannelSpec[] = [
    { asset: "CKB", udtTypeScript: null, amount: demoChannelShannons },
    ...(demoChannelRusd > 0n ? [{ asset: "RUSD" as const, udtTypeScript: TESTNET_RUSD_TYPE_SCRIPT, amount: demoChannelRusd }] : []),
  ];
  for (const spec of specs) {
    const label = `fnn-hub -> fnn-demo (${spec.asset})`;
    if (!(await ensureFiberChannel(ctx, hub, demoPubkey, spec, label))) continue;
    const ready = await waitForReadyChannel(ctx, hub, demoPubkey, spec, label);
    await balanceDemoChannel(ctx, ready, spec, label);
  }
}

async function connectFiberPeer(ctx: DeployContext, node: FiberRpc, pubkey: string, address: string): Promise<void> {
  if ((await node.peers()).some((peer) => peer.pubkey === pubkey)) return;
  await node.connectPeer(address);
  await waitFor(
    `${node.service} to connect to ${address}`,
    async () => ((await node.peers()).some((peer) => peer.pubkey === pubkey) ? true : undefined),
    waitOptions(ctx, true, ctx.settings.timeouts.peerConnectMs),
  );
  ctx.logger.info(`${node.service}: connected to ${address}`);
}

/** Opens the channel unless one of the asset exists; false when it could not be opened (the reason is logged). */
async function ensureFiberChannel(ctx: DeployContext, node: FiberRpc, peer: string, spec: FiberChannelSpec, label: string): Promise<boolean> {
  const existing = (await node.channels(peer)).find((channel) => isChannelOfAsset(channel, spec.udtTypeScript));
  if (existing) {
    ctx.logger.info(`${label}: ${existing.state.state_name}`);
    return true;
  }
  try {
    const temporaryId = await node.openChannel(peer, spec.amount, spec.udtTypeScript);
    ctx.logger.info(`${label}: opening ${display(spec.asset, spec.amount)} (temporary id ${temporaryId})`);
    return true;
  } catch (error) {
    ctx.logger.warn(`${label}: not opened (${describeError(error)}). Fund ${node.service} (testnet fund) and run channels again`);
    return false;
  }
}

function waitForReadyChannel(ctx: DeployContext, node: FiberRpc, peer: string, spec: FiberChannelSpec, label: string): Promise<FnnChannel> {
  return waitFor(
    `${label} to be ${FIBER_CHANNEL_READY_STATE} (its funding transaction confirms on CKB testnet)`,
    async () => {
      const channel = (await node.channels(peer)).find((candidate) => isChannelOfAsset(candidate, spec.udtTypeScript));
      return channel?.state.state_name === FIBER_CHANNEL_READY_STATE ? channel : undefined;
    },
    waitOptions(ctx, true),
  );
}

/** Seen from fnn-hub: remote is fnn-demo's side. Tops fnn-demo up to its share with one payment from fnn-hub. */
async function balanceDemoChannel(ctx: DeployContext, channel: FnnChannel, spec: FiberChannelSpec, label: string): Promise<void> {
  const demoSide = fromHexQuantity(channel.remote_balance);
  const total = fromHexQuantity(channel.local_balance) + demoSide;
  const target = (total * ctx.settings.fiber.demoShareBps) / BASIS_POINTS_PER_WHOLE;
  if (demoSide >= target) {
    ctx.logger.info(`${label}: ready; fnn-demo holds ${display(spec.asset, demoSide)}`);
    return;
  }
  await payDemo(ctx, target - demoSide, spec);
  ctx.logger.info(`${label}: ready; moved ${display(spec.asset, target - demoSide)} to fnn-demo`);
}

/** fnn-hub pays fnn-demo, retrying while the new channel reaches fnn's graph. */
async function payDemo(ctx: DeployContext, amount: bigint, spec: FiberChannelSpec): Promise<void> {
  const hub = ctx.fiber[SERVICE.FNN_HUB];
  const demo = ctx.fiber[SERVICE.FNN_DEMO];
  for (let attempt = 1; ; attempt += 1) {
    const reason = await tryPayment(ctx, hub, demo, amount, spec);
    if (reason === null) return;
    if (attempt >= ctx.settings.fiber.paymentAttempts) throw new Error(`fnn-hub could not pay fnn-demo: ${reason}`);
    ctx.logger.info(`attempt ${attempt} failed (${reason}); retrying`);
    await ctx.clock.sleep(ctx.settings.timeouts.pollIntervalMs);
  }
}

/** null on success, else why the payment failed. */
async function tryPayment(ctx: DeployContext, payer: FiberRpc, payee: FiberRpc, amount: bigint, spec: FiberChannelSpec): Promise<string | null> {
  const preimage = randomPreimage();
  const invoice = await payee.newInvoice({
    amount,
    udtTypeScript: spec.udtTypeScript,
    preimage,
    expirySeconds: ctx.settings.fiber.invoiceExpirySeconds,
    finalExpiryDeltaMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
    description: BALANCING_DESCRIPTION,
  });
  try {
    await payer.sendPayment(invoice);
  } catch (error) {
    return describeError(error);
  }
  const payment = await waitFor(
    "the balancing payment to finish",
    async () => {
      const current = await payer.getPayment(sha256Hex(preimage));
      return FNN_FINAL_PAYMENT_STATES.includes(current.status) ? current : undefined;
    },
    waitOptions(ctx, true),
  );
  return payment.status === FNN_PAYMENT_STATUS.SUCCESS ? null : (payment.failed_error ?? payment.status);
}
