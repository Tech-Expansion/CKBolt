import type { Script } from "../../../src/domain/types";
import { CkbChain } from "../lib/ckb";
import type { DevnetContext } from "../lib/context";
import type { HostEndpoints } from "../lib/endpoints";
import { writeTextFile } from "../lib/files";
import { renderHubEnv } from "../lib/hub-env";
import { rusdStandIn } from "../lib/rusd";
import { lndCredentialPaths, type LndSecrets } from "./lnd-secrets.step";

/**
 * Writes devnet/hub.env: everything the hub needs to run against this devnet, with the host ports Compose publishes
 * now. Returns false when the file already had this content.
 */
export async function writeHubEnv(ctx: DevnetContext, endpoints: HostEndpoints, lndSecrets: LndSecrets, rusdTypeScript: Script): Promise<boolean> {
  ctx.logger.step("Writing devnet/hub.env for the hub");
  const content = renderHubEnv({ endpoints, hubLnd: lndSecrets.hub, demoLnd: lndSecrets.demo, rusdTypeScript });
  const changed = await writeTextFile(ctx.paths.hubEnvFile, content);
  ctx.logger.info(changed ? ctx.paths.hubEnvFile : `${ctx.paths.hubEnvFile} is up to date`);
  return changed;
}

/**
 * Rewrites hub.env for a devnet that is already set up, after a restart: the published host ports follow the
 * environment of that start (port overrides set or dropped), so hub.env must follow them too.
 */
export async function refreshHubEnv(ctx: DevnetContext, endpoints: HostEndpoints): Promise<void> {
  const rusd = await CkbChain.use(endpoints.ckbRpcUrl, (ckb) => rusdStandIn(ckb, ctx.settings.ckb.issuerPrivateKey));
  if (await writeHubEnv(ctx, endpoints, lndCredentialPaths(ctx), rusd.typeScript)) {
    ctx.logger.info("hub.env changed: copy it to the hub's .env again and restart the hub");
  }
}
