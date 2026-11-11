import { activeServices, serviceStates, type DeployContext } from "../lib/context";
import { isServiceUp } from "../lib/compose-state";
import { HUB_MACAROON_PERMISSIONS, KIT_FILE, LND_CONTAINER_FILE, LND_HUB_FILES, LND_SERVICES, SERVICE } from "../lib/constants";
import { hubMacaroonPath, hubSecretsDir, hubTlsCertPath } from "../lib/kit-paths";

/**
 * Bakes the hub's least-privilege macaroon on each running LND node of the deployment and copies it with the node's TLS
 * certificate into secrets/hub/<node>/, which only the hub container's user may read. The hub never gets admin rights.
 */
export async function installMacaroons(ctx: DeployContext): Promise<void> {
  ctx.logger.step("Baking the hub's least-privilege macaroons");
  const active = await activeServices(ctx);
  const services = LND_SERVICES.filter((service) => active.has(service));
  await ctx.kit.makeSecretDirs([KIT_FILE.SECRETS_DIR, KIT_FILE.HUB_SECRETS_DIR, ...services.map(hubSecretsDir)]);
  for (const service of services) {
    const containerPath = await ctx.lnd[service].bakeMacaroon(LND_HUB_FILES[service].macaroon, HUB_MACAROON_PERMISSIONS);
    await ctx.kit.compose(["cp", `${service}:${containerPath}`, hubMacaroonPath(service)]);
    await ctx.kit.compose(["cp", `${service}:${LND_CONTAINER_FILE.TLS_CERT}`, hubTlsCertPath(service)]);
    ctx.logger.info(`${service}: ${hubMacaroonPath(service)} (${HUB_MACAROON_PERMISSIONS.join(" ")}) and ${hubTlsCertPath(service)}`);
  }
  await ctx.kit.handToHubUser(KIT_FILE.HUB_SECRETS_DIR);

  if (isServiceUp((await serviceStates(ctx)).get(SERVICE.HUB))) {
    await ctx.kit.compose(["restart", SERVICE.HUB]);
    ctx.logger.info("hub restarted with the new macaroons");
  }
}
