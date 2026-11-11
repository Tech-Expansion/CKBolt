import { resolve } from "node:path";

/** Local folders the scripts read: the deploy folder, its kit (deploy/testnet) and the hub repository root. */
export interface DeployPaths {
  deployDir: string;
  kitDir: string;
  hubRoot: string;
}

const KIT_FOLDER = "testnet";

/** From this file's folder (deploy/scripts/lib). */
export function resolveDeployPaths(libDir: string = __dirname): DeployPaths {
  const deployDir = resolve(libDir, "..", "..");
  return { deployDir, kitDir: resolve(deployDir, KIT_FOLDER), hubRoot: resolve(deployDir, "..") };
}
