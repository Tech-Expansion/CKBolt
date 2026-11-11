import { CkbChain } from "./lib/ckb";
import { createFiberNodes, createDevnetContext } from "./lib/context";
import { resolveHostEndpoints } from "./lib/endpoints";
import { runMain } from "./lib/main";
import { rusdStandIn } from "./lib/rusd";
import { setUpFiberChannels } from "./steps/fiber-channels.step";
import { fundFiberWallets } from "./steps/fiber-wallets.step";
import { whitelistRusd } from "./steps/fnn-whitelist.step";
import { writeHubEnv } from "./steps/hub-env.step";
import { setUpLightning } from "./steps/lightning.step";
import { exportLndSecrets } from "./steps/lnd-secrets.step";
import { startStack } from "./steps/stack.step";

/**
 * Brings the devnet to a state the hub can swap on: funded wallets, Lightning and Fiber channels with liquidity both
 * ways, the RUSD stand-in, secrets in devnet/.secrets and devnet/hub.env. Safe to re-run; done steps are skipped.
 */
async function bootstrap(): Promise<void> {
  const ctx = createDevnetContext();
  await startStack(ctx);
  await setUpLightning(ctx);
  const lndSecrets = await exportLndSecrets(ctx);

  const endpoints = await resolveHostEndpoints(ctx.compose);
  const fiber = createFiberNodes(endpoints, ctx.settings);
  await CkbChain.use(endpoints.ckbRpcUrl, async (ckb) => {
    const rusd = await rusdStandIn(ckb, ctx.settings.ckb.issuerPrivateKey);
    await fundFiberWallets(ctx, ckb, fiber, rusd);
    await whitelistRusd(ctx, ckb, fiber, rusd);
    await setUpFiberChannels(ctx, fiber, rusd);
    await writeHubEnv(ctx, endpoints, lndSecrets, rusd.typeScript);
  });
  ctx.logger.step("Devnet ready. Next: npm run smoke");
}

runMain("bootstrap", bootstrap);
