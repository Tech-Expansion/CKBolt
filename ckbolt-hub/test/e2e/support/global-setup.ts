import { spawnSync } from "node:child_process";
import { DEVNET_UP_COMMAND, HUB_ROOT } from "./e2e.constants";
import { loadE2eSettings } from "./e2e.settings";

/**
 * Runs once before every e2e test file (test/jest-e2e.json `globalSetup`): `npm --prefix devnet run up` starts the
 * devnet with its saved state, rewrites devnet/hub.env for the published ports, reconnects the nodes and waits until
 * every channel is active. It fails the run, with the command's output, when the devnet cannot come up.
 */
export default function globalSetup(): void {
  if (loadE2eSettings().skipDevnetUp) return;
  const [command, ...args] = DEVNET_UP_COMMAND;
  // npm is a .cmd script on Windows, which Node starts only through a shell.
  const result = spawnSync(command, args, { cwd: HUB_ROOT, encoding: "utf8", shell: process.platform === "win32" });
  if (result.status === 0) return;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`;
  throw new Error(`"${DEVNET_UP_COMMAND.join(" ")}" failed (exit ${result.status ?? "signal"}). Bootstrap the devnet first ` +
    `(npm --prefix devnet run bootstrap).\n${output}`);
}
