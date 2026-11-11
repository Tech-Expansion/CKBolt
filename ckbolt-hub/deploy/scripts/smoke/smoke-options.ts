import { parseArgs } from "node:util";
import { readDeploySettings, type DeploySettings } from "../lib/settings";
import type { SmokeOptions } from "./run-smoke";

/**
 * testnet:smoke's options: --direction, --asset and --sats override the DEPLOY_SMOKE_* settings and are validated the
 * same way (an unknown direction or asset, or sats that are not a whole number, stop the run with the reason).
 */
export function smokeOptions(settings: DeploySettings, args: readonly string[]): SmokeOptions {
  const { values } = parseArgs({ args: [...args], options: { direction: { type: "string" }, asset: { type: "string" }, sats: { type: "string" } } });
  const { smoke } = readDeploySettings({
    DEPLOY_SMOKE_DIRECTION: values.direction ?? settings.smoke.direction,
    DEPLOY_SMOKE_ASSET: values.asset ?? settings.smoke.asset,
    DEPLOY_SMOKE_SATS: values.sats ?? settings.smoke.sats.toString(),
  });
  return { direction: smoke.direction, asset: smoke.asset, sats: smoke.sats };
}
