import type { DevnetContext } from "../lib/context";

/** Builds the fnn image if needed, starts every service and waits for the healthchecks. */
export async function startStack({ compose, logger, settings }: DevnetContext): Promise<void> {
  logger.step("Starting the devnet containers (docker compose up)");
  await compose.up({ waitTimeoutSeconds: settings.waits.stackStartSeconds });
}
