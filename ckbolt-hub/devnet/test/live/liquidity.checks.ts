import assert from "node:assert/strict";
import { FIBER_CHANNEL_READY_STATE } from "../../../src/common/constants/fiber-rpc.constants";
import { BASIS_POINTS_PER_WHOLE } from "../../../src/common/constants/pricing.constants";
import { fromHexQuantity } from "../../../src/common/utils/amount.util";
import { sameScript } from "../../../src/common/utils/script.util";
import type { Script } from "../../../src/domain/types";
import { CkbChain } from "../../scripts/lib/ckb";
import { fromFnnScript, type FnnChannel } from "../../scripts/lib/fiber";
import { rusdStandIn } from "../../scripts/lib/rusd";
import { requireHubEnv, type LiveContext } from "./live-context";
import type { CheckRunner } from "./runner";

const sum = (values: bigint[]): bigint => values.reduce((total, value) => total + value, 0n);

const isChannelFor = (channel: FnnChannel, udt: Script | null): boolean =>
  udt === null ? channel.funding_udt_type_script == null : channel.funding_udt_type_script != null && sameScript(fromFnnScript(channel.funding_udt_type_script), udt);

export async function checkLiquidity(live: LiveContext, runner: CheckRunner): Promise<void> {
  runner.section("Liquidity: both nodes can pay and be paid");
  const { lnd } = live.devnet;

  await runner.check("Lightning: one active channel opened by each side (hub->user, user->hub)", async () => {
    const userPubkey = (await lnd.user.info()).identity_pubkey;
    const active = (await lnd.hub.channels()).filter((channel) => channel.remote_pubkey === userPubkey && channel.active);
    assert.ok(active.some((channel) => channel.initiator), "no active channel opened by lnd-hub");
    assert.ok(active.some((channel) => !channel.initiator), "no active channel opened by lnd-user");
  });

  await runner.check("Lightning: lnd-hub can send and receive the largest swap (SWAP_MAX_SATS)", async () => {
    const maxSats = requireHubEnv(live).config.pricing.maxSats;
    const channels = (await lnd.hub.channels()).filter((channel) => channel.active);
    const local = sum(channels.map((channel) => BigInt(channel.local_balance)));
    const remote = sum(channels.map((channel) => BigInt(channel.remote_balance)));
    assert.ok(local >= maxSats, `lnd-hub can send ${local} sats, less than ${maxSats}`);
    assert.ok(remote >= maxSats, `lnd-hub can receive ${remote} sats, less than ${maxSats}`);
    return `send ${local}, receive ${remote} sats`;
  });

  const ckb = await CkbChain.connect(live.endpoints.ckbRpcUrl);
  try {
    const rusd = (await rusdStandIn(ckb, live.devnet.settings.ckb.issuerPrivateKey)).typeScript;
    const userPubkey = (await live.fiber.user.nodeInfo()).pubkey;
    const { minSideShareBps } = live.devnet.settings.fiber;

    for (const [asset, udt] of [["CKB", null], ["RUSD", rusd]] as const) {
      await runner.check(`Fiber: a ready ${asset} channel fnn-hub <-> fnn-user with at least ${minSideShareBps} bps on each side`, async () => {
        const channel = (await live.fiber.hub.channelsWith(userPubkey)).find((candidate) => isChannelFor(candidate, udt));
        assert.ok(channel, `no ${asset} channel`);
        assert.equal(channel.state.state_name, FIBER_CHANNEL_READY_STATE);
        const hubSide = fromHexQuantity(channel.local_balance);
        const userSide = fromHexQuantity(channel.remote_balance);
        const minSide = ((hubSide + userSide) * minSideShareBps) / BASIS_POINTS_PER_WHOLE;
        assert.ok(hubSide >= minSide && userSide >= minSide, `unbalanced: hub ${hubSide}, user ${userSide}`);
        return `hub ${hubSide}, user ${userSide}`;
      });
    }

    for (const node of [live.fiber.hub, live.fiber.user]) {
      await runner.check(`${node.name}'s on-chain wallet still holds CKB and RUSD above the bootstrap's top-up thresholds`, async () => {
        const lock = fromFnnScript((await node.nodeInfo()).default_funding_lock_script);
        const [capacity, rusdBalance] = await Promise.all([ckb.capacityOf(lock), ckb.xudtBalanceOf(lock, rusd)]);
        assert.ok(capacity >= live.devnet.settings.ckb.minWalletShannons, `${capacity} shannons`);
        assert.ok(rusdBalance >= live.devnet.settings.rusd.minWalletAmount, `${rusdBalance} RUSD units`);
        return `${capacity} shannons, ${rusdBalance} RUSD units`;
      });
    }
  } finally {
    await ckb.close();
  }
}
