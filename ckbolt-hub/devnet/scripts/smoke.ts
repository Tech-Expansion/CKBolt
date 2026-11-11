import { CkbChain } from "./lib/ckb";
import { createFiberNodes, createDevnetContext } from "./lib/context";
import { resolveHostEndpoints } from "./lib/endpoints";
import { runMain } from "./lib/main";
import { nodeWhitelistsRusd, rusdStandIn } from "./lib/rusd";
import { fiberHoldInvoiceSmoke } from "./smoke/fiber-hold.smoke";
import { lightningHoldInvoiceSmoke } from "./smoke/lightning-hold.smoke";
import { ensureConnected } from "./steps/connectivity.step";

/** Proves the bootstrapped devnet carries both legs of a swap: hold invoices on the hub nodes, paid and settled. */
async function smoke(): Promise<void> {
  const ctx = createDevnetContext();
  const endpoints = await resolveHostEndpoints(ctx.compose);
  const fiber = createFiberNodes(endpoints, ctx.settings);
  await ensureConnected(ctx, fiber);

  await lightningHoldInvoiceSmoke(ctx);
  await fiberHoldInvoiceSmoke(ctx, fiber, { asset: "CKB", amount: ctx.settings.smoke.fiberCkbShannons, udtTypeScript: null });

  const rusd = await CkbChain.use(endpoints.ckbRpcUrl, (ckb) => rusdStandIn(ckb, ctx.settings.ckb.issuerPrivateKey));
  if (!nodeWhitelistsRusd(await fiber.hub.nodeInfo(), rusd.typeScript)) {
    throw new Error("fnn-hub does not whitelist the RUSD stand-in; run npm run bootstrap first");
  }
  await fiberHoldInvoiceSmoke(ctx, fiber, { asset: "RUSD", amount: ctx.settings.smoke.fiberRusdAmount, udtTypeScript: rusd.typeScript });

  ctx.logger.step("Smoke test passed");
}

runMain("smoke", smoke);
