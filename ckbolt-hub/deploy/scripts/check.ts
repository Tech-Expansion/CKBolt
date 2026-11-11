import { failed, renderReport } from "./check/checks";
import { runCheck } from "./check/run-check";
import { createDefaultContext } from "./lib/context";
import { runMain } from "./lib/main";

/**
 * testnet:check: the read-only readiness report of the deployment on DEPLOY_SSH_HOST (bitcoind sync, LND wallet, sync
 * and channels, fnn peers, wallet and channels, the hub's health, assets and browser-node addresses, the faucet). Each
 * line that is not ok says the next action. Exits 1 when something fails.
 *   npm --prefix deploy run testnet:check
 */
async function main(): Promise<number> {
  const ctx = createDefaultContext();
  const results = await runCheck(ctx);
  const title = `CKBolt testnet readiness: ${ctx.shell.target.host}:${ctx.settings.remoteDir}, ${new Date(ctx.clock.now()).toISOString()}`;
  ctx.logger.raw(renderReport(title, results));
  return failed(results) ? 1 : 0;
}

runMain("testnet:check", main);
