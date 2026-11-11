import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createDevnetContext } from "./lib/context";
import { DEVNET_FILE } from "./lib/devnet.constants";
import { runMain } from "./lib/main";

/** Deletes the devnet: containers, every node's volume, and the generated state, secrets and hub.env. */
async function reset(): Promise<void> {
  const { compose, logger, paths } = createDevnetContext();
  logger.step("Removing the devnet containers and volumes");
  await compose.down({ volumes: true });
  logger.step("Removing generated files");
  for (const generated of [DEVNET_FILE.STATE_DIR, DEVNET_FILE.SECRETS_DIR, DEVNET_FILE.HUB_ENV]) {
    await rm(join(paths.devnetDir, generated), { recursive: true, force: true });
    logger.info(generated);
  }
  logger.step("Reset done. Start again with: npm run bootstrap");
}

runMain("reset", reset);
