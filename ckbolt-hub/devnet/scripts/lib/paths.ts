import { join, posix, resolve } from "node:path";
import { DEVNET_FILE, HUB_RELATIVE_PREFIX, HUB_ROOT_DEVNET_DIR, type ServiceName } from "./devnet.constants";

/** Absolute locations of the devnet's files, resolved from this module so scripts run from any working directory. */
export interface DevnetPaths {
  /** devnet/: the docker compose project directory. */
  devnetDir: string;
  fnnUdtEnvFile: string;
  bitcoinTipFile: string;
  hubEnvFile: string;
}

const DEVNET_DIR_FROM_THIS_FILE = ["..", ".."] as const;

export function resolveDevnetPaths(devnetDir: string = resolve(__dirname, ...DEVNET_DIR_FROM_THIS_FILE)): DevnetPaths {
  return {
    devnetDir,
    fnnUdtEnvFile: join(devnetDir, DEVNET_FILE.FNN_UDT_ENV),
    bitcoinTipFile: join(devnetDir, DEVNET_FILE.BITCOIN_TIP),
    hubEnvFile: join(devnetDir, DEVNET_FILE.HUB_ENV),
  };
}

/** A file in devnet/.secrets/<service>/, named three ways for the three places that need it. */
export interface SecretFileLocation {
  /** Absolute directory on the host. */
  hostDir: string;
  /** Relative to devnet/, for `docker compose cp` (no drive letter). */
  devnetRelative: string;
  /** Relative to the hub root, for hub.env. */
  hubRelative: string;
}

export function secretFileLocation(paths: DevnetPaths, service: ServiceName, fileName: string): SecretFileLocation {
  const relativeDir = posix.join(DEVNET_FILE.SECRETS_DIR, service);
  return {
    hostDir: join(paths.devnetDir, relativeDir),
    devnetRelative: posix.join(relativeDir, fileName),
    hubRelative: `${HUB_RELATIVE_PREFIX}${posix.join(HUB_ROOT_DEVNET_DIR, relativeDir, fileName)}`,
  };
}
