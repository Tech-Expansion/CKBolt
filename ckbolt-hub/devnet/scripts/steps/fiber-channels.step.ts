import { ASSET_METADATA, type KnownAssetId } from "../../../src/common/constants/assets.constants";
import { FIBER_CHANNEL_READY_STATE } from "../../../src/common/constants/fiber-rpc.constants";
import { BASIS_POINTS_PER_WHOLE } from "../../../src/common/constants/pricing.constants";
import { fromHexQuantity } from "../../../src/common/utils/amount.util";
import { describeError } from "../../../src/common/utils/error.util";
import { formatBaseUnits } from "../../../src/common/utils/pricing.util";
import { sameScript } from "../../../src/common/utils/script.util";
import type { Script } from "../../../src/domain/types";
import { waitOptions, type DevnetContext, type FiberNodes } from "../lib/context";
import { FNN_PAYMENT_STATUS } from "../lib/devnet.constants";
import { fromFnnScript, type FiberNode, type FnnChannel } from "../lib/fiber";
import { newPaymentSecret } from "../lib/payment-secret";
import { waitFor } from "../lib/poll";
import type { RusdStandIn } from "../lib/rusd";
import { connectFiberPeers } from "./connectivity.step";

const BALANCING_DESCRIPTION = "ckbolt devnet: channel balancing";
const FINAL_PAYMENT_STATES: readonly string[] = [FNN_PAYMENT_STATUS.SUCCESS, FNN_PAYMENT_STATUS.FAILED];

interface ChannelSpec {
  asset: KnownAssetId;
  udtTypeScript: Script | null;
  funding: bigint;
}

type PaymentOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Connects fnn-hub to fnn-user and opens a CKB channel and a RUSD stand-in channel from the hub. A side that holds
 * too little of a channel is topped up to half by a payment from the other side, so both nodes can pay and be paid.
 */
export async function setUpFiberChannels(ctx: DevnetContext, fiber: FiberNodes, rusd: RusdStandIn): Promise<void> {
  ctx.logger.step("Fiber: connecting fnn-hub to fnn-user");
  await connectFiberPeers(ctx, fiber);
  const userPubkey = (await fiber.user.nodeInfo()).pubkey;

  const specs: ChannelSpec[] = [
    { asset: "CKB", udtTypeScript: null, funding: ctx.settings.fiber.ckbChannelShannons },
    { asset: "RUSD", udtTypeScript: rusd.typeScript, funding: ctx.settings.fiber.rusdChannelAmount },
  ];
  for (const spec of specs) {
    ctx.logger.step(`Fiber: ${spec.asset} channel hub <-> user`);
    const channel = await ensureReadyChannel(ctx, fiber.hub, userPubkey, spec);
    await balanceChannel(ctx, fiber, channel, spec);
  }
}

const isChannelFor = (channel: FnnChannel, udtTypeScript: Script | null): boolean => {
  const funding = channel.funding_udt_type_script;
  if (udtTypeScript === null) return funding == null;
  return funding != null && sameScript(fromFnnScript(funding), udtTypeScript);
};

async function ensureReadyChannel(ctx: DevnetContext, hub: FiberNode, peerPubkey: string, spec: ChannelSpec): Promise<FnnChannel> {
  const find = async () => (await hub.channelsWith(peerPubkey)).find((channel) => isChannelFor(channel, spec.udtTypeScript));
  if (!(await find())) {
    await hub.openChannel(peerPubkey, spec.funding, spec.udtTypeScript);
    ctx.logger.info(`opened with ${display(spec, spec.funding)}; waiting for ${FIBER_CHANNEL_READY_STATE}`);
  }
  return waitFor(
    `the ${spec.asset} channel to be ready`,
    async () => {
      const channel = await find();
      return channel?.state.state_name === FIBER_CHANNEL_READY_STATE ? channel : undefined;
    },
    waitOptions(ctx),
  );
}

/** Seen from the hub: local is the hub's balance, remote the user's. */
async function balanceChannel(ctx: DevnetContext, fiber: FiberNodes, channel: FnnChannel, spec: ChannelSpec): Promise<void> {
  const hubBalance = fromHexQuantity(channel.local_balance);
  const userBalance = fromHexQuantity(channel.remote_balance);
  const total = hubBalance + userBalance;
  const minSide = (total * ctx.settings.fiber.minSideShareBps) / BASIS_POINTS_PER_WHOLE;
  const half = total / 2n;
  if (userBalance < minSide) {
    await pay(ctx, fiber.hub, fiber.user, half - userBalance, spec);
  } else if (hubBalance < minSide) {
    await pay(ctx, fiber.user, fiber.hub, half - hubBalance, spec);
  }
  const [hubSide, userSide] = await currentSides(fiber.hub, channel);
  ctx.logger.info(`ready: hub ${display(spec, hubSide)}, user ${display(spec, userSide)}`);
}

async function currentSides(hub: FiberNode, channel: FnnChannel): Promise<[bigint, bigint]> {
  const current = (await hub.channelsWith(channel.pubkey)).find((candidate) => candidate.channel_id === channel.channel_id);
  if (!current) throw new Error(`Channel ${channel.channel_id} is gone`);
  return [fromHexQuantity(current.local_balance), fromHexQuantity(current.remote_balance)];
}

/** Pays `amount` from `payer` to `payee` over their direct channel, retrying while the channel reaches the graph. */
async function pay(ctx: DevnetContext, payer: FiberNode, payee: FiberNode, amount: bigint, spec: ChannelSpec): Promise<void> {
  ctx.logger.info(`${payer.name} pays ${payee.name} ${display(spec, amount)} so both sides hold liquidity`);
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await tryPayment(ctx, payer, payee, amount, spec.udtTypeScript);
    if (outcome.ok) return;
    if (attempt >= ctx.settings.fiber.paymentAttempts) throw new Error(`${payer.name} could not pay ${payee.name}: ${outcome.reason}`);
    ctx.logger.info(`attempt ${attempt} failed (${outcome.reason}); retrying`);
    await ctx.clock.sleep(ctx.settings.waits.pollIntervalMs);
  }
}

async function tryPayment(ctx: DevnetContext, payer: FiberNode, payee: FiberNode, amount: bigint, udtTypeScript: Script | null): Promise<PaymentOutcome> {
  const { preimage, paymentHash } = newPaymentSecret();
  const invoice = await payee.newInvoice({
    amount,
    udtTypeScript,
    hashLock: { paymentPreimage: preimage },
    expirySeconds: ctx.settings.fiber.invoiceExpirySeconds,
    description: BALANCING_DESCRIPTION,
  });
  try {
    await payer.sendPayment(invoice);
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
  const payment = await waitFor(
    "the balancing payment to finish",
    async () => {
      const current = await payer.getPayment(paymentHash);
      return FINAL_PAYMENT_STATES.includes(current.status) ? current : undefined;
    },
    waitOptions(ctx),
  );
  return payment.status === FNN_PAYMENT_STATUS.SUCCESS ? { ok: true } : { ok: false, reason: payment.failed_error ?? payment.status };
}

const display = (spec: ChannelSpec, amount: bigint): string => `${formatBaseUnits(amount, ASSET_METADATA[spec.asset].decimals)} ${spec.asset}`;
