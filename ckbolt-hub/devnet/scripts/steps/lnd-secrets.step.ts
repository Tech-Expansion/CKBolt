import { mkdir } from "node:fs/promises";
import { posix } from "node:path";
import type { DevnetContext } from "../lib/context";
import { BAKED_MACAROON, HUB_MACAROON_PERMISSIONS, LND_CONTAINER_FILE, SECRET_FILE } from "../lib/devnet.constants";
import type { LndCredentials } from "../lib/hub-env";
import type { LndNode } from "../lib/lnd";
import { secretFileLocation, type DevnetPaths } from "../lib/paths";

export interface LndSecrets {
  hub: LndCredentials;
  demo: LndCredentials;
}

/** An LND node whose secrets go to devnet/.secrets, and the name of its least-privilege macaroon. */
interface LndSecretSource {
  node: LndNode;
  macaroonName: string;
}

/** The hub's credentials come from lnd-hub, the demo wallet's from lnd-user. */
const lndSecretSources = ({ lnd }: DevnetContext): Record<keyof LndSecrets, LndSecretSource> => ({
  hub: { node: lnd.hub, macaroonName: BAKED_MACAROON.HUB },
  demo: { node: lnd.user, macaroonName: BAKED_MACAROON.DEMO },
});

/**
 * Bakes the least-privilege macaroon on each LND node (hub.macaroon for the hub, demo.macaroon for the demo wallet on
 * lnd-user) and copies it, the admin macaroon and the TLS certificate to devnet/.secrets/<service>/.
 */
export async function exportLndSecrets(ctx: DevnetContext): Promise<LndSecrets> {
  ctx.logger.step("Lightning: least-privilege macaroons and certificates to devnet/.secrets");
  for (const source of Object.values(lndSecretSources(ctx))) await exportNodeSecrets(ctx, source);
  return lndCredentialPaths(ctx);
}

/** Where exportLndSecrets puts each node's certificate and least-privilege macaroon, as hub.env names them. */
export function lndCredentialPaths(ctx: DevnetContext): LndSecrets {
  const { hub, demo } = lndSecretSources(ctx);
  return { hub: credentialsOf(ctx.paths, hub), demo: credentialsOf(ctx.paths, demo) };
}

async function exportNodeSecrets(ctx: DevnetContext, { node, macaroonName }: LndSecretSource): Promise<void> {
  const bakedPath = await node.bakeMacaroon(HUB_MACAROON_PERMISSIONS, macaroonName);
  const files = [
    { containerPath: LND_CONTAINER_FILE.TLS_CERT, name: SECRET_FILE.TLS_CERT },
    { containerPath: posix.join(LND_CONTAINER_FILE.MACAROON_DIR, LND_CONTAINER_FILE.ADMIN_MACAROON), name: SECRET_FILE.ADMIN_MACAROON },
    { containerPath: bakedPath, name: macaroonName },
  ];
  for (const file of files) {
    const location = secretFileLocation(ctx.paths, node.service, file.name);
    await mkdir(location.hostDir, { recursive: true });
    await ctx.compose.copyFrom(node.service, file.containerPath, location.devnetRelative);
    ctx.logger.info(`${node.service}: ${location.hubRelative}`);
  }
}

const credentialsOf = (paths: DevnetPaths, { node, macaroonName }: LndSecretSource): LndCredentials => ({
  tlsCertPath: secretFileLocation(paths, node.service, SECRET_FILE.TLS_CERT).hubRelative,
  macaroonPath: secretFileLocation(paths, node.service, macaroonName).hubRelative,
});
