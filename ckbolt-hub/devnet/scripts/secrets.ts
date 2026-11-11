import { createDevnetContext } from "./lib/context";
import { runMain } from "./lib/main";
import { exportLndSecrets } from "./steps/lnd-secrets.step";

/**
 * Bakes the least-privilege macaroons again on a running devnet and copies them to devnet/.secrets, e.g. after
 * HUB_MACAROON_PERMISSIONS changed. The paths in hub.env stay the same; restart the hub so it reads the new files.
 */
async function secrets(): Promise<void> {
  const ctx = createDevnetContext();
  await exportLndSecrets(ctx);
  ctx.logger.step("Macaroons baked again. Restart the hub to use them.");
}

runMain("secrets", secrets);
