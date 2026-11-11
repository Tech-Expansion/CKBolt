import { access } from "node:fs/promises";
import { createFiberNodes, createDevnetContext } from "./lib/context";
import { resolveHostEndpoints } from "./lib/endpoints";
import { runMain } from "./lib/main";
import { ensureConnected } from "./steps/connectivity.step";
import { refreshHubEnv } from "./steps/hub-env.step";
import { startStack } from "./steps/stack.step";

const isBootstrapped = (hubEnvFile: string): Promise<boolean> =>
  access(hubEnvFile).then(
    () => true,
    () => false,
  );

/**
 * Starts the devnet with its saved state and makes it usable again: hub.env on the ports published by this start,
 * nodes reconnected, channels active.
 */
async function up(): Promise<void> {
  const ctx = createDevnetContext();
  await startStack(ctx);
  if (!(await isBootstrapped(ctx.paths.hubEnvFile))) {
    ctx.logger.step("Started. The devnet is not set up yet: run npm run bootstrap");
    return;
  }
  const endpoints = await resolveHostEndpoints(ctx.compose);
  await refreshHubEnv(ctx, endpoints);
  await ensureConnected(ctx, createFiberNodes(endpoints, ctx.settings));
  ctx.logger.step("Devnet up");
}

runMain("up", up);
