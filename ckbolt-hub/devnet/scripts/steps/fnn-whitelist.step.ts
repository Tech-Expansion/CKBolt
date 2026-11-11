import type { CkbChain } from "../lib/ckb";
import { waitOptions, type DevnetContext, type FiberNodes } from "../lib/context";
import { SERVICE } from "../lib/devnet.constants";
import { writeTextFile } from "../lib/files";
import { doneWhen, waitFor } from "../lib/poll";
import { nodeWhitelistsRusd, renderUdtWhitelistEnv, type RusdStandIn } from "../lib/rusd";

/**
 * Puts the RUSD stand-in in both fnn UDT whitelists: writes devnet/state/fnn-udt.env (CKB_UDT_WHITELIST, read by
 * docker-compose.yml) and recreates the fnn containers if a node does not list it yet. Node data lives in volumes.
 */
export async function whitelistRusd(ctx: DevnetContext, ckb: CkbChain, fiber: FiberNodes, rusd: RusdStandIn): Promise<void> {
  ctx.logger.step("Fiber: the RUSD stand-in in both fnn UDT whitelists");
  const env = renderUdtWhitelistEnv(rusd.typeScript, ckb.xudt.outPoint, ctx.settings.rusd.autoAcceptAmount);
  if (await writeTextFile(ctx.paths.fnnUdtEnvFile, env)) ctx.logger.info(`wrote ${ctx.paths.fnnUdtEnvFile}`);

  if (await bothWhitelist(fiber, rusd)) {
    ctx.logger.info("both nodes already list it");
    return;
  }
  ctx.logger.info("recreating fnn-hub and fnn-user with the new whitelist");
  await ctx.compose.up({
    services: [SERVICE.FNN_HUB, SERVICE.FNN_USER],
    waitTimeoutSeconds: ctx.settings.waits.stackStartSeconds,
    forceRecreate: true,
  });
  await waitFor("both fnn nodes to list the RUSD stand-in", async () => doneWhen(await bothWhitelist(fiber, rusd)), waitOptions(ctx, true));
}

async function bothWhitelist(fiber: FiberNodes, rusd: RusdStandIn): Promise<boolean> {
  const infos = await Promise.all([fiber.hub.nodeInfo(), fiber.user.nodeInfo()]);
  return infos.every((info) => nodeWhitelistsRusd(info, rusd.typeScript));
}
